-- ============================================================================
-- Currency Reporting Phase 2 - Canonical Write Path
-- ============================================================================
-- Adds idempotency storage and FX normalization retry queue used by
-- create-transaction / update-transaction edge functions.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.transaction_write_idempotency (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  PRIMARY KEY (user_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_txn_idempotency_expires_at
  ON public.transaction_write_idempotency (expires_at);

COMMENT ON TABLE public.transaction_write_idempotency IS
  'Idempotency records for transaction create/update edge writes.';

CREATE TABLE IF NOT EXISTS public.fx_normalization_retry_queue (
  transaction_id UUID PRIMARY KEY REFERENCES public.wallet_transactions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fx_retry_next_attempt
  ON public.fx_normalization_retry_queue (next_attempt_at, user_id);

COMMENT ON TABLE public.fx_normalization_retry_queue IS
  'Queue of transactions that were saved without reporting fields because FX normalization failed.';
