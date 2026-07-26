-- 033_add_spending_ratio_to_scores.sql
-- Add spending_ratio column for Spending Control comparison card

BEGIN;

-- Add spending_ratio column as NULLABLE with NO DEFAULT
-- spending_ratio = spent / income (lower is better, means more controlled spending)
ALTER TABLE user_monthly_scores 
ADD COLUMN IF NOT EXISTS spending_ratio NUMERIC;

COMMENT ON COLUMN user_monthly_scores.spending_ratio IS 
'Spending to income ratio: (spent / income). Lower is better. Used for Spending Control comparison. NULL = not yet calculated.';

COMMIT;
