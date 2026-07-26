-- Phase 0: canonical transaction source cutover
-- Align user_transactions view with sync/categorize pipeline by reading from public.transactions.

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
WHERE t.user_id = auth.uid();

