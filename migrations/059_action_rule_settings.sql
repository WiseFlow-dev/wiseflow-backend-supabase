-- Configurable thresholds for Wisey actionable rules.
-- Supports global defaults (user_id is null) plus per-user overrides.

CREATE TABLE IF NOT EXISTS public.action_rule_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  rule_id text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  min_leftover_cents integer,
  transfer_ratio numeric(6,4),
  hard_cap_cents integer,
  trigger_days_remaining integer,
  target_coverage_months numeric(6,3),
  min_suggestion_cents integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_action_rule_settings_global_unique
  ON public.action_rule_settings(rule_id)
  WHERE user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_action_rule_settings_user_unique
  ON public.action_rule_settings(user_id, rule_id)
  WHERE user_id IS NOT NULL;

ALTER TABLE public.action_rule_settings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='action_rule_settings' AND policyname='select_own_or_global_action_rule_settings'
  ) THEN
    CREATE POLICY select_own_or_global_action_rule_settings
      ON public.action_rule_settings
      FOR SELECT
      USING (user_id = auth.uid() OR user_id IS NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='action_rule_settings' AND policyname='insert_own_action_rule_settings'
  ) THEN
    CREATE POLICY insert_own_action_rule_settings
      ON public.action_rule_settings
      FOR INSERT
      WITH CHECK (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='action_rule_settings' AND policyname='update_own_action_rule_settings'
  ) THEN
    CREATE POLICY update_own_action_rule_settings
      ON public.action_rule_settings
      FOR UPDATE
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='action_rule_settings' AND policyname='delete_own_action_rule_settings'
  ) THEN
    CREATE POLICY delete_own_action_rule_settings
      ON public.action_rule_settings
      FOR DELETE
      USING (user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.action_rule_settings
    WHERE user_id IS NULL AND rule_id = 'cycle_leftover_to_savings_wallet_v1'
  ) THEN
    INSERT INTO public.action_rule_settings (
      user_id,
      rule_id,
      is_enabled,
      min_leftover_cents,
      transfer_ratio,
      hard_cap_cents,
      trigger_days_remaining,
      min_suggestion_cents
    ) VALUES (
      NULL,
      'cycle_leftover_to_savings_wallet_v1',
      true,
      10000,
      0.5,
      50000,
      3,
      5000
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.action_rule_settings
    WHERE user_id IS NULL AND rule_id = 'emergency_wallet_booster_v1'
  ) THEN
    INSERT INTO public.action_rule_settings (
      user_id,
      rule_id,
      is_enabled,
      target_coverage_months,
      min_suggestion_cents
    ) VALUES (
      NULL,
      'emergency_wallet_booster_v1',
      true,
      1.0,
      5000
    );
  END IF;
END $$;
