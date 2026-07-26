-- Phase 6b: second low-risk RLS performance sweep
-- Wrap additional simple auth.uid() policies and remove exact duplicate policies.

-- Additional auth.uid() initplan wrappers -----------------------------------

ALTER POLICY account_filters_delete_own ON public.account_filters
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY account_filters_insert_own ON public.account_filters
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY account_filters_select_own ON public.account_filters
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY delete_own_action_rule_settings ON public.action_rule_settings
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY insert_own_action_rule_settings ON public.action_rule_settings
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY select_own_or_global_action_rule_settings ON public.action_rule_settings
  USING ((user_id = (SELECT auth.uid())) OR (user_id IS NULL));

ALTER POLICY update_own_action_rule_settings ON public.action_rule_settings
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY delete_own_actions_queue ON public.actions_queue
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY insert_own_actions_queue ON public.actions_queue
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY insert_own_queue ON public.actions_queue
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY select_own_actions_queue ON public.actions_queue
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY select_own_queue ON public.actions_queue
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY update_own_actions_queue ON public.actions_queue
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY insert_own_budget_suggestion_settings ON public.budget_suggestion_settings
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY select_own_budget_suggestion_settings ON public.budget_suggestion_settings
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY update_own_budget_suggestion_settings ON public.budget_suggestion_settings
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY delete_own_custom_categories ON public.categories
  USING ((is_system = false) AND (user_id = (SELECT auth.uid())));

ALTER POLICY insert_own_custom_categories ON public.categories
  WITH CHECK ((is_system = false) AND (user_id = (SELECT auth.uid())));

ALTER POLICY read_own_custom_categories ON public.categories
  USING ((is_system = false) AND (user_id = (SELECT auth.uid())));

ALTER POLICY update_own_custom_categories ON public.categories
  USING ((is_system = false) AND (user_id = (SELECT auth.uid())))
  WITH CHECK ((is_system = false) AND (user_id = (SELECT auth.uid())));

ALTER POLICY "Users can delete own requisitions" ON public.gocardless_requisitions
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can insert own requisitions" ON public.gocardless_requisitions
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can update own requisitions" ON public.gocardless_requisitions
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can view own requisitions" ON public.gocardless_requisitions
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY delete_own_insight_snoozes ON public.insight_snoozes
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY insert_own_insight_snoozes ON public.insight_snoozes
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY select_own_insight_snoozes ON public.insight_snoozes
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY update_own_insight_snoozes ON public.insight_snoozes
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY delete_own_planned_transfers ON public.planned_transfers
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY insert_own_planned_transfers ON public.planned_transfers
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY select_own_planned_transfers ON public.planned_transfers
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY select_own_transfers ON public.planned_transfers
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY update_own_planned_transfers ON public.planned_transfers
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY delete_own_tokens ON public.push_tokens
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY insert_own_tokens ON public.push_tokens
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY select_own_tokens ON public.push_tokens
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY update_own_tokens ON public.push_tokens
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY "Receipts: delete own" ON public.receipts
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "Receipts: insert own" ON public.receipts
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Receipts: read own" ON public.receipts
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "Receipts: update own" ON public.receipts
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY delete_own_spending_insight_feedback ON public.spending_insight_feedback
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY insert_own_spending_insight_feedback ON public.spending_insight_feedback
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY select_own_spending_insight_feedback ON public.spending_insight_feedback
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY update_own_spending_insight_feedback ON public.spending_insight_feedback
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY delete_own_spending_insight_snoozes ON public.spending_insight_snoozes
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY insert_own_spending_insight_snoozes ON public.spending_insight_snoozes
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY select_own_spending_insight_snoozes ON public.spending_insight_snoozes
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY update_own_spending_insight_snoozes ON public.spending_insight_snoozes
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY delete_own_subscription_reviews ON public.subscription_reviews
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY insert_own_subscription_reviews ON public.subscription_reviews
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY select_own_sub_reviews ON public.subscription_reviews
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY select_own_subscription_reviews ON public.subscription_reviews
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY update_own_subscription_reviews ON public.subscription_reviews
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY "Users can delete own connections" ON public.truelayer_connections
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can insert own connections" ON public.truelayer_connections
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can update own connections" ON public.truelayer_connections
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can view own connections" ON public.truelayer_connections
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY user_settings_delete_own ON public.user_settings
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY user_settings_insert_own ON public.user_settings
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY user_settings_select_own ON public.user_settings
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY user_settings_update_own ON public.user_settings
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- Exact duplicate permissive-policy cleanup ---------------------------------

DROP POLICY IF EXISTS "self profile" ON public.profiles;
DROP POLICY IF EXISTS "own accounts" ON public.accounts;
DROP POLICY IF EXISTS items_ins ON public.plaid_items;
DROP POLICY IF EXISTS user_can_read_own_items ON public.plaid_items;
DROP POLICY IF EXISTS "wallets owner can all" ON public.wallets;
DROP POLICY IF EXISTS "user can insert own ai prefs" ON public.user_ai_preferences;
DROP POLICY IF EXISTS "user can read own ai prefs" ON public.user_ai_preferences;
DROP POLICY IF EXISTS "user can update own ai prefs" ON public.user_ai_preferences;
DROP POLICY IF EXISTS "challenges owner can all" ON public.challenges;
DROP POLICY IF EXISTS insert_own_queue ON public.actions_queue;
DROP POLICY IF EXISTS select_own_queue ON public.actions_queue;
DROP POLICY IF EXISTS select_own_transfers ON public.planned_transfers;
DROP POLICY IF EXISTS select_own_sub_reviews ON public.subscription_reviews;
