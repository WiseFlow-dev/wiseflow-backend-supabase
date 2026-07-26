-- ============================================================================
-- Currency Reporting Phase 1 Foundation - Migration 062
-- ============================================================================
-- Adds reporting-currency columns to wallet_transactions and introduces
-- fx_rate_cache for historical FX lookups.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) wallet_transactions reporting columns
-- ----------------------------------------------------------------------------
ALTER TABLE public.wallet_transactions
  ADD COLUMN IF NOT EXISTS reporting_amount NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS reporting_currency TEXT,
  ADD COLUMN IF NOT EXISTS fx_rate_used NUMERIC(18,8),
  ADD COLUMN IF NOT EXISTS fx_requested_date DATE,
  ADD COLUMN IF NOT EXISTS fx_rate_date DATE,
  ADD COLUMN IF NOT EXISTS fx_provider TEXT,
  ADD COLUMN IF NOT EXISTS reporting_version INTEGER,
  ADD COLUMN IF NOT EXISTS normalized_at TIMESTAMPTZ;

-- Default is for new writes only; existing rows remain unchanged.
ALTER TABLE public.wallet_transactions
  ALTER COLUMN reporting_version SET DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_wt_reporting
  ON public.wallet_transactions (user_id, reporting_currency, date DESC);

-- Ensure reporting fields are either all absent or fully present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_reporting_pair'
      AND conrelid = 'public.wallet_transactions'::regclass
  ) THEN
    ALTER TABLE public.wallet_transactions
      ADD CONSTRAINT chk_reporting_pair
      CHECK (
        (reporting_amount IS NULL AND reporting_currency IS NULL)
        OR
        (reporting_amount IS NOT NULL AND reporting_currency ~ '^[A-Z]{3}$')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_reporting_fx_consistency'
      AND conrelid = 'public.wallet_transactions'::regclass
  ) THEN
    ALTER TABLE public.wallet_transactions
      ADD CONSTRAINT chk_reporting_fx_consistency
      CHECK (
        (
          reporting_amount IS NULL
          AND reporting_currency IS NULL
          AND fx_rate_used IS NULL
          AND fx_requested_date IS NULL
          AND fx_rate_date IS NULL
          AND fx_provider IS NULL
        )
        OR
        (
          reporting_amount IS NOT NULL
          AND reporting_currency ~ '^[A-Z]{3}$'
          AND fx_rate_used IS NOT NULL
          AND fx_rate_used > 0
          AND fx_requested_date IS NOT NULL
          AND fx_rate_date IS NOT NULL
          AND fx_rate_date <= fx_requested_date
          AND fx_provider IS NOT NULL
          AND length(trim(fx_provider)) > 0
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN public.wallet_transactions.reporting_amount IS
  'Converted amount in user main currency, stored for reporting.';
COMMENT ON COLUMN public.wallet_transactions.reporting_currency IS
  'ISO 4217 currency code used for reporting_amount.';
COMMENT ON COLUMN public.wallet_transactions.fx_rate_used IS
  'Historical FX rate used for conversion at write-time.';
COMMENT ON COLUMN public.wallet_transactions.fx_requested_date IS
  'Transaction effective date requested from FX provider (UTC calendar date).';
COMMENT ON COLUMN public.wallet_transactions.fx_rate_date IS
  'Actual date returned by FX provider for the applied rate.';
COMMENT ON COLUMN public.wallet_transactions.fx_provider IS
  'FX data provider identifier (for example frankfurter).';
COMMENT ON COLUMN public.wallet_transactions.reporting_version IS
  'Normalization schema version for reporting fields.';
COMMENT ON COLUMN public.wallet_transactions.normalized_at IS
  'Timestamp when reporting fields were last computed.';

-- ----------------------------------------------------------------------------
-- 2) fx_rate_cache table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fx_rate_cache (
  base TEXT NOT NULL CHECK (base ~ '^[A-Z]{3}$'),
  quote TEXT NOT NULL CHECK (quote ~ '^[A-Z]{3}$'),
  requested_date DATE NOT NULL,
  rate_date DATE NOT NULL,
  rate NUMERIC(18,8) NOT NULL CHECK (rate > 0),
  provider TEXT NOT NULL DEFAULT 'frankfurter',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (base, quote, requested_date),
  CONSTRAINT fx_rate_cache_rate_date_not_future CHECK (rate_date <= requested_date)
);

CREATE INDEX IF NOT EXISTS idx_fx_rate_cache_rate_date
  ON public.fx_rate_cache (base, quote, rate_date DESC);

COMMENT ON TABLE public.fx_rate_cache IS
  'Cache for historical FX lookups keyed by base/quote/requested_date.';
COMMENT ON COLUMN public.fx_rate_cache.requested_date IS
  'Date requested by caller (transaction effective date).';
COMMENT ON COLUMN public.fx_rate_cache.rate_date IS
  'Actual date supplied by provider; may be earlier on weekends/holidays.';
