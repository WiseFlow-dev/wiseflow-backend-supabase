-- Preserve import batch identity on wallet_transactions so the local
-- "Fix imported balances" repair screen still works after cloud restore.
ALTER TABLE public.wallet_transactions
  ADD COLUMN IF NOT EXISTS import_session_id text,
  ADD COLUMN IF NOT EXISTS import_source_type text,
  ADD COLUMN IF NOT EXISTS import_fingerprint text;

