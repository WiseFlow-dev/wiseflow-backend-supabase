-- 023_wisey_analytics_functions.sql
-- Phase 1: RPC Functions for wisey Analytics
-- increment_user_xp: Atomically update XP (handles first-time users)
-- get_peer_averages_by_bracket: Compute peer comparisons via JOIN

BEGIN;

/* ================================
 * increment_user_xp
 * Atomically increment user XP and calculate level
 * Handles first-time users (UPSERT)
 * SECURITY DEFINER - only callable via service role
 * ================================ */

CREATE OR REPLACE FUNCTION public.increment_user_xp(
  p_user_id UUID,
  p_xp_amount INT
)
RETURNS void AS $$
DECLARE
  v_current_xp INT;
  v_new_xp INT;
  v_new_level INT;
BEGIN
  -- UPSERT: Create row if missing (first-time user)
  INSERT INTO public.user_xp_progress (user_id, current_xp, current_level)
  VALUES (p_user_id, 0, 1)
  ON CONFLICT (user_id) DO NOTHING;
  
  -- Get current XP
  SELECT current_xp INTO v_current_xp
  FROM public.user_xp_progress
  WHERE user_id = p_user_id;
  
  -- Add new XP
  v_new_xp := v_current_xp + p_xp_amount;
  
  -- Calculate new level (1000 XP per level)
  v_new_level := FLOOR(v_new_xp / 1000) + 1;
  
  -- Update
  UPDATE public.user_xp_progress
  SET 
    current_xp = v_new_xp,
    current_level = v_new_level,
    total_xp_earned = total_xp_earned + p_xp_amount,
    last_updated = NOW()
  WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Restrict EXECUTE to prevent client-side calls
-- Only service role (via edge function) can call this
REVOKE EXECUTE ON FUNCTION public.increment_user_xp FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.increment_user_xp FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_user_xp TO service_role;

/* ================================
 * get_peer_averages_by_bracket
 * Compute peer averages by income bracket using JOIN
 * Does NOT modify analytics_user_monthly_stats
 * ================================ */

CREATE OR REPLACE FUNCTION public.get_peer_averages_by_bracket(
  p_month TEXT,
  p_bracket TEXT
)
RETURNS TABLE (
  avg_score DECIMAL,
  avg_savings_rate DECIMAL,
  peer_count INT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    AVG(ums.total_wisey_score)::DECIMAL as avg_score,
    AVG(
      CASE 
        WHEN aus.income_total > 0 
        THEN (aus.income_total - aus.spent_total) / aus.income_total 
        ELSE 0.15 
      END
    )::DECIMAL as avg_savings_rate,
    COUNT(DISTINCT ums.user_id)::INT as peer_count
  FROM public.user_monthly_scores ums
  JOIN public.analytics_user_monthly_stats aus 
    ON ums.user_id = aus.user_id 
    AND ums.month = aus.month
  WHERE ums.month = p_month
    AND aus.income_bracket = p_bracket;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.get_peer_averages_by_bracket FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_peer_averages_by_bracket TO authenticated;

COMMIT;
