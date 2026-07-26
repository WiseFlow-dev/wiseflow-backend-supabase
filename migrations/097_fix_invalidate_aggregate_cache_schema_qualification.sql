-- Fix auth-side delete failures caused by search_path while running SECURITY DEFINER functions.
-- The function must reference public tables explicitly and enforce a safe search_path.

CREATE OR REPLACE FUNCTION public.invalidate_aggregate_cache(p_user_id uuid, p_month_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
BEGIN
  DELETE FROM public.user_monthly_spending_aggregates
  WHERE user_id = p_user_id AND month_key = p_month_key;

  DELETE FROM public.user_monthly_insights_cache
  WHERE user_id = p_user_id AND month_key = p_month_key;
END;
$function$;
