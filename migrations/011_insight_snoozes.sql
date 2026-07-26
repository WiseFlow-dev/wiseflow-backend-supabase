-- 011_insight_snoozes.sql
-- Snoozed insights per user and month (Spending screen)

CREATE TABLE IF NOT EXISTS public.insight_snoozes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  insight_id text NOT NULL,
  month_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for lookups and uniqueness
CREATE INDEX IF NOT EXISTS idx_insight_snoozes_user_month
  ON public.insight_snoozes(user_id, month_key);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_insight_snooze_per_month
  ON public.insight_snoozes(user_id, insight_id, month_key);

-- Enable Row Level Security
ALTER TABLE public.insight_snoozes ENABLE ROW LEVEL SECURITY;

-- RLS policies: users manage only their own snoozes
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'insight_snoozes'
      AND policyname = 'select_own_insight_snoozes'
  ) THEN
    CREATE POLICY select_own_insight_snoozes
      ON public.insight_snoozes
      FOR SELECT
      USING (auth.uid() = user_id);
  END IF;


  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'insight_snoozes'
      AND policyname = 'insert_own_insight_snoozes'
  ) THEN
    CREATE POLICY insert_own_insight_snoozes
      ON public.insight_snoozes
      FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;


  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'insight_snoozes'
      AND policyname = 'delete_own_insight_snoozes'
  ) THEN
    CREATE POLICY delete_own_insight_snoozes
      ON public.insight_snoozes
      FOR DELETE
      USING (auth.uid() = user_id);
  END IF;


  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'insight_snoozes'
      AND policyname = 'update_own_insight_snoozes'
  ) THEN
    CREATE POLICY update_own_insight_snoozes
      ON public.insight_snoozes
      FOR UPDATE
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;


COMMENT ON TABLE public.insight_snoozes IS 'Per-user snoozed insights for specific months on the Spending screen.';
COMMENT ON COLUMN public.insight_snoozes.insight_id IS 'Full insight id (e.g. velocity_2025-11) to hide.';
COMMENT ON COLUMN public.insight_snoozes.month_key IS 'Month key in YYYY-MM format matching spending-engine input.';
