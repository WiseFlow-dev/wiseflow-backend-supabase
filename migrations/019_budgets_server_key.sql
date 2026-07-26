ALTER TABLE IF EXISTS budgets
ADD COLUMN IF NOT EXISTS server_key TEXT;

UPDATE budgets
SET server_key = (
  coalesce(user_id::text,'') || ':' ||
  coalesce(wallet_id::text,'') || ':' ||
  coalesce(category_id::text,'') || ':' ||
  coalesce(period,'') || ':' ||
  coalesce(start_date::text,'') || ':' ||
  coalesce(end_date::text,'') || ':' ||
  lower(coalesce(name,''))
)
WHERE server_key IS NULL;

WITH ranked AS (
  SELECT
    id,
    user_id,
    server_key,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, server_key
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id
    ) AS rn
  FROM budgets
  WHERE server_key IS NOT NULL
)
DELETE FROM budgets b
USING ranked r
WHERE b.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS budgets_user_server_key_uniq
ON budgets(user_id, server_key)
WHERE server_key IS NOT NULL;

ALTER TABLE budgets
ALTER COLUMN server_key SET NOT NULL;
