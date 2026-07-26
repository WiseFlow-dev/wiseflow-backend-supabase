-- Migration: Add currency_code to goals table
-- Purpose: Support multi-currency goals (EUR, USD, GBP, etc.)
-- Date: 2026-01-10

-- Add currency_code column to goals table
ALTER TABLE goals
ADD COLUMN IF NOT EXISTS currency_code TEXT DEFAULT 'USD' NOT NULL;

-- Add index for currency filtering (optional but recommended)
CREATE INDEX IF NOT EXISTS idx_goals_currency_code ON goals(currency_code);

-- Add comment for documentation
COMMENT ON COLUMN goals.currency_code IS 'ISO 4217 currency code for the goal (USD, EUR, GBP, etc.)';
