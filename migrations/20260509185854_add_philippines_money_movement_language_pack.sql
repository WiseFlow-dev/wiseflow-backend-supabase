BEGIN;

-- Philippines / Filipino money-movement language pack.
-- These patterns catch protected payment categories only. Filipino transfer
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
  ('Interest Paid', 'expense', '(?:^|[^a-z0-9])(?:interes|interest\\s+fee|singil\\s+sa\\s+interes|bayad\\s+sa\\s+interes|interes\\s+sa\\s+utang|interes\\s+sa\\s+loan|interes\\s+sa\\s+credit\\s+card|finance\\s+charge)(?:$|[^a-z0-9])', 5, 'money_movement_ph_interest_paid', true, now()),

  ('Buy Now Pay Later', 'expense', '(?:^|[^a-z0-9])(?:billease|tala|cashalo|atome\\s+philippines|spaylater\\s+philippines|gcash\\s+ggives|ggives|gcredit)(?:$|[^a-z0-9])', 8, 'money_movement_ph_bnpl_provider', true, now()),
  ('Buy Now Pay Later', 'expense', '(?:^|[^a-z0-9])(?:bayad|pagbabayad).{0,24}(?:hulugan|installment|paylater|pay\\s+later|buy\\s+now\\s+pay\\s+later)(?:$|[^a-z0-9])', 18, 'money_movement_ph_bnpl_payment', true, now()),
  ('Buy Now Pay Later', 'expense', '(?:^|[^a-z0-9])(?:hulugan|installment\\s+plan).{0,24}(?:bayad|pagbabayad|payment)(?:$|[^a-z0-9])', 18, 'money_movement_ph_bnpl_installment', true, now()),

  ('Credit Card Payment', 'expense', '(?:^|[^a-z0-9])(?:bayad|pagbabayad|settlement|hulog).{0,40}(?:credit\\s+card|kredit\\s+card|card)(?:$|[^a-z0-9])', 9, 'money_movement_ph_credit_card_payment', true, now()),
  ('Credit Card Payment', 'expense', '(?:^|[^a-z0-9])(?:credit\\s+card|kredit\\s+card|card).{0,40}(?:bayad|pagbabayad|settlement|hulog)(?:$|[^a-z0-9])', 10, 'money_movement_ph_credit_card_payment_reversed', true, now()),

  ('Loan Payment', 'expense', '(?:^|[^a-z0-9])(?:bayad|pagbabayad|hulog|settlement).{0,40}(?:loan|pautang|home\\s+loan|car\\s+loan|personal\\s+loan)(?:$|[^a-z0-9])', 13, 'money_movement_ph_loan_payment', true, now()),
  ('Loan Payment', 'expense', '(?:^|[^a-z0-9])(?:loan|pautang|home\\s+loan|car\\s+loan|personal\\s+loan).{0,40}(?:bayad|pagbabayad|hulog|settlement)(?:$|[^a-z0-9])', 14, 'money_movement_ph_loan_payment_reversed', true, now()),

  ('Debt', 'expense', '(?:^|[^a-z0-9])(?:utang|pautang).{0,40}(?:bayad|pagbabayad|settlement|singil|koleksyon|collection)(?:$|[^a-z0-9])', 20, 'money_movement_ph_debt_payment', true, now()),
  ('Debt', 'expense', '(?:^|[^a-z0-9])(?:bayad|pagbabayad|settlement|singil|koleksyon|collection).{0,40}(?:utang|pautang)(?:$|[^a-z0-9])', 21, 'money_movement_ph_debt_payment_reversed', true, now())
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
  seed_version = '2026-05-money-movement-ph-v1',
  updated_at = now()
FROM (
  VALUES
    ('Debt', 'expense', '["utang","pautang","bayad utang"]'::jsonb, '["Bayad Utang"]'::jsonb),
    ('Buy Now Pay Later', 'expense', '["billease","tala","hulugan"]'::jsonb, '["BillEase Payment"]'::jsonb),
    ('Interest Paid', 'expense', '["interes","singil sa interes","interes sa credit card"]'::jsonb, '["Singil sa Interes"]'::jsonb),
    ('Credit Card Payment', 'expense', '["bayad credit card","pagbabayad credit card","hulog credit card"]'::jsonb, '["Bayad Credit Card"]'::jsonb),
    ('Loan Payment', 'expense', '["bayad loan","hulog loan","bayad pautang"]'::jsonb, '["Bayad Loan"]'::jsonb)
) AS additions(category_key, side, hints, examples)
WHERE category_ontology.category_key = additions.category_key
  AND category_ontology.side = additions.side;

COMMIT;
