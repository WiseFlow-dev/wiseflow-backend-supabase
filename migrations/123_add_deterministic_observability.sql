ALTER TABLE public.ai_categorization_queue
ADD COLUMN IF NOT EXISTS deterministic_would_match BOOLEAN;

ALTER TABLE public.ai_categorization_queue
ADD COLUMN IF NOT EXISTS deterministic_would_match_category_key TEXT;

ALTER TABLE public.ai_categorization_queue
ADD COLUMN IF NOT EXISTS deterministic_did_apply BOOLEAN;

ALTER TABLE public.ai_categorization_queue
ADD COLUMN IF NOT EXISTS failure_stage TEXT;
