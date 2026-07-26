BEGIN;

-- Hong Kong / Traditional Chinese money-movement language pack.
-- These are intentionally limited to protected banking categories. Transfer is
-- still evidence-gated in the Edge Function and is not created by text alone.
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
  ('Interest Paid', 'expense', '(利息|利息支出|利息收費|財務費用|透支利息|現金透支利息)', 5, 'money_movement_hk_interest_paid', true, now()),

  ('Buy Now Pay Later', 'expense', '(?:^|[^a-z0-9])(?:atome|hoolah|pace)(?:$|[^a-z0-9])', 8, 'money_movement_hk_bnpl_provider', true, now()),
  ('Buy Now Pay Later', 'expense', '(先買後付|分期付款|分期還款|分期繳款)', 8, 'money_movement_hk_bnpl_phrase', true, now()),

  ('Credit Card Payment', 'expense', '(?:^|[^a-z0-9])credit\s*card.{0,40}(?:repayment|settlement)(?:$|[^a-z0-9])', 9, 'money_movement_hk_credit_card_repayment_en', true, now()),
  ('Credit Card Payment', 'expense', '(?:^|[^a-z0-9])(?:repayment|settlement).{0,40}credit\s*card(?:$|[^a-z0-9])', 10, 'money_movement_hk_credit_card_repayment_en_reversed', true, now()),
  ('Credit Card Payment', 'expense', '(信用卡|卡數|卡賬|卡帳).{0,16}(還款|付款|繳款|自動轉賬|自動轉帳|結算)', 9, 'money_movement_hk_credit_card_payment', true, now()),
  ('Credit Card Payment', 'expense', '(還卡數|繳付信用卡|償還信用卡)', 9, 'money_movement_hk_credit_card_payment_specific', true, now()),

  ('Loan Payment', 'expense', '(貸款|按揭|私人貸款).{0,16}(還款|付款|供款|繳款)', 13, 'money_movement_hk_loan_payment', true, now()),
  ('Loan Payment', 'expense', '(還貸|供樓|按揭供款|按揭還款)', 13, 'money_movement_hk_loan_payment_specific', true, now()),

  ('Debt', 'expense', '(債務|欠款).{0,16}(還款|付款|償還|清還|結清|追討)', 20, 'money_movement_hk_debt_payment', true, now()),
  ('Debt', 'expense', '(還債|清還欠款|債務重組|追討欠款)', 20, 'money_movement_hk_debt_specific', true, now())
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
  seed_version = '2026-05-money-movement-hk-v1',
  updated_at = now()
FROM (
  VALUES
    ('Debt', 'expense', '["債務還款","欠款還款","還債"]'::jsonb, '["債務還款"]'::jsonb),
    ('Buy Now Pay Later', 'expense', '["atome","先買後付","分期付款"]'::jsonb, '["Atome Payment","分期付款"]'::jsonb),
    ('Interest Paid', 'expense', '["利息支出","利息收費","財務費用"]'::jsonb, '["利息支出"]'::jsonb),
    ('Credit Card Payment', 'expense', '["信用卡還款","還卡數","繳付信用卡"]'::jsonb, '["信用卡還款"]'::jsonb),
    ('Loan Payment', 'expense', '["貸款還款","按揭供款","還貸"]'::jsonb, '["貸款還款"]'::jsonb)
) AS additions(category_key, side, hints, examples)
WHERE category_ontology.category_key = additions.category_key
  AND category_ontology.side = additions.side;

COMMIT;
