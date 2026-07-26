-- Phase 2: DB-driven global merchant rules

CREATE TABLE IF NOT EXISTS public.global_merchant_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_normalized TEXT NOT NULL,
  category_key TEXT NOT NULL,
  confidence NUMERIC(3,2) NOT NULL DEFAULT 0.85 CHECK (confidence >= 0 AND confidence <= 1),
  country TEXT NOT NULL DEFAULT 'global',
  source TEXT NOT NULL DEFAULT 'seed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_normalized, country)
);

CREATE INDEX IF NOT EXISTS idx_global_merchant_rules_norm
  ON public.global_merchant_rules (merchant_normalized);

CREATE INDEX IF NOT EXISTS idx_global_merchant_rules_country_norm
  ON public.global_merchant_rules (country, merchant_normalized);

ALTER TABLE public.global_merchant_rules ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'global_merchant_rules'
      AND policyname = 'global_merchant_rules_public_read'
  ) THEN
    CREATE POLICY global_merchant_rules_public_read
      ON public.global_merchant_rules
      FOR SELECT
      USING (true);
  END IF;
END $$;

INSERT INTO public.global_merchant_rules (merchant_normalized, category_key, confidence, country, source)
VALUES
  ('starbucks', 'Food & Dining', 0.95, 'global', 'seed'),
  ('dunkin', 'Food & Dining', 0.95, 'global', 'seed'),
  ('tim hortons', 'Food & Dining', 0.93, 'global', 'seed'),
  ('peets', 'Food & Dining', 0.92, 'global', 'seed'),
  ('costa coffee', 'Food & Dining', 0.92, 'global', 'seed'),
  ('mcdonalds', 'Food & Dining', 0.95, 'global', 'seed'),
  ('burger king', 'Food & Dining', 0.95, 'global', 'seed'),
  ('kfc', 'Food & Dining', 0.94, 'global', 'seed'),
  ('subway', 'Food & Dining', 0.93, 'global', 'seed'),
  ('pizza hut', 'Food & Dining', 0.93, 'global', 'seed'),
  ('dominos', 'Food & Dining', 0.93, 'global', 'seed'),
  ('taco bell', 'Food & Dining', 0.92, 'global', 'seed'),
  ('chipotle', 'Food & Dining', 0.93, 'global', 'seed'),
  ('panera', 'Food & Dining', 0.91, 'global', 'seed'),
  ('olive garden', 'Food & Dining', 0.90, 'global', 'seed'),
  ('applebees', 'Food & Dining', 0.90, 'global', 'seed'),
  ('chilis', 'Food & Dining', 0.90, 'global', 'seed'),
  ('outback', 'Food & Dining', 0.89, 'global', 'seed'),
  ('red lobster', 'Food & Dining', 0.89, 'global', 'seed'),
  ('uber eats', 'Food & Dining', 0.92, 'global', 'seed'),
  ('doordash', 'Food & Dining', 0.92, 'global', 'seed'),
  ('grubhub', 'Food & Dining', 0.91, 'global', 'seed'),
  ('just eat', 'Food & Dining', 0.90, 'global', 'seed'),
  ('deliveroo', 'Food & Dining', 0.90, 'global', 'seed'),
  ('talabat', 'Food & Dining', 0.90, 'global', 'seed'),
  ('zomato', 'Food & Dining', 0.89, 'global', 'seed'),
  ('walmart', 'Shopping', 0.86, 'global', 'seed'),
  ('target', 'Shopping', 0.86, 'global', 'seed'),
  ('kroger', 'Shopping', 0.88, 'global', 'seed'),
  ('safeway', 'Shopping', 0.88, 'global', 'seed'),
  ('whole foods', 'Shopping', 0.88, 'global', 'seed'),
  ('trader joes', 'Shopping', 0.88, 'global', 'seed'),
  ('costco', 'Shopping', 0.89, 'global', 'seed'),
  ('sams club', 'Shopping', 0.88, 'global', 'seed'),
  ('aldi', 'Shopping', 0.88, 'global', 'seed'),
  ('publix', 'Shopping', 0.88, 'global', 'seed'),
  ('wegmans', 'Shopping', 0.88, 'global', 'seed'),
  ('tesco', 'Shopping', 0.89, 'global', 'seed'),
  ('sainsburys', 'Shopping', 0.89, 'global', 'seed'),
  ('asda', 'Shopping', 0.88, 'global', 'seed'),
  ('lidl', 'Shopping', 0.88, 'global', 'seed'),
  ('carrefour', 'Shopping', 0.88, 'global', 'seed'),
  ('amazon', 'Shopping', 0.78, 'global', 'seed'),
  ('amazon marketplace', 'Shopping', 0.80, 'global', 'seed'),
  ('amazon prime', 'Entertainment', 0.82, 'global', 'seed'),
  ('ebay', 'Shopping', 0.82, 'global', 'seed'),
  ('etsy', 'Shopping', 0.82, 'global', 'seed'),
  ('aliexpress', 'Shopping', 0.82, 'global', 'seed'),
  ('temu', 'Shopping', 0.80, 'global', 'seed'),
  ('paypal', 'Shopping', 0.74, 'global', 'seed'),
  ('shopify', 'Shopping', 0.74, 'global', 'seed'),
  ('apple store', 'Shopping', 0.84, 'global', 'seed'),
  ('google play', 'Entertainment', 0.83, 'global', 'seed'),
  ('steam', 'Entertainment', 0.88, 'global', 'seed'),
  ('epic games', 'Entertainment', 0.86, 'global', 'seed'),
  ('playstation', 'Entertainment', 0.86, 'global', 'seed'),
  ('xbox', 'Entertainment', 0.86, 'global', 'seed'),
  ('nintendo', 'Entertainment', 0.86, 'global', 'seed'),
  ('netflix', 'Entertainment', 0.96, 'global', 'seed'),
  ('spotify', 'Entertainment', 0.95, 'global', 'seed'),
  ('hulu', 'Entertainment', 0.95, 'global', 'seed'),
  ('disney plus', 'Entertainment', 0.95, 'global', 'seed'),
  ('max', 'Entertainment', 0.90, 'global', 'seed'),
  ('hbo max', 'Entertainment', 0.95, 'global', 'seed'),
  ('youtube premium', 'Entertainment', 0.90, 'global', 'seed'),
  ('apple music', 'Entertainment', 0.92, 'global', 'seed'),
  ('amazon music', 'Entertainment', 0.90, 'global', 'seed'),
  ('uber', 'Transportation', 0.90, 'global', 'seed'),
  ('lyft', 'Transportation', 0.90, 'global', 'seed'),
  ('careem', 'Transportation', 0.89, 'global', 'seed'),
  ('bolt', 'Transportation', 0.89, 'global', 'seed'),
  ('shell', 'Transportation', 0.92, 'global', 'seed'),
  ('exxon', 'Transportation', 0.92, 'global', 'seed'),
  ('bp', 'Transportation', 0.92, 'global', 'seed'),
  ('chevron', 'Transportation', 0.92, 'global', 'seed'),
  ('mobil', 'Transportation', 0.92, 'global', 'seed'),
  ('texaco', 'Transportation', 0.92, 'global', 'seed'),
  ('circle k', 'Transportation', 0.88, 'global', 'seed'),
  ('wawa', 'Transportation', 0.86, 'global', 'seed'),
  ('mta', 'Transportation', 0.90, 'global', 'seed'),
  ('metro', 'Transportation', 0.80, 'global', 'seed'),
  ('parking', 'Transportation', 0.82, 'global', 'seed'),
  ('verizon', 'Bills & Utilities', 0.92, 'global', 'seed'),
  ('att', 'Bills & Utilities', 0.92, 'global', 'seed'),
  ('tmobile', 'Bills & Utilities', 0.92, 'global', 'seed'),
  ('sprint', 'Bills & Utilities', 0.90, 'global', 'seed'),
  ('comcast', 'Bills & Utilities', 0.90, 'global', 'seed'),
  ('xfinity', 'Bills & Utilities', 0.90, 'global', 'seed'),
  ('spectrum', 'Bills & Utilities', 0.90, 'global', 'seed'),
  ('british gas', 'Bills & Utilities', 0.90, 'global', 'seed'),
  ('national grid', 'Bills & Utilities', 0.90, 'global', 'seed'),
  ('duke energy', 'Bills & Utilities', 0.90, 'global', 'seed'),
  ('con edison', 'Bills & Utilities', 0.90, 'global', 'seed'),
  ('water company', 'Bills & Utilities', 0.84, 'global', 'seed'),
  ('internet', 'Bills & Utilities', 0.78, 'global', 'seed'),
  ('cable', 'Bills & Utilities', 0.78, 'global', 'seed'),
  ('rent', 'Bills & Utilities', 0.82, 'global', 'seed'),
  ('mortgage', 'Bills & Utilities', 0.82, 'global', 'seed'),
  ('cvs', 'Healthcare', 0.92, 'global', 'seed'),
  ('walgreens', 'Healthcare', 0.92, 'global', 'seed'),
  ('rite aid', 'Healthcare', 0.90, 'global', 'seed'),
  ('pharmacy', 'Healthcare', 0.82, 'global', 'seed'),
  ('hospital', 'Healthcare', 0.85, 'global', 'seed'),
  ('clinic', 'Healthcare', 0.85, 'global', 'seed'),
  ('doctor', 'Healthcare', 0.85, 'global', 'seed'),
  ('dentist', 'Healthcare', 0.85, 'global', 'seed'),
  ('optical', 'Healthcare', 0.80, 'global', 'seed'),
  ('vision', 'Healthcare', 0.80, 'global', 'seed')
ON CONFLICT (merchant_normalized, country) DO UPDATE
SET
  category_key = EXCLUDED.category_key,
  confidence = EXCLUDED.confidence,
  source = EXCLUDED.source,
  updated_at = now();
