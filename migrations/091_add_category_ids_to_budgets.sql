-- Migration 091: Add category_ids column to budgets table
-- Supports multi-category budgets (one budget spanning multiple categories).
-- Uses TEXT to store a JSON array of category ID strings.
-- Nullable — existing single-category budgets are unaffected.

ALTER TABLE budgets
  ADD COLUMN IF NOT EXISTS category_ids TEXT DEFAULT NULL;

COMMENT ON COLUMN budgets.category_ids IS
  'JSON array of category ID strings for multi-category budgets. Null for single-category budgets. Example: ["cat_abc","cat_def"]';
