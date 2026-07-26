-- Phase 3 follow-up: the Android app still writes legacy insights rows directly
-- with the authenticated user JWT. Preserve RLS while allowing own-row inserts.

DROP POLICY IF EXISTS "Users can insert own legacy insights" ON public.insights;
CREATE POLICY "Users can insert own legacy insights"
  ON public.insights
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
