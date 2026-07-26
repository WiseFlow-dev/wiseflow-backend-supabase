ALTER TABLE public.ai_categorization_queue
ADD COLUMN IF NOT EXISTS prompt_version TEXT;

ALTER TABLE public.ai_categorization_queue
ADD COLUMN IF NOT EXISTS ai_broad_concept TEXT;

ALTER TABLE public.ai_categorization_queue
ADD COLUMN IF NOT EXISTS ai_language_detected TEXT;

ALTER TABLE public.ai_categorization_queue
ADD COLUMN IF NOT EXISTS ai_merchant_clean TEXT;

ALTER TABLE public.ai_categorization_queue
ADD COLUMN IF NOT EXISTS ai_reasoning TEXT;

ALTER TABLE public.ai_categorization_queue
ADD COLUMN IF NOT EXISTS ai_needs_review BOOLEAN;

ALTER TABLE public.ai_categorization_queue
ADD COLUMN IF NOT EXISTS ai_alternate_category TEXT;

ALTER TABLE public.ai_categorization_queue
ADD COLUMN IF NOT EXISTS ai_validation_error TEXT;

ALTER TABLE public.ai_categorization_queue
ADD COLUMN IF NOT EXISTS ai_raw_category TEXT;
