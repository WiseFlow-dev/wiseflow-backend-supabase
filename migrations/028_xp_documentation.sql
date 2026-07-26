-- 028_xp_documentation.sql
-- Add documentation for XP event security requirements
-- NOTE: This migration does NOT enforce security, only documents it
-- Enforcement is currently handled in wisey-xp-events edge function

BEGIN;

-- Add comment documenting that is_budget_rollover should only be set by service role
COMMENT ON COLUMN public.wallet_transactions.is_budget_rollover IS 
  'True for automatic budget rollover transfers. MUST ONLY be set by service role (backend process), never by users. Currently enforced via wisey-xp-events validation.';

-- Add comments for XP event linking columns
COMMENT ON COLUMN public.wallet_transactions.goal_id IS 
  'Links transaction to a goal contribution. Used for goal milestone XP verification.';

COMMENT ON COLUMN public.wallet_transactions.debt_id IS 
  'Links transaction to a debt payment. Used for debt milestone XP verification.';

COMMENT ON COLUMN public.wallet_transactions.budget_id IS 
  'Links transaction to a budget. Used for budget rollover XP verification.';

-- TODO (Future Enhancement): Add trigger-based enforcement
-- This would prevent users from setting is_budget_rollover=true at the database level
-- 
-- Example implementation:
-- 
-- CREATE OR REPLACE FUNCTION check_budget_rollover_service_role()
-- RETURNS TRIGGER AS $$
-- BEGIN
--     IF NEW.is_budget_rollover = true THEN
--         -- Check if current role is service_role
--         -- This would require pg_jwt and proper service role detection
--         RAISE EXCEPTION 'Only service role can set is_budget_rollover flag';
--     END IF;
--     RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql;
-- 
-- CREATE TRIGGER prevent_user_budget_rollover
--     BEFORE INSERT OR UPDATE ON wallet_transactions
--     FOR EACH ROW
--     WHEN (NEW.is_budget_rollover = true)
--     EXECUTE FUNCTION check_budget_rollover_service_role();

COMMIT;
