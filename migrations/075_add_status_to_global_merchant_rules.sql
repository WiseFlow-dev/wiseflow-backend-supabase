-- Phase 5 prerequisite: rule lifecycle status for safe AI promotions.
-- Existing Phase 2/4 logic should continue to treat current rules as active.

ALTER TABLE public.global_merchant_rules
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE public.global_merchant_rules
  DROP CONSTRAINT IF EXISTS global_merchant_rules_status_check;

ALTER TABLE public.global_merchant_rules
  ADD CONSTRAINT global_merchant_rules_status_check
  CHECK (status IN ('active', 'pending_review', 'disabled'));

UPDATE public.global_merchant_rules
SET status = 'active'
WHERE status IS NULL;

CREATE INDEX IF NOT EXISTS idx_global_merchant_rules_status
  ON public.global_merchant_rules (status, confidence DESC);
