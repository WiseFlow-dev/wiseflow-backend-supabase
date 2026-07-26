-- Sprint 0 / Communications & Benchmarks schema
-- Creates: nudges, digests, push_tokens, benchmarks_cache
-- Adds RLS and useful indexes

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- nudges: push or in-app notifications
CREATE TABLE IF NOT EXISTS public.nudges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trigger text NOT NULL, -- e.g., overspend_spike, surplus_found, subscription_change
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  channel text NOT NULL CHECK (channel IN ('push','in_app')),
  sent_at timestamptz,
  clicked_at timestamptz,
  suppressed_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nudges_user_created ON public.nudges(user_id, created_at DESC);
ALTER TABLE public.nudges ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='nudges' AND policyname='select_own_nudges') THEN
    CREATE POLICY select_own_nudges ON public.nudges FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='nudges' AND policyname='insert_own_nudges') THEN
    CREATE POLICY insert_own_nudges ON public.nudges FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='nudges' AND policyname='update_own_nudges') THEN
    CREATE POLICY update_own_nudges ON public.nudges FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- digests: weekly summary
CREATE TABLE IF NOT EXISTS public.digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  week_key text NOT NULL, -- e.g., 2025-W43
  sections_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, week_key)
);
CREATE INDEX IF NOT EXISTS idx_digests_user_week ON public.digests(user_id, week_key);
ALTER TABLE public.digests ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='digests' AND policyname='select_own_digests') THEN
    CREATE POLICY select_own_digests ON public.digests FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='digests' AND policyname='insert_own_digests') THEN
    CREATE POLICY insert_own_digests ON public.digests FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='digests' AND policyname='update_own_digests') THEN
    CREATE POLICY update_own_digests ON public.digests FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- push_tokens: FCM device tokens per user
CREATE TABLE IF NOT EXISTS public.push_tokens (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('android','ios','web')),
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, token)
);
ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='push_tokens' AND policyname='select_own_tokens') THEN
    CREATE POLICY select_own_tokens ON public.push_tokens FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='push_tokens' AND policyname='insert_own_tokens') THEN
    CREATE POLICY insert_own_tokens ON public.push_tokens FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='push_tokens' AND policyname='update_own_tokens') THEN
    CREATE POLICY update_own_tokens ON public.push_tokens FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='push_tokens' AND policyname='delete_own_tokens') THEN
    CREATE POLICY delete_own_tokens ON public.push_tokens FOR DELETE USING (user_id = auth.uid());
  END IF;
END $$;

-- benchmarks_cache: cohort percentiles by income bracket, country, category
CREATE TABLE IF NOT EXISTS public.benchmarks_cache (
  id bigserial PRIMARY KEY,
  income_bracket text NOT NULL,
  country text,
  category text NOT NULL,
  p10 numeric,
  p25 numeric,
  p50 numeric,
  p75 numeric,
  p90 numeric,
  sample_size int,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_benchmarks_lookup ON public.benchmarks_cache(income_bracket, country, category);

COMMIT;
