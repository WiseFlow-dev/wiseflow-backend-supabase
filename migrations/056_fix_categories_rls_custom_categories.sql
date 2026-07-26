-- Enable authenticated users to manage their own custom categories.
-- Keeps canonical categories read-only.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'categories'
      AND policyname = 'read_own_custom_categories'
  ) THEN
    CREATE POLICY read_own_custom_categories
      ON public.categories
      FOR SELECT
      TO authenticated
      USING (is_system = false AND user_id = auth.uid());
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'categories'
      AND policyname = 'insert_own_custom_categories'
  ) THEN
    CREATE POLICY insert_own_custom_categories
      ON public.categories
      FOR INSERT
      TO authenticated
      WITH CHECK (is_system = false AND user_id = auth.uid());
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'categories'
      AND policyname = 'update_own_custom_categories'
  ) THEN
    CREATE POLICY update_own_custom_categories
      ON public.categories
      FOR UPDATE
      TO authenticated
      USING (is_system = false AND user_id = auth.uid())
      WITH CHECK (is_system = false AND user_id = auth.uid());
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'categories'
      AND policyname = 'delete_own_custom_categories'
  ) THEN
    CREATE POLICY delete_own_custom_categories
      ON public.categories
      FOR DELETE
      TO authenticated
      USING (is_system = false AND user_id = auth.uid());
  END IF;
END $$;

COMMIT;

