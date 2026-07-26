-- Migration 102: Currency reporting fields on transactions
--
-- Phase 4.1 Fix 6 writes reporting data during Plaid/TrueLayer sync.
-- These columns mirror the wallet_transactions reporting metadata shape so
-- sync functions can persist normalized amounts without altering existing readers.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS reporting_amount NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS reporting_currency TEXT,
  ADD COLUMN IF NOT EXISTS fx_rate_used NUMERIC(18,8),
  ADD COLUMN IF NOT EXISTS fx_requested_date DATE,
  ADD COLUMN IF NOT EXISTS fx_rate_date DATE,
  ADD COLUMN IF NOT EXISTS fx_provider TEXT,
  ADD COLUMN IF NOT EXISTS reporting_version INTEGER,
  ADD COLUMN IF NOT EXISTS normalized_at TIMESTAMPTZ;

ALTER TABLE public.transactions
  ALTER COLUMN reporting_version SET DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_transactions_reporting_lookup
  ON public.transactions (user_id, reporting_currency, txn_date DESC);

COMMENT ON COLUMN public.transactions.reporting_amount IS
  'Amount converted to user main currency during bank sync when FX is available.';
COMMENT ON COLUMN public.transactions.reporting_currency IS
  'ISO 4217 currency code for reporting_amount.';
COMMENT ON COLUMN public.transactions.fx_rate_used IS
  'FX rate used for conversion when reporting_amount is populated.';
COMMENT ON COLUMN public.transactions.fx_requested_date IS
  'Requested FX lookup date (transaction effective date).';
COMMENT ON COLUMN public.transactions.fx_rate_date IS
  'Date of the FX rate returned by provider.';
COMMENT ON COLUMN public.transactions.fx_provider IS
  'FX provider identifier, e.g., frankfurter or identity.';
COMMENT ON COLUMN public.transactions.reporting_version IS
  'Reporting normalization schema version for transactions table.';
COMMENT ON COLUMN public.transactions.normalized_at IS
  'Timestamp when reporting fields were last computed.';
