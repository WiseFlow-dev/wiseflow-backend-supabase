-- Allow Finverse rows in wallet_transactions mirror writes.
-- Fixes HTTP 400 / 23514 on wallet_transactions_provider_check during sync upserts.

ALTER TABLE public.wallet_transactions
DROP CONSTRAINT IF EXISTS wallet_transactions_provider_check;

ALTER TABLE public.wallet_transactions
ADD CONSTRAINT wallet_transactions_provider_check
CHECK (
  provider IS NULL
  OR provider = ANY (ARRAY['plaid'::text, 'truelayer'::text, 'gocardless'::text, 'finverse'::text])
);
