BEGIN;

-- Indonesia money-movement language pack.
-- These patterns catch protected payment categories only. Indonesian transfer
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
  ('Interest Paid', 'expense', '(?:^|[^a-z0-9])(?:bunga|biaya\s+bunga|beban\s+bunga|bunga\s+pinjaman|bunga\s+kartu\s+kredit|bunga\s+kredit|denda\s+bunga)(?:$|[^a-z0-9])', 5, 'money_movement_id_interest_paid', true, now()),

  ('Buy Now Pay Later', 'expense', '(?:^|[^a-z0-9])(?:kredivo|akulaku|spaylater|shopee\s+paylater|gopaylater|go\s+paylater|traveloka\s+paylater)(?:$|[^a-z0-9])', 8, 'money_movement_id_bnpl_provider', true, now()),
  ('Buy Now Pay Later', 'expense', '(?:^|[^a-z0-9])(?:cicilan|angsuran).{0,24}(?:bayar|pembayaran|paylater|pay\s+later)(?:$|[^a-z0-9])', 18, 'money_movement_id_bnpl_installment', true, now()),
  ('Buy Now Pay Later', 'expense', '(?:^|[^a-z0-9])(?:bayar|pembayaran).{0,24}(?:cicilan|angsuran|paylater|pay\s+later)(?:$|[^a-z0-9])', 18, 'money_movement_id_bnpl_payment', true, now()),

  ('Credit Card Payment', 'expense', '(?:^|[^a-z0-9])(?:pembayaran|bayar|pelunasan|tagihan).{0,40}(?:kartu\s+kredit|cc)(?:$|[^a-z0-9])', 9, 'money_movement_id_credit_card_payment', true, now()),
  ('Credit Card Payment', 'expense', '(?:^|[^a-z0-9])(?:kartu\s+kredit|cc).{0,40}(?:pembayaran|bayar|pelunasan|tagihan)(?:$|[^a-z0-9])', 10, 'money_movement_id_credit_card_payment_reversed', true, now()),

  ('Loan Payment', 'expense', '(?:^|[^a-z0-9])(?:pembayaran|bayar|pelunasan|cicilan|angsuran).{0,40}(?:pinjaman|kredit|kpr|kredit\s+rumah|kredit\s+mobil)(?:$|[^a-z0-9])', 13, 'money_movement_id_loan_payment', true, now()),
  ('Loan Payment', 'expense', '(?:^|[^a-z0-9])(?:pinjaman|kredit|kpr|kredit\s+rumah|kredit\s+mobil).{0,40}(?:pembayaran|bayar|pelunasan|cicilan|angsuran)(?:$|[^a-z0-9])', 14, 'money_movement_id_loan_payment_reversed', true, now()),

  ('Debt', 'expense', '(?:^|[^a-z0-9])(?:utang|hutang).{0,40}(?:pembayaran|bayar|pelunasan|cicilan|angsuran|penagihan|tagihan)(?:$|[^a-z0-9])', 20, 'money_movement_id_debt_payment', true, now()),
  ('Debt', 'expense', '(?:^|[^a-z0-9])(?:pembayaran|bayar|pelunasan|cicilan|angsuran|penagihan|tagihan).{0,40}(?:utang|hutang)(?:$|[^a-z0-9])', 21, 'money_movement_id_debt_payment_reversed', true, now())
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
  seed_version = '2026-05-money-movement-id-v1',
  updated_at = now()
FROM (
  VALUES
    ('Debt', 'expense', '["utang","hutang","pelunasan utang"]'::jsonb, '["Pelunasan Utang"]'::jsonb),
    ('Buy Now Pay Later', 'expense', '["kredivo","akulaku","spaylater"]'::jsonb, '["Kredivo Payment"]'::jsonb),
    ('Interest Paid', 'expense', '["bunga","biaya bunga","bunga kartu kredit"]'::jsonb, '["Biaya Bunga"]'::jsonb),
    ('Credit Card Payment', 'expense', '["pembayaran kartu kredit","tagihan kartu kredit","pelunasan kartu kredit"]'::jsonb, '["Pembayaran Kartu Kredit"]'::jsonb),
    ('Loan Payment', 'expense', '["pembayaran pinjaman","cicilan pinjaman","angsuran kredit"]'::jsonb, '["Cicilan Pinjaman"]'::jsonb)
) AS additions(category_key, side, hints, examples)
WHERE category_ontology.category_key = additions.category_key
  AND category_ontology.side = additions.side;

COMMIT;
