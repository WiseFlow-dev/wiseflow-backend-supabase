-- Phase 4: Source-specific confidence gating support.
-- Persist whether a model-assigned category is only a suggestion.

ALTER TABLE public.txn_categorization
  ADD COLUMN IF NOT EXISTS is_suggested BOOLEAN NOT NULL DEFAULT false;

