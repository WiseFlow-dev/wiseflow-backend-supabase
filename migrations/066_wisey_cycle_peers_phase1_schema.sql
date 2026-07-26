-- 066_wisey_cycle_peers_phase1_schema.sql
-- Phase 1 for cycle-based, income-only peers

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_cycle_scores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cycle_start_date DATE NOT NULL,
  cycle_end_date DATE NOT NULL,
  bucket_month DATE NOT NULL,

  -- Core peer metrics
  savings_rate_v2 NUMERIC,
  spending_ratio NUMERIC,
  weekend_ratio NUMERIC,
  total_wisey_score NUMERIC(3,1),

  -- Reserved category share metrics (locked in Phase 1)
  essentials_ratio NUMERIC,
  discretionary_ratio NUMERIC,
  savings_ratio NUMERIC,

  -- Income anchoring (USD normalized)
  income_total_normalized NUMERIC,
  income_anchor_normalized NUMERIC,
  anchor_window_size SMALLINT,
  reference_currency_code TEXT NOT NULL DEFAULT 'USD',

  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uniq_user_cycle_scores UNIQUE (user_id, cycle_start_date, cycle_end_date),
  CONSTRAINT chk_cycle_window_valid CHECK (cycle_end_date >= cycle_start_date),
  CONSTRAINT chk_bucket_month_midpoint_formula CHECK (
    bucket_month = DATE_TRUNC('month', (cycle_start_date + ((cycle_end_date - cycle_start_date) / 2))::timestamp)::date
  ),
  CONSTRAINT chk_total_wisey_score_range CHECK (total_wisey_score IS NULL OR (total_wisey_score >= 0 AND total_wisey_score <= 10)),
  CONSTRAINT chk_weekend_ratio_range CHECK (weekend_ratio IS NULL OR (weekend_ratio >= 0 AND weekend_ratio <= 1)),
  CONSTRAINT chk_essentials_ratio_range CHECK (essentials_ratio IS NULL OR (essentials_ratio >= 0 AND essentials_ratio <= 1)),
  CONSTRAINT chk_discretionary_ratio_range CHECK (discretionary_ratio IS NULL OR (discretionary_ratio >= 0 AND discretionary_ratio <= 1)),
  CONSTRAINT chk_savings_ratio_range CHECK (savings_ratio IS NULL OR (savings_ratio >= 0 AND savings_ratio <= 1)),
  CONSTRAINT chk_anchor_window_size CHECK (anchor_window_size IS NULL OR anchor_window_size IN (1, 2, 3)),
  CONSTRAINT chk_reference_currency_code CHECK (reference_currency_code = 'USD')
);

CREATE INDEX IF NOT EXISTS idx_user_cycle_scores_bucket_income
  ON public.user_cycle_scores (bucket_month, income_anchor_normalized);

CREATE INDEX IF NOT EXISTS idx_user_cycle_scores_user_cycle_start
  ON public.user_cycle_scores (user_id, cycle_start_date DESC);

ALTER TABLE public.user_cycle_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_cycle_scores_select_own ON public.user_cycle_scores;
CREATE POLICY user_cycle_scores_select_own
  ON public.user_cycle_scores
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE TABLE IF NOT EXISTS public.internal_test_users (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('seed_account', 'developer', 'qa')),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Internal-only table: no authenticated policies on purpose.
ALTER TABLE public.internal_test_users ENABLE ROW LEVEL SECURITY;

INSERT INTO public.internal_test_users (user_id, reason)
SELECT v.user_id, v.reason
FROM (
  VALUES
    ('a411ed10-b9c8-44e8-8f90-f775f3fcff66'::uuid, 'seed_account'::text),
    ('088b7281-037d-4124-a3c6-edcbe3453b61'::uuid, 'seed_account'::text)
) AS v(user_id, reason)
JOIN auth.users u ON u.id = v.user_id
ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason;

COMMIT;
