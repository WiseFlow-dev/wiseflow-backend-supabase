-- Persist "Add More Categories" enabled extras per user/account
ALTER TABLE public.user_preferences
ADD COLUMN IF NOT EXISTS category_extra_expense TEXT NOT NULL DEFAULT '';

ALTER TABLE public.user_preferences
ADD COLUMN IF NOT EXISTS category_extra_income TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN public.user_preferences.category_extra_expense IS
'CSV list of normalized extra EXPENSE category names enabled by the user in Categories > Add More.';

COMMENT ON COLUMN public.user_preferences.category_extra_income IS
'CSV list of normalized extra INCOME category names enabled by the user in Categories > Add More.';

