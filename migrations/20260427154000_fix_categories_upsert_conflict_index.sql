-- Replace the partial user-category unique index with a full-table unique index
-- so PostgREST can infer ON CONFLICT (user_id, name, is_income) correctly.
-- PostgreSQL still allows multiple NULL user_id rows, so system categories remain valid.

DROP INDEX IF EXISTS public.uq_categories_user_name_income;

CREATE UNIQUE INDEX uq_categories_user_name_income
ON public.categories (user_id, name, is_income);
