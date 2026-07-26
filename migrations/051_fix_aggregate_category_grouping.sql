-- ============================================================================
-- Fix Aggregate Category Grouping - Migration 051
-- ============================================================================
-- Improves compute_monthly_aggregate to:
--   1. Preserve category names as IDs if UUID is missing (prevents clumping into 'uncategorized')
--   2. Normalizes category names into slugs for stable matching (lowercase, alphanumeric, underscores)
--   3. Ensures category names are correctly propagated even when UUID is present
--   4. Prevents valid categories from being filtered out by the engine due to 'uncategorized' key
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
  
  -- Compute expense total
  SELECT COALESCE(SUM(ROUND(ABS(wt.amount) * 100)), 0)::BIGINT
  INTO v_expense_cents
  FROM wallet_transactions wt
  JOIN wallets w ON w.id = wt.wallet_id
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end
    AND wt.amount < 0
    AND w.currency_code = p_currency_code;
  
  -- Compute income total
  SELECT COALESCE(SUM(ROUND(wt.amount * 100)), 0)::BIGINT
  INTO v_income_cents
  FROM wallet_transactions wt
  JOIN wallets w ON w.id = wt.wallet_id
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end
    AND wt.amount >= 0
    AND w.currency_code = p_currency_code;
  
  -- Count transactions
  SELECT COUNT(*)::INTEGER
  INTO v_txn_count
  FROM wallet_transactions wt
  JOIN wallets w ON w.id = wt.wallet_id
  WHERE wt.user_id = p_user_id
    AND wt.date >= v_month_start
    AND wt.date <= v_month_end
    AND w.currency_code = p_currency_code;
  
  -- Daily Net Totals
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
  
  -- Daily Expense Totals
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
  
  -- Category Breakdown (The Fix)
  WITH category_base AS (
    SELECT
      COALESCE(
        wt.category_id::TEXT,
        NULLIF(
          trim(both '_' from regexp_replace(
            regexp_replace(lower(trim(wt.category)), '[^a-z0-9]+', '_', 'g'),
            '_+',
            '_',
            'g'
          )),
          ''
        ),
        'uncategorized'
      ) as category_id,
      COALESCE(wt.category, 'Uncategorized') as category_name,
      ROUND(ABS(wt.amount) * 100)::BIGINT as txn_cents
    FROM wallet_transactions wt
    JOIN wallets w ON w.id = wt.wallet_id
    WHERE wt.user_id = p_user_id
      AND wt.date >= v_month_start
      AND wt.date <= v_month_end
      AND wt.amount < 0
      AND w.currency_code = p_currency_code
  ),
  category_agg AS (
    SELECT
      category_id,
      MIN(category_name) as category_name,
      SUM(txn_cents)::BIGINT as category_cents
    FROM category_base
    GROUP BY category_id
  ),
  ranked_categories AS (
    SELECT
      category_id,
      category_name,
      category_cents,
      ROW_NUMBER() OVER (
        ORDER BY category_cents DESC,
        category_name ASC
      ) as rank
    FROM category_agg
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
  
  -- Last transaction date
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
  'Compute monthly spending aggregate. Fix: Uses normalized category name as ID if UUID missing to prevent clumping.';
