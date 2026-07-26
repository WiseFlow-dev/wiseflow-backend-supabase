BEGIN;

-- Add savings_rate_v2 column as NULLABLE with NO DEFAULT
-- This ensures only users who run analytics get a real value
-- Historical rows stay NULL and are excluded from peer averages
ALTER TABLE user_monthly_scores 
ADD COLUMN IF NOT EXISTS savings_rate_v2 NUMERIC;

COMMENT ON COLUMN user_monthly_scores.savings_rate_v2 IS 
'Wallet-based savings rate: (net savings wallet change / income). Used for peer comparisons. NULL = not yet calculated.';

COMMIT;
