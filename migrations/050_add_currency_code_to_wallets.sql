-- ============================================================================
-- Add currency_code column to wallets - Migration 050
-- ============================================================================
-- Proper fix: Add currency_code column and restore currency filtering
-- Replaces hotfix from migration 049
-- ============================================================================

-- ============================================================================
-- 1. ADD CURRENCY_CODE COLUMN TO WALLETS
-- ============================================================================

ALTER TABLE wallets ADD COLUMN IF NOT EXISTS currency_code TEXT;

-- ============================================================================
-- 2. BACKFILL CURRENCY_CODE FROM CURRENCY_SYMBOL
-- ============================================================================

UPDATE wallets
SET currency_code = CASE currency_symbol
  WHEN '₺' THEN 'TRY'
  WHEN '$' THEN 'USD'  -- Default for ambiguous $ symbol
  WHEN '€' THEN 'EUR'
  WHEN '£' THEN 'GBP'
  WHEN '¥' THEN 'JPY'
  WHEN '₹' THEN 'INR'
  WHEN 'R$' THEN 'BRL'
  WHEN 'C$' THEN 'CAD'
  WHEN 'A$' THEN 'AUD'
  WHEN 'CHF' THEN 'CHF'
  WHEN '₽' THEN 'RUB'
  WHEN '元' THEN 'CNY'
  ELSE 'TRY'  -- Default to TRY for unknown symbols
END
WHERE currency_code IS NULL;

-- ============================================================================
-- 3. ADD CONSTRAINTS AND INDEXES
-- ============================================================================

-- Make currency_code required after backfill
ALTER TABLE wallets ALTER COLUMN currency_code SET NOT NULL;
ALTER TABLE wallets ALTER COLUMN currency_code SET DEFAULT 'TRY';

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS wallets_user_currency_idx ON wallets(user_id, currency_code);
CREATE INDEX IF NOT EXISTS wallets_currency_code_idx ON wallets(currency_code);

-- ============================================================================
-- 4. RESTORE CURRENCY FILTERING IN COMPUTE_MONTHLY_AGGREGATE
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
  v_month_start := (p_month_key || '-01')::DATE AT TIME ZONE 'UTC';
  v_month_end := (v_month_start + INTERVAL '1 month' - INTERVAL '1 second');
  
  -- Compute expense total - RESTORED currency filter
  SELECT COALESCE(SUM(ROUND(ABS(wt.amount) * 100)), 0)::BIGINT
  INTO v_expense_cents
  FROM wallet_transactions wt
  JOIN wallets w ON w.id = wt.wallet_id
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end
    AND wt.amount < 0
    AND w.currency_code = p_currency_code;
  
  -- Compute income total - RESTORED currency filter
  SELECT COALESCE(SUM(ROUND(wt.amount * 100)), 0)::BIGINT
  INTO v_income_cents
  FROM wallet_transactions wt
  JOIN wallets w ON w.id = wt.wallet_id
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end
    AND wt.amount >= 0
    AND w.currency_code = p_currency_code;
  
  -- Count transactions - RESTORED currency filter
  SELECT COUNT(*)::INTEGER
  INTO v_txn_count
  FROM wallet_transactions wt
  JOIN wallets w ON w.id = wt.wallet_id
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end
    AND w.currency_code = p_currency_code;
  
  -- Build daily_totals - RESTORED currency filter
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
  
  -- Build daily_expense_totals - RESTORED currency filter
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
      AND wt.amount < 0
      AND w.currency_code = p_currency_code
    GROUP BY wt.date::DATE
    ORDER BY wt.date::DATE
  ) daily_expense_agg;
  
  -- Build category_totals - RESTORED currency filter
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
      AND wt.amount < 0
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
  
  -- Get last transaction timestamp - RESTORED currency filter
  SELECT MAX(wt.date)
  INTO v_last_txn_at
  FROM wallet_transactions wt
  JOIN wallets w ON w.id = wt.wallet_id
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end
    AND w.currency_code = p_currency_code;
  
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
  'Compute monthly spending aggregate from wallet_transactions for a specific currency. Uses wallets.currency_code for proper filtering.';


-- ============================================================================
-- 5. RESTORE CURRENCY FILTERING IN IS_AGGREGATE_CACHE_FRESH
-- ============================================================================

CREATE OR REPLACE FUNCTION is_aggregate_cache_fresh(
  p_user_id UUID,
  p_month_key TEXT,
  p_currency_code TEXT
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
  v_month_start := (p_month_key || '-01')::DATE AT TIME ZONE 'UTC';
  v_month_end := (v_month_start + INTERVAL '1 month' - INTERVAL '1 second');
  
  SELECT computed_at
  INTO v_aggregate_computed_at
  FROM user_monthly_spending_aggregates
  WHERE user_id = p_user_id
    AND month_key = p_month_key
    AND currency_code = p_currency_code;
  
  IF v_aggregate_computed_at IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Get most recent transaction timestamp - RESTORED currency filter
  SELECT MAX(wt.date)
  INTO v_last_transaction_at
  FROM wallet_transactions wt
  JOIN wallets w ON w.id = wt.wallet_id
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end
    AND w.currency_code = p_currency_code;
  
  RETURN (v_last_transaction_at IS NULL) OR (v_aggregate_computed_at >= v_last_transaction_at);
END;
$$;

COMMENT ON FUNCTION is_aggregate_cache_fresh(UUID, TEXT, TEXT) IS 
  'Check if aggregate cache is fresh for a specific currency. Uses wallets.currency_code for proper filtering.';


-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'Migration 050 complete: Added currency_code column and restored proper filtering';
  RAISE NOTICE '  - Added wallets.currency_code column (NOT NULL)';
  RAISE NOTICE '  - Backfilled from currency_symbol';
  RAISE NOTICE '  - Added indexes: wallets_user_currency_idx, wallets_currency_code_idx';
  RAISE NOTICE '  - Restored currency filtering in compute_monthly_aggregate';
  RAISE NOTICE '  - Restored currency filtering in is_aggregate_cache_fresh';
  RAISE NOTICE '  - Multi-currency aggregates now work correctly';
  RAISE NOTICE '';
  RAISE NOTICE 'IMPORTANT: Recompute current month aggregates:';
  RAISE NOTICE '  SELECT upsert_monthly_aggregate(user_id, month_key, currency_code)';
  RAISE NOTICE '  FROM user_monthly_spending_aggregates';
  RAISE NOTICE '  WHERE month_key = to_char(CURRENT_DATE, ''YYYY-MM'');';
END $$;
