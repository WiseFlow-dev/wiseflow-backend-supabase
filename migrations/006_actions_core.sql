-- Sprint 0 / Core schema for Wisey Actions
-- Creates: action_proposals, executed_actions, user_action_settings, action_audit_logs
-- Adds missing columns to profiles: country, income_bracket, timezone

BEGIN;

-- Ensure helpful extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- Augment profiles with optional fields
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='profiles' AND column_name='country')
  THEN
    EXECUTE 'ALTER TABLE public.profiles ADD COLUMN country text';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='profiles' AND column_name='income_bracket')
  THEN
    EXECUTE 'ALTER TABLE public.profiles ADD COLUMN income_bracket text';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema='public' AND table_name='profiles' AND column_name='timezone')
  THEN
    EXECUTE 'ALTER TABLE public.profiles ADD COLUMN timezone text DEFAULT ''UTC''';
  END IF;
END$$;

-- action_proposals: pending items requiring user consent or eligible for autopilot
CREATE TABLE IF NOT EXISTS public.action_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rule_id text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  cta_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk_level text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high')),
  consent_required text NOT NULL CHECK (consent_required IN ('strict','smart','autopilot')),
  period_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','expired')),
  expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_action_proposals_user_status_created ON public.action_proposals(user_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_action_proposal ON public.action_proposals(user_id, rule_id, period_key) WHERE status = 'pending';
ALTER TABLE public.action_proposals ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='action_proposals' AND policyname='select_own_proposals')
  THEN
    CREATE POLICY select_own_proposals ON public.action_proposals FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='action_proposals' AND policyname='insert_own_proposals')
  THEN
    CREATE POLICY insert_own_proposals ON public.action_proposals FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='action_proposals' AND policyname='update_own_proposals')
  THEN
    CREATE POLICY update_own_proposals ON public.action_proposals FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='action_proposals' AND policyname='delete_own_proposals')
  THEN
    CREATE POLICY delete_own_proposals ON public.action_proposals FOR DELETE USING (user_id = auth.uid());
  END IF;
END $$;

-- executed_actions: record of accepted actions (and undo state)
CREATE TABLE IF NOT EXISTS public.executed_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  proposal_id uuid REFERENCES public.action_proposals(id) ON DELETE SET NULL,
  rule_id text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('success','failed','undone')),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_executed_actions_user_created ON public.executed_actions(user_id, created_at DESC);
ALTER TABLE public.executed_actions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='executed_actions' AND policyname='select_own_executed')
  THEN
    CREATE POLICY select_own_executed ON public.executed_actions FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='executed_actions' AND policyname='insert_own_executed')
  THEN
    CREATE POLICY insert_own_executed ON public.executed_actions FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='executed_actions' AND policyname='update_own_executed')
  THEN
    CREATE POLICY update_own_executed ON public.executed_actions FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='executed_actions' AND policyname='delete_own_executed')
  THEN
    CREATE POLICY delete_own_executed ON public.executed_actions FOR DELETE USING (user_id = auth.uid());
  END IF;
END $$;

-- user_action_settings: consent mode, caps, quiet hours
CREATE TABLE IF NOT EXISTS public.user_action_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  consent_mode text NOT NULL DEFAULT 'smart' CHECK (consent_mode IN ('strict','smart','autopilot')),
  per_action_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  quiet_hours jsonb NOT NULL DEFAULT '{"start":"21:00","end":"08:00"}'::jsonb,
  caps jsonb NOT NULL DEFAULT '{"weekly_actions":3}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.user_action_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_action_settings' AND policyname='select_own_settings')
  THEN
    CREATE POLICY select_own_settings ON public.user_action_settings FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_action_settings' AND policyname='insert_own_settings')
  THEN
    CREATE POLICY insert_own_settings ON public.user_action_settings FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_action_settings' AND policyname='update_own_settings')
  THEN
    CREATE POLICY update_own_settings ON public.user_action_settings FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- action_audit_logs: append-only audit for proposals/executions
CREATE TABLE IF NOT EXISTS public.action_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event text NOT NULL,
  entity_type text NOT NULL DEFAULT 'action',
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_action_audit_user_created ON public.action_audit_logs(user_id, created_at DESC);
ALTER TABLE public.action_audit_logs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='action_audit_logs' AND policyname='select_own_audit')
  THEN
    CREATE POLICY select_own_audit ON public.action_audit_logs FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='action_audit_logs' AND policyname='insert_own_audit')
  THEN
    CREATE POLICY insert_own_audit ON public.action_audit_logs FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

COMMIT;
