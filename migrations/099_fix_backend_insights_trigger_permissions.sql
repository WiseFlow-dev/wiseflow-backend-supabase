-- Fix permission failures during auth user deletion cascades.
-- Trigger functions touching backend_insights must run with owner privileges.

CREATE OR REPLACE FUNCTION public.invalidate_insights_cache()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  txn_month TEXT;
  txn_user UUID;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    txn_user := OLD.user_id;
    txn_month := TO_CHAR(OLD.date, 'YYYY-MM');
  ELSE
    txn_user := NEW.user_id;
    txn_month := TO_CHAR(NEW.date, 'YYYY-MM');
  END IF;

  DELETE FROM public.backend_insights
  WHERE user_id = txn_user
    AND month_key = txn_month;

  RAISE NOTICE 'Cache invalidated for user % month % due to transaction change', txn_user, txn_month;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_insight_state_to_cache()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
BEGIN
  UPDATE public.backend_insights
  SET
    is_snoozed = NEW.is_snoozed,
    snooze_until = NEW.snooze_until,
    is_dismissed = NEW.is_dismissed
  WHERE user_id = NEW.user_id
    AND id = NEW.insight_id;

  RAISE NOTICE 'Insight state synced for user % insight %', NEW.user_id, NEW.insight_id;
  RETURN NEW;
END;
$function$;
