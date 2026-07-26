CREATE TABLE IF NOT EXISTS public.finverse_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  login_identity_id text NOT NULL,
  institution_id text,
  status text,
  access_token text NOT NULL,
  refresh_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, login_identity_id)
);

ALTER TABLE public.finverse_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can manage own finverse connections"
  ON public.finverse_connections
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
