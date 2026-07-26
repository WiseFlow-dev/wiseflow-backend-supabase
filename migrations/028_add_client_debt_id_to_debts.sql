-- Add client_debt_id to debts so Android can upsert by stable client-side ID
-- Same pattern as goals (which have client_goal_id)

ALTER TABLE debts
ADD COLUMN IF NOT EXISTS client_debt_id TEXT;

-- Create unique index for upsert on conflict
CREATE UNIQUE INDEX IF NOT EXISTS debts_user_client_debt_id_uidx
ON debts(user_id, client_debt_id)
WHERE client_debt_id IS NOT NULL;

COMMENT ON COLUMN debts.client_debt_id IS 
  'Android local debt.id for stable upsert and XP linking';
