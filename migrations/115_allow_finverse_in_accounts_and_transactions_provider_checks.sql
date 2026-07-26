ALTER TABLE public.accounts
DROP CONSTRAINT IF EXISTS accounts_provider_check;

ALTER TABLE public.accounts
ADD CONSTRAINT accounts_provider_check
CHECK (provider = ANY (ARRAY['plaid'::text, 'truelayer'::text, 'gocardless'::text, 'finverse'::text]));

ALTER TABLE public.transactions
DROP CONSTRAINT IF EXISTS transactions_provider_check;

ALTER TABLE public.transactions
ADD CONSTRAINT transactions_provider_check
CHECK (provider = ANY (ARRAY['plaid'::text, 'truelayer'::text, 'gocardless'::text, 'finverse'::text]));
