ALTER TABLE public.sync_event_logs
DROP CONSTRAINT IF EXISTS sync_event_logs_provider_check;

ALTER TABLE public.sync_event_logs
ADD CONSTRAINT sync_event_logs_provider_check
CHECK (
  provider = ANY (
    ARRAY[
      'plaid'::text,
      'truelayer'::text,
      'gocardless'::text,
      'finverse'::text,
      'system'::text
    ]
  )
);
