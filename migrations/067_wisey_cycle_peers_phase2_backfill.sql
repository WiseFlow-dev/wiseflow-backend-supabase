-- 067_wisey_cycle_peers_phase2_backfill.sql
-- Phase 2 for cycle-based, income-only peers:
-- - Backfill last 6 completed cycles per active user
-- - Use historical FX (never today's FX) for USD normalization
-- - Compute midpoint bucket month
-- - Skip short cycles (< 20 days)
-- - Keep Phase 3 gated via explicit backfill status

BEGIN;

-- ---------------------------------------------------------------------------
-- Phase 3 gate: do not switch RPCs until this is marked complete.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wisey_cycle_peers_backfill_status (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  is_complete BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  rows_upserted INTEGER NOT NULL DEFAULT 0,
  users_processed INTEGER NOT NULL DEFAULT 0,
  skipped_short_cycles INTEGER NOT NULL DEFAULT 0,
  skipped_missing_fx_rows INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

INSERT INTO public.wisey_cycle_peers_backfill_status (id, is_complete, note)
VALUES (1, false, 'Phase 2 backfill not started')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.wisey_cycle_peers_backfill_status ENABLE ROW LEVEL SECURITY;

-- No authenticated policy on purpose. Service role only.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.wisey_cycle_anchor_for_month(
  p_reference_date DATE,
  p_cycle_start_day INTEGER
)
RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_year INTEGER;
  v_month INTEGER;
  v_last_day INTEGER;
  v_safe_day INTEGER;
BEGIN
  v_year := EXTRACT(YEAR FROM p_reference_date)::INTEGER;
  v_month := EXTRACT(MONTH FROM p_reference_date)::INTEGER;
  v_last_day := EXTRACT(DAY FROM (DATE_TRUNC('month', p_reference_date) + INTERVAL '1 month - 1 day'))::INTEGER;
  v_safe_day := LEAST(v_last_day, GREATEST(1, COALESCE(p_cycle_start_day, 1)));
  RETURN MAKE_DATE(v_year, v_month, v_safe_day);
END;
$$;

CREATE OR REPLACE FUNCTION public.wisey_current_cycle_start(
  p_today DATE,
  p_cycle_start_day INTEGER
)
RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_this_month_anchor DATE;
  v_prev_month DATE;
BEGIN
  v_this_month_anchor := public.wisey_cycle_anchor_for_month(p_today, p_cycle_start_day);
  IF p_today >= v_this_month_anchor THEN
    RETURN v_this_month_anchor;
  END IF;

  v_prev_month := (DATE_TRUNC('month', p_today)::DATE - INTERVAL '1 day')::DATE;
  RETURN public.wisey_cycle_anchor_for_month(v_prev_month, p_cycle_start_day);
END;
$$;

CREATE OR REPLACE FUNCTION public.wisey_previous_cycle_start(
  p_cycle_start DATE,
  p_cycle_start_day INTEGER
)
RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_prev_month_ref DATE;
BEGIN
  v_prev_month_ref := (DATE_TRUNC('month', p_cycle_start)::DATE - INTERVAL '1 day')::DATE;
  RETURN public.wisey_cycle_anchor_for_month(v_prev_month_ref, p_cycle_start_day);
END;
$$;

CREATE OR REPLACE FUNCTION public.wisey_historical_fx_rate_to_usd(
  p_base_currency TEXT,
  p_effective_date DATE
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base TEXT;
  v_direct NUMERIC;
  v_inverse NUMERIC;
BEGIN
  v_base := UPPER(COALESCE(TRIM(p_base_currency), ''));

  IF v_base = '' THEN
    RETURN NULL;
  END IF;
  IF v_base = 'USD' THEN
    RETURN 1;
  END IF;

  SELECT frc.rate
  INTO v_direct
  FROM public.fx_rate_cache frc
  WHERE frc.base = v_base
    AND frc.quote = 'USD'
    AND frc.requested_date <= p_effective_date
  ORDER BY frc.requested_date DESC
  LIMIT 1;

  IF v_direct IS NOT NULL AND v_direct > 0 THEN
    RETURN v_direct;
  END IF;

  SELECT frc.rate
  INTO v_inverse
  FROM public.fx_rate_cache frc
  WHERE frc.base = 'USD'
    AND frc.quote = v_base
    AND frc.requested_date <= p_effective_date
  ORDER BY frc.requested_date DESC
  LIMIT 1;

  IF v_inverse IS NOT NULL AND v_inverse > 0 THEN
    RETURN 1 / v_inverse;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.wisey_historical_fx_rate_to_usd(TEXT, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wisey_historical_fx_rate_to_usd(TEXT, DATE) TO service_role;

CREATE OR REPLACE FUNCTION public.wisey_amount_to_usd(
  p_amount NUMERIC,
  p_currency TEXT,
  p_effective_date DATE
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rate NUMERIC;
BEGIN
  IF p_amount IS NULL THEN
    RETURN NULL;
  END IF;

  v_rate := public.wisey_historical_fx_rate_to_usd(p_currency, p_effective_date);
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN NULL;
  END IF;

  RETURN p_amount * v_rate;
END;
$$;

REVOKE ALL ON FUNCTION public.wisey_amount_to_usd(NUMERIC, TEXT, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wisey_amount_to_usd(NUMERIC, TEXT, DATE) TO service_role;

CREATE OR REPLACE FUNCTION public.wisey_txn_amount_to_usd(
  p_amount NUMERIC,
  p_reporting_amount NUMERIC,
  p_reporting_currency TEXT,
  p_wallet_currency TEXT,
  p_effective_date DATE
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_reporting_amount IS NOT NULL AND p_reporting_currency IS NOT NULL THEN
    RETURN public.wisey_amount_to_usd(p_reporting_amount, p_reporting_currency, p_effective_date);
  END IF;

  RETURN public.wisey_amount_to_usd(p_amount, p_wallet_currency, p_effective_date);
END;
$$;

REVOKE ALL ON FUNCTION public.wisey_txn_amount_to_usd(NUMERIC, NUMERIC, TEXT, TEXT, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wisey_txn_amount_to_usd(NUMERIC, NUMERIC, TEXT, TEXT, DATE) TO service_role;

-- ---------------------------------------------------------------------------
-- Main backfill runner (idempotent upsert)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.backfill_wisey_cycle_scores(
  p_max_cycles_per_user INTEGER DEFAULT 6
)
RETURNS TABLE (
  users_processed INTEGER,
  rows_upserted INTEGER,
  skipped_short_cycles INTEGER,
  skipped_missing_fx_rows INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_users_processed INTEGER := 0;
  v_rows_upserted INTEGER := 0;
  v_skipped_short_cycles INTEGER := 0;
  v_skipped_missing_fx_rows INTEGER := 0;
BEGIN
  UPDATE public.wisey_cycle_peers_backfill_status
  SET
    is_complete = false,
    started_at = now(),
    completed_at = NULL,
    rows_upserted = 0,
    users_processed = 0,
    skipped_short_cycles = 0,
    skipped_missing_fx_rows = 0,
    note = 'Phase 2 backfill in progress'
  WHERE id = 1;

  WITH RECURSIVE active_users AS (
    SELECT
      wt.user_id,
      GREATEST(1, LEAST(31, COALESCE(up.cycle_start_day, 1)))::INTEGER AS cycle_start_day,
      MIN((wt.date AT TIME ZONE 'UTC')::DATE) AS first_txn_date
    FROM public.wallet_transactions wt
    LEFT JOIN public.user_preferences up
      ON up.user_id = wt.user_id
    LEFT JOIN public.internal_test_users itu
      ON itu.user_id = wt.user_id
    WHERE itu.user_id IS NULL
    GROUP BY wt.user_id, GREATEST(1, LEAST(31, COALESCE(up.cycle_start_day, 1)))::INTEGER
  ),
  cycle_seed AS (
    SELECT
      au.user_id,
      au.cycle_start_day,
      au.first_txn_date,
      public.wisey_current_cycle_start(CURRENT_DATE, au.cycle_start_day) AS current_cycle_start
    FROM active_users au
  ),
  generated_cycles AS (
    SELECT
      cs.user_id,
      cs.cycle_start_day,
      cs.first_txn_date,
      public.wisey_previous_cycle_start(cs.current_cycle_start, cs.cycle_start_day) AS cycle_start_date,
      (cs.current_cycle_start - INTERVAL '1 day')::DATE AS cycle_end_date
    FROM cycle_seed cs

    UNION ALL

    SELECT
      gc.user_id,
      gc.cycle_start_day,
      gc.first_txn_date,
      public.wisey_previous_cycle_start(gc.cycle_start_date, gc.cycle_start_day) AS cycle_start_date,
      (gc.cycle_start_date - INTERVAL '1 day')::DATE AS cycle_end_date
    FROM generated_cycles gc
    WHERE gc.cycle_start_date > (gc.first_txn_date - INTERVAL '40 day')::DATE
  ),
  all_cycles AS (
    SELECT
      gc.user_id,
      gc.cycle_start_day,
      gc.cycle_start_date,
      gc.cycle_end_date,
      (gc.cycle_end_date - gc.cycle_start_date + 1)::INTEGER AS cycle_days
    FROM generated_cycles gc
    WHERE gc.cycle_end_date >= gc.cycle_start_date
  ),
  valid_cycles AS (
    SELECT
      ac.*,
      DATE_TRUNC('month', (ac.cycle_start_date + ((ac.cycle_end_date - ac.cycle_start_date) / 2))::TIMESTAMP)::DATE AS bucket_month,
      ROW_NUMBER() OVER (PARTITION BY ac.user_id ORDER BY ac.cycle_end_date DESC) AS cycle_rank_desc,
      ROW_NUMBER() OVER (PARTITION BY ac.user_id ORDER BY ac.cycle_end_date ASC) AS cycle_rank_asc
    FROM all_cycles ac
    WHERE ac.cycle_days >= 20
  ),
  cycle_txns AS (
    SELECT
      vc.user_id,
      vc.cycle_start_date,
      vc.cycle_end_date,
      vc.cycle_rank_desc,
      vc.cycle_rank_asc,
      vc.bucket_month,
      wt.id AS txn_id,
      wt.amount,
      LOWER(COALESCE(wt.category, '')) AS category_key,
      (wt.date AT TIME ZONE 'UTC')::DATE AS txn_date,
      w.type AS wallet_type,
      c.expense_tier,
      public.wisey_txn_amount_to_usd(
        wt.amount,
        wt.reporting_amount,
        UPPER(wt.reporting_currency),
        UPPER(w.currency_code),
        (wt.date AT TIME ZONE 'UTC')::DATE
      ) AS amount_usd
    FROM valid_cycles vc
    LEFT JOIN public.wallet_transactions wt
      ON wt.user_id = vc.user_id
     AND (wt.date AT TIME ZONE 'UTC')::DATE >= vc.cycle_start_date
     AND (wt.date AT TIME ZONE 'UTC')::DATE <= vc.cycle_end_date
    LEFT JOIN public.wallets w
      ON w.id = wt.wallet_id
    LEFT JOIN public.categories c
      ON c.id = wt.category_id
  ),
  cycle_metrics AS (
    SELECT
      ct.user_id,
      ct.cycle_start_date,
      ct.cycle_end_date,
      ct.cycle_rank_desc,
      ct.cycle_rank_asc,
      ct.bucket_month,
      COUNT(*) FILTER (WHERE ct.txn_id IS NOT NULL) AS txn_count,
      COUNT(*) FILTER (WHERE ct.txn_id IS NOT NULL AND ct.amount_usd IS NULL) AS missing_fx_rows,
      COALESCE(SUM(CASE WHEN ct.amount > 0 AND ct.amount_usd IS NOT NULL THEN ct.amount_usd ELSE 0 END), 0) AS income_total_normalized,
      COALESCE(SUM(CASE WHEN ct.amount < 0
                         AND ct.amount_usd IS NOT NULL
                         AND ct.category_key NOT IN ('transfer', 'balance-adjustment')
                        THEN ABS(ct.amount_usd) ELSE 0 END), 0) AS spending_total_normalized,
      COALESCE(SUM(CASE WHEN ct.amount < 0
                         AND ct.amount_usd IS NOT NULL
                         AND ct.category_key NOT IN ('transfer', 'balance-adjustment')
                         AND EXTRACT(ISODOW FROM ct.txn_date) IN (6, 7)
                        THEN ABS(ct.amount_usd) ELSE 0 END), 0) AS weekend_spending_normalized,
      COALESCE(SUM(CASE WHEN ct.wallet_type = 'savings'
                         AND ct.amount_usd IS NOT NULL
                        THEN ct.amount_usd ELSE 0 END), 0) AS net_savings_wallet_normalized,
      COALESCE(SUM(CASE WHEN ct.amount < 0
                         AND ct.amount_usd IS NOT NULL
                         AND ct.category_key NOT IN ('transfer', 'balance-adjustment')
                         AND ct.expense_tier IN ('essential', 'flexible_essential')
                        THEN ABS(ct.amount_usd) ELSE 0 END), 0) AS essential_spending_normalized,
      COALESCE(SUM(CASE WHEN ct.amount < 0
                         AND ct.amount_usd IS NOT NULL
                         AND ct.category_key NOT IN ('transfer', 'balance-adjustment')
                         AND ct.expense_tier = 'discretionary'
                        THEN ABS(ct.amount_usd) ELSE 0 END), 0) AS discretionary_spending_normalized
    FROM cycle_txns ct
    GROUP BY
      ct.user_id,
      ct.cycle_start_date,
      ct.cycle_end_date,
      ct.cycle_rank_desc,
      ct.cycle_rank_asc,
      ct.bucket_month
  ),
  cycle_metrics_scored AS (
    SELECT
      cm.*,
      ums.total_wisey_score
    FROM cycle_metrics cm
    LEFT JOIN public.user_monthly_scores ums
      ON ums.user_id = cm.user_id
     AND ums.month = TO_CHAR(cm.cycle_end_date, 'YYYY-MM')
  ),
  cycle_with_anchors AS (
    SELECT
      cms.*,
      CASE
        WHEN cms.income_total_normalized > 0 THEN cms.income_total_normalized
        ELSE 0
      END AS income_for_anchor,
      AVG(
        CASE
          WHEN cms.income_total_normalized > 0 THEN cms.income_total_normalized
          ELSE 0
        END
      ) OVER (
        PARTITION BY cms.user_id
        ORDER BY cms.cycle_end_date ASC
        ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
      ) AS rolling_income_3
    FROM cycle_metrics_scored cms
  ),
  to_upsert AS (
    SELECT
      cwa.user_id,
      cwa.cycle_start_date,
      cwa.cycle_end_date,
      cwa.bucket_month,
      CASE
        WHEN cwa.income_total_normalized > 0
          THEN cwa.net_savings_wallet_normalized / cwa.income_total_normalized
        ELSE NULL
      END AS savings_rate_v2,
      CASE
        WHEN cwa.income_total_normalized > 0
          THEN cwa.spending_total_normalized / cwa.income_total_normalized
        ELSE NULL
      END AS spending_ratio,
      CASE
        WHEN cwa.spending_total_normalized > 0
          THEN cwa.weekend_spending_normalized / cwa.spending_total_normalized
        ELSE NULL
      END AS weekend_ratio,
      cwa.total_wisey_score,
      CASE
        WHEN cwa.spending_total_normalized > 0
          THEN cwa.essential_spending_normalized / cwa.spending_total_normalized
        ELSE NULL
      END AS essentials_ratio,
      CASE
        WHEN cwa.spending_total_normalized > 0
          THEN cwa.discretionary_spending_normalized / cwa.spending_total_normalized
        ELSE NULL
      END AS discretionary_ratio,
      CASE
        WHEN cwa.income_total_normalized > 0
          THEN GREATEST(cwa.income_total_normalized - cwa.spending_total_normalized, 0) / cwa.income_total_normalized
        ELSE NULL
      END AS savings_ratio,
      cwa.income_total_normalized,
      CASE
        WHEN cwa.cycle_rank_asc <= 3 THEN cwa.income_for_anchor
        ELSE cwa.rolling_income_3
      END AS income_anchor_normalized,
      CASE
        WHEN cwa.cycle_rank_asc <= 3 THEN 1
        ELSE 3
      END AS anchor_window_size,
      'USD'::TEXT AS reference_currency_code,
      cwa.missing_fx_rows,
      cwa.cycle_rank_desc,
      cwa.txn_count
    FROM cycle_with_anchors cwa
    WHERE cwa.cycle_rank_desc <= GREATEST(1, p_max_cycles_per_user)
      AND cwa.txn_count > 0
      AND (cwa.txn_count - cwa.missing_fx_rows) > 0
  ),
  upserted AS (
    INSERT INTO public.user_cycle_scores (
      user_id,
      cycle_start_date,
      cycle_end_date,
      bucket_month,
      savings_rate_v2,
      spending_ratio,
      weekend_ratio,
      total_wisey_score,
      essentials_ratio,
      discretionary_ratio,
      savings_ratio,
      income_total_normalized,
      income_anchor_normalized,
      anchor_window_size,
      reference_currency_code,
      created_at,
      updated_at
    )
    SELECT
      tu.user_id,
      tu.cycle_start_date,
      tu.cycle_end_date,
      tu.bucket_month,
      tu.savings_rate_v2,
      tu.spending_ratio,
      tu.weekend_ratio,
      tu.total_wisey_score,
      tu.essentials_ratio,
      tu.discretionary_ratio,
      tu.savings_ratio,
      tu.income_total_normalized,
      tu.income_anchor_normalized,
      tu.anchor_window_size,
      tu.reference_currency_code,
      now(),
      now()
    FROM to_upsert tu
    ON CONFLICT (user_id, cycle_start_date, cycle_end_date) DO UPDATE
    SET
      bucket_month = EXCLUDED.bucket_month,
      savings_rate_v2 = EXCLUDED.savings_rate_v2,
      spending_ratio = EXCLUDED.spending_ratio,
      weekend_ratio = EXCLUDED.weekend_ratio,
      total_wisey_score = EXCLUDED.total_wisey_score,
      essentials_ratio = EXCLUDED.essentials_ratio,
      discretionary_ratio = EXCLUDED.discretionary_ratio,
      savings_ratio = EXCLUDED.savings_ratio,
      income_total_normalized = EXCLUDED.income_total_normalized,
      income_anchor_normalized = EXCLUDED.income_anchor_normalized,
      anchor_window_size = EXCLUDED.anchor_window_size,
      reference_currency_code = EXCLUDED.reference_currency_code,
      updated_at = now()
    RETURNING user_id
  )
  SELECT
    (SELECT COUNT(*)::INTEGER FROM active_users),
    (SELECT COUNT(*)::INTEGER FROM upserted),
    (SELECT COUNT(*)::INTEGER FROM all_cycles WHERE cycle_days < 20),
    (SELECT COALESCE(SUM(missing_fx_rows), 0)::INTEGER FROM to_upsert)
  INTO
    v_users_processed,
    v_rows_upserted,
    v_skipped_short_cycles,
    v_skipped_missing_fx_rows;

  UPDATE public.wisey_cycle_peers_backfill_status
  SET
    is_complete = true,
    completed_at = now(),
    rows_upserted = v_rows_upserted,
    users_processed = v_users_processed,
    skipped_short_cycles = v_skipped_short_cycles,
    skipped_missing_fx_rows = v_skipped_missing_fx_rows,
    note = 'Phase 2 backfill complete'
  WHERE id = 1;

  RETURN QUERY
  SELECT
    v_users_processed,
    v_rows_upserted,
    v_skipped_short_cycles,
    v_skipped_missing_fx_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_wisey_cycle_scores(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.backfill_wisey_cycle_scores(INTEGER) TO service_role;

-- ---------------------------------------------------------------------------
-- Parity check helper for cycles aligned to calendar months.
-- This does not block deploy; it gives a deterministic validation surface.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_cycle_monthly_score_parity(
  p_tolerance NUMERIC DEFAULT 0.0001
)
RETURNS TABLE (
  user_id UUID,
  month TEXT,
  cycle_start_date DATE,
  cycle_end_date DATE,
  savings_rate_v2_delta NUMERIC,
  spending_ratio_delta NUMERIC,
  weekend_ratio_delta NUMERIC,
  total_wisey_score_delta NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ucs.user_id,
    TO_CHAR(ucs.cycle_start_date, 'YYYY-MM') AS month,
    ucs.cycle_start_date,
    ucs.cycle_end_date,
    ABS(COALESCE(ucs.savings_rate_v2, 0) - COALESCE(ums.savings_rate_v2, 0)) AS savings_rate_v2_delta,
    ABS(COALESCE(ucs.spending_ratio, 0) - COALESCE(ums.spending_ratio, 0)) AS spending_ratio_delta,
    ABS(COALESCE(ucs.weekend_ratio, 0) - COALESCE(ums.weekend_ratio, 0)) AS weekend_ratio_delta,
    ABS(COALESCE(ucs.total_wisey_score, 0) - COALESCE(ums.total_wisey_score, 0)) AS total_wisey_score_delta
  FROM public.user_cycle_scores ucs
  JOIN public.user_monthly_scores ums
    ON ums.user_id = ucs.user_id
   AND ums.month = TO_CHAR(ucs.cycle_start_date, 'YYYY-MM')
  WHERE ucs.cycle_start_date = DATE_TRUNC('month', ucs.cycle_start_date)::DATE
    AND ucs.cycle_end_date = (DATE_TRUNC('month', ucs.cycle_start_date) + INTERVAL '1 month - 1 day')::DATE
    AND (
      ABS(COALESCE(ucs.savings_rate_v2, 0) - COALESCE(ums.savings_rate_v2, 0)) > p_tolerance
      OR ABS(COALESCE(ucs.spending_ratio, 0) - COALESCE(ums.spending_ratio, 0)) > p_tolerance
      OR ABS(COALESCE(ucs.weekend_ratio, 0) - COALESCE(ums.weekend_ratio, 0)) > p_tolerance
      OR ABS(COALESCE(ucs.total_wisey_score, 0) - COALESCE(ums.total_wisey_score, 0)) > 0.1
    );
$$;

REVOKE ALL ON FUNCTION public.validate_cycle_monthly_score_parity(NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_cycle_monthly_score_parity(NUMERIC) TO service_role;

-- Run Phase 2 backfill now (idempotent). Keep Phase 3 gated by status table.
SELECT * FROM public.backfill_wisey_cycle_scores(6);

COMMIT;
