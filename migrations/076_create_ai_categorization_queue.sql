-- Phase 5: queue unresolved transactions for AI batch categorization.

CREATE TABLE IF NOT EXISTS public.ai_categorization_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  txn_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  merchant_raw TEXT,
  merchant_normalized TEXT,
  amount_cents BIGINT,
  account_subtype TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result_category_key TEXT,
  result_confidence NUMERIC(3,2),
  is_suggested BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

ALTER TABLE public.ai_categorization_queue
  DROP CONSTRAINT IF EXISTS ai_categorization_queue_status_check;

ALTER TABLE public.ai_categorization_queue
  ADD CONSTRAINT ai_categorization_queue_status_check
  CHECK (status IN ('pending', 'processing', 'done', 'failed'));

ALTER TABLE public.ai_categorization_queue ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ai_categorization_queue'
      AND policyname = 'ai_categorization_queue_manage_own'
  ) THEN
    CREATE POLICY ai_categorization_queue_manage_own
      ON public.ai_categorization_queue
      FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_categorization_queue_status_created
  ON public.ai_categorization_queue (status, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_categorization_queue_txn_provider
  ON public.ai_categorization_queue (txn_id, provider);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_categorization_queue_user_txn_provider
  ON public.ai_categorization_queue (user_id, txn_id, provider);

CREATE OR REPLACE FUNCTION public.claim_ai_categorization_queue(p_limit INTEGER DEFAULT 50)
RETURNS SETOF public.ai_categorization_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_limit := GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));

  RETURN QUERY
  WITH picked AS (
    SELECT q.id
    FROM public.ai_categorization_queue q
    WHERE q.status = 'pending'
    ORDER BY q.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  )
  UPDATE public.ai_categorization_queue q
     SET status = 'processing'
   FROM picked
   WHERE q.id = picked.id
  RETURNING q.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_categorization_queue(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_ai_categorization_queue(INTEGER) TO service_role;
