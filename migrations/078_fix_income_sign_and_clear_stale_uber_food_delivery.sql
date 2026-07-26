-- Phase 5 hotfix:
-- 1) sync-transactions now skips global expense rules for money-in Plaid rows.
-- 2) clear stale Uber rideshare mislabels that were written as "Food Delivery"
--    by model categorization (user overrides are preserved).

-- Clear the app-facing wallet mirror for affected users/titles so the next sync
-- rewrites these rows with the corrected categorization.
WITH affected_users AS (
  SELECT DISTINCT user_id
  FROM public.txn_categorization
  WHERE
    category_user IS NULL
    AND lower(trim(coalesce(category_model, ''))) = 'food delivery'
    AND merchant_normalized ILIKE 'uber%'
    AND merchant_normalized NOT ILIKE 'uber eats%'
)
UPDATE public.wallet_transactions wt
SET
  category = 'Uncategorized',
  category_id = NULL
WHERE
  wt.user_id IN (SELECT user_id FROM affected_users)
  AND wt.title ILIKE 'uber%'
  AND wt.title NOT ILIKE 'uber eats%'
  AND lower(trim(coalesce(wt.category, ''))) = 'food delivery';

-- Clear stale model categorizations for Uber rideshare-like merchants.
UPDATE public.txn_categorization
SET
  category_model = NULL,
  category_confidence = NULL,
  is_suggested = FALSE,
  merchant_normalized = NULL,
  updated_at = now()
WHERE
  category_user IS NULL
  AND lower(trim(coalesce(category_model, ''))) = 'food delivery'
  AND merchant_normalized ILIKE 'uber%'
  AND merchant_normalized NOT ILIKE 'uber eats%';
