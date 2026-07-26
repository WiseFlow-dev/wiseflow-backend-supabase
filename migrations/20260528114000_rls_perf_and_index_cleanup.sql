-- Phase 6a: database-side scaling cleanup
-- 1. Wrap hot auth.uid() RLS policies in SELECT initplans for better performance.
-- 2. Drop exact duplicate indexes / duplicate unique constraints.
-- 3. Add covering indexes for unindexed foreign keys flagged by the advisor.

-- Hot RLS policy rewrites ---------------------------------------------------

-- profiles
ALTER POLICY "Users can update their own profile" ON public.profiles
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

ALTER POLICY "Users can upsert their own profile" ON public.profiles
  WITH CHECK ((SELECT auth.uid()) = id);

ALTER POLICY "Users can view their own profile" ON public.profiles
  USING ((SELECT auth.uid()) = id);

ALTER POLICY "self profile" ON public.profiles
  USING (id = (SELECT auth.uid()));

-- accounts
ALTER POLICY acc_del ON public.accounts
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY acc_select ON public.accounts
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY acc_upd ON public.accounts
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY acc_upsert ON public.accounts
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY accounts_insert_via_item ON public.accounts
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.plaid_items pi
      WHERE pi.item_id = accounts.item_id
        AND pi.user_id = (SELECT auth.uid())
    )
  );

ALTER POLICY accounts_select_via_item ON public.accounts
  USING (
    EXISTS (
      SELECT 1
      FROM public.plaid_items pi
      WHERE pi.item_id = accounts.item_id
        AND pi.user_id = (SELECT auth.uid())
    )
  );

ALTER POLICY "own accounts" ON public.accounts
  USING (user_id = (SELECT auth.uid()));

-- plaid_items
ALTER POLICY "Allow users to insert their own Plaid items" ON public.plaid_items
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Policy with table joins" ON public.plaid_items
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY items_del ON public.plaid_items
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY items_ins ON public.plaid_items
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY items_select ON public.plaid_items
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY user_can_read_own_items ON public.plaid_items
  USING ((SELECT auth.uid()) = user_id);

-- wallets / wallet_transactions / budgets / goals / debts
ALTER POLICY "Users can delete own wallets" ON public.wallets
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can insert own wallets" ON public.wallets
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can update own wallets" ON public.wallets
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can view own wallets" ON public.wallets
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "wallets owner can all" ON public.wallets
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY "Users can delete own wallet transactions" ON public.wallet_transactions
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can insert own wallet transactions" ON public.wallet_transactions
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can update own wallet transactions" ON public.wallet_transactions
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can view own wallet transactions" ON public.wallet_transactions
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can manage their own budgets" ON public.budgets
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can manage their own goals" ON public.goals
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can manage their own debts" ON public.debts
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can manage their own subscriptions" ON public.subscriptions
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can manage their own planned payments" ON public.planned_payments
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can manage their own bills" ON public.bills
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can manage their own incomes" ON public.incomes
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can manage their own receivables" ON public.receivables
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can manage their own preferences" ON public.user_preferences
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- transactions
ALTER POLICY txn_del ON public.transactions
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY txn_select ON public.transactions
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY txn_upd ON public.transactions
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY txn_upsert ON public.transactions
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY txns_insert_via_item ON public.transactions
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.plaid_items pi
      WHERE pi.item_id = transactions.item_id
        AND pi.user_id = (SELECT auth.uid())
    )
  );

ALTER POLICY txns_select_via_item ON public.transactions
  USING (
    EXISTS (
      SELECT 1
      FROM public.plaid_items pi
      WHERE pi.item_id = transactions.item_id
        AND pi.user_id = (SELECT auth.uid())
    )
  );

-- actions and AI prefs
ALTER POLICY delete_own_proposals ON public.action_proposals
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY insert_own_proposals ON public.action_proposals
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY select_own_proposals ON public.action_proposals
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY update_own_proposals ON public.action_proposals
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY delete_own_executed ON public.executed_actions
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY insert_own_executed ON public.executed_actions
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY select_own_executed ON public.executed_actions
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY update_own_executed ON public.executed_actions
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY "Users can manage own AI preferences" ON public.user_ai_preferences
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "user can insert own ai prefs" ON public.user_ai_preferences
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "user can read own ai prefs" ON public.user_ai_preferences
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "user can update own ai prefs" ON public.user_ai_preferences
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users read own llm_jobs" ON public.llm_rewrite_queue
  USING ((SELECT auth.uid()) = user_id);

-- challenge-related hot policies
ALTER POLICY delete_own_challenge_category_policy ON public.challenge_category_policy
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY insert_own_challenge_category_policy ON public.challenge_category_policy
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY select_own_challenge_category_policy ON public.challenge_category_policy
  USING ((user_id = (SELECT auth.uid())) OR (user_id IS NULL));

ALTER POLICY update_own_challenge_category_policy ON public.challenge_category_policy
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY delete_own_challenge_events ON public.challenge_events
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY insert_own_challenge_events ON public.challenge_events
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY select_own_challenge_events ON public.challenge_events
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY update_own_challenge_events ON public.challenge_events
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY insert_own_challenge_suggestion_settings ON public.challenge_suggestion_settings
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY select_own_challenge_suggestion_settings ON public.challenge_suggestion_settings
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY update_own_challenge_suggestion_settings ON public.challenge_suggestion_settings
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY "challenges owner can all" ON public.challenges
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY delete_own_challenges ON public.challenges
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY insert_own_challenges ON public.challenges
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER POLICY select_own_challenges ON public.challenges
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY update_own_challenges ON public.challenges
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Duplicate index / constraint cleanup -------------------------------------

DROP INDEX IF EXISTS public.ix_accounts_user;
DROP INDEX IF EXISTS public.idx_actions_queue_user_status;
DROP INDEX IF EXISTS public.uq_deep_reads_user_insight;
DROP INDEX IF EXISTS public.idx_au_ms_bracket;
DROP INDEX IF EXISTS public.uq_au_ms_user_month;
DROP INDEX IF EXISTS public.uq_category_registry_key;
DROP INDEX IF EXISTS public.idx_transactions_date;
DROP INDEX IF EXISTS public.ix_transactions_user_date;
DROP INDEX IF EXISTS public.transactions_user_txn_uniq;
DROP INDEX IF EXISTS public.idx_wallets_user;

ALTER TABLE public.bills
  DROP CONSTRAINT IF EXISTS bills_user_client_id_unique;

ALTER TABLE public.incomes
  DROP CONSTRAINT IF EXISTS incomes_user_client_id_unique;

ALTER TABLE public.planned_payments
  DROP CONSTRAINT IF EXISTS planned_payments_user_client_id_unique;

ALTER TABLE public.receivables
  DROP CONSTRAINT IF EXISTS receivables_user_client_id_unique;

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_txn_id_key;

ALTER TABLE public.xp_transactions
  DROP CONSTRAINT IF EXISTS xp_transactions_user_id_reason_reference_id_key;

-- Covering indexes for unindexed foreign keys -------------------------------

CREATE INDEX IF NOT EXISTS idx_chat_memory_index_session_id
  ON public.chat_memory_index (session_id);

CREATE INDEX IF NOT EXISTS idx_deterministic_category_patterns_ontology_fk
  ON public.deterministic_category_patterns (category_key, side);

CREATE INDEX IF NOT EXISTS idx_executed_actions_proposal_id
  ON public.executed_actions (proposal_id);

CREATE INDEX IF NOT EXISTS idx_gocardless_requisitions_user_id
  ON public.gocardless_requisitions (user_id);

CREATE INDEX IF NOT EXISTS idx_planner_run_metrics_session_id
  ON public.planner_run_metrics (session_id);

CREATE INDEX IF NOT EXISTS idx_recurring_match_feedback_profile_id
  ON public.recurring_match_feedback (profile_id);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_receipt_id
  ON public.wallet_transactions (receipt_id);
