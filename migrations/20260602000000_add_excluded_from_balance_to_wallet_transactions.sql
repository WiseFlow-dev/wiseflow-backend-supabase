-- Mirror-only imports record a transaction without it counting toward the wallet balance.
-- This permanent per-transaction marker lets the sync-time balance recompute skip these rows
-- so a "mirror only" choice survives a sync (and a cloud round-trip).
-- Additive + default false: existing rows and normal/apply-to-wallet transactions are unchanged.
ALTER TABLE public.wallet_transactions
  ADD COLUMN IF NOT EXISTS excluded_from_balance boolean NOT NULL DEFAULT false;
