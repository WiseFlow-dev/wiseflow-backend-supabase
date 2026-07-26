-- Migration 101: Hide soft-deleted transactions from user_transactions view
--
-- Migration 100 added is_removed + removed_at columns to the transactions table.
-- This migration updates the user_transactions view so that soft-deleted rows
-- are invisible to all callers that read through the view (Android sync,
-- categorization pipeline, AI queries, etc.).
--
-- Rows that are soft-deleted (is_removed = true) must not appear in any normal
-- query. The OR IS NULL guard handles rows that existed before migration 100
-- where the column is still NULL (equivalent to not removed).

CREATE OR REPLACE VIEW public.user_transactions AS
SELECT
  t.txn_id AS id,
  t.account_id,
  t.txn_date AS date,
  t.name,
  t.amount,
  t.currency,
  COALESCE(NULLIF(t.merchant_name, ''), t.merchant) AS merchant,
  tc.category_model,
  tc.category_user,
  t.pending
FROM public.transactions t
LEFT JOIN public.txn_categorization tc
  ON tc.user_id = t.user_id
 AND tc.txn_id = t.txn_id
WHERE t.user_id = auth.uid()
  AND (t.is_removed = false OR t.is_removed IS NULL);
