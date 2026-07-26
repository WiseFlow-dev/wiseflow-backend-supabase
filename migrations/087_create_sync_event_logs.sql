-- Phase 4 reliability telemetry: per-user bank link/sync events
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.sync_event_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('plaid', 'truelayer', 'system')),
  event_name text NOT NULL CHECK (
    event_name IN (
      'link_started',
      'link_success',
      'link_failed',
      'sync_started',
      'sync_success',
      'sync_failed',
      'duplicate_prevented',
      'remap_performed'
    )
  ),
  latency_ms integer NULL CHECK (latency_ms >= 0),
  provider_ref text NULL,
  error_code text NULL,
  error_message text NULL,
  source text NOT NULL DEFAULT 'android'
);

CREATE INDEX IF NOT EXISTS idx_sync_event_logs_user_created_at
  ON public.sync_event_logs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_event_logs_provider_event
  ON public.sync_event_logs(provider, event_name, created_at DESC);

ALTER TABLE public.sync_event_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sync_event_logs_insert_own ON public.sync_event_logs;
CREATE POLICY sync_event_logs_insert_own
ON public.sync_event_logs
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS sync_event_logs_select_own ON public.sync_event_logs;
CREATE POLICY sync_event_logs_select_own
ON public.sync_event_logs
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);
