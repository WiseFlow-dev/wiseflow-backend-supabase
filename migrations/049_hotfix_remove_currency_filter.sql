-- ============================================================================
-- HOTFIX: Remove currency_code filter from aggregate functions
-- ============================================================================
-- Problem: wallets table has currency_symbol, not currency_code
-- Fix: Remove w.currency_code filter to unblock Strategy B pipeline
-- Future: Migration 050 will add proper currency_code column and restore filter
-- ============================================================================

-- ============================================================================
-- 1. FIX COMPUTE_MONTHLY_AGGREGATE
-- ============================================================================

CREATE OR REPLACE FUNCTION compute_monthly_aggregate(
  p_user_id UUID,
  p_month_key TEXT,
  p_currency_code TEXT  -- Keep parameter for compatibility, but don't use in WHERE
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
  -- Log hotfix is active (one-time per compute)
  RAISE LOG 'spending_engine.agg_hotfix_no_currency_filter=true user=% month=%', 
    p_user_id, p_month_key;
  
  -- Calculate month boundaries (UTC)
  v_month_start := (p_month_key || '-01')::DATE AT TIME ZONE 'UTC';
  v_month_end := (v_month_start + INTERVAL '1 month' - INTERVAL '1 second');
  
  -- Compute expense total (negative amounts → positive cents)
  -- HOTFIX: Removed currency filter until wallets.currency_code column exists
  SELECT COALESCE(SUM(ROUND(ABS(wt.amount) * 100)), 0)::BIGINT
  INTO v_expense_cents
  FROM wallet_transactions wt
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end
    AND wt.amount < 0;
  
  -- Compute income total (positive amounts → cents)
  -- HOTFIX: Removed currency filter
  SELECT COALESCE(SUM(ROUND(wt.amount * 100)), 0)::BIGINT
  INTO v_income_cents
  FROM wallet_transactions wt
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end
    AND wt.amount >= 0;
  
  -- Count transactions
  -- HOTFIX: Removed currency filter
  SELECT COUNT(*)::INTEGER
  INTO v_txn_count
  FROM wallet_transactions wt
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end;
  
  -- Build daily_totals JSONB (net amount per day in cents)
  -- HOTFIX: Removed currency filter
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
    WHERE wt.user_id = p_user_id
      AND wt.date >= v_month_start
      AND wt.date <= v_month_end
    GROUP BY wt.date::DATE
    ORDER BY wt.date::DATE
  ) daily_agg;
  
  -- Build daily_expense_totals JSONB (expense-only, not net)
  -- HOTFIX: Removed currency filter
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
    WHERE wt.user_id = p_user_id
      AND wt.date >= v_month_start
      AND wt.date <= v_month_end
      AND wt.amount < 0  -- Expenses only
    GROUP BY wt.date::DATE
    ORDER BY wt.date::DATE
  ) daily_expense_agg;
  
  -- Build category_totals JSONB (top 99 categories + "Other")
  -- HOTFIX: Removed currency filter
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
    WHERE wt.user_id = p_user_id
      AND wt.date >= v_month_start
      AND wt.date <= v_month_end
      AND wt.amount < 0  -- Only expenses have categories
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
  
  -- Get last transaction timestamp
  -- HOTFIX: Removed currency filter
  SELECT MAX(wt.date)
  INTO v_last_txn_at
  FROM wallet_transactions wt
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end;
  
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
  'HOTFIX: Compute monthly aggregate without currency filter. Currency parameter kept for compatibility but not used until wallets.currency_code column exists.';


-- ============================================================================
-- 2. FIX IS_AGGREGATE_CACHE_FRESH
-- ============================================================================

CREATE OR REPLACE FUNCTION is_aggregate_cache_fresh(
  p_user_id UUID,
  p_month_key TEXT,
  p_currency_code TEXT  -- Keep parameter for compatibility
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_month_start TIMESTAMPTZ;
  v_month_end TIMESTAMPTZ;
  v_aggregate_computed_at TIMESTAMPTZ;
  v_last_transaction_at TIMESTAMPTZ;
BEGIN
  -- Calculate month boundaries
  v_month_start := (p_month_key || '-01')::DATE AT TIME ZONE 'UTC';
  v_month_end := (v_month_start + INTERVAL '1 month' - INTERVAL '1 second');
  
  -- Get aggregate computed_at timestamp
  -- HOTFIX: Query without currency filter for now
  SELECT computed_at
  INTO v_aggregate_computed_at
  FROM user_monthly_spending_aggregates
  WHERE user_id = p_user_id
    AND month_key = p_month_key
    AND currency_code = p_currency_code;  -- Keep this for table lookup
  
  -- If no aggregate exists, return false
  IF v_aggregate_computed_at IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Get most recent transaction timestamp in month
  -- HOTFIX: Removed currency filter
  SELECT MAX(wt.date)
  INTO v_last_transaction_at
  FROM wallet_transactions wt
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end;
  
  -- Cache is fresh if no transactions or aggregate computed after last transaction
  RETURN (v_last_transaction_at IS NULL) OR (v_aggregate_computed_at >= v_last_transaction_at);
END;
$$;

COMMENT ON FUNCTION is_aggregate_cache_fresh(UUID, TEXT, TEXT) IS 
  'HOTFIX: Check cache freshness without currency filter on transactions. Table lookup still uses currency_code.';


-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'Migration 049 (HOTFIX) complete: Removed currency filter from aggregate functions';
  RAISE NOTICE '  - compute_monthly_aggregate: removed w.currency_code filter';
  RAISE NOTICE '  - is_aggregate_cache_fresh: removed w.currency_code filter on transactions';
  RAISE NOTICE '  - Risk: Multi-currency wallets will mix amounts';
  RAISE NOTICE '  - Next: Migration 050 will add wallets.currency_code column and restore proper filtering';
END $$;
