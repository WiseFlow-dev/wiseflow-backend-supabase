-- Bucket 4: lock down the remaining exposed aggregate/rewrite RPCs and
-- backend-only observability views.
--
-- Scope:
-- 1) Remove client-callable EXECUTE from internal/helper functions that should
--    only be reachable by service_role or internal trigger/function calls.
-- 2) Remove client-visible SELECT from backend-only aggregate/observability
--    views.
-- 3) Add explicit search_path to the two still-exposed SECURITY DEFINER
--    helpers whose bodies were previously relying on implicit lookup.

ALTER FUNCTION public.compute_monthly_aggregate(UUID, TEXT, TEXT)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.enqueue_llm_rewrite(UUID, TEXT, JSONB, TEXT, TEXT)
  SET search_path = public, pg_catalog;

REVOKE ALL ON FUNCTION public.compute_monthly_aggregate(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invalidate_aggregate_cache(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_llm_rewrite(UUID, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backfill_wisey_cycle_scores(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.catch_up_wisey_cycle_scores(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_wisey_cycle_dirty_date(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_wisey_cycle_dirty_queue_from_wallet_transactions() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.compute_monthly_aggregate(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.invalidate_aggregate_cache(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_llm_rewrite(UUID, TEXT, JSONB, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.backfill_wisey_cycle_scores(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.catch_up_wisey_cycle_scores(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_wisey_cycle_dirty_date(UUID, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_wisey_cycle_dirty_queue_from_wallet_transactions() TO service_role;

ALTER VIEW public.baseline_metrics_dashboard SET (security_invoker = true);
ALTER VIEW public.txn_categorization_accuracy_by_provider SET (security_invoker = true);
ALTER VIEW public.provider_constraint_parity SET (security_invoker = true);
ALTER VIEW public.wisey_comparison_cohort_density SET (security_invoker = true);

REVOKE ALL ON TABLE public.baseline_metrics_dashboard FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.txn_categorization_accuracy_by_provider FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.provider_constraint_parity FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.wisey_comparison_cohort_density FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.baseline_metrics_dashboard TO service_role;
GRANT SELECT ON TABLE public.txn_categorization_accuracy_by_provider TO service_role;
GRANT SELECT ON TABLE public.provider_constraint_parity TO service_role;
GRANT SELECT ON TABLE public.wisey_comparison_cohort_density TO service_role;
