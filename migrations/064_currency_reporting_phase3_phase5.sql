-- ============================================================================
-- Currency Reporting Phase 3/4/5 Foundation
-- ============================================================================
-- 1) Adds currency_rebase_jobs for full-history re-normalization.
-- 2) Auto-enqueues rebase jobs whenever user_preferences.currency changes.
-- 3) Blocks direct client writes to reporting_* fields on wallet_transactions.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.currency_rebase_jobs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_currency TEXT NOT NULL CHECK (from_currency ~ '^[A-Z]{3}$'),
  to_currency TEXT NOT NULL CHECK (to_currency ~ '^[A-Z]{3}$'),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'superseded')),
  processed_rows INTEGER NOT NULL DEFAULT 0 CHECK (processed_rows >= 0),
  total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_currency_rebase_jobs_user_status
  ON public.currency_rebase_jobs (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_currency_rebase_jobs_status_created
  ON public.currency_rebase_jobs (status, created_at);

COMMENT ON TABLE public.currency_rebase_jobs IS
  'Per-user background jobs that re-normalize historical reporting fields when main currency changes.';

CREATE OR REPLACE FUNCTION public.enqueue_currency_rebase_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  old_currency TEXT;
  new_currency TEXT;
  txn_count INTEGER;
BEGIN
  old_currency := upper(coalesce(OLD.currency, ''));
  new_currency := upper(coalesce(NEW.currency, ''));

  IF new_currency !~ '^[A-Z]{3}$' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND old_currency = new_currency THEN
    RETURN NEW;
  END IF;

  IF old_currency = '' THEN
    old_currency := 'USD';
  END IF;

  UPDATE public.currency_rebase_jobs
  SET status = 'superseded',
      updated_at = now()
  WHERE user_id = NEW.user_id
    AND status IN ('queued', 'running');

  SELECT COUNT(*)::INTEGER
    INTO txn_count
  FROM public.wallet_transactions
  WHERE user_id = NEW.user_id;

  INSERT INTO public.currency_rebase_jobs (
    user_id,
    from_currency,
    to_currency,
    status,
    processed_rows,
    total_rows,
    created_at,
    updated_at
  ) VALUES (
    NEW.user_id,
    old_currency,
    new_currency,
    'queued',
    0,
    coalesce(txn_count, 0),
    now(),
    now()
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_preferences_currency_rebase ON public.user_preferences;

CREATE TRIGGER trg_user_preferences_currency_rebase
AFTER INSERT OR UPDATE OF currency
ON public.user_preferences
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_currency_rebase_job();

CREATE OR REPLACE FUNCTION public.block_client_reporting_field_writes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  jwt_role TEXT := current_setting('request.jwt.claim.role', true);
BEGIN
  IF jwt_role IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.reporting_amount IS NOT NULL
        OR NEW.reporting_currency IS NOT NULL
        OR NEW.fx_rate_used IS NOT NULL
        OR NEW.fx_requested_date IS NOT NULL
        OR NEW.fx_rate_date IS NOT NULL
        OR NEW.fx_provider IS NOT NULL
        OR NEW.reporting_version IS DISTINCT FROM 1
        OR NEW.normalized_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Direct client write to reporting fields is not allowed';
      END IF;
    ELSE
      IF NEW.reporting_amount IS DISTINCT FROM OLD.reporting_amount
        OR NEW.reporting_currency IS DISTINCT FROM OLD.reporting_currency
        OR NEW.fx_rate_used IS DISTINCT FROM OLD.fx_rate_used
        OR NEW.fx_requested_date IS DISTINCT FROM OLD.fx_requested_date
        OR NEW.fx_rate_date IS DISTINCT FROM OLD.fx_rate_date
        OR NEW.fx_provider IS DISTINCT FROM OLD.fx_provider
        OR NEW.reporting_version IS DISTINCT FROM OLD.reporting_version
        OR NEW.normalized_at IS DISTINCT FROM OLD.normalized_at
      THEN
        RAISE EXCEPTION 'Direct client write to reporting fields is not allowed';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_client_reporting_fields ON public.wallet_transactions;

CREATE TRIGGER trg_block_client_reporting_fields
BEFORE INSERT OR UPDATE
ON public.wallet_transactions
FOR EACH ROW
EXECUTE FUNCTION public.block_client_reporting_field_writes();
