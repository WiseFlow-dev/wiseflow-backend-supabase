-- Allow statement PDF/import rows to use bank-style provider metadata.
-- This is intentionally limited to transaction/log tables; statement imports
-- are not linked bank accounts and should not be added to account constraints.

ALTER TABLE public.transactions
DROP CONSTRAINT IF EXISTS transactions_provider_check;

ALTER TABLE public.transactions
ADD CONSTRAINT transactions_provider_check
CHECK (
  provider = ANY (
    ARRAY[
      'plaid'::text,
      'truelayer'::text,
      'gocardless'::text,
      'finverse'::text,
      'statement_import'::text
    ]
  )
);

ALTER TABLE public.wallet_transactions
DROP CONSTRAINT IF EXISTS wallet_transactions_provider_check;

ALTER TABLE public.wallet_transactions
ADD CONSTRAINT wallet_transactions_provider_check
CHECK (
  provider IS NULL
  OR provider = ANY (
    ARRAY[
      'plaid'::text,
      'truelayer'::text,
      'gocardless'::text,
      'finverse'::text,
      'statement_import'::text
    ]
  )
);

ALTER TABLE public.sync_event_logs
DROP CONSTRAINT IF EXISTS sync_event_logs_provider_check;

ALTER TABLE public.sync_event_logs
ADD CONSTRAINT sync_event_logs_provider_check
CHECK (
  provider = ANY (
    ARRAY[
      'plaid'::text,
      'truelayer'::text,
      'gocardless'::text,
      'finverse'::text,
      'statement_import'::text,
      'system'::text
    ]
  )
);
