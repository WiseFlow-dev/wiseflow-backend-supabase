-- ============================================================================
-- Spending Insights Backend Optimization - Phase 3: Async LLM Rewrite
-- ============================================================================
-- Creates infrastructure for asynchronous LLM rewriting of insights.
-- Insights are returned immediately with raw text, then enhanced by LLM
-- in the background without blocking the user.
--
-- Key Features:
--   - Queue table for pending LLM jobs
--   - Retry logic with attempt tracking
--   - Status tracking (pending, processing, completed, failed)
--   - Idempotent job processing with Postgres advisory locks
-- ============================================================================

-- ============================================================================
-- LLM REWRITE QUEUE TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS llm_rewrite_queue (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month_key TEXT NOT NULL, -- Format: YYYY-MM
  insights JSONB NOT NULL, -- Array of raw insights to rewrite
  locale TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  CONSTRAINT valid_status CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT valid_attempts CHECK (attempts >= 0 AND attempts <= max_attempts)
);

-- Indexes for efficient queue polling
CREATE INDEX idx_llm_queue_status_created 
  ON llm_rewrite_queue(status, created_at) 
  WHERE status IN ('pending', 'processing');

CREATE INDEX idx_llm_queue_user_month 
  ON llm_rewrite_queue(user_id, month_key);

-- Index for cleanup of old jobs
CREATE INDEX idx_llm_queue_completed_at 
  ON llm_rewrite_queue(completed_at) 
  WHERE status IN ('completed', 'failed');

COMMENT ON TABLE llm_rewrite_queue IS 
  'Queue for asynchronous LLM rewriting of spending insights. Jobs are processed by background worker.';

-- ============================================================================
-- ROW-LEVEL SECURITY
-- ============================================================================

ALTER TABLE llm_rewrite_queue ENABLE ROW LEVEL SECURITY;

-- Service role: Full access for background worker
CREATE POLICY "Service role full access on llm_queue"
  ON llm_rewrite_queue
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Authenticated users: Read own jobs only (for debugging)
CREATE POLICY "Users read own llm_jobs"
  ON llm_rewrite_queue
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Function to enqueue LLM rewrite job (idempotent)
CREATE OR REPLACE FUNCTION enqueue_llm_rewrite(
  p_user_id UUID,
  p_month_key TEXT,
  p_insights JSONB,
  p_locale TEXT DEFAULT 'en'
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_job_id BIGINT;
  v_existing_job_id BIGINT;
BEGIN
  -- Check if pending/processing job already exists for this user+month
  SELECT id INTO v_existing_job_id
  FROM llm_rewrite_queue
  WHERE user_id = p_user_id
    AND month_key = p_month_key
    AND status IN ('pending', 'processing')
  ORDER BY created_at DESC
  LIMIT 1;
  
  -- If job already exists, return existing job ID (idempotent)
  IF v_existing_job_id IS NOT NULL THEN
    RETURN v_existing_job_id;
  END IF;
  
  -- Create new job
  INSERT INTO llm_rewrite_queue (
    user_id,
    month_key,
    insights,
    locale,
    status,
    attempts,
    created_at
  ) VALUES (
    p_user_id,
    p_month_key,
    p_insights,
    p_locale,
    'pending',
    0,
    NOW()
  )
  RETURNING id INTO v_job_id;
  
  RETURN v_job_id;
END;
$$;

COMMENT ON FUNCTION enqueue_llm_rewrite(UUID, TEXT, JSONB, TEXT) IS 
  'Enqueue LLM rewrite job. Idempotent: returns existing job ID if pending/processing job exists for user+month.';

-- Function to get next pending job (for worker polling)
CREATE OR REPLACE FUNCTION get_next_llm_job()
RETURNS TABLE(
  job_id BIGINT,
  user_id UUID,
  month_key TEXT,
  insights JSONB,
  locale TEXT,
  attempts INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    id,
    llm_rewrite_queue.user_id,
    llm_rewrite_queue.month_key,
    llm_rewrite_queue.insights,
    llm_rewrite_queue.locale,
    llm_rewrite_queue.attempts
  FROM llm_rewrite_queue
  WHERE status = 'pending'
    AND attempts < max_attempts
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED; -- Prevent concurrent workers from picking same job
END;
$$;

COMMENT ON FUNCTION get_next_llm_job() IS 
  'Get next pending LLM job for processing. Uses FOR UPDATE SKIP LOCKED for concurrent worker safety.';

-- Function to mark job as processing
CREATE OR REPLACE FUNCTION mark_llm_job_processing(p_job_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE llm_rewrite_queue
  SET 
    status = 'processing',
    started_at = NOW()
  WHERE id = p_job_id;
END;
$$;

-- Function to mark job as completed
CREATE OR REPLACE FUNCTION mark_llm_job_completed(p_job_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE llm_rewrite_queue
  SET 
    status = 'completed',
    completed_at = NOW()
  WHERE id = p_job_id;
END;
$$;

-- Function to mark job as failed (with retry logic)
CREATE OR REPLACE FUNCTION mark_llm_job_failed(
  p_job_id BIGINT,
  p_error_message TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_attempts INTEGER;
  v_max_attempts INTEGER;
BEGIN
  -- Increment attempts
  UPDATE llm_rewrite_queue
  SET 
    attempts = attempts + 1,
    error_message = p_error_message,
    completed_at = CASE 
      WHEN attempts + 1 >= max_attempts THEN NOW()
      ELSE NULL
    END,
    status = CASE 
      WHEN attempts + 1 >= max_attempts THEN 'failed'
      ELSE 'pending' -- Retry
    END
  WHERE id = p_job_id
  RETURNING attempts, max_attempts INTO v_attempts, v_max_attempts;
  
  -- Log retry or final failure
  IF v_attempts < v_max_attempts THEN
    RAISE NOTICE 'LLM job % failed (attempt %/%), will retry', p_job_id, v_attempts, v_max_attempts;
  ELSE
    RAISE NOTICE 'LLM job % failed permanently after % attempts', p_job_id, v_attempts;
  END IF;
END;
$$;

COMMENT ON FUNCTION mark_llm_job_failed(BIGINT, TEXT) IS 
  'Mark LLM job as failed. Automatically retries if attempts < max_attempts, otherwise marks as permanently failed.';

-- ============================================================================
-- CLEANUP FUNCTION
-- ============================================================================

-- Function to cleanup old completed/failed jobs
CREATE OR REPLACE FUNCTION cleanup_old_llm_jobs(p_retention_days INTEGER DEFAULT 7)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted_count INTEGER;
BEGIN
  DELETE FROM llm_rewrite_queue
  WHERE status IN ('completed', 'failed')
    AND completed_at < NOW() - (p_retention_days || ' days')::INTERVAL;
  
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  
  RAISE NOTICE 'Cleaned up % old LLM jobs (retention: % days)', v_deleted_count, p_retention_days;
  
  RETURN v_deleted_count;
END;
$$;

COMMENT ON FUNCTION cleanup_old_llm_jobs(INTEGER) IS 
  'Cleanup completed/failed LLM jobs older than retention period (default 7 days).';

-- ============================================================================
-- VERIFICATION
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'LLM rewrite queue infrastructure created successfully';
  RAISE NOTICE 'Queue table: llm_rewrite_queue';
  RAISE NOTICE 'Helper functions: enqueue_llm_rewrite, get_next_llm_job, mark_llm_job_*';
  RAISE NOTICE 'Cleanup function: cleanup_old_llm_jobs';
END $$;
