CREATE TABLE IF NOT EXISTS public.finverse_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  login_identity_id text NULL,
  institution_id text NULL,
  event_type text NULL,
  event_time timestamptz NULL,
  state text NULL,
  request_method text NOT NULL,
  request_path text NOT NULL,
  query_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NULL,
  payload_raw text NOT NULL DEFAULT '',
  parse_error text NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.finverse_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can read own finverse webhook events"
  ON public.finverse_webhook_events
  FOR SELECT
  USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_finverse_webhook_events_user_received_at
  ON public.finverse_webhook_events (user_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_finverse_webhook_events_login_identity
  ON public.finverse_webhook_events (login_identity_id);

CREATE INDEX IF NOT EXISTS idx_finverse_webhook_events_event_type
  ON public.finverse_webhook_events (event_type, received_at DESC);
