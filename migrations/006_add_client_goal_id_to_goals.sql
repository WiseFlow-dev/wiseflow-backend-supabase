-- Add client_goal_id to goals so Android can upsert by stable client-side ID
ALTER TABLE goals
ADD COLUMN IF NOT EXISTS client_goal_id TEXT;

-- Ensure (user_id, client_goal_id) is unique when client_goal_id is present
CREATE UNIQUE INDEX IF NOT EXISTS goals_user_client_goal_id_uidx
ON goals(user_id, client_goal_id)
WHERE client_goal_id IS NOT NULL;
