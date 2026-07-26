-- Final security tail pass:
-- 1) Lock the remaining high-risk helper RPCs to service_role only.
-- 2) Narrow unlink_account to authenticated + service_role.
-- 3) Remove the production debug_jwt helper.
-- 4) Add explicit search_path to the remaining service-role-only
--    SECURITY DEFINER internals and active trigger helper.

REVOKE ALL ON FUNCTION public.upsert_monthly_aggregate(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_aggregate_cache_fresh(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_user_xp(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_user_xp_v2(UUID, INTEGER) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.upsert_monthly_aggregate(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_aggregate_cache_fresh(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_user_xp(UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_user_xp_v2(UUID, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public.unlink_account(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlink_account(UUID) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.debug_jwt();

ALTER FUNCTION public.cleanup_old_aggregates_and_cache()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.cleanup_old_llm_jobs(INTEGER)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.get_next_llm_job()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.mark_llm_job_processing(BIGINT)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.mark_llm_job_completed(BIGINT)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.mark_llm_job_failed(BIGINT, TEXT)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.trigger_invalidate_aggregate_on_txn_change()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.trigger_invalidate_aggregate_on_txn_change_v2()
  SET search_path = public, pg_catalog;
