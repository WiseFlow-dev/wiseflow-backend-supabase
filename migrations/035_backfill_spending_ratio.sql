-- 035_backfill_spending_ratio.sql
-- Backfill spending_ratio for existing user_monthly_scores rows
-- This calculates spending_ratio from wallet_transactions data

BEGIN;

-- For each user_monthly_scores row that has NULL spending_ratio,
-- calculate it from their transactions for that month
UPDATE user_monthly_scores ums
SET spending_ratio = (
    SELECT 
        CASE 
            WHEN COALESCE(SUM(CASE WHEN t.amount > 0 AND t.category NOT IN ('balance-adjustment', 'Balance adjustment') THEN t.amount ELSE 0 END), 0) > 0 
            THEN ABS(
                COALESCE(SUM(CASE WHEN t.amount < 0 AND t.category NOT IN ('Transfer', 'transfer', 'balance-adjustment', 'Balance adjustment') THEN t.amount ELSE 0 END), 0)
            ) / NULLIF(
                COALESCE(SUM(CASE WHEN t.amount > 0 AND t.category NOT IN ('balance-adjustment', 'Balance adjustment') THEN t.amount ELSE 0 END), 0),
                0
            )
            ELSE 0 
        END
    FROM wallet_transactions t
    WHERE t.user_id = ums.user_id
      AND t.date >= (ums.month || '-01')::DATE
      AND t.date < ((ums.month || '-01')::DATE + INTERVAL '1 month')
)
WHERE ums.spending_ratio IS NULL;

COMMIT;
