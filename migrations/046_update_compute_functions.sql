-- ============================================================================
-- Update Compute Functions for Currency Support - Migration 046
-- ============================================================================
-- Updates compute_monthly_aggregate and upsert_monthly_aggregate to:
--   1. Accept currency_code parameter
--   2. Filter transactions by wallet currency
--   3. Handle NULL categories safely
--   4. Use category_id for stable insights
--   5. Add advisory lock for thundering herd protection
--   6. Compute daily_expense_totals separately from daily_totals
-- ============================================================================

-- ============================================================================
-- 1. UPDATE COMPUTE_MONTHLY_AGGREGATE FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION compute_monthly_aggregate(
  p_user_id UUID,
  p_month_key TEXT,
  p_currency_code TEXT
)
RETURNS TABLE(
  total_expense_cents BIGINT,
  total_income_cents BIGINT,
  transaction_count INTEGER,
  daily_totals JSONB,
  daily_expense_totals JSONB,
  category_totals JSONB,
  last_transaction_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_month_start TIMESTAMPTZ;
  v_month_end TIMESTAMPTZ;
  v_expense_cents BIGINT;
  v_income_cents BIGINT;
  v_txn_count INTEGER;
  v_daily_totals JSONB;
  v_daily_expense_totals JSONB;
  v_category_totals JSONB;
  v_last_txn_at TIMESTAMPTZ;
BEGIN
  -- Calculate month boundaries (UTC)
  v_month_start := (p_month_key || '-01')::DATE AT TIME ZONE 'UTC';
  v_month_end := (v_month_start + INTERVAL '1 month' - INTERVAL '1 second');
  
  -- Compute expense total (negative amounts → positive cents)
  -- Filter by wallet currency
  SELECT COALESCE(SUM(ROUND(ABS(wt.amount) * 100)), 0)::BIGINT
  INTO v_expense_cents
  FROM wallet_transactions wt
  JOIN wallets w ON w.id = wt.wallet_id
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end
    AND wt.amount < 0
    AND w.currency_code = p_currency_code;
  
  -- Compute income total (positive amounts → cents)
  -- Filter by wallet currency
  SELECT COALESCE(SUM(ROUND(wt.amount * 100)), 0)::BIGINT
  INTO v_income_cents
  FROM wallet_transactions wt
  JOIN wallets w ON w.id = wt.wallet_id
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end
    AND wt.amount >= 0
    AND w.currency_code = p_currency_code;
  
  -- Count transactions (currency-filtered)
  SELECT COUNT(*)::INTEGER
  INTO v_txn_count
  FROM wallet_transactions wt
  JOIN wallets w ON w.id = wt.wallet_id
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end
    AND w.currency_code = p_currency_code;
  
  -- Build daily_totals JSONB (net amount per day in cents)
  -- Format: {"2025-01-15": -5000, "2025-01-16": 10000}
  SELECT COALESCE(
    jsonb_object_agg(
      to_char(date AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
      daily_net_cents
    ),
    '{}'::JSONB
  )
  INTO v_daily_totals
  FROM (
    SELECT 
      wt.date::DATE as date,
      SUM(ROUND(wt.amount * 100))::BIGINT as daily_net_cents
    FROM wallet_transactions wt
    JOIN wallets w ON w.id = wt.wallet_id
    WHERE wt.user_id = p_user_id
      AND wt.date >= v_month_start
      AND wt.date <= v_month_end
      AND w.currency_code = p_currency_code
    GROUP BY wt.date::DATE
    ORDER BY wt.date::DATE
  ) daily_agg;
  
  -- Build daily_expense_totals JSONB (expense-only, not net)
  -- Format: {"2025-01-15": 5000, "2025-01-16": 3000}
  -- Used for spike/weekend detection
  SELECT COALESCE(
    jsonb_object_agg(
      to_char(date AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
      daily_expense_cents
    ),
    '{}'::JSONB
  )
  INTO v_daily_expense_totals
  FROM (
    SELECT 
      wt.date::DATE as date,
      SUM(ROUND(ABS(wt.amount) * 100))::BIGINT as daily_expense_cents
    FROM wallet_transactions wt
    JOIN wallets w ON w.id = wt.wallet_id
    WHERE wt.user_id = p_user_id
      AND wt.date >= v_month_start
      AND wt.date <= v_month_end
      AND wt.amount < 0  -- Expenses only
      AND w.currency_code = p_currency_code
    GROUP BY wt.date::DATE
    ORDER BY wt.date::DATE
  ) daily_expense_agg;
  
  -- Build category_totals JSONB (top 99 categories + "Other")
  -- Use category_id for stability, but store both id and name
  -- Handle NULL categories safely with COALESCE
  WITH ranked_categories AS (
    SELECT 
      COALESCE(wt.category_id::TEXT, 'uncategorized') as category_id,
      COALESCE(wt.category, 'Uncategorized') as category_name,
      SUM(ROUND(ABS(wt.amount) * 100))::BIGINT as category_cents,
      ROW_NUMBER() OVER (
        ORDER BY SUM(ROUND(ABS(wt.amount) * 100)) DESC, 
        COALESCE(wt.category, 'Uncategorized') ASC
      ) as rank
    FROM wallet_transactions wt
    JOIN wallets w ON w.id = wt.wallet_id
    WHERE wt.user_id = p_user_id
      AND wt.date >= v_month_start
      AND wt.date <= v_month_end
      AND wt.amount < 0  -- Only expenses have categories
      AND w.currency_code = p_currency_code
    GROUP BY COALESCE(wt.category_id::TEXT, 'uncategorized'), COALESCE(wt.category, 'Uncategorized')
  ),
  top_99 AS (
    SELECT 
      category_id,
      jsonb_build_object(
        'id', category_id,
        'name', category_name,
        'cents', category_cents
      ) as category_data
    FROM ranked_categories
    WHERE rank <= 99
  ),
  other_sum AS (
    SELECT COALESCE(SUM(category_cents), 0)::BIGINT as other_cents
    FROM ranked_categories
    WHERE rank > 99
  )
  SELECT COALESCE(
    (SELECT jsonb_object_agg(category_id, category_data) FROM top_99) ||
    CASE 
      WHEN (SELECT other_cents FROM other_sum) > 0 
      THEN jsonb_build_object('other', jsonb_build_object(
        'id', 'other',
        'name', 'Other',
        'cents', (SELECT other_cents FROM other_sum)
      ))
      ELSE '{}'::JSONB
    END,
    '{}'::JSONB
  )
  INTO v_category_totals;
  
  -- Get last transaction timestamp (currency-filtered)
  SELECT MAX(wt.date)
  INTO v_last_txn_at
  FROM wallet_transactions wt
  JOIN wallets w ON w.id = wt.wallet_id
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end
    AND w.currency_code = p_currency_code;
  
  -- Return computed values
  RETURN QUERY SELECT 
    v_expense_cents,
    v_income_cents,
    v_txn_count,
    v_daily_totals,
    v_daily_expense_totals,
    v_category_totals,
    v_last_txn_at;
END;
$$;

COMMENT ON FUNCTION compute_monthly_aggregate(UUID, TEXT, TEXT) IS 
  'Compute monthly spending aggregate from wallet_transactions for a specific currency. Filters by wallet currency_code. Handles NULL categories safely. Uses category_id for stability.';

-- Drop old 2-arg version to avoid ambiguity
DROP FUNCTION IF EXISTS compute_monthly_aggregate(UUID, TEXT);



-- ============================================================================
-- 2. UPDATE UPSERT_MONTHLY_AGGREGATE WITH ADVISORY LOCK
-- ============================================================================

CREATE OR REPLACE FUNCTION upsert_monthly_aggregate(
  p_user_id UUID,
  p_month_key TEXT,
  p_currency_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_aggregate RECORD;
  v_start_time TIMESTAMPTZ;
  v_duration_ms INTEGER;
  v_lock_key BIGINT;
  v_lock_acquired BOOLEAN;
BEGIN
  -- Generate advisory lock key from user_id + month_key + currency_code
  -- Use hash to convert to int64
  v_lock_key := ('x' || substring(md5(p_user_id::TEXT || p_month_key || p_currency_code), 1, 15))::bit(64)::BIGINT;
  
  -- Try to acquire advisory lock (transaction-scoped)
  SELECT pg_try_advisory_xact_lock(v_lock_key) INTO v_lock_acquired;
  
  IF NOT v_lock_acquired THEN
    -- Another process is computing this aggregate, wait for it
    PERFORM pg_advisory_xact_lock(v_lock_key);
    
    -- Check if aggregate was computed while waiting
    IF EXISTS (
      SELECT 1 FROM user_monthly_spending_aggregates
      WHERE user_id = p_user_id 
        AND month_key = p_month_key
        AND currency_code = p_currency_code
    ) THEN
      -- Already computed by another process, skip
      RAISE NOTICE 'Aggregate already computed by another process: user=%, month=%, currency=%', 
        p_user_id, p_month_key, p_currency_code;
      RETURN;
    END IF;
  END IF;
  
  -- Lock acquired, proceed with computation
  v_start_time := clock_timestamp();
  
  -- Compute aggregate
  SELECT * INTO v_aggregate
  FROM compute_monthly_aggregate(p_user_id, p_month_key, p_currency_code);
  
  -- Upsert into aggregates table
  INSERT INTO user_monthly_spending_aggregates (
    user_id,
    month_key,
    currency_code,
    total_expense_cents,
    total_income_cents,
    transaction_count,
    daily_totals,
    daily_expense_totals,
    category_totals,
    last_transaction_at,
    computed_at
  ) VALUES (
    p_user_id,
    p_month_key,
    p_currency_code,
    v_aggregate.total_expense_cents,
    v_aggregate.total_income_cents,
    v_aggregate.transaction_count,
    v_aggregate.daily_totals,
    v_aggregate.daily_expense_totals,
    v_aggregate.category_totals,
    v_aggregate.last_transaction_at,
    NOW()
  )
  ON CONFLICT (user_id, month_key, currency_code) 
  DO UPDATE SET
    total_expense_cents = EXCLUDED.total_expense_cents,
    total_income_cents = EXCLUDED.total_income_cents,
    transaction_count = EXCLUDED.transaction_count,
    daily_totals = EXCLUDED.daily_totals,
    daily_expense_totals = EXCLUDED.daily_expense_totals,
    category_totals = EXCLUDED.category_totals,
    last_transaction_at = EXCLUDED.last_transaction_at,
    computed_at = NOW();
  
  -- Calculate duration
  v_duration_ms := EXTRACT(MILLISECONDS FROM clock_timestamp() - v_start_time)::INTEGER;
  
  -- Log to audit
  INSERT INTO aggregation_audit_log (user_id, month_key, operation, triggered_by, duration_ms, metadata)
  VALUES (
    p_user_id,
    p_month_key,
    'compute',
    'manual',
    v_duration_ms,
    jsonb_build_object(
      'currency_code', p_currency_code,
      'expense_cents', v_aggregate.total_expense_cents,
      'income_cents', v_aggregate.total_income_cents,
      'txn_count', v_aggregate.transaction_count
    )
  );
  
  -- Advisory lock is automatically released at transaction end
END;
$$;

COMMENT ON FUNCTION upsert_monthly_aggregate(UUID, TEXT, TEXT) IS 
  'Compute and upsert monthly aggregate for a specific currency. Uses advisory lock to prevent thundering herd. Idempotent: safe to call multiple times.';

-- Drop old 2-arg version to avoid ambiguity
DROP FUNCTION IF EXISTS upsert_monthly_aggregate(UUID, TEXT);

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'Migration 046 complete: Updated compute functions';
  RAISE NOTICE '  - compute_monthly_aggregate now accepts currency_code parameter';
  RAISE NOTICE '  - Filters transactions by wallet currency';
  RAISE NOTICE '  - Handles NULL categories safely with COALESCE';
  RAISE NOTICE '  - Uses category_id for stable insights';
  RAISE NOTICE '  - Computes daily_expense_totals separately';
  RAISE NOTICE '  - upsert_monthly_aggregate uses advisory lock for thundering herd protection';
END $$;

