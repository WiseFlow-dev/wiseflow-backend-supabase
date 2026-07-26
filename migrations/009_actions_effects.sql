-- 009_actions_effects.sql
-- Create actions_queue, action_outcomes, planned_transfers (amount_cents), spend_clamps, subscription_reviews
-- Add RLS policies and useful indexes

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- actions_queue: queue of accepted proposals awaiting execution
CREATE TABLE IF NOT EXISTS public.actions_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  proposal_id uuid REFERENCES public.action_proposals(id) ON DELETE SET NULL,
  rule_id text NOT NULL,
  action_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','in_progress','completed','failed')),
  attempts int NOT NULL DEFAULT 0,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_actions_queue_user_status_created ON public.actions_queue(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_actions_queue_proposal ON public.actions_queue(proposal_id);
ALTER TABLE public.actions_queue ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='actions_queue' AND policyname='select_own_actions_queue') THEN
    CREATE POLICY select_own_actions_queue ON public.actions_queue FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='actions_queue' AND policyname='insert_own_actions_queue') THEN
    CREATE POLICY insert_own_actions_queue ON public.actions_queue FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='actions_queue' AND policyname='update_own_actions_queue') THEN
    CREATE POLICY update_own_actions_queue ON public.actions_queue FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='actions_queue' AND policyname='delete_own_actions_queue') THEN
    CREATE POLICY delete_own_actions_queue ON public.actions_queue FOR DELETE USING (user_id = auth.uid());
  END IF;
END $$;

-- action_outcomes: execution results of queue items
CREATE TABLE IF NOT EXISTS public.action_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id uuid NOT NULL REFERENCES public.actions_queue(id) ON DELETE CASCADE,
  success boolean NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_action_outcomes_queue ON public.action_outcomes(queue_id);
ALTER TABLE public.action_outcomes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='action_outcomes' AND policyname='select_own_action_outcomes') THEN
    CREATE POLICY select_own_action_outcomes ON public.action_outcomes FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM public.actions_queue q
        WHERE q.id = action_outcomes.queue_id AND q.user_id = auth.uid()
      )
    );
  END IF;
END $$;

-- planned_transfers: planned savings or internal transfers
CREATE TABLE IF NOT EXISTS public.planned_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  note text,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','canceled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  canceled_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_planned_transfers_user_status_created ON public.planned_transfers(user_id, status, created_at DESC);
ALTER TABLE public.planned_transfers ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='planned_transfers' AND policyname='select_own_planned_transfers') THEN
    CREATE POLICY select_own_planned_transfers ON public.planned_transfers FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='planned_transfers' AND policyname='insert_own_planned_transfers') THEN
    CREATE POLICY insert_own_planned_transfers ON public.planned_transfers FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='planned_transfers' AND policyname='update_own_planned_transfers') THEN
    CREATE POLICY update_own_planned_transfers ON public.planned_transfers FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='planned_transfers' AND policyname='delete_own_planned_transfers') THEN
    CREATE POLICY delete_own_planned_transfers ON public.planned_transfers FOR DELETE USING (user_id = auth.uid());
  END IF;
END $$;

-- spend_clamps: time-bound spending clamps
CREATE TABLE IF NOT EXISTS public.spend_clamps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cap numeric NOT NULL,
  days int NOT NULL CHECK (days > 0),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','canceled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_spend_clamps_user_status ON public.spend_clamps(user_id, status);
ALTER TABLE public.spend_clamps ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='spend_clamps' AND policyname='select_own_spend_clamps') THEN
    CREATE POLICY select_own_spend_clamps ON public.spend_clamps FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='spend_clamps' AND policyname='insert_own_spend_clamps') THEN
    CREATE POLICY insert_own_spend_clamps ON public.spend_clamps FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='spend_clamps' AND policyname='update_own_spend_clamps') THEN
    CREATE POLICY update_own_spend_clamps ON public.spend_clamps FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='spend_clamps' AND policyname='delete_own_spend_clamps') THEN
    CREATE POLICY delete_own_spend_clamps ON public.spend_clamps FOR DELETE USING (user_id = auth.uid());
  END IF;
END $$;

-- subscription_reviews: user tasks to review subscriptions
CREATE TABLE IF NOT EXISTS public.subscription_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','canceled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_subscription_reviews_user_status ON public.subscription_reviews(user_id, status);
ALTER TABLE public.subscription_reviews ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='subscription_reviews' AND policyname='select_own_subscription_reviews') THEN
    CREATE POLICY select_own_subscription_reviews ON public.subscription_reviews FOR SELECT USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='subscription_reviews' AND policyname='insert_own_subscription_reviews') THEN
    CREATE POLICY insert_own_subscription_reviews ON public.subscription_reviews FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='subscription_reviews' AND policyname='update_own_subscription_reviews') THEN
    CREATE POLICY update_own_subscription_reviews ON public.subscription_reviews FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='subscription_reviews' AND policyname='delete_own_subscription_reviews') THEN
    CREATE POLICY delete_own_subscription_reviews ON public.subscription_reviews FOR DELETE USING (user_id = auth.uid());
  END IF;
END $$;

COMMIT;
