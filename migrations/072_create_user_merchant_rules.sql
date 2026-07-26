-- Phase 3: user-learned merchant rules

CREATE TABLE IF NOT EXISTS public.user_merchant_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  merchant_normalized TEXT NOT NULL,
  category_key TEXT NOT NULL,
  confidence NUMERIC(3,2) NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, merchant_normalized)
);

CREATE INDEX IF NOT EXISTS idx_user_merchant_rules_user_norm
  ON public.user_merchant_rules (user_id, merchant_normalized);

ALTER TABLE public.user_merchant_rules ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_merchant_rules'
      AND policyname = 'user_merchant_rules_manage_own'
  ) THEN
    CREATE POLICY user_merchant_rules_manage_own
      ON public.user_merchant_rules
      FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;
