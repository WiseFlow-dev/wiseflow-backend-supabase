-- ============================================
-- Migration: Decouple bank data from Plaid-only item FK
-- Purpose:
-- 1) Allow non-Plaid providers (TrueLayer/GoCardless) to write accounts/transactions
-- 2) Keep explicit provider tagging for analytics/debugging
-- ============================================

-- 1) Drop Plaid-only foreign key coupling.
ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_item_id_fkey;

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_item_id_fkey;

-- 2) Ensure provider column exists on shared bank tables.
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS provider text;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS provider text;

-- 3) Backfill legacy rows.
UPDATE public.accounts
SET provider = 'plaid'
WHERE provider IS NULL;

UPDATE public.transactions
SET provider = 'plaid'
WHERE provider IS NULL;

-- 4) Replace provider checks with multi-provider allowlist.
ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_provider_check;

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_provider_check;

ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_provider_check
  CHECK (provider IN ('plaid', 'truelayer', 'gocardless'));

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_provider_check
  CHECK (provider IN ('plaid', 'truelayer', 'gocardless'));

