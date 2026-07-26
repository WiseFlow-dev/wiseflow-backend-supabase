-- Phase 2: prioritize claiming rows for the requesting user, then fall back to global FIFO.

DROP FUNCTION IF EXISTS public.claim_ai_categorization_queue(INTEGER);

CREATE OR REPLACE FUNCTION public.claim_ai_categorization_queue(
  p_limit INTEGER DEFAULT 50,
  p_user_id UUID DEFAULT NULL
)
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
    ORDER BY
      CASE
        WHEN p_user_id IS NOT NULL AND q.user_id = p_user_id THEN 0
        ELSE 1
      END ASC,
      q.created_at ASC
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

REVOKE ALL ON FUNCTION public.claim_ai_categorization_queue(INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_ai_categorization_queue(INTEGER, UUID) TO service_role;
