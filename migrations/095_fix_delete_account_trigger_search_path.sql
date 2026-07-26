-- Fix delete-account failures caused by search_path-dependent function resolution
-- in transaction cache invalidation trigger.
CREATE OR REPLACE FUNCTION public.trigger_invalidate_aggregate_on_txn_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_month_key TEXT;
  v_old_month_key TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_month_key := public.get_month_key_utc(NEW.date);
    PERFORM public.invalidate_aggregate_cache(NEW.user_id, v_month_key);

    INSERT INTO public.aggregation_audit_log (user_id, month_key, operation, triggered_by, metadata)
    VALUES (NEW.user_id, v_month_key, 'invalidate', 'transaction_insert',
            jsonb_build_object('transaction_id', NEW.id));

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_month_key := public.get_month_key_utc(NEW.date);
    v_old_month_key := public.get_month_key_utc(OLD.date);

    PERFORM public.invalidate_aggregate_cache(NEW.user_id, v_month_key);

    IF v_month_key != v_old_month_key THEN
      PERFORM public.invalidate_aggregate_cache(OLD.user_id, v_old_month_key);
    END IF;

    INSERT INTO public.aggregation_audit_log (user_id, month_key, operation, triggered_by, metadata)
    VALUES (NEW.user_id, v_month_key, 'invalidate', 'transaction_update',
            jsonb_build_object('transaction_id', NEW.id, 'old_month', v_old_month_key));

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_month_key := public.get_month_key_utc(OLD.date);
    PERFORM public.invalidate_aggregate_cache(OLD.user_id, v_month_key);

    INSERT INTO public.aggregation_audit_log (user_id, month_key, operation, triggered_by, metadata)
    VALUES (OLD.user_id, v_month_key, 'invalidate', 'transaction_delete',
            jsonb_build_object('transaction_id', OLD.id));

    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$function$;
