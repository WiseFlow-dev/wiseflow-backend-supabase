-- 032_update_peer_averages_rpc.sql
-- Update get_peer_averages_by_bracket to use savings_rate_v2
-- Simple aggregation from user_monthly_scores only (no JOIN needed)

BEGIN;

DROP FUNCTION IF EXISTS public.get_peer_averages_by_bracket(TEXT, TEXT);

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
  -- Simple approach: Aggregate from user_monthly_scores
  -- Note: Income bracket filtering removed (was in analytics_user_monthly_stats)
  -- For MVP, we compare all users in the same month
  -- TODO: Add income bracket filtering if needed later
  
  RETURN QUERY
  SELECT 
    AVG(ums.total_wisey_score)::DECIMAL as avg_score,
    AVG(ums.savings_rate_v2)::DECIMAL as avg_savings_rate,
    COUNT(DISTINCT ums.user_id)::INT as peer_count
  FROM public.user_monthly_scores ums
  WHERE ums.month = p_month
    AND ums.savings_rate_v2 IS NOT NULL;  -- Exclude users with no data
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Security: Only authenticated users can call this
REVOKE EXECUTE ON FUNCTION public.get_peer_averages_by_bracket FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_peer_averages_by_bracket TO authenticated;

COMMIT;
