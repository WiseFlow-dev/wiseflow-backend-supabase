-- Per-user monthly analytics summary for Rankings & comparisons
-- This table is already used by the analytics-engine function; this migration
-- makes the schema explicit and versioned in the repo.

BEGIN;

CREATE TABLE IF NOT EXISTS public.analytics_user_monthly_stats (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month text NOT NULL,                         -- e.g. '2025-11'
  income_total numeric,                        -- total income for the month
  spent_total numeric,                         -- total expenses for the month (absolute value)
  saved_total numeric,                         -- income_total - spent_total (clamped to >= 0)
  savings_balance_total numeric,               -- sum of balances in Savings wallets
  income_bracket text,                         -- label like '<1.5k', '1.5k–2.5k', '5k+'
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, month)
);

CREATE INDEX IF NOT EXISTS idx_analytics_user_monthly_income_bracket
  ON public.analytics_user_monthly_stats (income_bracket, month);

COMMENT ON TABLE public.analytics_user_monthly_stats IS
  'Per-user monthly income/spend/savings and income bracket used by analytics-engine to compute peer rankings.';

COMMIT;
