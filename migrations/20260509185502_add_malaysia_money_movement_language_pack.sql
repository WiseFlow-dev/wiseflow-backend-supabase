BEGIN;

-- Malaysia / Malay money-movement language pack.
-- These patterns catch protected payment categories only. Malay transfer
-- wording remains evidence-gated in the Edge Function and is not deterministic.
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
  ('Interest Paid', 'expense', '(?:^|[^a-z0-9])(?:faedah|caj\\s+faedah|bayaran\\s+faedah|faedah\\s+pinjaman|faedah\\s+kad\\s+kredit|caj\\s+kewangan|caj\\s+pembiayaan)(?:$|[^a-z0-9])', 5, 'money_movement_my_interest_paid', true, now()),

  ('Buy Now Pay Later', 'expense', '(?:^|[^a-z0-9])(?:grab\\s+paylater|grabpaylater|paylater\\s+by\\s+grab)(?:$|[^a-z0-9])', 8, 'money_movement_my_bnpl_provider', true, now()),
  ('Buy Now Pay Later', 'expense', '(?:^|[^a-z0-9])(?:beli\\s+sekarang\\s+bayar\\s+kemudian|bayar\\s+kemudian)(?:$|[^a-z0-9])', 8, 'money_movement_my_bnpl_phrase', true, now()),
  ('Buy Now Pay Later', 'expense', '(?:^|[^a-z0-9])(?:bayar|bayaran|pembayaran).{0,24}(?:ansuran|paylater|pay\\s+later|beli\\s+sekarang\\s+bayar\\s+kemudian)(?:$|[^a-z0-9])', 18, 'money_movement_my_bnpl_payment', true, now()),
  ('Buy Now Pay Later', 'expense', '(?:^|[^a-z0-9])(?:ansuran|bayaran\\s+ansuran).{0,24}(?:bayar|bayaran|pembayaran)(?:$|[^a-z0-9])', 18, 'money_movement_my_bnpl_installment', true, now()),

  ('Credit Card Payment', 'expense', '(?:^|[^a-z0-9])(?:bayaran|pembayaran|bayar|penyelesaian|jelaskan).{0,40}(?:kad\\s+kredit|cc)(?:$|[^a-z0-9])', 9, 'money_movement_my_credit_card_payment', true, now()),
  ('Credit Card Payment', 'expense', '(?:^|[^a-z0-9])(?:kad\\s+kredit|cc).{0,40}(?:bayaran|pembayaran|bayar|penyelesaian|jelaskan)(?:$|[^a-z0-9])', 10, 'money_movement_my_credit_card_payment_reversed', true, now()),

  ('Loan Payment', 'expense', '(?:^|[^a-z0-9])(?:bayaran|pembayaran|bayar|penyelesaian|ansuran).{0,40}(?:pinjaman|pembiayaan|gadai\\s+janji|pinjaman\\s+perumahan|pinjaman\\s+kereta|pinjaman\\s+peribadi)(?:$|[^a-z0-9])', 13, 'money_movement_my_loan_payment', true, now()),
  ('Loan Payment', 'expense', '(?:^|[^a-z0-9])(?:pinjaman|pembiayaan|gadai\\s+janji|pinjaman\\s+perumahan|pinjaman\\s+kereta|pinjaman\\s+peribadi).{0,40}(?:bayaran|pembayaran|bayar|penyelesaian|ansuran)(?:$|[^a-z0-9])', 14, 'money_movement_my_loan_payment_reversed', true, now()),

  ('Debt', 'expense', '(?:^|[^a-z0-9])(?:hutang|utang).{0,40}(?:bayaran|pembayaran|bayar|penyelesaian|ansuran|kutipan|tuntutan)(?:$|[^a-z0-9])', 20, 'money_movement_my_debt_payment', true, now()),
  ('Debt', 'expense', '(?:^|[^a-z0-9])(?:bayaran|pembayaran|bayar|penyelesaian|ansuran|kutipan|tuntutan).{0,40}(?:hutang|utang)(?:$|[^a-z0-9])', 21, 'money_movement_my_debt_payment_reversed', true, now())
ON CONFLICT (side, pattern_regex)
DO UPDATE SET
  category_key = EXCLUDED.category_key,
  priority = EXCLUDED.priority,
  reason = EXCLUDED.reason,
  is_active = EXCLUDED.is_active,
  updated_at = now();

UPDATE public.category_ontology
SET
  multilingual_hints = (
    SELECT jsonb_agg(DISTINCT value)
    FROM jsonb_array_elements_text(
      COALESCE(category_ontology.multilingual_hints, '[]'::jsonb) || additions.hints
    ) AS value
  ),
  examples = (
    SELECT jsonb_agg(DISTINCT value)
    FROM jsonb_array_elements_text(
      COALESCE(category_ontology.examples, '[]'::jsonb) || additions.examples
    ) AS value
  ),
  seed_version = '2026-05-money-movement-my-v1',
  updated_at = now()
FROM (
  VALUES
    ('Debt', 'expense', '["hutang","bayaran hutang","penyelesaian hutang"]'::jsonb, '["Bayaran Hutang"]'::jsonb),
    ('Buy Now Pay Later', 'expense', '["grab paylater","beli sekarang bayar kemudian","ansuran"]'::jsonb, '["Bayaran Ansuran"]'::jsonb),
    ('Interest Paid', 'expense', '["faedah","caj faedah","faedah kad kredit"]'::jsonb, '["Caj Faedah"]'::jsonb),
    ('Credit Card Payment', 'expense', '["bayaran kad kredit","pembayaran kad kredit","penyelesaian kad kredit"]'::jsonb, '["Bayaran Kad Kredit"]'::jsonb),
    ('Loan Payment', 'expense', '["bayaran pinjaman","ansuran pinjaman","bayaran pembiayaan"]'::jsonb, '["Bayaran Pinjaman"]'::jsonb)
) AS additions(category_key, side, hints, examples)
WHERE category_ontology.category_key = additions.category_key
  AND category_ontology.side = additions.side;

COMMIT;
