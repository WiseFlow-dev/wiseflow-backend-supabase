-- 024_xp_level_curve.sql
-- Update increment_user_xp to use Option B leveling curve
-- L1-10: 250 XP per level
-- L11-30: 500 XP per level
-- L31+: 1000 XP per level

BEGIN;

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
  
  -- Calculate level using Option B curve (piecewise thresholds)
  IF v_new_xp < 2500 THEN
    -- Levels 1-10: 250 XP per level
    -- Level 1 = 0-249 XP, Level 2 = 250-499, ..., Level 10 = 2250-2499
    v_new_level := FLOOR(v_new_xp / 250.0) + 1;
  ELSIF v_new_xp < 12500 THEN
    -- Levels 11-30: 500 XP per level
    -- Level 11 starts at 2500 XP, each level needs +500 XP
    v_new_level := 10 + FLOOR((v_new_xp - 2500) / 500.0) + 1;
  ELSE
    -- Level 31+: 1000 XP per level
    -- Level 31 starts at 12500 XP, each level needs +1000 XP
    v_new_level := 30 + FLOOR((v_new_xp - 12500) / 1000.0) + 1;
  END IF;
  
  -- Update progress
  UPDATE public.user_xp_progress
  SET 
    current_xp = v_new_xp,
    current_level = v_new_level,
    total_xp_earned = total_xp_earned + p_xp_amount,
    last_updated = NOW()
  WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- No permission changes (already restricted to service role)

COMMIT;
