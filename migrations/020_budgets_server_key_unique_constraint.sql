DO $$
BEGIN
  ALTER TABLE IF EXISTS budgets
  ALTER COLUMN server_key SET NOT NULL;

  DROP INDEX IF EXISTS budgets_user_server_key_uniq;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'budgets_user_server_key_unique'
  ) THEN
    ALTER TABLE budgets
    ADD CONSTRAINT budgets_user_server_key_unique UNIQUE (user_id, server_key);
  END IF;
END $$;
