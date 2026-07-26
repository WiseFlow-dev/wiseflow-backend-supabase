-- ============================================
-- Migration 020: Add UUID Category Support
-- Add category_id column to wallet_transactions
-- Backfill from existing category TEXT data
-- ============================================

-- STEP 1: Add category_id column (nullable for migration)
ALTER TABLE wallet_transactions 
ADD COLUMN IF NOT EXISTS category_id UUID;

-- Add index for performance
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_category_id 
ON wallet_transactions(category_id);

-- Add comment
COMMENT ON COLUMN wallet_transactions.category_id IS 
'UUID reference to categories table. Preferred over category TEXT for consistency.';

-- ============================================
-- STEP 2: Create helper function to get/create category UUID
-- ============================================
CREATE OR REPLACE FUNCTION get_category_id_for_user(
    p_user_id UUID,
    p_category_name TEXT,
    p_is_income BOOLEAN DEFAULT FALSE
) RETURNS UUID AS $$
DECLARE
    v_category_id UUID;
    v_normalized_name TEXT;
BEGIN
    -- Normalize the category name (title case, trimmed)
    v_normalized_name := INITCAP(LOWER(TRIM(COALESCE(p_category_name, ''))));
    
    -- Special case: empty/null -> "Other"
    IF v_normalized_name = '' THEN
        v_normalized_name := 'Other';
    END IF;
    
    -- Try to find existing category (case-insensitive match)
    SELECT id INTO v_category_id
    FROM categories
    WHERE user_id = p_user_id
      AND LOWER(TRIM(name)) = LOWER(v_normalized_name)
      AND is_income = p_is_income
    LIMIT 1;
    
    -- If not found, create it
    IF v_category_id IS NULL THEN
        INSERT INTO categories (user_id, name, is_income, is_system)
        VALUES (p_user_id, v_normalized_name, p_is_income, FALSE)
        RETURNING id INTO v_category_id;
        
        RAISE NOTICE 'Created category: % (income=%) for user %', v_normalized_name, p_is_income, p_user_id;
    END IF;
    
    RETURN v_category_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- STEP 3: Backfill category_id for existing transactions
-- ============================================
DO $$
DECLARE
    v_row RECORD;
    v_category_id UUID;
    v_is_income BOOLEAN;
    v_updated_count INTEGER := 0;
    v_total_count INTEGER;
BEGIN
    -- Get total count for progress tracking
    SELECT COUNT(*) INTO v_total_count
    FROM wallet_transactions
    WHERE category_id IS NULL;
    
    RAISE NOTICE 'Starting backfill for % transactions...', v_total_count;
    
    FOR v_row IN 
        SELECT id, user_id, category, amount
        FROM wallet_transactions
        WHERE category_id IS NULL
        ORDER BY created_at  -- Process oldest first
    LOOP
        -- Determine if income based on amount
        -- Positive amount = income, Negative = expense
        v_is_income := (v_row.amount >= 0);
        
        -- Get or create category ID
        v_category_id := get_category_id_for_user(
            v_row.user_id,
            v_row.category,
            v_is_income
        );
        
        -- Update transaction with category_id
        UPDATE wallet_transactions
        SET category_id = v_category_id
        WHERE id = v_row.id;
        
        v_updated_count := v_updated_count + 1;
        
        -- Progress logging (every 100 rows)
        IF v_updated_count % 100 = 0 THEN
            RAISE NOTICE 'Progress: % / % transactions backfilled (%.1f%%)', 
                v_updated_count, v_total_count, 
                (v_updated_count::FLOAT / v_total_count * 100);
        END IF;
    END LOOP;
    
    RAISE NOTICE '✅ Backfill complete: % / % transactions updated', v_updated_count, v_total_count;
END $$;

-- ============================================
-- STEP 4: Add foreign key constraint
-- ============================================
-- Use ON DELETE SET NULL to avoid cascade deletes breaking transactions
-- If a category is deleted, transactions keep their data but lose the UUID link
ALTER TABLE wallet_transactions
ADD CONSTRAINT fk_wallet_transactions_category_id
FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL;

-- Log success
DO $$
BEGIN
    RAISE NOTICE '✅ Foreign key constraint added: wallet_transactions.category_id -> categories.id';
END $$;

-- ============================================
-- STEP 5: Verify migration
-- ============================================
DO $$
DECLARE
    v_null_count INTEGER;
    v_total_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_null_count
    FROM wallet_transactions
    WHERE category_id IS NULL;
    
    SELECT COUNT(*) INTO v_total_count
    FROM wallet_transactions;
    
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Migration Verification:';
    RAISE NOTICE '  Total transactions: %', v_total_count;
    RAISE NOTICE '  With category_id: %', v_total_count - v_null_count;
    RAISE NOTICE '  Without category_id: %', v_null_count;
    
    IF v_null_count > 0 THEN
        RAISE WARNING '⚠️  % transactions still missing category_id - this is OK if they were created during migration', v_null_count;
    ELSE
        RAISE NOTICE '✅ All transactions have category_id!';
    END IF;
    RAISE NOTICE '========================================';
END $$;

-- ============================================
-- NOTES FOR FUTURE:
-- ============================================
-- After Android is fully migrated to send category_id:
-- 1. Make category_id NOT NULL: 
--    ALTER TABLE wallet_transactions ALTER COLUMN category_id SET NOT NULL;
-- 
-- 2. Consider deprecating category TEXT column:
--    -- Don't drop it yet - keep as fallback
--    COMMENT ON COLUMN wallet_transactions.category IS 'DEPRECATED: Use category_id instead';
