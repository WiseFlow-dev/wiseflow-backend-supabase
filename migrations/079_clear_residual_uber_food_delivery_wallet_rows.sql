-- Follow-up cleanup:
-- Some app-facing wallet mirror rows can remain stale even after model cleanup.
-- Reset Uber (non-Eats) "Food Delivery" mirrors so next sync/refresh rewrites correctly.

UPDATE public.wallet_transactions
SET
  category = 'Uncategorized',
  category_id = NULL
WHERE
  title ILIKE 'uber%'
  AND title NOT ILIKE 'uber eats%'
  AND lower(trim(coalesce(category, ''))) = 'food delivery';
