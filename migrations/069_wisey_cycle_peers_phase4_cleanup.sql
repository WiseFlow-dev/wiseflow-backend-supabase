-- 069_wisey_cycle_peers_phase4_cleanup.sql
-- Phase 4 cleanup after 14-day stability window:
-- Remove legacy month-based peer RPC `get_peer_averages_by_bracket`.
-- This RPC was replaced by `get_peer_averages_by_cycle_income` in Phase 3.

BEGIN;

DO $$
DECLARE
  v_signature TEXT;
BEGIN
  FOR v_signature IN
    SELECT pg_get_function_identity_arguments(p.oid)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'get_peer_averages_by_bracket'
  LOOP
    EXECUTE format(
      'DROP FUNCTION IF EXISTS public.get_peer_averages_by_bracket(%s);',
      v_signature
    );
  END LOOP;
END;
$$;

COMMIT;

