-- ============================================
-- Migration 081: Add Uncategorized Income Category
-- Adds an income-side Uncategorized default alongside the expense version.
-- ============================================

BEGIN;

INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES (
  get_canonical_category_uuid('income', 'uncategorized-income'),
  NULL,
  'Uncategorized',
  '❓',
  '#0097A7',
  true,
  true,
  'Other Income'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
