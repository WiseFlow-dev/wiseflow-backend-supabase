-- ============================================
-- Migration 039: Expand Category Taxonomy
-- Comprehensive 80-category system with:
-- - Canonical UUIDs (deterministic, consistent across users)
-- - Section grouping for UI organization
-- - Budgetability flags for autopilot
-- - Emoji + color assignments
-- ============================================

BEGIN;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- STEP 1: Create category key normalization function
-- ============================================
CREATE OR REPLACE FUNCTION normalize_category_key(category_name TEXT)
RETURNS TEXT AS $$
BEGIN
  -- 1. Lowercase
  -- 2. Trim whitespace
  -- 3. Replace special chars with hyphens
  -- 4. Collapse multiple hyphens
  -- 5. Remove leading/trailing hyphens
  RETURN TRIM(
    BOTH '-' FROM 
    REGEXP_REPLACE(
      REGEXP_REPLACE(
        LOWER(TRIM(category_name)),
        '[^a-z0-9]+',  -- Replace non-alphanumeric with hyphen
        '-',
        'g'
      ),
      '-+',  -- Collapse multiple hyphens
      '-',
      'g'
    )
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION normalize_category_key IS 
'Normalizes category names for consistent matching across users and platforms. Must match Android CategoryHelper.toCategoryKey() exactly.';

-- ============================================
-- STEP 2: Create canonical UUID generation function
-- ============================================
CREATE OR REPLACE FUNCTION get_canonical_category_uuid(
  p_category_type TEXT,  -- 'expense' or 'income'
  p_category_key TEXT    -- normalized key (e.g., 'groceries')
) RETURNS UUID AS $$
BEGIN
  -- Use DNS namespace UUID + deterministic seed
  RETURN uuid_generate_v5(
    '6ba7b810-9dad-11d1-80b4-00c04fd430c8'::UUID,
    p_category_type || ':' || p_category_key
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION get_canonical_category_uuid IS 
'Generates deterministic UUIDs for categories. Same category = same UUID across all users for accurate analytics.';

-- ============================================
-- STEP 3: Add section column for UI grouping
-- ============================================
ALTER TABLE categories ADD COLUMN IF NOT EXISTS section TEXT;

COMMENT ON COLUMN categories.section IS 
'UI grouping section for category picker. Not used for analytics, only for visual organization.';

-- ============================================
-- STEP 4: Insert system expense categories (65 total)
-- ============================================

-- Food & Dining (7 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('expense', 'groceries'), NULL, 'Groceries', '🛒', '#FF6B6B', false, true, 'Food & Dining'),
  (get_canonical_category_uuid('expense', 'restaurants'), NULL, 'Restaurants', '🍽️', '#FF6B6B', false, true, 'Food & Dining'),
  (get_canonical_category_uuid('expense', 'fast-food'), NULL, 'Fast Food', '🍔', '#EF5350', false, true, 'Food & Dining'),
  (get_canonical_category_uuid('expense', 'coffee-cafes'), NULL, 'Coffee & Cafes', '☕', '#B794F6', false, true, 'Food & Dining'),
  (get_canonical_category_uuid('expense', 'snacks'), NULL, 'Snacks', '🍿', '#E57373', false, true, 'Food & Dining'),
  (get_canonical_category_uuid('expense', 'alcohol-bars'), NULL, 'Alcohol & Bars', '🍺', '#FFA726', false, true, 'Food & Dining'),
  (get_canonical_category_uuid('expense', 'food-delivery'), NULL, 'Food Delivery', '🚴', '#FF8C42', false, true, 'Food & Dining')
ON CONFLICT (id) DO NOTHING;

-- Housing & Utilities (10 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('expense', 'rent'), NULL, 'Rent', '🏘️', '#FFE66D', false, true, 'Housing & Utilities'),
  (get_canonical_category_uuid('expense', 'mortgage'), NULL, 'Mortgage', '🏡', '#FFD93D', false, true, 'Housing & Utilities'),
  (get_canonical_category_uuid('expense', 'property-tax'), NULL, 'Property Tax', '🏛️', '#FFC947', false, true, 'Housing & Utilities'),
  (get_canonical_category_uuid('expense', 'home-insurance'), NULL, 'Home Insurance', '🏠', '#FFB84D', false, true, 'Housing & Utilities'),
  (get_canonical_category_uuid('expense', 'electricity'), NULL, 'Electricity', '⚡', '#607D8B', false, true, 'Housing & Utilities'),
  (get_canonical_category_uuid('expense', 'water'), NULL, 'Water', '💧', '#42A5F5', false, true, 'Housing & Utilities'),
  (get_canonical_category_uuid('expense', 'gas-heating'), NULL, 'Gas & Heating', '🔥', '#FF6F00', false, true, 'Housing & Utilities'),
  (get_canonical_category_uuid('expense', 'internet'), NULL, 'Internet', '🌐', '#1976D2', false, true, 'Housing & Utilities'),
  (get_canonical_category_uuid('expense', 'phone'), NULL, 'Phone', '📞', '#0288D1', false, true, 'Housing & Utilities'),
  (get_canonical_category_uuid('expense', 'hoa-fees'), NULL, 'HOA Fees', '🏘️', '#FFA726', false, true, 'Housing & Utilities')
ON CONFLICT (id) DO NOTHING;

-- Transportation (8 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('expense', 'gas-fuel'), NULL, 'Gas & Fuel', '⛽', '#9C27B0', false, true, 'Transportation'),
  (get_canonical_category_uuid('expense', 'car-payment'), NULL, 'Car Payment', '🚙', '#7B1FA2', false, true, 'Transportation'),
  (get_canonical_category_uuid('expense', 'car-insurance'), NULL, 'Car Insurance', '🛡️', '#6A1B9A', false, true, 'Transportation'),
  (get_canonical_category_uuid('expense', 'car-maintenance'), NULL, 'Car Maintenance', '🔧', '#4A148C', false, true, 'Transportation'),
  (get_canonical_category_uuid('expense', 'parking'), NULL, 'Parking', '🅿️', '#8E24AA', false, true, 'Transportation'),
  (get_canonical_category_uuid('expense', 'public-transit'), NULL, 'Public Transit', '🚇', '#AB47BC', false, true, 'Transportation'),
  (get_canonical_category_uuid('expense', 'rideshare'), NULL, 'Rideshare', '🚖', '#BA68C8', false, true, 'Transportation'),
  (get_canonical_category_uuid('expense', 'tolls'), NULL, 'Tolls', '🛣️', '#CE93D8', false, true, 'Transportation')
ON CONFLICT (id) DO NOTHING;

-- Health & Wellness (7 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('expense', 'health-insurance'), NULL, 'Health Insurance', '❤️‍🩹', '#009688', false, true, 'Health & Wellness'),
  (get_canonical_category_uuid('expense', 'doctor-visits'), NULL, 'Doctor Visits', '🏥', '#00897B', false, true, 'Health & Wellness'),
  (get_canonical_category_uuid('expense', 'prescriptions'), NULL, 'Prescriptions', '💊', '#00796B', false, true, 'Health & Wellness'),
  (get_canonical_category_uuid('expense', 'dental-care'), NULL, 'Dental Care', '🦷', '#26A69A', false, true, 'Health & Wellness'),
  (get_canonical_category_uuid('expense', 'vision-care'), NULL, 'Vision Care', '👓', '#4DB6AC', false, true, 'Health & Wellness'),
  (get_canonical_category_uuid('expense', 'fitness-gym'), NULL, 'Fitness & Gym', '🏋️', '#66BB6A', false, true, 'Health & Wellness'),
  (get_canonical_category_uuid('expense', 'wellness-spa'), NULL, 'Wellness & Spa', '🧖', '#80CBC4', false, true, 'Health & Wellness')
ON CONFLICT (id) DO NOTHING;

-- Entertainment & Lifestyle (8 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('expense', 'entertainment'), NULL, 'Entertainment', '🎬', '#673AB7', false, true, 'Entertainment & Lifestyle'),
  (get_canonical_category_uuid('expense', 'streaming-services'), NULL, 'Streaming Services', '📺', '#5E35B1', false, true, 'Entertainment & Lifestyle'),
  (get_canonical_category_uuid('expense', 'movies-events'), NULL, 'Movies & Events', '🎭', '#512DA8', false, true, 'Entertainment & Lifestyle'),
  (get_canonical_category_uuid('expense', 'hobbies'), NULL, 'Hobbies', '🎨', '#4527A0', false, true, 'Entertainment & Lifestyle'),
  (get_canonical_category_uuid('expense', 'games'), NULL, 'Games', '🎮', '#7E57C2', false, true, 'Entertainment & Lifestyle'),
  (get_canonical_category_uuid('expense', 'books-media'), NULL, 'Books & Media', '📚', '#9575CD', false, true, 'Entertainment & Lifestyle'),
  (get_canonical_category_uuid('expense', 'subscriptions'), NULL, 'Subscriptions', '📦', '#B39DDB', false, true, 'Entertainment & Lifestyle'),
  (get_canonical_category_uuid('expense', 'memberships'), NULL, 'Memberships', '🎫', '#D1C4E9', false, true, 'Entertainment & Lifestyle')
ON CONFLICT (id) DO NOTHING;

-- Shopping & Personal (9 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('expense', 'clothing'), NULL, 'Clothing', '👕', '#4ECDC4', false, true, 'Shopping & Personal'),
  (get_canonical_category_uuid('expense', 'shoes'), NULL, 'Shoes', '👟', '#45B7AF', false, true, 'Shopping & Personal'),
  (get_canonical_category_uuid('expense', 'accessories'), NULL, 'Accessories', '👜', '#3DA19A', false, true, 'Shopping & Personal'),
  (get_canonical_category_uuid('expense', 'beauty-cosmetics'), NULL, 'Beauty & Cosmetics', '💄', '#E91E63', false, true, 'Shopping & Personal'),
  (get_canonical_category_uuid('expense', 'hair-care'), NULL, 'Hair Care', '💇', '#D81B60', false, true, 'Shopping & Personal'),
  (get_canonical_category_uuid('expense', 'personal-care'), NULL, 'Personal Care', '🧴', '#C2185B', false, true, 'Shopping & Personal'),
  (get_canonical_category_uuid('expense', 'laundry-dry-cleaning'), NULL, 'Laundry & Dry Cleaning', '🧺', '#AD1457', false, true, 'Shopping & Personal'),
  (get_canonical_category_uuid('expense', 'shopping'), NULL, 'Shopping', '🛍️', '#42A5F5', false, true, 'Shopping & Personal'),
  (get_canonical_category_uuid('expense', 'electronics'), NULL, 'Electronics', '💻', '#1E88E5', false, true, 'Shopping & Personal')
ON CONFLICT (id) DO NOTHING;

-- Family & Dependents (5 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('expense', 'childcare'), NULL, 'Childcare', '👶', '#795548', false, true, 'Family & Dependents'),
  (get_canonical_category_uuid('expense', 'child-support'), NULL, 'Child Support', '👨‍👩‍👧', '#6D4C41', false, true, 'Family & Dependents'),
  (get_canonical_category_uuid('expense', 'education'), NULL, 'Education', '🎓', '#38B6FF', false, true, 'Family & Dependents'),
  (get_canonical_category_uuid('expense', 'school-supplies'), NULL, 'School Supplies', '📝', '#29A6EF', false, true, 'Family & Dependents'),
  (get_canonical_category_uuid('expense', 'pet-care'), NULL, 'Pet Care', '🐾', '#8D6E63', false, true, 'Family & Dependents')
ON CONFLICT (id) DO NOTHING;

-- Home & Maintenance (5 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('expense', 'furniture'), NULL, 'Furniture', '🛋️', '#A1887F', false, true, 'Home & Maintenance'),
  (get_canonical_category_uuid('expense', 'home-improvement'), NULL, 'Home Improvement', '🔨', '#8D6E63', false, true, 'Home & Maintenance'),
  (get_canonical_category_uuid('expense', 'lawn-garden'), NULL, 'Lawn & Garden', '🌱', '#558B2F', false, true, 'Home & Maintenance'),
  (get_canonical_category_uuid('expense', 'cleaning-supplies'), NULL, 'Cleaning Supplies', '🧹', '#689F38', false, true, 'Home & Maintenance'),
  (get_canonical_category_uuid('expense', 'home-services'), NULL, 'Home Services', '🔧', '#7CB342', false, true, 'Home & Maintenance')
ON CONFLICT (id) DO NOTHING;

-- Professional & Financial (6 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('expense', 'office-supplies'), NULL, 'Office Supplies', '📎', '#546E7A', false, true, 'Professional & Financial'),
  (get_canonical_category_uuid('expense', 'professional-services'), NULL, 'Professional Services', '💼', '#455A64', false, true, 'Professional & Financial'),
  (get_canonical_category_uuid('expense', 'bank-fees'), NULL, 'Bank Fees', '🏦', '#37474F', false, true, 'Professional & Financial'),
  (get_canonical_category_uuid('expense', 'credit-card-fees'), NULL, 'Credit Card Fees', '💳', '#263238', false, true, 'Professional & Financial'),
  (get_canonical_category_uuid('expense', 'taxes'), NULL, 'Taxes', '📋', '#607D8B', false, true, 'Professional & Financial'),
  (get_canonical_category_uuid('expense', 'insurance-other'), NULL, 'Insurance (Other)', '🛡️', '#78909C', false, true, 'Professional & Financial')
ON CONFLICT (id) DO NOTHING;

-- Travel & Vacation (4 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('expense', 'travel'), NULL, 'Travel', '✈️', '#3F51B5', false, true, 'Travel & Vacation'),
  (get_canonical_category_uuid('expense', 'hotels-lodging'), NULL, 'Hotels & Lodging', '🏨', '#3949AB', false, true, 'Travel & Vacation'),
  (get_canonical_category_uuid('expense', 'flights'), NULL, 'Flights', '✈️', '#303F9F', false, true, 'Travel & Vacation'),
  (get_canonical_category_uuid('expense', 'vacation'), NULL, 'Vacation', '🏖️', '#5C6BC0', false, true, 'Travel & Vacation')
ON CONFLICT (id) DO NOTHING;

-- Gifts & Donations (3 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('expense', 'gifts'), NULL, 'Gifts', '🎁', '#FF6B9D', false, true, 'Gifts & Donations'),
  (get_canonical_category_uuid('expense', 'charity-donations'), NULL, 'Charity & Donations', '💝', '#FF4081', false, true, 'Gifts & Donations'),
  (get_canonical_category_uuid('expense', 'religious-donations'), NULL, 'Religious Donations', '⛪', '#F50057', false, true, 'Gifts & Donations')
ON CONFLICT (id) DO NOTHING;

-- Other (3 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('expense', 'software-apps'), NULL, 'Software & Apps', '💿', '#00BCD4', false, true, 'Other'),
  (get_canonical_category_uuid('expense', 'atm-withdrawals'), NULL, 'ATM Withdrawals', '💵', '#00ACC1', false, true, 'Other'),
  (get_canonical_category_uuid('expense', 'uncategorized'), NULL, 'Uncategorized', '❓', '#0097A7', false, true, 'Other'),
  (get_canonical_category_uuid('expense', 'other'), NULL, 'Other', '…', '#78909C', false, true, 'Other')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- STEP 5: Insert system income categories (15 total)
-- ============================================

-- Employment Income (3 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('income', 'salary'), NULL, 'Salary', '💰', '#4CAF50', true, true, 'Employment Income'),
  (get_canonical_category_uuid('income', 'hourly-wages'), NULL, 'Hourly Wages', '⏰', '#66BB6A', true, true, 'Employment Income'),
  (get_canonical_category_uuid('income', 'bonus'), NULL, 'Bonus', '🎯', '#81C784', true, true, 'Employment Income')
ON CONFLICT (id) DO NOTHING;

-- Business & Freelance (3 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('income', 'freelance'), NULL, 'Freelance', '💼', '#8BC34A', true, true, 'Business & Freelance'),
  (get_canonical_category_uuid('income', 'business'), NULL, 'Business', '🏢', '#9CCC65', true, true, 'Business & Freelance'),
  (get_canonical_category_uuid('income', 'side-hustle'), NULL, 'Side Hustle', '🚀', '#AED581', true, true, 'Business & Freelance')
ON CONFLICT (id) DO NOTHING;

-- Investments & Passive (4 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('income', 'investment'), NULL, 'Investment', '📈', '#2196F3', true, true, 'Investments & Passive'),
  (get_canonical_category_uuid('income', 'dividends'), NULL, 'Dividends', '💹', '#42A5F5', true, true, 'Investments & Passive'),
  (get_canonical_category_uuid('income', 'interest'), NULL, 'Interest', '🏦', '#64B5F6', true, true, 'Investments & Passive'),
  (get_canonical_category_uuid('income', 'rental-income'), NULL, 'Rental Income', '🏠', '#90CAF9', true, true, 'Investments & Passive')
ON CONFLICT (id) DO NOTHING;

-- Other Income (5 categories)
INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
VALUES
  (get_canonical_category_uuid('income', 'tax-refund'), NULL, 'Tax Refund', '💸', '#FFA726', true, true, 'Other Income'),
  (get_canonical_category_uuid('income', 'cashback-rewards'), NULL, 'Cashback & Rewards', '🏆', '#FFB74D', true, true, 'Other Income'),
  (get_canonical_category_uuid('income', 'gifts'), NULL, 'Gifts', '🎁', '#FFCC80', true, true, 'Other Income'),
  (get_canonical_category_uuid('income', 'reimbursements'), NULL, 'Reimbursements', '💳', '#FFE082', true, true, 'Other Income'),
  (get_canonical_category_uuid('income', 'other-income'), NULL, 'Other Income', '…', '#78909C', true, true, 'Other Income')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- STEP 6: Seed budgetability flags
-- ============================================

-- Discretionary categories (budgetable=true)
INSERT INTO category_budget_policy (user_id, category_key, is_budgetable)
VALUES
  -- Food & Dining (all budgetable)
  (NULL, 'groceries', true),
  (NULL, 'restaurants', true),
  (NULL, 'fast-food', true),
  (NULL, 'coffee-cafes', true),
  (NULL, 'snacks', true),
  (NULL, 'alcohol-bars', true),
  (NULL, 'food-delivery', true),
  
  -- Entertainment (all budgetable)
  (NULL, 'entertainment', true),
  (NULL, 'streaming-services', true),
  (NULL, 'movies-events', true),
  (NULL, 'hobbies', true),
  (NULL, 'games', true),
  (NULL, 'books-media', true),
  (NULL, 'subscriptions', true),
  (NULL, 'memberships', true),
  
  -- Shopping & Personal (all budgetable)
  (NULL, 'clothing', true),
  (NULL, 'shoes', true),
  (NULL, 'accessories', true),
  (NULL, 'beauty-cosmetics', true),
  (NULL, 'hair-care', true),
  (NULL, 'personal-care', true),
  (NULL, 'shopping', true),
  (NULL, 'electronics', true),
  
  -- Transportation (variable costs only)
  (NULL, 'gas-fuel', true),
  (NULL, 'parking', true),
  (NULL, 'public-transit', true),
  (NULL, 'rideshare', true),
  (NULL, 'tolls', true),
  
  -- Wellness (discretionary)
  (NULL, 'fitness-gym', true),
  (NULL, 'wellness-spa', true),
  
  -- Discretionary other
  (NULL, 'gifts', true),
  (NULL, 'charity-donations', true),
  (NULL, 'religious-donations', true),
  (NULL, 'travel', true),
  (NULL, 'hotels-lodging', true),
  (NULL, 'flights', true),
  (NULL, 'vacation', true),
  (NULL, 'software-apps', true)
ON CONFLICT (user_id, category_key) DO NOTHING;

-- Essential categories (budgetable=false)
INSERT INTO category_budget_policy (user_id, category_key, is_budgetable)
VALUES
  -- Housing (all essential)
  (NULL, 'rent', false),
  (NULL, 'mortgage', false),
  (NULL, 'property-tax', false),
  (NULL, 'home-insurance', false),
  (NULL, 'electricity', false),
  (NULL, 'water', false),
  (NULL, 'gas-heating', false),
  (NULL, 'internet', false),
  (NULL, 'phone', false),
  (NULL, 'hoa-fees', false),
  
  -- Transportation (fixed costs)
  (NULL, 'car-payment', false),
  (NULL, 'car-insurance', false),
  (NULL, 'car-maintenance', false),
  
  -- Healthcare (all essential)
  (NULL, 'health-insurance', false),
  (NULL, 'doctor-visits', false),
  (NULL, 'prescriptions', false),
  (NULL, 'dental-care', false),
  (NULL, 'vision-care', false),
  
  -- Family (essential obligations)
  (NULL, 'childcare', false),
  (NULL, 'child-support', false),
  
  -- Financial (essential)
  (NULL, 'bank-fees', false),
  (NULL, 'credit-card-fees', false),
  (NULL, 'taxes', false),
  (NULL, 'insurance-other', false),
  (NULL, 'professional-services', false)
ON CONFLICT (user_id, category_key) DO NOTHING;

-- Context-dependent (budgetable=true, user can override)
INSERT INTO category_budget_policy (user_id, category_key, is_budgetable)
VALUES
  (NULL, 'education', true),
  (NULL, 'school-supplies', true),
  (NULL, 'pet-care', true),
  (NULL, 'furniture', true),
  (NULL, 'home-improvement', true),
  (NULL, 'lawn-garden', true),
  (NULL, 'cleaning-supplies', true),
  (NULL, 'home-services', true),
  (NULL, 'laundry-dry-cleaning', true),
  (NULL, 'office-supplies', true),
  (NULL, 'atm-withdrawals', true),
  (NULL, 'uncategorized', true),
  (NULL, 'other', true)
ON CONFLICT (user_id, category_key) DO NOTHING;

-- ============================================
-- STEP 7: Backfill existing users
-- ============================================
DO $$
DECLARE
  v_user_record RECORD;
  v_added_count INTEGER := 0;
BEGIN
  RAISE NOTICE 'Starting category backfill for existing users...';
  
  FOR v_user_record IN (SELECT id FROM auth.users)
  LOOP
    -- Insert system categories that user doesn't already have
    INSERT INTO categories (id, user_id, name, icon_key, color, is_income, is_system, section)
    SELECT 
      get_canonical_category_uuid(
        CASE WHEN sc.is_income THEN 'income' ELSE 'expense' END,
        normalize_category_key(sc.name)
      ),
      v_user_record.id,
      sc.name,
      sc.icon_key,
      sc.color,
      sc.is_income,
      true,  -- is_system
      sc.section
    FROM categories sc
    WHERE sc.user_id IS NULL  -- System categories
      AND sc.is_system = true
      AND NOT EXISTS (
        -- Skip if user already has this category (case-insensitive match)
        SELECT 1 FROM categories uc
        WHERE uc.user_id = v_user_record.id
          AND normalize_category_key(uc.name) = normalize_category_key(sc.name)
          AND uc.is_income = sc.is_income
      )
    ON CONFLICT (id) DO NOTHING;
    
    GET DIAGNOSTICS v_added_count = ROW_COUNT;
    
    IF v_added_count > 0 THEN
      RAISE NOTICE 'Added % categories for user %', v_added_count, v_user_record.id;
    END IF;
  END LOOP;
  
  RAISE NOTICE '✅ Category backfill complete';
END $$;

-- ============================================
-- STEP 8: Verification
-- ============================================
DO $$
DECLARE
  v_system_expense_count INTEGER;
  v_system_income_count INTEGER;
  v_budgetable_count INTEGER;
  v_non_budgetable_count INTEGER;
BEGIN
  -- Count system categories
  SELECT COUNT(*) INTO v_system_expense_count
  FROM categories
  WHERE is_system = true AND user_id IS NULL AND is_income = false;
  
  SELECT COUNT(*) INTO v_system_income_count
  FROM categories
  WHERE is_system = true AND user_id IS NULL AND is_income = true;
  
  -- Count budgetability flags
  SELECT COUNT(*) INTO v_budgetable_count
  FROM category_budget_policy
  WHERE is_budgetable = true AND user_id IS NULL;
  
  SELECT COUNT(*) INTO v_non_budgetable_count
  FROM category_budget_policy
  WHERE is_budgetable = false AND user_id IS NULL;
  
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Migration 039 Verification:';
  RAISE NOTICE '  System expense categories: %', v_system_expense_count;
  RAISE NOTICE '  System income categories: %', v_system_income_count;
  RAISE NOTICE '  Budgetable categories: %', v_budgetable_count;
  RAISE NOTICE '  Non-budgetable categories: %',v_non_budgetable_count;
  RAISE NOTICE '========================================';
  
  -- Validate counts
  IF v_system_expense_count < 65 THEN
    RAISE WARNING '⚠️  Expected 65+ expense categories, found %', v_system_expense_count;
  END IF;
  
  IF v_system_income_count < 15 THEN
    RAISE WARNING '⚠️  Expected 15 income categories, found %', v_system_income_count;
  END IF;
  
  RAISE NOTICE '✅ Migration 039 complete';
END $$;

COMMIT;
