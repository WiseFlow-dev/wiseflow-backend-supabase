-- Final: add explicit search_path to the 5 SECURITY DEFINER functions
-- locked down in the previous migration. No behavior change.

ALTER FUNCTION public.upsert_monthly_aggregate(uuid, text, text)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.is_aggregate_cache_fresh(uuid, text, text)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.increment_user_xp(uuid, integer)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.increment_user_xp_v2(uuid, integer)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.unlink_account(uuid)
  SET search_path = public, pg_catalog;
