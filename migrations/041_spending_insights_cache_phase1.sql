-- ============================================================================
-- Spending Insights Backend Optimization - Phase 1
-- ============================================================================
-- Creates aggregation tables, insight cache, and invalidation triggers
-- for fast spending insights with proper caching and security.
--
-- Tables:
--   - user_monthly_spending_aggregates: Pre-computed monthly summaries
--   - user_monthly_insights_cache: Cached insights with LLM rewrites
--   - insight_type_config: Per-type decay configuration
--   - aggregation_audit_log: Audit trail for cache operations
--
-- Security: RLS enabled, service role writes, authenticated reads
-- ============================================================================

-- ============================================================================
-- 0. HELPER FUNCTIONS (must be created before tables for CHECK constraints)
-- ============================================================================

-- Function to count JSONB object keys (for CHECK constraints)
CREATE OR REPLACE FUNCTION jsonb_key_count(p_json JSONB)
RETURNS INTEGER
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT COUNT(*)::INTEGER FROM jsonb_object_keys(p_json);
$$;

COMMENT ON FUNCTION jsonb_key_count(JSONB) IS 
  'Count number of keys in a JSONB object. Used in CHECK constraints to prevent JSONB bloat.';

-- ============================================================================
-- 1. AGGREGATION TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_monthly_spending_aggregates (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month_key TEXT NOT NULL, -- Format: YYYY-MM (UTC month)
  
  -- Aggregated totals (in cents for consistency with other tables)
  -- Note: wallet_transactions.amount is DECIMAL, converted to cents via ROUND(amount * 100)
  total_expense_cents BIGINT NOT NULL DEFAULT 0,
  total_income_cents BIGINT NOT NULL DEFAULT 0,
  transaction_count INTEGER NOT NULL DEFAULT 0,
  
  -- Detailed breakdowns (JSONB for flexibility)
  -- Values stored in cents: { "2025-01-15": 45000, ... } (45000 cents = 450.00)
  daily_totals JSONB NOT NULL DEFAULT '{}', -- { "2025-01-15": 45000, ... } (UTC dates, amounts in cents)
  category_totals JSONB NOT NULL DEFAULT '{}', -- { "restaurants": 120000, ... } (amounts in cents)
  
  -- Cache metadata
  last_transaction_at TIMESTAMPTZ, -- UTC timestamp of most recent transaction
  data_hash TEXT, -- Hash of transaction IDs to detect changes (optional)
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  PRIMARY KEY (user_id, month_key),
  
  -- Guardrails: Prevent JSONB bloat
  CONSTRAINT daily_totals_size_limit CHECK (
    jsonb_typeof(daily_totals) = 'object' AND
    jsonb_key_count(daily_totals) <= 31
  ),
  CONSTRAINT category_totals_size_limit CHECK (
    jsonb_typeof(category_totals) = 'object' AND
    jsonb_key_count(category_totals) <= 100
  )
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_user_monthly_aggregates_user_month 
  ON user_monthly_spending_aggregates(user_id, month_key);

CREATE INDEX IF NOT EXISTS idx_user_monthly_aggregates_last_txn
  ON user_monthly_spending_aggregates(user_id, last_transaction_at);

CREATE INDEX IF NOT EXISTS idx_user_monthly_aggregates_computed
  ON user_monthly_spending_aggregates(computed_at);

COMMENT ON TABLE user_monthly_spending_aggregates IS 
  'Pre-computed monthly spending summaries for fast insight generation. Invalidated on transaction changes. Amounts stored in cents (wallet_transactions.amount * 100) for consistency with other tables.';

COMMENT ON COLUMN user_monthly_spending_aggregates.total_expense_cents IS
  'Total expenses in cents. Computed as SUM(ROUND(ABS(amount) * 100)) WHERE amount < 0';

COMMENT ON COLUMN user_monthly_spending_aggregates.total_income_cents IS
  'Total income in cents. Computed as SUM(ROUND(amount * 100)) WHERE amount >= 0';

COMMENT ON COLUMN user_monthly_spending_aggregates.daily_totals IS
  'Daily totals in cents by date. Format: {"2025-01-15": 45000} where 45000 = 450.00 in wallet_transactions';

COMMENT ON COLUMN user_monthly_spending_aggregates.category_totals IS
  'Category totals with stable IDs. Format: {"category_id": {"id": "uuid", "name": "Restaurants", "cents": 120000}}';

-- ============================================================================
-- 2. INSIGHTS CACHE TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_monthly_insights_cache (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month_key TEXT NOT NULL,
  insight_type TEXT NOT NULL, -- SPENDING_VELOCITY, WEEKEND_SPIKE, etc.
  
  -- Insight data
  insight_data JSONB NOT NULL, -- Full insight object (title, description, stats, etc.)
  
  -- Cache metadata
  raw_computed_at TIMESTAMPTZ NOT NULL, -- When raw insight was computed
  llm_rewritten_at TIMESTAMPTZ, -- When LLM rewrite completed (NULL = not yet rewritten)
  last_shown_at TIMESTAMPTZ, -- When insight was last shown to user
  show_count INTEGER NOT NULL DEFAULT 0, -- How many times shown
  job_id TEXT, -- LLM job ID for idempotency
  
  PRIMARY KEY (user_id, month_key, insight_type)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_insights_cache_user_month 
  ON user_monthly_insights_cache(user_id, month_key);

CREATE INDEX IF NOT EXISTS idx_insights_cache_last_shown 
  ON user_monthly_insights_cache(user_id, insight_type, last_shown_at);

CREATE INDEX IF NOT EXISTS idx_insights_cache_llm_status
  ON user_monthly_insights_cache(user_id, month_key, llm_rewritten_at)
  WHERE llm_rewritten_at IS NULL; -- Find insights needing LLM rewrite

COMMENT ON TABLE user_monthly_insights_cache IS 
  'Cached spending insights with LLM rewrites. Tracks show frequency for decay logic.';

-- ============================================================================
-- 3. INSIGHT TYPE CONFIGURATION
-- ============================================================================

CREATE TABLE IF NOT EXISTS insight_type_config (
  insight_type TEXT PRIMARY KEY,
  decay_months INTEGER NOT NULL DEFAULT 2, -- How many months before showing again
  min_threshold_cents BIGINT, -- Minimum amount to trigger insight (optional)
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed with default configuration
INSERT INTO insight_type_config (insight_type, decay_months, description) VALUES
  ('SPENDING_VELOCITY', 0, 'Always show - core spending metric'),
  ('WEEKEND_SPIKE', 1, 'Show monthly - behavioral pattern'),
  ('TOP_MERCHANT', 2, 'Show every 2 months - spending habit'),
  ('SPIKE_DAY', 3, 'Show every 3 months - anomaly detection'),
  ('SMALL_LEAKS', 2, 'Show every 2 months - spending awareness'),
  ('SUBSCRIPTIONS', 2, 'Show every 2 months - recurring costs'),
  ('INCOME_SHARE', 1, 'Show monthly - financial health'),
  ('TIME_OF_DAY', 2, 'Show every 2 months - behavioral pattern')
ON CONFLICT (insight_type) DO NOTHING;

COMMENT ON TABLE insight_type_config IS 
  'Configuration for insight decay and thresholds. Allows per-type tuning.';

-- ============================================================================
-- 4. AUDIT LOG
-- ============================================================================

CREATE TABLE IF NOT EXISTS aggregation_audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  month_key TEXT,
  operation TEXT NOT NULL, -- 'compute', 'invalidate', 'cleanup', 'manual_invalidate'
  triggered_by TEXT, -- 'transaction_insert', 'transaction_update', 'manual', 'cron'
  duration_ms INTEGER,
  metadata JSONB, -- Additional context (transaction_id, admin_user, etc.)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for audit queries
CREATE INDEX IF NOT EXISTS idx_audit_log_user_operation
  ON aggregation_audit_log(user_id, operation, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_created
  ON aggregation_audit_log(created_at DESC);

COMMENT ON TABLE aggregation_audit_log IS 
  'Audit trail for cache operations. Retention: 90 days.';

-- ============================================================================
-- 5. ROW-LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE user_monthly_spending_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_monthly_insights_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight_type_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE aggregation_audit_log ENABLE ROW LEVEL SECURITY;

-- Aggregation table policies
DROP POLICY IF EXISTS "Service role full access on aggregates" ON user_monthly_spending_aggregates;
CREATE POLICY "Service role full access on aggregates"
  ON user_monthly_spending_aggregates
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own aggregates" ON user_monthly_spending_aggregates;
CREATE POLICY "Users read own aggregates"
  ON user_monthly_spending_aggregates
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Insights cache policies
DROP POLICY IF EXISTS "Service role full access on insights cache" ON user_monthly_insights_cache;
CREATE POLICY "Service role full access on insights cache"
  ON user_monthly_insights_cache
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own insights cache" ON user_monthly_insights_cache;
CREATE POLICY "Users read own insights cache"
  ON user_monthly_insights_cache
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Config table policies (read-only for all authenticated users)
DROP POLICY IF EXISTS "Anyone can read insight config" ON insight_type_config;
CREATE POLICY "Anyone can read insight config"
  ON insight_type_config
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Service role can manage config" ON insight_type_config;
CREATE POLICY "Service role can manage config"
  ON insight_type_config
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Audit log policies (service role only)
DROP POLICY IF EXISTS "Service role full access on audit log" ON aggregation_audit_log;
CREATE POLICY "Service role full access on audit log"
  ON aggregation_audit_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- 6. HELPER FUNCTIONS
-- ============================================================================

-- Function to get month key from timestamp (UTC)
CREATE OR REPLACE FUNCTION get_month_key_utc(ts TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM');
$$;

COMMENT ON FUNCTION get_month_key_utc(TIMESTAMPTZ) IS 
  'Extract UTC month key (YYYY-MM) from timestamp. Used for consistent month boundaries.';

-- Function to invalidate aggregate cache for a user+month
CREATE OR REPLACE FUNCTION invalidate_aggregate_cache(
  p_user_id UUID,
  p_month_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Delete aggregate
  DELETE FROM user_monthly_spending_aggregates
  WHERE user_id = p_user_id AND month_key = p_month_key;
  
  -- Delete all insights for that month
  DELETE FROM user_monthly_insights_cache
  WHERE user_id = p_user_id AND month_key = p_month_key;
  
  -- NOTE: Audit logging is handled by trigger, not here
  -- This prevents duplicate audit log entries
END;
$$;

COMMENT ON FUNCTION invalidate_aggregate_cache(UUID, TEXT) IS 
  'Invalidate aggregate and insights cache for a specific user+month. Used by triggers and manual invalidation. Audit logging handled by trigger.';

-- Function to check if aggregate cache is fresh
CREATE OR REPLACE FUNCTION is_aggregate_cache_fresh(
  p_user_id UUID,
  p_month_key TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_cached_last_txn TIMESTAMPTZ;
  v_newest_txn TIMESTAMPTZ;
  v_month_start TIMESTAMPTZ;
  v_month_end TIMESTAMPTZ;
BEGIN
  -- Get cached last_transaction_at
  SELECT last_transaction_at INTO v_cached_last_txn
  FROM user_monthly_spending_aggregates
  WHERE user_id = p_user_id AND month_key = p_month_key;
  
  -- If no cache, not fresh
  IF v_cached_last_txn IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Calculate month boundaries (UTC)
  v_month_start := (p_month_key || '-01')::DATE AT TIME ZONE 'UTC';
  v_month_end := (v_month_start + INTERVAL '1 month' - INTERVAL '1 second');
  
  -- Get newest transaction date for this month
  SELECT MAX(date) INTO v_newest_txn
  FROM wallet_transactions
  WHERE user_id = p_user_id
    AND date >= v_month_start
    AND date <= v_month_end;
  
  -- If no transactions, cache is fresh
  IF v_newest_txn IS NULL THEN
    RETURN TRUE;
  END IF;
  
  -- Cache is fresh if last_transaction_at >= newest transaction
  RETURN v_cached_last_txn >= v_newest_txn;
END;
$$;

COMMENT ON FUNCTION is_aggregate_cache_fresh(UUID, TEXT) IS 
  'Check if aggregate cache is fresh by comparing cached last_transaction_at with newest transaction date.';

-- ============================================================================
-- 7. CACHE INVALIDATION TRIGGERS
-- ============================================================================

-- Trigger function to invalidate cache on transaction changes
CREATE OR REPLACE FUNCTION trigger_invalidate_aggregate_on_txn_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_month_key TEXT;
  v_old_month_key TEXT;
BEGIN
  -- Handle INSERT
  IF TG_OP = 'INSERT' THEN
    v_month_key := get_month_key_utc(NEW.date);
    PERFORM invalidate_aggregate_cache(NEW.user_id, v_month_key);
    
    INSERT INTO aggregation_audit_log (user_id, month_key, operation, triggered_by, metadata)
    VALUES (NEW.user_id, v_month_key, 'invalidate', 'transaction_insert', 
            jsonb_build_object('transaction_id', NEW.id));
    
    RETURN NEW;
  END IF;
  
  -- Handle UPDATE
  IF TG_OP = 'UPDATE' THEN
    v_month_key := get_month_key_utc(NEW.date);
    v_old_month_key := get_month_key_utc(OLD.date);
    
    -- Invalidate new month
    PERFORM invalidate_aggregate_cache(NEW.user_id, v_month_key);
    
    -- If date changed and crossed month boundary, invalidate old month too
    IF v_month_key != v_old_month_key THEN
      PERFORM invalidate_aggregate_cache(OLD.user_id, v_old_month_key);
    END IF;
    
    INSERT INTO aggregation_audit_log (user_id, month_key, operation, triggered_by, metadata)
    VALUES (NEW.user_id, v_month_key, 'invalidate', 'transaction_update',
            jsonb_build_object('transaction_id', NEW.id, 'old_month', v_old_month_key));
    
    RETURN NEW;
  END IF;
  
  -- Handle DELETE
  IF TG_OP = 'DELETE' THEN
    v_month_key := get_month_key_utc(OLD.date);
    PERFORM invalidate_aggregate_cache(OLD.user_id, v_month_key);
    
    INSERT INTO aggregation_audit_log (user_id, month_key, operation, triggered_by, metadata)
    VALUES (OLD.user_id, v_month_key, 'invalidate', 'transaction_delete',
            jsonb_build_object('transaction_id', OLD.id));
    
    RETURN OLD;
  END IF;
  
  RETURN NULL;
END;
$$;

-- Create triggers on wallet_transactions table
DROP TRIGGER IF EXISTS trigger_invalidate_cache_on_insert ON wallet_transactions;
CREATE TRIGGER trigger_invalidate_cache_on_insert
  AFTER INSERT ON wallet_transactions
  FOR EACH ROW
  EXECUTE FUNCTION trigger_invalidate_aggregate_on_txn_change();

DROP TRIGGER IF EXISTS trigger_invalidate_cache_on_update ON wallet_transactions;
CREATE TRIGGER trigger_invalidate_cache_on_update
  AFTER UPDATE ON wallet_transactions
  FOR EACH ROW
  WHEN (
    OLD.amount IS DISTINCT FROM NEW.amount OR
    OLD.date IS DISTINCT FROM NEW.date OR
    OLD.category IS DISTINCT FROM NEW.category
  )
  EXECUTE FUNCTION trigger_invalidate_aggregate_on_txn_change();

DROP TRIGGER IF EXISTS trigger_invalidate_cache_on_delete ON wallet_transactions;
CREATE TRIGGER trigger_invalidate_cache_on_delete
  AFTER DELETE ON wallet_transactions
  FOR EACH ROW
  EXECUTE FUNCTION trigger_invalidate_aggregate_on_txn_change();

COMMENT ON FUNCTION trigger_invalidate_aggregate_on_txn_change() IS 
  'Trigger function to invalidate aggregate cache when transactions change. Handles INSERT/UPDATE/DELETE.';

-- ============================================================================
-- 8. CLEANUP FUNCTION (for cron job)
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_old_aggregates_and_cache()
RETURNS TABLE(
  aggregates_deleted BIGINT,
  insights_deleted BIGINT,
  audit_logs_deleted BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_agg_deleted BIGINT;
  v_insights_deleted BIGINT;
  v_audit_deleted BIGINT;
BEGIN
  -- Delete aggregates older than 24 months
  DELETE FROM user_monthly_spending_aggregates
  WHERE computed_at < NOW() - INTERVAL '24 months';
  GET DIAGNOSTICS v_agg_deleted = ROW_COUNT;
  
  -- Delete insight cache older than 12 months
  DELETE FROM user_monthly_insights_cache
  WHERE raw_computed_at < NOW() - INTERVAL '12 months';
  GET DIAGNOSTICS v_insights_deleted = ROW_COUNT;
  
  -- Delete audit logs older than 90 days
  DELETE FROM aggregation_audit_log
  WHERE created_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS v_audit_deleted = ROW_COUNT;
  
  -- Log cleanup operation
  INSERT INTO aggregation_audit_log (user_id, operation, triggered_by, metadata)
  VALUES (
    '00000000-0000-0000-0000-000000000000'::UUID,
    'cleanup',
    'cron',
    jsonb_build_object(
      'aggregates_deleted', v_agg_deleted,
      'insights_deleted', v_insights_deleted,
      'audit_logs_deleted', v_audit_deleted
    )
  );
  
  -- Return counts
  RETURN QUERY SELECT v_agg_deleted, v_insights_deleted, v_audit_deleted;
END;
$$;

COMMENT ON FUNCTION cleanup_old_aggregates_and_cache() IS 
  'Cleanup old data: aggregates >24mo, insights >12mo, audit logs >90d. Run monthly via cron.';

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

-- Verify tables created
DO $$
BEGIN
  RAISE NOTICE 'Migration 041 complete: Spending insights cache tables created';
  RAISE NOTICE '  - user_monthly_spending_aggregates';
  RAISE NOTICE '  - user_monthly_insights_cache';
  RAISE NOTICE '  - insight_type_config';
  RAISE NOTICE '  - aggregation_audit_log';
  RAISE NOTICE 'RLS policies enabled, triggers active, helper functions ready';
END $$;
