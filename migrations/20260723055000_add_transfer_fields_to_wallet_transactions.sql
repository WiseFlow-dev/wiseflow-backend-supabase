-- Forward migration: add internal-transfer tracking fields to wallet_transactions.
-- internal_transfer_group_id is TEXT (not UUID) because Android creates IDs
-- shaped "itf_<16 hex chars>" (e.g. "itf_0123456789abcdef") which are not
-- valid UUIDs.
ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS is_internal_transfer         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS internal_transfer_group_id   TEXT    NULL,
  ADD COLUMN IF NOT EXISTS user_dismissed_transfer_pair BOOLEAN NOT NULL DEFAULT FALSE;
