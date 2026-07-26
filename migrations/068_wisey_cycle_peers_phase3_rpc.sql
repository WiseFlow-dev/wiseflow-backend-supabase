-- 068_wisey_cycle_peers_phase3_rpc.sql
-- Phase 3: New cycle-income peer RPC + fix Phase 2 calculated_at oversight.
-- Does NOT touch the app/edge function cutover — that is in the edge function deploy.
-- Old RPC (get_peer_averages_by_bracket) is kept untouched for rollback safety.

BEGIN;

-- ---------------------------------------------------------------------------
-- Fix Phase 2: calculated_at was missing from the DO UPDATE clause.
-- Patch the backfill function so future re-runs stamp it correctly.
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
    LEFT JOIN public.user_preferences up ON up.user_id = wt.user_id
    LEFT JOIN public.internal_test_users itu ON itu.user_id = wt.user_id
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
      (cs.current_cycle_start - INTERVAL '1 day')::DATE AS cycle_end_date,
      1 AS depth
    FROM cycle_seed cs

    UNION ALL

    SELECT
      gc.user_id,
      gc.cycle_start_day,
      gc.first_txn_date,
      public.wisey_previous_cycle_start(gc.cycle_start_date, gc.cycle_start_day) AS cycle_start_date,
      (gc.cycle_start_date - INTERVAL '1 day')::DATE AS cycle_end_date,
      gc.depth + 1
    FROM generated_cycles gc
    WHERE gc.cycle_start_date > (gc.first_txn_date - INTERVAL '40 day')::DATE
      AND gc.depth < (p_max_cycles_per_user + 2)   -- ← Phase 2 fix: depth cap
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
      ROW_NUMBER() OVER (PARTITION BY ac.user_id ORDER BY ac.cycle_end_date ASC)  AS cycle_rank_asc
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
    LEFT JOIN public.wallets w ON w.id = wt.wallet_id
    LEFT JOIN public.categories c ON c.id = wt.category_id
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
      COALESCE(SUM(CASE WHEN ct.amount < 0 AND ct.amount_usd IS NOT NULL AND ct.category_key NOT IN ('transfer','balance-adjustment') THEN ABS(ct.amount_usd) ELSE 0 END), 0) AS spending_total_normalized,
      COALESCE(SUM(CASE WHEN ct.amount < 0 AND ct.amount_usd IS NOT NULL AND ct.category_key NOT IN ('transfer','balance-adjustment') AND EXTRACT(ISODOW FROM ct.txn_date) IN (6,7) THEN ABS(ct.amount_usd) ELSE 0 END), 0) AS weekend_spending_normalized,
      COALESCE(SUM(CASE WHEN ct.wallet_type = 'savings' AND ct.amount_usd IS NOT NULL THEN ct.amount_usd ELSE 0 END), 0) AS net_savings_wallet_normalized,
      COALESCE(SUM(CASE WHEN ct.amount < 0 AND ct.amount_usd IS NOT NULL AND ct.category_key NOT IN ('transfer','balance-adjustment') AND ct.expense_tier IN ('essential','flexible_essential') THEN ABS(ct.amount_usd) ELSE 0 END), 0) AS essential_spending_normalized,
      COALESCE(SUM(CASE WHEN ct.amount < 0 AND ct.amount_usd IS NOT NULL AND ct.category_key NOT IN ('transfer','balance-adjustment') AND ct.expense_tier = 'discretionary' THEN ABS(ct.amount_usd) ELSE 0 END), 0) AS discretionary_spending_normalized
    FROM cycle_txns ct
    GROUP BY ct.user_id, ct.cycle_start_date, ct.cycle_end_date, ct.cycle_rank_desc, ct.cycle_rank_asc, ct.bucket_month
  ),
  cycle_metrics_scored AS (
    SELECT cm.*, ums.total_wisey_score
    FROM cycle_metrics cm
    LEFT JOIN public.user_monthly_scores ums
      ON ums.user_id = cm.user_id
     AND ums.month = TO_CHAR(cm.cycle_end_date, 'YYYY-MM')
  ),
  cycle_with_anchors AS (
    SELECT
      cms.*,
      CASE WHEN cms.income_total_normalized > 0 THEN cms.income_total_normalized ELSE 0 END AS income_for_anchor,
      AVG(CASE WHEN cms.income_total_normalized > 0 THEN cms.income_total_normalized ELSE 0 END)
        OVER (PARTITION BY cms.user_id ORDER BY cms.cycle_end_date ASC ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS rolling_income_3
    FROM cycle_metrics_scored cms
  ),
  to_upsert AS (
    SELECT
      cwa.user_id,
      cwa.cycle_start_date,
      cwa.cycle_end_date,
      cwa.bucket_month,
      CASE WHEN cwa.income_total_normalized > 0 THEN cwa.net_savings_wallet_normalized / cwa.income_total_normalized ELSE NULL END AS savings_rate_v2,
      CASE WHEN cwa.income_total_normalized > 0 THEN cwa.spending_total_normalized / cwa.income_total_normalized ELSE NULL END AS spending_ratio,
      CASE WHEN cwa.spending_total_normalized > 0 THEN cwa.weekend_spending_normalized / cwa.spending_total_normalized ELSE NULL END AS weekend_ratio,
      cwa.total_wisey_score,
      CASE WHEN cwa.spending_total_normalized > 0 THEN cwa.essential_spending_normalized / cwa.spending_total_normalized ELSE NULL END AS essentials_ratio,
      CASE WHEN cwa.spending_total_normalized > 0 THEN cwa.discretionary_spending_normalized / cwa.spending_total_normalized ELSE NULL END AS discretionary_ratio,
      CASE WHEN cwa.income_total_normalized > 0 THEN GREATEST(cwa.income_total_normalized - cwa.spending_total_normalized, 0) / cwa.income_total_normalized ELSE NULL END AS savings_ratio,
      cwa.income_total_normalized,
      CASE WHEN cwa.cycle_rank_asc <= 3 THEN cwa.income_for_anchor ELSE cwa.rolling_income_3 END AS income_anchor_normalized,
      CASE WHEN cwa.cycle_rank_asc <= 3 THEN 1 ELSE 3 END AS anchor_window_size,
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
      user_id, cycle_start_date, cycle_end_date, bucket_month,
      savings_rate_v2, spending_ratio, weekend_ratio, total_wisey_score,
      essentials_ratio, discretionary_ratio, savings_ratio,
      income_total_normalized, income_anchor_normalized, anchor_window_size,
      reference_currency_code, calculated_at, created_at, updated_at
    )
    SELECT
      tu.user_id, tu.cycle_start_date, tu.cycle_end_date, tu.bucket_month,
      tu.savings_rate_v2, tu.spending_ratio, tu.weekend_ratio, tu.total_wisey_score,
      tu.essentials_ratio, tu.discretionary_ratio, tu.savings_ratio,
      tu.income_total_normalized, tu.income_anchor_normalized, tu.anchor_window_size,
      tu.reference_currency_code, now(), now(), now()
    FROM to_upsert tu
    ON CONFLICT (user_id, cycle_start_date, cycle_end_date) DO UPDATE SET
      bucket_month               = EXCLUDED.bucket_month,
      savings_rate_v2            = EXCLUDED.savings_rate_v2,
      spending_ratio             = EXCLUDED.spending_ratio,
      weekend_ratio              = EXCLUDED.weekend_ratio,
      total_wisey_score          = EXCLUDED.total_wisey_score,
      essentials_ratio           = EXCLUDED.essentials_ratio,
      discretionary_ratio        = EXCLUDED.discretionary_ratio,
      savings_ratio              = EXCLUDED.savings_ratio,
      income_total_normalized    = EXCLUDED.income_total_normalized,
      income_anchor_normalized   = EXCLUDED.income_anchor_normalized,
      anchor_window_size         = EXCLUDED.anchor_window_size,
      reference_currency_code    = EXCLUDED.reference_currency_code,
      calculated_at              = now(),   -- ← Phase 2 fix
      updated_at                 = now()
    RETURNING user_id
  )
  SELECT
    (SELECT COUNT(*)::INTEGER FROM active_users),
    (SELECT COUNT(*)::INTEGER FROM upserted),
    (SELECT COUNT(*)::INTEGER FROM all_cycles WHERE cycle_days < 20),
    (SELECT COALESCE(SUM(missing_fx_rows), 0)::INTEGER FROM to_upsert)
  INTO v_users_processed, v_rows_upserted, v_skipped_short_cycles, v_skipped_missing_fx_rows;

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

  RETURN QUERY SELECT v_users_processed, v_rows_upserted, v_skipped_short_cycles, v_skipped_missing_fx_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_wisey_cycle_scores(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.backfill_wisey_cycle_scores(INTEGER) TO service_role;

-- ---------------------------------------------------------------------------
-- Phase 3: New peer RPC — cycle-income based
-- Old RPC (get_peer_averages_by_bracket) untouched for rollback safety.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_peer_averages_by_cycle_income(
    p_user_id            UUID,
    p_bucket_month       DATE,
    p_income_anchor_usd  NUMERIC,
    p_min_peer_count     INTEGER DEFAULT 2
)
RETURNS TABLE (
    avg_savings_rate      NUMERIC,
    avg_spending_ratio    NUMERIC,
    avg_weekend_ratio     NUMERIC,
    avg_score             NUMERIC,
    avg_essentials_ratio  NUMERIC,
    avg_discretionary_ratio NUMERIC,
    avg_savings_ratio     NUMERIC,
    peer_count            INTEGER,
    peer_band_label       TEXT,
    has_sufficient_peers  BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_band_min   NUMERIC;
    v_band_max   NUMERIC;
    v_band_label TEXT;
    v_step       NUMERIC := 2000;
BEGIN
    -- Gate: only serve if backfill is confirmed complete
    IF NOT EXISTS (
        SELECT 1 FROM public.wisey_cycle_peers_backfill_status
        WHERE id = 1 AND is_complete = true
    ) THEN
        RETURN QUERY
        SELECT NULL::NUMERIC, NULL::NUMERIC, NULL::NUMERIC, NULL::NUMERIC,
               NULL::NUMERIC, NULL::NUMERIC, NULL::NUMERIC,
               0::INTEGER, 'backfill_pending'::TEXT, false::BOOLEAN;
        RETURN;
    END IF;

    -- Determine income band (all values USD)
    IF p_income_anchor_usd IS NULL OR p_income_anchor_usd < 0 THEN
        v_band_min := 0; v_band_max := 500; v_band_label := '$0–$500';
    ELSIF p_income_anchor_usd < 500 THEN
        v_band_min := 0;    v_band_max := 500;  v_band_label := '$0–$500';
    ELSIF p_income_anchor_usd < 1500 THEN
        v_band_min := 500;  v_band_max := 1500; v_band_label := '$500–$1.5k';
    ELSIF p_income_anchor_usd < 3000 THEN
        v_band_min := 1500; v_band_max := 3000; v_band_label := '$1.5k–$3k';
    ELSIF p_income_anchor_usd < 5000 THEN
        v_band_min := 3000; v_band_max := 5000; v_band_label := '$3k–$5k';
    ELSIF p_income_anchor_usd < 7000 THEN
        v_band_min := 5000; v_band_max := 7000; v_band_label := '$5k–$7k';
    ELSE
        v_band_min := FLOOR((p_income_anchor_usd - 7000) / v_step) * v_step + 7000;
        v_band_max := v_band_min + v_step;
        v_band_label := '$' || (v_band_min / 1000)::INTEGER || 'k–$' || (v_band_max / 1000)::INTEGER || 'k';
    END IF;

    RETURN QUERY
    WITH peer_rows AS (
        SELECT
            ucs.savings_rate_v2,
            ucs.spending_ratio,
            ucs.weekend_ratio,
            ucs.total_wisey_score,
            ucs.essentials_ratio,
            ucs.discretionary_ratio,
            ucs.savings_ratio
        FROM public.user_cycle_scores ucs
        WHERE ucs.bucket_month = p_bucket_month
          AND ucs.income_anchor_normalized >= v_band_min
          AND ucs.income_anchor_normalized <  v_band_max
          AND ucs.user_id != p_user_id
          AND ucs.user_id NOT IN (SELECT itu.user_id FROM public.internal_test_users itu)
    ),
    agg AS (
        SELECT
            COUNT(*)::INTEGER        AS peer_count,
            AVG(savings_rate_v2)     AS avg_savings_rate,
            AVG(spending_ratio)      AS avg_spending_ratio,
            AVG(weekend_ratio)       AS avg_weekend_ratio,
            AVG(total_wisey_score)   AS avg_score,
            AVG(essentials_ratio)    AS avg_essentials_ratio,
            AVG(discretionary_ratio) AS avg_discretionary_ratio,
            AVG(savings_ratio)       AS avg_savings_ratio
        FROM peer_rows
    )
    SELECT
        agg.avg_savings_rate,
        agg.avg_spending_ratio,
        agg.avg_weekend_ratio,
        agg.avg_score,
        agg.avg_essentials_ratio,
        agg.avg_discretionary_ratio,
        agg.avg_savings_ratio,
        agg.peer_count,
        v_band_label,
        (agg.peer_count >= p_min_peer_count)
    FROM agg;
END;
$$;

REVOKE ALL ON FUNCTION public.get_peer_averages_by_cycle_income(UUID, DATE, NUMERIC, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_peer_averages_by_cycle_income(UUID, DATE, NUMERIC, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_peer_averages_by_cycle_income(UUID, DATE, NUMERIC, INTEGER) TO service_role;

COMMIT;
