-- 026_budgets_rollover_destination.sql
-- Add leftover_destination_wallet_id to budgets table
-- Matches Android Budget model field: leftoverDestinationWalletId

BEGIN;

-- Add rollover destination column
ALTER TABLE public.budgets
  ADD COLUMN IF NOT EXISTS leftover_destination_wallet_id UUID 
    REFERENCES public.wallets(id) ON DELETE SET NULL;

-- Create index for efficient rollover queries
CREATE INDEX IF NOT EXISTS idx_budgets_rollover_destination 
  ON public.budgets(leftover_destination_wallet_id) 
  WHERE leftover_destination_wallet_id IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.budgets.leftover_destination_wallet_id IS 
  'Wallet where budget leftovers are automatically transferred when period ends';

COMMIT;
