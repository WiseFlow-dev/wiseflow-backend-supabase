-- 015_budget_suggestions.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.budget_suggestion_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  threshold_pct_of_income numeric NOT NULL DEFAULT 0.10 CHECK (threshold_pct_of_income > 0 AND threshold_pct_of_income <= 1),
  min_income_cents bigint NOT NULL DEFAULT 0 CHECK (min_income_cents >= 0),
  min_tx_count_in_category int NOT NULL DEFAULT 2 CHECK (min_tx_count_in_category >= 1),
  max_suggestions_per_day int NOT NULL DEFAULT 1 CHECK (max_suggestions_per_day >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.budget_suggestion_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='budget_suggestion_settings' AND policyname='select_own_budget_suggestion_settings') THEN
    CREATE POLICY select_own_budget_suggestion_settings ON public.budget_suggestion_settings FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='budget_suggestion_settings' AND policyname='insert_own_budget_suggestion_settings') THEN
    CREATE POLICY insert_own_budget_suggestion_settings ON public.budget_suggestion_settings FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='budget_suggestion_settings' AND policyname='update_own_budget_suggestion_settings') THEN
    CREATE POLICY update_own_budget_suggestion_settings ON public.budget_suggestion_settings FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.category_budget_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  category_key text NOT NULL,
  display_name text,
  is_budgetable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_category_budget_policy_lookup ON public.category_budget_policy(user_id, category_key);

ALTER TABLE public.category_budget_policy ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='category_budget_policy' AND policyname='select_own_category_budget_policy') THEN
    CREATE POLICY select_own_category_budget_policy ON public.category_budget_policy FOR SELECT USING (user_id = auth.uid() OR user_id IS NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='category_budget_policy' AND policyname='insert_own_category_budget_policy') THEN
    CREATE POLICY insert_own_category_budget_policy ON public.category_budget_policy FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='category_budget_policy' AND policyname='update_own_category_budget_policy') THEN
    CREATE POLICY update_own_category_budget_policy ON public.category_budget_policy FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.action_suggestion_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  suggestion_type text NOT NULL,
  category_key text,
  month_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_action_suggestion_log_month_category
  ON public.action_suggestion_log(user_id, suggestion_type, category_key, month_key)
  WHERE category_key IS NOT NULL AND month_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_action_suggestion_log_daily
  ON public.action_suggestion_log(user_id, suggestion_type, created_at DESC);

ALTER TABLE public.action_suggestion_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='action_suggestion_log' AND policyname='select_own_action_suggestion_log') THEN
    CREATE POLICY select_own_action_suggestion_log ON public.action_suggestion_log FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='action_suggestion_log' AND policyname='insert_own_action_suggestion_log') THEN
    CREATE POLICY insert_own_action_suggestion_log ON public.action_suggestion_log FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

INSERT INTO public.category_budget_policy (user_id, category_key, display_name, is_budgetable)
SELECT NULL, 'health', 'Health', false
WHERE NOT EXISTS (
  SELECT 1 FROM public.category_budget_policy WHERE user_id IS NULL AND category_key = 'health'
);

INSERT INTO public.category_budget_policy (user_id, category_key, display_name, is_budgetable)
SELECT NULL, 'healthcare', 'Healthcare', false
WHERE NOT EXISTS (
  SELECT 1 FROM public.category_budget_policy WHERE user_id IS NULL AND category_key = 'healthcare'
);

COMMIT;
