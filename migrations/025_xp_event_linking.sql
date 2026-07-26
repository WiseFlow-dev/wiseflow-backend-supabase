-- 025_xp_event_linking.sql
-- Add linking columns to wallet_transactions for XP event verification
-- Uses naming consistent with Room TransactionEntity (e.g., budgetId)

BEGIN;

-- Add linking columns (nullable, cascade deletes)
ALTER TABLE public.wallet_transactions
  ADD COLUMN IF NOT EXISTS goal_id UUID 
    REFERENCES public.goals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS debt_id UUID 
    REFERENCES public.debts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS budget_id UUID 
    REFERENCES public.budgets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_budget_rollover BOOLEAN 
    DEFAULT FALSE;

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_txn_goal_id 
  ON public.wallet_transactions(goal_id) 
  WHERE goal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_txn_debt_id 
  ON public.wallet_transactions(debt_id) 
  WHERE debt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_txn_budget_id 
  ON public.wallet_transactions(budget_id) 
  WHERE budget_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_txn_budget_rollover 
  ON public.wallet_transactions(is_budget_rollover) 
  WHERE is_budget_rollover = true;

-- Add comment for documentation
COMMENT ON COLUMN public.wallet_transactions.goal_id IS 
  'Links transaction to a goal contribution (for XP verification)';
COMMENT ON COLUMN public.wallet_transactions.debt_id IS 
  'Links transaction to a debt payment (for XP verification)';
COMMENT ON COLUMN public.wallet_transactions.budget_id IS 
  'Links transaction to a budget (matches Room TransactionEntity.budgetId)';
COMMENT ON COLUMN public.wallet_transactions.is_budget_rollover IS 
  'True if this transaction represents automatic budget leftover rollover';

COMMIT;
