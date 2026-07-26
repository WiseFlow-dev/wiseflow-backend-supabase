-- ============================================================================
-- Add Currency to LLM Rewrite Queue - Migration 047
-- ============================================================================
-- Adds currency_code to llm_rewrite_queue to support currency-scoped
-- LLM rewriting of insights.
-- ============================================================================

-- Add currency_code column
ALTER TABLE llm_rewrite_queue 
ADD COLUMN IF NOT EXISTS currency_code TEXT NOT NULL DEFAULT 'USD';

-- Update index to include currency
DROP INDEX IF EXISTS idx_llm_queue_user_month;
CREATE INDEX idx_llm_queue_user_month_currency
  ON llm_rewrite_queue(user_id, month_key, currency_code);

COMMENT ON COLUMN llm_rewrite_queue.currency_code IS
  'Currency code for this LLM job (e.g., USD, EUR). Jobs are queued per currency.';

-- Drop old 4-arg version to avoid ambiguity
DROP FUNCTION IF EXISTS enqueue_llm_rewrite(UUID, TEXT, JSONB, TEXT);

-- Update enqueue function to accept currency_code
CREATE OR REPLACE FUNCTION enqueue_llm_rewrite(
  p_user_id UUID,
  p_month_key TEXT,
  p_insights JSONB,
  p_locale TEXT DEFAULT 'en',
  p_currency_code TEXT DEFAULT 'USD'
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_job_id BIGINT;
  v_existing_job_id BIGINT;
BEGIN
  -- Check if pending/processing job already exists for this user+month+currency
  SELECT id INTO v_existing_job_id
  FROM llm_rewrite_queue
  WHERE user_id = p_user_id
    AND month_key = p_month_key
    AND currency_code = p_currency_code
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
    currency_code,
    insights,
    locale,
    status,
    attempts,
    created_at
  ) VALUES (
    p_user_id,
    p_month_key,
    p_currency_code,
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

COMMENT ON FUNCTION enqueue_llm_rewrite(UUID, TEXT, JSONB, TEXT, TEXT) IS 
  'Enqueue LLM rewrite job. Idempotent: returns existing job ID if pending/processing job exists for user+month+currency.';

-- Drop old version to avoid ambiguity (return type changed)
DROP FUNCTION IF EXISTS get_next_llm_job();

-- Update get_next_llm_job to return currency_code
CREATE OR REPLACE FUNCTION get_next_llm_job()
RETURNS TABLE(
  job_id BIGINT,
  user_id UUID,
  month_key TEXT,
  currency_code TEXT,
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
    llm_rewrite_queue.currency_code,
    llm_rewrite_queue.insights,
    llm_rewrite_queue.locale,
    llm_rewrite_queue.attempts
  FROM llm_rewrite_queue
  WHERE status = 'pending'
    AND attempts < max_attempts
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;
END;
$$;

COMMENT ON FUNCTION get_next_llm_job() IS 
  'Get next pending LLM job for processing. Returns currency_code for currency-scoped cache updates.';

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'Migration 047 complete: Added currency_code to LLM rewrite queue';
  RAISE NOTICE '  - Added currency_code column to llm_rewrite_queue';
  RAISE NOTICE '  - Updated enqueue_llm_rewrite to accept currency_code';
  RAISE NOTICE '  - Updated get_next_llm_job to return currency_code';
END $$;

