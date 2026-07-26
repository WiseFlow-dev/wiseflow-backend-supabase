-- Phase 3: close exposed legacy insight/analytics tables in the public schema.
-- Keep direct client access read-only and user-scoped where needed, while
-- internal service-role Edge Functions continue to own writes.

ALTER TABLE public.insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insight_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insight_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insight_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_user_monthly_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_deep_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own legacy insights" ON public.insights;
CREATE POLICY "Users can read own legacy insights"
  ON public.insights
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can read own insight metrics" ON public.insight_metrics;
CREATE POLICY "Users can read own insight metrics"
  ON public.insight_metrics
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can read own insight feedback" ON public.insight_feedback;
CREATE POLICY "Users can read own insight feedback"
  ON public.insight_feedback
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can read own insight interactions" ON public.insight_interactions;
CREATE POLICY "Users can read own insight interactions"
  ON public.insight_interactions
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can read own monthly analytics rows" ON public.analytics_user_monthly_stats;
CREATE POLICY "Users can read own monthly analytics rows"
  ON public.analytics_user_monthly_stats
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can read own deep-read history" ON public.analytics_deep_reads;
CREATE POLICY "Users can read own deep-read history"
  ON public.analytics_deep_reads
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);
