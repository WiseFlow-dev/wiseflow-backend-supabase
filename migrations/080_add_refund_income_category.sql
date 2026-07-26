-- ============================================
-- Migration 080: Add Refund Income Category
-- Adds a new default income category alongside Tax Refund.
-- ============================================

BEGIN;

INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES (
  get_canonical_category_uuid('income', 'refund'),
  NULL,
  'Refund',
  '↩️',
  '#FF8A65',
  true,
  true,
  'Other Income'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
