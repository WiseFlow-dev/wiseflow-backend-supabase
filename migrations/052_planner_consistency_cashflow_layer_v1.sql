-- Planner Consistency + Cashflow Data Layer V1
-- Adds:
--   1) user_cashflow_snapshots
--   2) planner_run_metrics

CREATE TABLE IF NOT EXISTS public.user_cashflow_snapshots (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  currency_code TEXT NOT NULL,
  window_type TEXT NOT NULL CHECK (window_type IN ('rolling_30_days', 'current_cycle', 'horizon_projection')),
  window_start DATE NOT NULL,
  window_end DATE NOT NULL,

  income_monthly_cents BIGINT NOT NULL DEFAULT 0,
  fixed_obligations_monthly_cents BIGINT NOT NULL DEFAULT 0,
  variable_spend_monthly_cents BIGINT NOT NULL DEFAULT 0,
  monthly_surplus_cents BIGINT NOT NULL DEFAULT 0,
  discretionary_pool_cents BIGINT NOT NULL DEFAULT 0,
  max_optional_cut_capacity_cents BIGINT NOT NULL DEFAULT 0,
  category_cut_cap_pct NUMERIC(5,2) NOT NULL DEFAULT 40.00,

  tx_watermark_at TIMESTAMPTZ,
  budget_watermark_at TIMESTAMPTZ,
  obligation_watermark_at TIMESTAMPTZ,

  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '60 minutes'),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (user_id, currency_code, window_type, window_start, window_end)
);

CREATE INDEX IF NOT EXISTS idx_user_cashflow_snapshots_user_window
  ON public.user_cashflow_snapshots (user_id, window_type, window_start, window_end);

CREATE INDEX IF NOT EXISTS idx_user_cashflow_snapshots_expires_at
  ON public.user_cashflow_snapshots (expires_at);

CREATE INDEX IF NOT EXISTS idx_user_cashflow_snapshots_computed_at
  ON public.user_cashflow_snapshots (user_id, computed_at DESC);

CREATE TABLE IF NOT EXISTS public.planner_run_metrics (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id UUID NULL REFERENCES public.chat_sessions(id) ON DELETE SET NULL,

  planner_type TEXT NOT NULL CHECK (planner_type IN ('vacation_plan', 'savings_plan')),
  currency_code TEXT NOT NULL,
  window_type TEXT NOT NULL CHECK (window_type IN ('rolling_30_days', 'current_cycle', 'horizon_projection')),
  window_start DATE,
  window_end DATE,

  required_cents BIGINT NOT NULL DEFAULT 0,
  risk_required_cents BIGINT NOT NULL DEFAULT 0,
  base_capacity_cents BIGINT NOT NULL DEFAULT 0,

  required_cut_to_target_cents BIGINT NOT NULL DEFAULT 0,
  selected_cut_cents BIGINT NOT NULL DEFAULT 0,
  max_optional_cut_capacity_cents BIGINT NOT NULL DEFAULT 0,

  base_coverage_pct NUMERIC(8,2) NOT NULL DEFAULT 0,
  comfort_coverage_pct NUMERIC(8,2) NOT NULL DEFAULT 0,
  max_coverage_pct NUMERIC(8,2) NOT NULL DEFAULT 0,

  verdict TEXT NOT NULL CHECK (verdict IN ('yes', 'close', 'no')),
  cut_mode TEXT NOT NULL CHECK (cut_mode IN ('needed_to_hit_target', 'optional_buffer')),
  is_one_time_achievable BOOLEAN,
  recurring_capacity_cents BIGINT,

  debug_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_run_metrics_user_created
  ON public.planner_run_metrics (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_planner_run_metrics_planner_type
  ON public.planner_run_metrics (planner_type, created_at DESC);

ALTER TABLE public.user_cashflow_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.planner_run_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own cashflow snapshots" ON public.user_cashflow_snapshots;
CREATE POLICY "Users can manage their own cashflow snapshots"
ON public.user_cashflow_snapshots
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage their own planner run metrics" ON public.planner_run_metrics;
CREATE POLICY "Users can manage their own planner run metrics"
ON public.planner_run_metrics
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.user_cashflow_snapshots IS
  'Planner cashflow snapshots keyed by user/currency/window for consistency and cacheability.';

COMMENT ON TABLE public.planner_run_metrics IS
  'Per-run planner diagnostics for coverage, cuts, verdicts, and one-time vs recurring behavior.';
