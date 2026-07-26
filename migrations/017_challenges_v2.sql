-- 017_challenges_v2.sql
-- Challenges v2: behavior coaching system (separate from Goals)
-- Strict mode (1 slip ends), 1 active challenge per user, keyword+category detection support

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

/* ================================
 * Suggestion settings (per user)
 * ================================ */

CREATE TABLE IF NOT EXISTS public.challenge_suggestion_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  max_suggestions_per_day int NOT NULL DEFAULT 1 CHECK (max_suggestions_per_day >= 0),

  -- A simple v1 trigger for “no-spend challenges”
  -- If the user spends frequently and/or heavily in last 7 days, suggest a challenge.
  min_tx_count_last_7d int NOT NULL DEFAULT 4 CHECK (min_tx_count_last_7d >= 1),
  min_spend_cents_last_7d bigint NOT NULL DEFAULT 0 CHECK (min_spend_cents_last_7d >= 0),

  -- Optional income-based threshold (same idea as budgets)
  threshold_pct_of_income_last_7d numeric NOT NULL DEFAULT 0.00 CHECK (threshold_pct_of_income_last_7d >= 0 AND threshold_pct_of_income_last_7d <= 1),
  min_income_cents bigint NOT NULL DEFAULT 0 CHECK (min_income_cents >= 0),

  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.challenge_suggestion_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='challenge_suggestion_settings' AND policyname='select_own_challenge_suggestion_settings') THEN
    CREATE POLICY select_own_challenge_suggestion_settings ON public.challenge_suggestion_settings
      FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='challenge_suggestion_settings' AND policyname='insert_own_challenge_suggestion_settings') THEN
    CREATE POLICY insert_own_challenge_suggestion_settings ON public.challenge_suggestion_settings
      FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='challenge_suggestion_settings' AND policyname='update_own_challenge_suggestion_settings') THEN
    CREATE POLICY update_own_challenge_suggestion_settings ON public.challenge_suggestion_settings
      FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

/* ================================
 * Category + keyword policy
 * (global rows user_id is null, user overrides by setting user_id)
 * ================================ */

CREATE TABLE IF NOT EXISTS public.challenge_category_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  category_key text NOT NULL,
  display_name text,
  is_challengeable boolean NOT NULL DEFAULT true,
  keywords text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_challenge_category_policy_lookup
  ON public.challenge_category_policy(user_id, category_key);

ALTER TABLE public.challenge_category_policy ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='challenge_category_policy' AND policyname='select_own_challenge_category_policy') THEN
    CREATE POLICY select_own_challenge_category_policy ON public.challenge_category_policy
      FOR SELECT USING (user_id = auth.uid() OR user_id IS NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='challenge_category_policy' AND policyname='insert_own_challenge_category_policy') THEN
    CREATE POLICY insert_own_challenge_category_policy ON public.challenge_category_policy
      FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='challenge_category_policy' AND policyname='update_own_challenge_category_policy') THEN
    CREATE POLICY update_own_challenge_category_policy ON public.challenge_category_policy
      FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='challenge_category_policy' AND policyname='delete_own_challenge_category_policy') THEN
    CREATE POLICY delete_own_challenge_category_policy ON public.challenge_category_policy
      FOR DELETE USING (user_id = auth.uid());
  END IF;
END $$;

/* ================================
 * Challenges v2
 * ================================ */

CREATE TABLE IF NOT EXISTS public.challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- v1: only NO_SPEND is required, but keep room for expansion
  type text NOT NULL CHECK (type IN ('NO_SPEND', 'REDUCE_CATEGORY', 'STREAK', 'CUSTOM')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed', 'ended')),

  title text NOT NULL,
  subtitle text,

  strict_mode boolean NOT NULL DEFAULT true,
  start_at timestamptz NOT NULL DEFAULT now(),
  end_at timestamptz,

  -- Detection fields
  category_key text,
  keywords text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- Link to an action proposal if created from Actions Center
  source_proposal_id uuid REFERENCES public.action_proposals(id) ON DELETE SET NULL,
  created_from text NOT NULL DEFAULT 'manual' CHECK (created_from IN ('manual','suggestion')),

  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- If a legacy challenges table already existed, it may be missing v2 columns.
-- Add required columns in a safe way so later indexes can be created.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='challenges' AND column_name='type'
  ) THEN
    EXECUTE 'ALTER TABLE public.challenges ADD COLUMN type text';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='challenges' AND column_name='status'
  ) THEN
    EXECUTE 'ALTER TABLE public.challenges ADD COLUMN status text';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='challenges' AND column_name='title'
  ) THEN
    EXECUTE 'ALTER TABLE public.challenges ADD COLUMN title text';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='challenges' AND column_name='subtitle'
  ) THEN
    EXECUTE 'ALTER TABLE public.challenges ADD COLUMN subtitle text';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='challenges' AND column_name='strict_mode'
  ) THEN
    EXECUTE 'ALTER TABLE public.challenges ADD COLUMN strict_mode boolean';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='challenges' AND column_name='start_at'
  ) THEN
    EXECUTE 'ALTER TABLE public.challenges ADD COLUMN start_at timestamptz';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='challenges' AND column_name='end_at'
  ) THEN
    EXECUTE 'ALTER TABLE public.challenges ADD COLUMN end_at timestamptz';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='challenges' AND column_name='category_key'
  ) THEN
    EXECUTE 'ALTER TABLE public.challenges ADD COLUMN category_key text';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='challenges' AND column_name='keywords'
  ) THEN
    EXECUTE 'ALTER TABLE public.challenges ADD COLUMN keywords text[] NOT NULL DEFAULT ARRAY[]::text[]';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='challenges' AND column_name='source_proposal_id'
  ) THEN
    EXECUTE 'ALTER TABLE public.challenges ADD COLUMN source_proposal_id uuid';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='challenges' AND column_name='created_from'
  ) THEN
    EXECUTE 'ALTER TABLE public.challenges ADD COLUMN created_from text';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='challenges' AND column_name='metadata'
  ) THEN
    EXECUTE 'ALTER TABLE public.challenges ADD COLUMN metadata jsonb NOT NULL DEFAULT ''{}''::jsonb';
  END IF;

  -- Backfill defaults for legacy rows (best-effort)
  EXECUTE 'UPDATE public.challenges SET status = COALESCE(status, ''active'')';
  EXECUTE 'UPDATE public.challenges SET strict_mode = COALESCE(strict_mode, true)';
  EXECUTE 'UPDATE public.challenges SET created_from = COALESCE(created_from, ''manual'')';
  EXECUTE 'UPDATE public.challenges SET start_at = COALESCE(start_at, created_at, now())';
  EXECUTE 'UPDATE public.challenges SET title = COALESCE(title, ''Challenge'')';
  EXECUTE 'UPDATE public.challenges SET type = COALESCE(type, ''NO_SPEND'')';
END $$;

-- Enforce: 1 active challenge per user
CREATE UNIQUE INDEX IF NOT EXISTS uniq_one_active_challenge_per_user
  ON public.challenges(user_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_challenges_user_status_created
  ON public.challenges(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_challenges_user_category
  ON public.challenges(user_id, category_key);

ALTER TABLE public.challenges ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='challenges' AND policyname='select_own_challenges') THEN
    CREATE POLICY select_own_challenges ON public.challenges
      FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='challenges' AND policyname='insert_own_challenges') THEN
    CREATE POLICY insert_own_challenges ON public.challenges
      FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='challenges' AND policyname='update_own_challenges') THEN
    CREATE POLICY update_own_challenges ON public.challenges
      FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='challenges' AND policyname='delete_own_challenges') THEN
    CREATE POLICY delete_own_challenges ON public.challenges
      FOR DELETE USING (user_id = auth.uid());
  END IF;
END $$;

/* ================================
 * Challenge events (audit + progress)
 * ================================ */

CREATE TABLE IF NOT EXISTS public.challenge_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  challenge_id uuid NOT NULL REFERENCES public.challenges(id) ON DELETE CASCADE,

  event_type text NOT NULL CHECK (event_type IN ('started','slipped','completed','ended','note')),
  event_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_challenge_events_user_time
  ON public.challenge_events(user_id, event_at DESC);

CREATE INDEX IF NOT EXISTS idx_challenge_events_challenge_time
  ON public.challenge_events(challenge_id, event_at DESC);

ALTER TABLE public.challenge_events ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='challenge_events' AND policyname='select_own_challenge_events') THEN
    CREATE POLICY select_own_challenge_events ON public.challenge_events
      FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='challenge_events' AND policyname='insert_own_challenge_events') THEN
    CREATE POLICY insert_own_challenge_events ON public.challenge_events
      FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='challenge_events' AND policyname='update_own_challenge_events') THEN
    CREATE POLICY update_own_challenge_events ON public.challenge_events
      FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='challenge_events' AND policyname='delete_own_challenge_events') THEN
    CREATE POLICY delete_own_challenge_events ON public.challenge_events
      FOR DELETE USING (user_id = auth.uid());
  END IF;
END $$;

/* ================================
 * Seed: a few global “replaceable” habits
 * NOTE: these are generic; user can override by inserting user_id rows.
 * ================================ */

INSERT INTO public.challenge_category_policy (user_id, category_key, display_name, is_challengeable, keywords)
SELECT NULL, 'coffee', 'Coffee', true, ARRAY['coffee','caffe','café','espresso','latte','starbucks','costa']
WHERE NOT EXISTS (
  SELECT 1 FROM public.challenge_category_policy WHERE user_id IS NULL AND category_key = 'coffee'
);

INSERT INTO public.challenge_category_policy (user_id, category_key, display_name, is_challengeable, keywords)
SELECT NULL, 'eating out', 'Eating Out', true, ARRAY['restaurant','burger','pizza','shawarma','kebab','diner','cafe']
WHERE NOT EXISTS (
  SELECT 1 FROM public.challenge_category_policy WHERE user_id IS NULL AND category_key = 'eating out'
);

INSERT INTO public.challenge_category_policy (user_id, category_key, display_name, is_challengeable, keywords)
SELECT NULL, 'snacks', 'Snacks', true, ARRAY['snack','chips','chocolate','candy','dessert']
WHERE NOT EXISTS (
  SELECT 1 FROM public.challenge_category_policy WHERE user_id IS NULL AND category_key = 'snacks'
);

INSERT INTO public.challenge_category_policy (user_id, category_key, display_name, is_challengeable, keywords)
SELECT NULL, 'shopping', 'Shopping', true, ARRAY['shopping','store','mall','amazon','noon']
WHERE NOT EXISTS (
  SELECT 1 FROM public.challenge_category_policy WHERE user_id IS NULL AND category_key = 'shopping'
);

COMMIT;
