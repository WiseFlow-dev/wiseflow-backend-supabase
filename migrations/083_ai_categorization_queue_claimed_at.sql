-- Phase 1 stabilization:
-- Track claim time so stale recovery only resets genuinely stuck processing rows.

ALTER TABLE public.ai_categorization_queue
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ai_categorization_queue_status_claimed
  ON public.ai_categorization_queue (status, claimed_at);

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
     SET status = 'processing',
         claimed_at = now()
   FROM picked
   WHERE q.id = picked.id
  RETURNING q.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_categorization_queue(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_ai_categorization_queue(INTEGER) TO service_role;
