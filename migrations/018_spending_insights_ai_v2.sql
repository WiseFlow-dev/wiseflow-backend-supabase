BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.spending_insight_snoozes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('monthly','weekly')),
  insight_type text NOT NULL,
  insight_key text NOT NULL DEFAULT '',
  snoozed_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_spending_insight_snooze
  ON public.spending_insight_snoozes(user_id, scope, insight_type, insight_key);

CREATE INDEX IF NOT EXISTS idx_spending_insight_snoozes_active
  ON public.spending_insight_snoozes(user_id, snoozed_until DESC);

ALTER TABLE public.spending_insight_snoozes ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='spending_insight_snoozes' AND policyname='select_own_spending_insight_snoozes') THEN
    CREATE POLICY select_own_spending_insight_snoozes
      ON public.spending_insight_snoozes
      FOR SELECT
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='spending_insight_snoozes' AND policyname='insert_own_spending_insight_snoozes') THEN
    CREATE POLICY insert_own_spending_insight_snoozes
      ON public.spending_insight_snoozes
      FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='spending_insight_snoozes' AND policyname='update_own_spending_insight_snoozes') THEN
    CREATE POLICY update_own_spending_insight_snoozes
      ON public.spending_insight_snoozes
      FOR UPDATE
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='spending_insight_snoozes' AND policyname='delete_own_spending_insight_snoozes') THEN
    CREATE POLICY delete_own_spending_insight_snoozes
      ON public.spending_insight_snoozes
      FOR DELETE
      USING (auth.uid() = user_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.spending_insight_feedback (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('monthly','weekly')),
  period_key text NOT NULL,
  insight_type text NOT NULL,
  insight_key text NOT NULL DEFAULT '',
  helpful boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, period_key, insight_type, insight_key)
);

CREATE INDEX IF NOT EXISTS idx_spending_insight_feedback_user_time
  ON public.spending_insight_feedback(user_id, updated_at DESC);

ALTER TABLE public.spending_insight_feedback ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='spending_insight_feedback' AND policyname='select_own_spending_insight_feedback') THEN
    CREATE POLICY select_own_spending_insight_feedback
      ON public.spending_insight_feedback
      FOR SELECT
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='spending_insight_feedback' AND policyname='insert_own_spending_insight_feedback') THEN
    CREATE POLICY insert_own_spending_insight_feedback
      ON public.spending_insight_feedback
      FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='spending_insight_feedback' AND policyname='update_own_spending_insight_feedback') THEN
    CREATE POLICY update_own_spending_insight_feedback
      ON public.spending_insight_feedback
      FOR UPDATE
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='spending_insight_feedback' AND policyname='delete_own_spending_insight_feedback') THEN
    CREATE POLICY delete_own_spending_insight_feedback
      ON public.spending_insight_feedback
      FOR DELETE
      USING (auth.uid() = user_id);
  END IF;
END $$;

COMMIT;
