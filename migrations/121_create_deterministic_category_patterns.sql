CREATE TABLE IF NOT EXISTS public.deterministic_category_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_key text NOT NULL,
  side text NOT NULL CHECK (side IN ('income', 'expense')),
  pattern_regex text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  reason text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (side, pattern_regex),
  CONSTRAINT deterministic_category_patterns_ontology_fk
    FOREIGN KEY (category_key, side)
    REFERENCES public.category_ontology (category_key, side)
    ON UPDATE CASCADE
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deterministic_category_patterns_side_priority
  ON public.deterministic_category_patterns (side, priority, is_active);

INSERT INTO public.deterministic_category_patterns (
  category_key,
  side,
  pattern_regex,
  priority,
  reason,
  is_active,
  updated_at
)
VALUES
  ('Coffee & Cafes', 'expense', '(?:^|[^\\p{L}\\p{N}])starbucks(?:$|[^\\p{L}\\p{N}])', 10, 'brand_starbucks', true, now()),
  ('Coffee & Cafes', 'expense', '(?:^|[^\\p{L}\\p{N}])flash coffee(?:$|[^\\p{L}\\p{N}])', 11, 'brand_flash_coffee', true, now()),
  ('Coffee & Cafes', 'expense', '(?:^|[^\\p{L}\\p{N}])coffee(?:$|[^\\p{L}\\p{N}])', 20, 'keyword_coffee', true, now()),
  ('Coffee & Cafes', 'expense', '(?:^|[^\\p{L}\\p{N}])cafe(?:$|[^\\p{L}\\p{N}])', 21, 'keyword_cafe', true, now()),
  ('Restaurants', 'expense', '(?:^|[^\\p{L}\\p{N}])din tai fung(?:$|[^\\p{L}\\p{N}])', 10, 'brand_din_tai_fung', true, now()),
  ('Restaurants', 'expense', '(?:^|[^\\p{L}\\p{N}])ristorante(?:$|[^\\p{L}\\p{N}])', 20, 'keyword_ristorante', true, now()),
  ('Restaurants', 'expense', '(?:^|[^\\p{L}\\p{N}])restaurant(?:$|[^\\p{L}\\p{N}])', 21, 'keyword_restaurant', true, now()),
  ('Fast Food', 'expense', '(?:^|[^\\p{L}\\p{N}])mcdonalds(?:$|[^\\p{L}\\p{N}])', 10, 'brand_mcdonalds', true, now()),
  ('Fast Food', 'expense', '(?:^|[^\\p{L}\\p{N}])subway(?:$|[^\\p{L}\\p{N}])', 11, 'brand_subway', true, now()),
  ('Movies & Events', 'expense', '(?:^|[^\\p{L}\\p{N}])cinema(?:$|[^\\p{L}\\p{N}])', 10, 'keyword_cinema', true, now()),
  ('Movies & Events', 'expense', '(?:^|[^\\p{L}\\p{N}])movie(?:$|[^\\p{L}\\p{N}])', 11, 'keyword_movie', true, now()),
  ('Streaming Services', 'expense', '(?:^|[^\\p{L}\\p{N}])spotify(?:$|[^\\p{L}\\p{N}])', 10, 'brand_spotify', true, now()),
  ('Streaming Services', 'expense', '(?:^|[^\\p{L}\\p{N}])netflix(?:$|[^\\p{L}\\p{N}])', 11, 'brand_netflix', true, now()),
  ('Flights', 'expense', '(?:^|[^\\p{L}\\p{N}])united airlines(?:$|[^\\p{L}\\p{N}])', 10, 'brand_united_airlines', true, now()),
  ('Flights', 'expense', '(?:^|[^\\p{L}\\p{N}])flight(?:$|[^\\p{L}\\p{N}])', 20, 'keyword_flight', true, now()),
  ('Internet', 'expense', '(?:^|[^\\p{L}\\p{N}])hkbn(?:$|[^\\p{L}\\p{N}])', 10, 'brand_hkbn', true, now()),
  ('Salary', 'income', '(?:^|[^\\p{L}\\p{N}])gusto pay(?:$|[^\\p{L}\\p{N}])', 10, 'brand_gusto_pay', true, now()),
  ('Salary', 'income', '(?:^|[^\\p{L}\\p{N}])salary(?:$|[^\\p{L}\\p{N}])', 20, 'keyword_salary', true, now()),
  ('Salary', 'income', '(?:^|[^\\p{L}\\p{N}])payroll(?:$|[^\\p{L}\\p{N}])', 21, 'keyword_payroll', true, now()),
  ('Public Transit', 'expense', '(?:^|[^\\p{L}\\p{N}])mtr(?:$|[^\\p{L}\\p{N}])', 10, 'brand_mtr', true, now()),
  ('Bank Fees', 'expense', '(?:^|[^\\p{L}\\p{N}])finance charge(?:$|[^\\p{L}\\p{N}])', 10, 'keyword_finance_charge', true, now()),
  ('Bank Fees', 'expense', '(?:^|[^\\p{L}\\p{N}])overseas transaction fee(?:$|[^\\p{L}\\p{N}])', 11, 'keyword_overseas_fee', true, now())
ON CONFLICT (side, pattern_regex)
DO UPDATE SET
  category_key = EXCLUDED.category_key,
  priority = EXCLUDED.priority,
  reason = EXCLUDED.reason,
  is_active = EXCLUDED.is_active,
  updated_at = now();
