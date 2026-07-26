-- ============================================================================
-- Stable Insight Snooze Keys - Phase B: Data Integrity
-- ============================================================================
-- Adds stable columns to insight_snoozes to prevent snooze breakage when
-- insight IDs change due to category renames or translations.
--
-- Key Changes:
--   - Add insight_type column (e.g., 'CATEGORY_CHANGE_UP')
--   - Add category_id column (UUID for category-specific insights)
--   - Keep old insight_id column for backward compatibility (1 month)
--   - Migrate existing snoozes (best effort)
-- ============================================================================

-- Add new columns for stable snooze keys
ALTER TABLE public.insight_snoozes
  ADD COLUMN IF NOT EXISTS insight_type TEXT,
  ADD COLUMN IF NOT EXISTS category_id UUID;

-- Create index for new stable key lookups
CREATE INDEX IF NOT EXISTS idx_insight_snoozes_stable_key
  ON public.insight_snoozes(user_id, month_key, insight_type, category_id);

-- Migrate existing snoozes (best effort)
-- Extract insight_type from insight_id patterns
UPDATE public.insight_snoozes
SET insight_type = CASE
  -- Category insights: category_jump_YYYY-MM_uuid or category_drop_YYYY-MM_uuid
  WHEN insight_id LIKE 'category_jump_%' THEN 'CATEGORY_CHANGE_UP'
  WHEN insight_id LIKE 'category_drop_%' THEN 'CATEGORY_CHANGE_DOWN'
  -- Other insight types (match actual ID prefixes from code)
  WHEN insight_id LIKE 'velocity_%' THEN 'SPENDING_VELOCITY'
  WHEN insight_id LIKE 'weekend_%' THEN 'WEEKEND_SPIKE'
  WHEN insight_id LIKE 'spike_%' THEN 'SPIKE_DAY'
  WHEN insight_id LIKE 'merchant_%' THEN 'TOP_MERCHANT'
  WHEN insight_id LIKE 'small_leaks_%' THEN 'SMALL_LEAKS'
  WHEN insight_id LIKE 'subscriptions_%' THEN 'SUBSCRIPTIONS'
  WHEN insight_id LIKE 'income_share_%' THEN 'INCOME_SHARE'
  WHEN insight_id LIKE 'time_of_day_%' THEN 'TIME_OF_DAY'
  WHEN insight_id LIKE 'goal_contrib_%' THEN 'GOAL_CONTRIB'
  ELSE NULL
END
WHERE insight_type IS NULL;

-- Extract category_id from category insight IDs
-- New format: category_jump_YYYY-MM_uuid or category_drop_YYYY-MM_uuid
-- Old format: category_jump_YYYY-MM_safe_name or category_drop_YYYY-MM_safe_name
UPDATE public.insight_snoozes
SET category_id = (
  -- Extract the part after the second underscore and month
  -- e.g., category_jump_2025-01_abc123 -> abc123
  CASE
    WHEN insight_id ~ '^category_(jump|drop)_\d{4}-\d{2}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      -- New format with UUID
      SUBSTRING(insight_id FROM '^category_(jump|drop)_\d{4}-\d{2}_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')::UUID
    ELSE NULL
  END
)
WHERE insight_type IN ('CATEGORY_CHANGE_UP', 'CATEGORY_CHANGE_DOWN')
  AND category_id IS NULL;

-- Add comment explaining the migration
COMMENT ON COLUMN public.insight_snoozes.insight_type IS 
  'Stable insight type identifier (e.g., CATEGORY_CHANGE_UP). Used for snooze matching instead of full insight_id.';

COMMENT ON COLUMN public.insight_snoozes.category_id IS 
  'Category UUID for category-specific insights. Stable across renames and translations.';

COMMENT ON COLUMN public.insight_snoozes.insight_id IS 
  'Legacy insight ID. Kept for backward compatibility. Will be deprecated after 1 month.';

-- Log migration results
DO $$
DECLARE
  v_total_snoozes INTEGER;
  v_migrated_type INTEGER;
  v_migrated_category INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_total_snoozes FROM public.insight_snoozes;
  SELECT COUNT(*) INTO v_migrated_type FROM public.insight_snoozes WHERE insight_type IS NOT NULL;
  SELECT COUNT(*) INTO v_migrated_category FROM public.insight_snoozes WHERE category_id IS NOT NULL;
  
  RAISE NOTICE 'Insight snooze migration complete:';
  RAISE NOTICE '  Total snoozes: %', v_total_snoozes;
  RAISE NOTICE '  Migrated insight_type: % (%.1f%%)', v_migrated_type, 
    CASE WHEN v_total_snoozes > 0 THEN (v_migrated_type::FLOAT / v_total_snoozes * 100) ELSE 0 END;
  RAISE NOTICE '  Migrated category_id: % (%.1f%%)', v_migrated_category,
    CASE WHEN v_total_snoozes > 0 THEN (v_migrated_category::FLOAT / v_total_snoozes * 100) ELSE 0 END;
END $$;

