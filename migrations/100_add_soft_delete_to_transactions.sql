-- Migration 100: Add soft-delete columns to transactions table
--
-- Required by Fix 2 (Phase 4.1): Plaid's removed[] transactions are now
-- soft-deleted instead of ignored. This keeps removed rows recoverable in
-- case the aggregator incorrectly marks a legitimate transaction as removed.
--
-- Filtered from all normal queries via WHERE is_removed = false (or IS NULL).
-- The partial index below keeps those queries fast at scale.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS is_removed BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

-- Partial index: only indexes non-removed rows, which is what every normal
-- query scans. Keeps the index small even as removed rows accumulate.
CREATE INDEX IF NOT EXISTS idx_transactions_is_removed
  ON transactions (is_removed)
  WHERE is_removed = false;
