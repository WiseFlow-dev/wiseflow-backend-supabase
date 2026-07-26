-- 036_add_weekend_ratio_to_scores.sql
-- Add weekend_ratio column for Weekend Spend Share comparison card

BEGIN;

-- Add weekend_ratio column as NULLABLE with NO DEFAULT
-- weekend_ratio = weekend_spending / total_spending (lower is better)
ALTER TABLE user_monthly_scores 
ADD COLUMN IF NOT EXISTS weekend_ratio NUMERIC;

COMMENT ON COLUMN user_monthly_scores.weekend_ratio IS 
'% of spending on weekends (Sat/Sun). Lower is better. Used for Weekend Spend Share comparison.';

COMMIT;
