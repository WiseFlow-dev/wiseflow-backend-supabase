-- ============================================================================
-- Spending Insights Currency Support - Migration 045
-- ============================================================================
-- Adds currency awareness to aggregates and insights cache to support
-- multi-currency users with proper Main Currency filtering.
--
-- Changes:
--   1. Add currency_code to user_monthly_spending_aggregates
--   2. Add currency_code to user_monthly_insights_cache
--   3. Add daily_expense_totals for accurate spike/weekend detection
--   4. Update primary keys to include currency_code
--   5. Update helper functions for currency filtering
--   6. Add composite index on wallet_transactions
-- ============================================================================

-- ============================================================================
-- 1. ADD CURRENCY TO AGGREGATES TABLE
-- ============================================================================

-- Add currency_code column (default USD for existing data)
ALTER TABLE user_monthly_spending_aggregates 
ADD COLUMN IF NOT EXISTS currency_code TEXT NOT NULL DEFAULT 'USD';

-- Add daily_expense_totals for expense-only tracking
ALTER TABLE user_monthly_spending_aggregates 
ADD COLUMN IF NOT EXISTS daily_expense_totals JSONB NOT NULL DEFAULT '{}';

-- Add CHECK constraint for daily_expense_totals size
ALTER TABLE user_monthly_spending_aggregates 
ADD CONSTRAINT daily_expense_totals_size_limit CHECK (
  jsonb_typeof(daily_expense_totals) = 'object' AND
  jsonb_key_count(daily_expense_totals) <= 31
);

-- Drop old primary key
ALTER TABLE user_monthly_spending_aggregates 
DROP CONSTRAINT IF EXISTS user_monthly_spending_aggregates_pkey;

-- Add new primary key with currency_code
ALTER TABLE user_monthly_spending_aggregates 
ADD PRIMARY KEY (user_id, month_key, currency_code);

-- Add index for currency filtering
CREATE INDEX IF NOT EXISTS idx_user_monthly_aggregates_currency
ON user_monthly_spending_aggregates(user_id, currency_code, month_key);

COMMENT ON COLUMN user_monthly_spending_aggregates.currency_code IS
  'Currency code for this aggregate (e.g., USD, EUR). Aggregates are computed per currency.';

COMMENT ON COLUMN user_monthly_spending_aggregates.daily_expense_totals IS
  'Daily expense totals (expense-only, not net) in cents by date. Format: {"2025-01-15": 45000}';

-- ============================================================================
-- 2. ADD CURRENCY TO INSIGHTS CACHE TABLE
-- ============================================================================

-- Add currency_code column
ALTER TABLE user_monthly_insights_cache 
ADD COLUMN IF NOT EXISTS currency_code TEXT NOT NULL DEFAULT 'USD';

-- Drop old primary key
ALTER TABLE user_monthly_insights_cache 
DROP CONSTRAINT IF EXISTS user_monthly_insights_cache_pkey;

-- Add new primary key with currency_code
ALTER TABLE user_monthly_insights_cache 
ADD PRIMARY KEY (user_id, month_key, currency_code, insight_type);

-- Update indexes
DROP INDEX IF EXISTS idx_insights_cache_user_month;
CREATE INDEX idx_insights_cache_user_month_currency
ON user_monthly_insights_cache(user_id, month_key, currency_code);

DROP INDEX IF EXISTS idx_insights_cache_llm_status;
CREATE INDEX idx_insights_cache_llm_status
ON user_monthly_insights_cache(user_id, month_key, currency_code, llm_rewritten_at)
WHERE llm_rewritten_at IS NULL;

COMMENT ON COLUMN user_monthly_insights_cache.currency_code IS
  'Currency code for this insight (e.g., USD, EUR). Insights are cached per currency.';

-- ============================================================================
-- 3. UPDATE HELPER FUNCTIONS FOR CURRENCY
-- ============================================================================

-- Update invalidate_aggregate_cache to include currency
CREATE OR REPLACE FUNCTION invalidate_aggregate_cache(
  p_user_id UUID,
  p_month_key TEXT,
  p_currency_code TEXT DEFAULT NULL  -- NULL = invalidate all currencies
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Delete aggregate(s)
  IF p_currency_code IS NULL THEN
    -- Invalidate all currencies for this month
    DELETE FROM user_monthly_spending_aggregates
    WHERE user_id = p_user_id AND month_key = p_month_key;
    
    -- Delete all insights for that month (all currencies)
    DELETE FROM user_monthly_insights_cache
    WHERE user_id = p_user_id AND month_key = p_month_key;
  ELSE
    -- Invalidate specific currency only
    DELETE FROM user_monthly_spending_aggregates
    WHERE user_id = p_user_id 
      AND month_key = p_month_key 
      AND currency_code = p_currency_code;
    
    -- Delete insights for that month+currency
    DELETE FROM user_monthly_insights_cache
    WHERE user_id = p_user_id 
      AND month_key = p_month_key 
      AND currency_code = p_currency_code;
  END IF;
  
  -- NOTE: Audit logging is handled by trigger, not here
END;
$$;

-- Drop old 2-arg version to avoid ambiguity
DROP FUNCTION IF EXISTS invalidate_aggregate_cache(UUID, TEXT);

COMMENT ON FUNCTION invalidate_aggregate_cache(UUID, TEXT, TEXT) IS 
  'Invalidate aggregate and insights cache for a specific user+month+currency. If currency is NULL, invalidates all currencies.';

-- Update is_aggregate_cache_fresh to include currency
CREATE OR REPLACE FUNCTION is_aggregate_cache_fresh(
  p_user_id UUID,
  p_month_key TEXT,
  p_currency_code TEXT
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
  -- Get cached last_transaction_at for this currency
  SELECT last_transaction_at INTO v_cached_last_txn
  FROM user_monthly_spending_aggregates
  WHERE user_id = p_user_id 
    AND month_key = p_month_key
    AND currency_code = p_currency_code;
  
  -- If no cache, not fresh
  IF v_cached_last_txn IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Calculate month boundaries (UTC)
  v_month_start := (p_month_key || '-01')::DATE AT TIME ZONE 'UTC';
  v_month_end := (v_month_start + INTERVAL '1 month' - INTERVAL '1 second');
  
  -- Get newest transaction date for this month+currency
  -- Filter by wallet currency
  SELECT MAX(wt.date) INTO v_newest_txn
  FROM wallet_transactions wt
  JOIN wallets w ON w.id = wt.wallet_id
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end
    AND w.currency_code = p_currency_code;
  
  -- If no transactions, cache is fresh
  IF v_newest_txn IS NULL THEN
    RETURN TRUE;
  END IF;
  
  -- Cache is fresh if last_transaction_at >= newest transaction
  RETURN v_cached_last_txn >= v_newest_txn;
END;
$$;

COMMENT ON FUNCTION is_aggregate_cache_fresh(UUID, TEXT, TEXT) IS 
  'Check if aggregate cache is fresh for a specific currency by comparing cached last_transaction_at with newest transaction date.';



-- ============================================================================
-- 4. UPDATE CACHE INVALIDATION TRIGGER FOR CURRENCY
-- ============================================================================

-- Update trigger function to invalidate only matching currency
CREATE OR REPLACE FUNCTION trigger_invalidate_aggregate_on_txn_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_month_key TEXT;
  v_old_month_key TEXT;
  v_currency_code TEXT;
  v_old_currency_code TEXT;
BEGIN
  -- Handle INSERT
  IF TG_OP = 'INSERT' THEN
    v_month_key := get_month_key_utc(NEW.date);
    
    -- Get currency from wallet
    SELECT currency_code INTO v_currency_code
    FROM wallets
    WHERE id = NEW.wallet_id;
    
    -- Invalidate cache for this currency only
    PERFORM invalidate_aggregate_cache(NEW.user_id, v_month_key, v_currency_code);
    
    INSERT INTO aggregation_audit_log (user_id, month_key, operation, triggered_by, metadata)
    VALUES (NEW.user_id, v_month_key, 'invalidate', 'transaction_insert', 
            jsonb_build_object('transaction_id', NEW.id, 'currency_code', v_currency_code));
    
    RETURN NEW;
  END IF;
  
  -- Handle UPDATE
  IF TG_OP = 'UPDATE' THEN
    v_month_key := get_month_key_utc(NEW.date);
    v_old_month_key := get_month_key_utc(OLD.date);
    
    -- Get currency from wallet (new)
    SELECT currency_code INTO v_currency_code
    FROM wallets
    WHERE id = NEW.wallet_id;
    
    -- Get currency from wallet (old, if wallet changed)
    IF NEW.wallet_id != OLD.wallet_id THEN
      SELECT currency_code INTO v_old_currency_code
      FROM wallets
      WHERE id = OLD.wallet_id;
    ELSE
      v_old_currency_code := v_currency_code;
    END IF;
    
    -- Invalidate new month+currency
    PERFORM invalidate_aggregate_cache(NEW.user_id, v_month_key, v_currency_code);
    
    -- If date changed and crossed month boundary, invalidate old month too
    IF v_month_key != v_old_month_key THEN
      PERFORM invalidate_aggregate_cache(OLD.user_id, v_old_month_key, v_old_currency_code);
    END IF;
    
    -- If wallet changed (currency change), invalidate old currency
    IF v_currency_code != v_old_currency_code THEN
      PERFORM invalidate_aggregate_cache(OLD.user_id, v_month_key, v_old_currency_code);
    END IF;
    
    INSERT INTO aggregation_audit_log (user_id, month_key, operation, triggered_by, metadata)
    VALUES (NEW.user_id, v_month_key, 'invalidate', 'transaction_update',
            jsonb_build_object(
              'transaction_id', NEW.id, 
              'old_month', v_old_month_key,
              'currency_code', v_currency_code,
              'old_currency_code', v_old_currency_code
            ));
    
    RETURN NEW;
  END IF;
  
  -- Handle DELETE
  IF TG_OP = 'DELETE' THEN
    v_month_key := get_month_key_utc(OLD.date);
    
    -- Get currency from wallet
    SELECT currency_code INTO v_currency_code
    FROM wallets
    WHERE id = OLD.wallet_id;
    
    -- Invalidate cache for this currency only
    PERFORM invalidate_aggregate_cache(OLD.user_id, v_month_key, v_currency_code);
    
    INSERT INTO aggregation_audit_log (user_id, month_key, operation, triggered_by, metadata)
    VALUES (OLD.user_id, v_month_key, 'invalidate', 'transaction_delete',
            jsonb_build_object('transaction_id', OLD.id, 'currency_code', v_currency_code));
    
    RETURN OLD;
  END IF;
  
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION trigger_invalidate_aggregate_on_txn_change() IS 
  'Trigger function to invalidate aggregate cache when transactions change. Currency-aware: only invalidates matching currency.';

-- ============================================================================
-- 5. ADD COMPOSITE INDEX ON WALLET_TRANSACTIONS
-- ============================================================================

-- Add composite index for efficient month-range queries
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_date 
ON wallet_transactions(user_id, date DESC);

-- Add index for currency filtering (via wallet join)
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_date_wallet
ON wallet_transactions(user_id, date DESC, wallet_id);

COMMENT ON INDEX idx_wallet_transactions_user_date IS
  'Composite index for efficient user+date range queries in aggregate computation';

COMMENT ON INDEX idx_wallet_transactions_user_date_wallet IS
  'Composite index for efficient user+date+wallet queries (supports currency filtering)';

-- ============================================================================
-- 6. BACKFILL CURRENCY FOR EXISTING DATA (OPTIONAL)
-- ============================================================================

-- Backfill currency_code for existing aggregates based on user's wallets
-- Strategy: Use most common wallet currency for each user
DO $$
DECLARE
  v_updated_count INTEGER;
BEGIN
  -- Update aggregates with most common currency per user
  WITH user_currencies AS (
    SELECT 
      w.user_id,
      w.currency_code,
      COUNT(*) as wallet_count,
      ROW_NUMBER() OVER (PARTITION BY w.user_id ORDER BY COUNT(*) DESC) as rn
    FROM wallets w
    GROUP BY w.user_id, w.currency_code
  )
  UPDATE user_monthly_spending_aggregates agg
  SET currency_code = uc.currency_code
  FROM user_currencies uc
  WHERE agg.user_id = uc.user_id
    AND uc.rn = 1
    AND agg.currency_code = 'USD'; -- Only update default values
  
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  
  RAISE NOTICE 'Backfilled currency_code for % existing aggregates', v_updated_count;
END $$;

-- Backfill currency_code for existing insights cache
DO $$
DECLARE
  v_updated_count INTEGER;
BEGIN
  WITH user_currencies AS (
    SELECT 
      w.user_id,
      w.currency_code,
      COUNT(*) as wallet_count,
      ROW_NUMBER() OVER (PARTITION BY w.user_id ORDER BY COUNT(*) DESC) as rn
    FROM wallets w
    GROUP BY w.user_id, w.currency_code
  )
  UPDATE user_monthly_insights_cache ic
  SET currency_code = uc.currency_code
  FROM user_currencies uc
  WHERE ic.user_id = uc.user_id
    AND uc.rn = 1
    AND ic.currency_code = 'USD'; -- Only update default values
  
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  
  RAISE NOTICE 'Backfilled currency_code for % existing insights', v_updated_count;
END $$;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'Migration 045 complete: Currency-aware aggregates and insights cache';
  RAISE NOTICE '  - Added currency_code to user_monthly_spending_aggregates';
  RAISE NOTICE '  - Added currency_code to user_monthly_insights_cache';
  RAISE NOTICE '  - Added daily_expense_totals for accurate spike/weekend detection';
  RAISE NOTICE '  - Updated primary keys to include currency_code';
  RAISE NOTICE '  - Updated helper functions for currency filtering';
  RAISE NOTICE '  - Added composite indexes on wallet_transactions';
  RAISE NOTICE '  - Updated cache invalidation trigger for currency awareness';
END $$;

