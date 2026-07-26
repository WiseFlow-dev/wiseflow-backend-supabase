-- ============================================================================
-- Spending Insights Backend Optimization - Phase 2A: Aggregation Compute
-- ============================================================================
-- Implements the core aggregation logic to compute monthly spending summaries
-- from wallet_transactions with proper DECIMAL→cents conversion.
--
-- Key Features:
--   - Converts DECIMAL amounts to cents: ROUND(amount * 100)
--   - Separates expenses (negative) from income (positive)
--   - Builds daily_totals and category_totals JSONB
--   - Respects JSONB size limits (31 days, 100 categories)
--   - Idempotent: safe to re-run for same month
-- ============================================================================

-- ============================================================================
-- AGGREGATION COMPUTE FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION compute_monthly_aggregate(
  p_user_id UUID,
  p_month_key TEXT
)
RETURNS TABLE(
  total_expense_cents BIGINT,
  total_income_cents BIGINT,
  transaction_count INTEGER,
  daily_totals JSONB,
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
  v_category_totals JSONB;
  v_last_txn_at TIMESTAMPTZ;
BEGIN
  -- Calculate month boundaries (UTC)
  v_month_start := (p_month_key || '-01')::DATE AT TIME ZONE 'UTC';
  v_month_end := (v_month_start + INTERVAL '1 month' - INTERVAL '1 second');
  
  -- Compute expense total (negative amounts → positive cents)
  -- Formula: SUM(ROUND(ABS(amount) * 100)) WHERE amount < 0
  SELECT COALESCE(SUM(ROUND(ABS(amount) * 100)), 0)::BIGINT
  INTO v_expense_cents
  FROM wallet_transactions
  WHERE user_id = p_user_id
    AND date >= v_month_start
    AND date <= v_month_end
    AND amount < 0;
  
  -- Compute income total (positive amounts → cents)
  -- Formula: SUM(ROUND(amount * 100)) WHERE amount >= 0
  SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::BIGINT
  INTO v_income_cents
  FROM wallet_transactions
  WHERE user_id = p_user_id
    AND date >= v_month_start
    AND date <= v_month_end
    AND amount >= 0;
  
  -- Count transactions
  SELECT COUNT(*)::INTEGER
  INTO v_txn_count
  FROM wallet_transactions
  WHERE user_id = p_user_id
    AND date >= v_month_start
    AND date <= v_month_end;
  
  -- Build daily_totals JSONB (net amount per day in cents)
  -- Format: {"2025-01-15": -5000, "2025-01-16": 10000}
  -- Negative = net expense, positive = net income
  -- Note: No LIMIT here - rely on CHECK constraint to enforce max 31 keys
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
      date::DATE as date,
      SUM(ROUND(amount * 100))::BIGINT as daily_net_cents
    FROM wallet_transactions
    WHERE user_id = p_user_id
      AND date >= v_month_start
      AND date <= v_month_end
    GROUP BY date::DATE
    ORDER BY date::DATE
  ) daily_agg;
  
  -- Build category_totals JSONB (top 99 categories + "Other")
  -- Format: {"restaurants": 12000, "transport": 8500, "Other": 2500}
  -- All values in cents (absolute value for expenses)
  WITH ranked_categories AS (
    SELECT 
      category,
      SUM(ROUND(ABS(amount) * 100))::BIGINT as category_cents,
      ROW_NUMBER() OVER (ORDER BY SUM(ROUND(ABS(amount) * 100)) DESC, category ASC) as rank
    FROM wallet_transactions
    WHERE user_id = p_user_id
      AND date >= v_month_start
      AND date <= v_month_end
      AND amount < 0 -- Only expenses have categories
    GROUP BY category
  ),
  top_99 AS (
    SELECT category, category_cents
    FROM ranked_categories
    WHERE rank <= 99
  ),
  other_sum AS (
    SELECT COALESCE(SUM(category_cents), 0)::BIGINT as other_cents
    FROM ranked_categories
    WHERE rank > 99
  )
  SELECT COALESCE(
    jsonb_object_agg(category, category_cents) || 
    CASE 
      WHEN (SELECT other_cents FROM other_sum) > 0 
      THEN jsonb_build_object('Other', (SELECT other_cents FROM other_sum))
      ELSE '{}'::JSONB
    END,
    '{}'::JSONB
  )
  INTO v_category_totals
  FROM top_99;
  
  -- Get last transaction timestamp
  SELECT MAX(date)
  INTO v_last_txn_at
  FROM wallet_transactions
  WHERE user_id = p_user_id
    AND date >= v_month_start
    AND date <= v_month_end;
  
  -- Return computed values
  RETURN QUERY SELECT 
    v_expense_cents,
    v_income_cents,
    v_txn_count,
    v_daily_totals,
    v_category_totals,
    v_last_txn_at;
END;
$$;

COMMENT ON FUNCTION compute_monthly_aggregate(UUID, TEXT) IS 
  'Compute monthly spending aggregate from wallet_transactions. Converts DECIMAL amounts to cents using ROUND(amount * 100). Expenses (negative) and income (positive) separated. Returns top 99 categories + Other.';

-- ============================================================================
-- UPSERT AGGREGATE FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION upsert_monthly_aggregate(
  p_user_id UUID,
  p_month_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_aggregate RECORD;
  v_start_time TIMESTAMPTZ;
  v_duration_ms INTEGER;
BEGIN
  v_start_time := clock_timestamp();
  
  -- Compute aggregate
  SELECT * INTO v_aggregate
  FROM compute_monthly_aggregate(p_user_id, p_month_key);
  
  -- Upsert into aggregates table
  INSERT INTO user_monthly_spending_aggregates (
    user_id,
    month_key,
    total_expense_cents,
    total_income_cents,
    transaction_count,
    daily_totals,
    category_totals,
    last_transaction_at,
    computed_at
  ) VALUES (
    p_user_id,
    p_month_key,
    v_aggregate.total_expense_cents,
    v_aggregate.total_income_cents,
    v_aggregate.transaction_count,
    v_aggregate.daily_totals,
    v_aggregate.category_totals,
    v_aggregate.last_transaction_at,
    NOW()
  )
  ON CONFLICT (user_id, month_key) 
  DO UPDATE SET
    total_expense_cents = EXCLUDED.total_expense_cents,
    total_income_cents = EXCLUDED.total_income_cents,
    transaction_count = EXCLUDED.transaction_count,
    daily_totals = EXCLUDED.daily_totals,
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
      'expense_cents', v_aggregate.total_expense_cents,
      'income_cents', v_aggregate.total_income_cents,
      'txn_count', v_aggregate.transaction_count
    )
  );
END;
$$;

COMMENT ON FUNCTION upsert_monthly_aggregate(UUID, TEXT) IS 
  'Compute and upsert monthly aggregate. Idempotent: safe to call multiple times. Logs duration to audit trail.';

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Test the conversion logic
DO $$
DECLARE
  v_test_user_id UUID := '00000000-0000-0000-0000-000000000001';
  v_test_result RECORD;
BEGIN
  -- This will be used for testing after deployment
  RAISE NOTICE 'Aggregation functions created successfully';
  RAISE NOTICE 'Test with: SELECT * FROM compute_monthly_aggregate(''user-id'', ''2025-01'');';
  RAISE NOTICE 'Or upsert: SELECT upsert_monthly_aggregate(''user-id'', ''2025-01'');';
END $$;
