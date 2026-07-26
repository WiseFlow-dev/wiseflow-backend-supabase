-- 038_backfill_weekend_ratio.sql
-- Backfill weekend_ratio for existing user_monthly_scores rows
-- Uses same filters as the analytics function: excludes Transfer and balance-adjustment

BEGIN;

-- Calculate weekend_ratio from transactions for each user/month
UPDATE user_monthly_scores ums
SET weekend_ratio = (
    SELECT 
        CASE 
            WHEN total_spend > 0 THEN weekend_spend / total_spend
            ELSE 0
        END
    FROM (
        SELECT 
            COALESCE(SUM(CASE 
                WHEN t.amount < 0 
                AND t.category NOT IN ('Transfer', 'transfer', 'balance-adjustment', 'Balance adjustment')
                AND EXTRACT(DOW FROM t.date) IN (0, 6)  -- Sun=0, Sat=6
                THEN ABS(t.amount) 
                ELSE 0 
            END), 0) as weekend_spend,
            COALESCE(SUM(CASE 
                WHEN t.amount < 0 
                AND t.category NOT IN ('Transfer', 'transfer', 'balance-adjustment', 'Balance adjustment')
                THEN ABS(t.amount) 
                ELSE 0 
            END), 0) as total_spend
        FROM wallet_transactions t
        WHERE t.user_id = ums.user_id
          AND t.date >= (ums.month || '-01')::DATE
          AND t.date < ((ums.month || '-01')::DATE + INTERVAL '1 month')
    ) spending_calc
)
WHERE ums.weekend_ratio IS NULL;

COMMIT;
