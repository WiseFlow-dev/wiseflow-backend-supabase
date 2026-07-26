-- 029_increment_user_xp_v2.sql
-- Add increment_user_xp_v2: returns old/new XP + level for global level-up celebration
-- Uses Option B leveling curve (same as 024_xp_level_curve.sql)

BEGIN;

CREATE OR REPLACE FUNCTION public.increment_user_xp_v2(
  p_user_id UUID,
  p_xp_amount INT
)
RETURNS TABLE (
  old_xp INT,
  new_xp INT,
  old_level INT,
  new_level INT
) AS $$
DECLARE
  v_current_xp INT;
  v_current_level INT;
  v_new_xp INT;
  v_new_level INT;
BEGIN
  -- Ensure progress row exists (first-time user)
  INSERT INTO public.user_xp_progress (user_id, current_xp, current_level, total_xp_earned)
  VALUES (p_user_id, 0, 1, 0)
  ON CONFLICT (user_id) DO NOTHING;

  -- Lock the user row to ensure concurrency safety
  SELECT current_xp, current_level
    INTO v_current_xp, v_current_level
  FROM public.user_xp_progress
  WHERE user_id = p_user_id
  FOR UPDATE;

  v_new_xp := v_current_xp + p_xp_amount;

  -- Calculate level using Option B curve (piecewise thresholds)
  IF v_new_xp < 2500 THEN
    -- Levels 1-10: 250 XP per level
    v_new_level := FLOOR(v_new_xp / 250.0) + 1;
  ELSIF v_new_xp < 12500 THEN
    -- Levels 11-30: 500 XP per level
    v_new_level := 10 + FLOOR((v_new_xp - 2500) / 500.0) + 1;
  ELSE
    -- Level 31+: 1000 XP per level
    v_new_level := 30 + FLOOR((v_new_xp - 12500) / 1000.0) + 1;
  END IF;

  UPDATE public.user_xp_progress
  SET
    current_xp = v_new_xp,
    current_level = v_new_level,
    total_xp_earned = total_xp_earned + p_xp_amount,
    last_updated = NOW()
  WHERE user_id = p_user_id;

  old_xp := v_current_xp;
  new_xp := v_new_xp;
  old_level := v_current_level;
  new_level := v_new_level;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION public.increment_user_xp_v2(UUID, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.increment_user_xp_v2(UUID, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_user_xp_v2(UUID, INT) TO service_role;

COMMIT;
