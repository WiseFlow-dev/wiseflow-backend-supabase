-- Migration: Add explicit is_wish to goals
-- Purpose: Make wish items first-class instead of inferring them from target_amount_cents
-- Date: 2026-03-12

ALTER TABLE goals
ADD COLUMN IF NOT EXISTS is_wish BOOLEAN DEFAULT false NOT NULL;

UPDATE goals
SET is_wish = true
WHERE is_wish = false
  AND is_challenge = false
  AND COALESCE(target_amount_cents, 0) <= 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'goals_is_wish_not_challenge_chk'
  ) THEN
    ALTER TABLE goals
    ADD CONSTRAINT goals_is_wish_not_challenge_chk
    CHECK (NOT (is_wish AND is_challenge));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'goals_wish_target_amount_chk'
  ) THEN
    ALTER TABLE goals
    ADD CONSTRAINT goals_wish_target_amount_chk
    CHECK (NOT is_wish OR COALESCE(target_amount_cents, 0) <= 0);
  END IF;
END $$;

COMMENT ON COLUMN goals.is_wish IS
  'True when the row is a wish item rather than a progress goal. Current app semantics require non-challenge rows with target_amount_cents <= 0.';
