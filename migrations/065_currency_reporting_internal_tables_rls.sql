-- ============================================================================
-- Currency Reporting Internal Tables - RLS Hardening
-- ============================================================================
-- Converts internal reporting tables from publicly exposed-without-RLS to
-- service-role-managed tables. End users can only read their own job/queue rows.
-- ============================================================================

ALTER TABLE public.transaction_write_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_rate_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_normalization_retry_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.currency_rebase_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fx_retry_queue_select_own ON public.fx_normalization_retry_queue;
CREATE POLICY fx_retry_queue_select_own
ON public.fx_normalization_retry_queue
FOR SELECT
TO authenticated
USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS currency_rebase_jobs_select_own ON public.currency_rebase_jobs;
CREATE POLICY currency_rebase_jobs_select_own
ON public.currency_rebase_jobs
FOR SELECT
TO authenticated
USING ((select auth.uid()) = user_id);

CREATE INDEX IF NOT EXISTS idx_fx_retry_user_id
  ON public.fx_normalization_retry_queue (user_id);
