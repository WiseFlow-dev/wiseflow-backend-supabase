-- Add expense tier classification for expense categories only.
-- Values map current app UX:
--   essential | flexible_essential | discretionary

BEGIN;

ALTER TABLE public.categories
ADD COLUMN IF NOT EXISTS expense_tier TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'categories_expense_tier_chk'
  ) THEN
    ALTER TABLE public.categories
      ADD CONSTRAINT categories_expense_tier_chk
      CHECK (
        expense_tier IS NULL
        OR expense_tier IN ('essential', 'flexible_essential', 'discretionary')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'categories_expense_tier_only_for_expense_chk'
  ) THEN
    ALTER TABLE public.categories
      ADD CONSTRAINT categories_expense_tier_only_for_expense_chk
      CHECK (
        (is_income = true AND expense_tier IS NULL)
        OR (is_income = false)
      );
  END IF;
END $$;

-- Backfill existing expense rows so downstream logic has a stable value.
UPDATE public.categories
SET expense_tier = 'flexible_essential'
WHERE is_income = false
  AND expense_tier IS NULL;

-- Keep income rows clean.
UPDATE public.categories
SET expense_tier = NULL
WHERE is_income = true;

CREATE INDEX IF NOT EXISTS categories_expense_tier_idx
ON public.categories(expense_tier)
WHERE is_income = false;

COMMIT;

