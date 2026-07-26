ALTER TABLE public.ai_categorization_queue
  ADD COLUMN IF NOT EXISTS result_source TEXT;

DELETE FROM public.deterministic_category_patterns
WHERE category_key = 'Public Transit'
  AND side = 'expense'
  AND reason = 'brand_hk_mtr';
