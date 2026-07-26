-- 027_goal_debt_milestones.sql
-- Add milestone tracking columns to goals and debts tables
-- Tracks last XP milestone awarded (0, 10, 25, 50, 75, 100)

BEGIN;

-- Add milestone tracking to goals
ALTER TABLE public.goals
  ADD COLUMN IF NOT EXISTS last_milestone_awarded INT 
    DEFAULT 0 
    CHECK (last_milestone_awarded IN (0, 10, 25, 50, 75, 100));

-- Add milestone tracking to debts
ALTER TABLE public.debts
  ADD COLUMN IF NOT EXISTS last_milestone_awarded INT 
    DEFAULT 0 
    CHECK (last_milestone_awarded IN (0, 10, 25, 50, 75, 100));

-- Create indexes for milestone queries
CREATE INDEX IF NOT EXISTS idx_goals_milestone 
  ON public.goals(last_milestone_awarded);

CREATE INDEX IF NOT EXISTS idx_debts_milestone 
  ON public.debts(last_milestone_awarded);

-- Add comments for documentation
COMMENT ON COLUMN public.goals.last_milestone_awarded IS 
  'Last XP milestone % awarded (0, 10, 25, 50, 75, 100). Prevents duplicate awards.';

COMMENT ON COLUMN public.debts.last_milestone_awarded IS 
  'Last XP milestone % awarded (0, 10, 25, 50, 75, 100). Prevents duplicate awards.';

COMMIT;
