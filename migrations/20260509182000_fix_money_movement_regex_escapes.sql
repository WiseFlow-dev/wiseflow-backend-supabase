BEGIN;

-- The first guardrail migration accidentally stored several whitespace escapes
-- as literal "\\s". Replace all money-movement patterns with the intended regexes.
DELETE FROM public.deterministic_category_patterns
WHERE reason LIKE 'money_movement_%';

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
  ('Interest Paid', 'expense', '(?:^|[^a-z0-9])finance\s+charge(?:$|[^a-z0-9])', 5, 'money_movement_interest_finance_charge', true, now()),
  ('Interest Paid', 'expense', '(?:^|[^a-z0-9])interest.{0,24}(?:charge|charged|paid|payment|fee)(?:$|[^a-z0-9])', 6, 'money_movement_interest_charge', true, now()),
  ('Interest Paid', 'expense', '(?:^|[^a-z0-9])(?:apr\s+interest|purchase\s+interest|cash\s+advance\s+interest|loan\s+interest|overdraft\s+interest)(?:$|[^a-z0-9])', 7, 'money_movement_interest_specific', true, now()),

  ('Buy Now Pay Later', 'expense', '(?:^|[^a-z0-9])(?:klarna|afterpay|affirm|tabby|tamara|sezzle|clearpay|zip\s+pay|zip\s+co|paylater|pay\s+later)(?:$|[^a-z0-9])', 8, 'money_movement_bnpl_provider', true, now()),
  ('Buy Now Pay Later', 'expense', '(?:^|[^a-z0-9])(?:installment|instalment).{0,24}(?:payment|repayment|pmt)(?:$|[^a-z0-9])', 18, 'money_movement_bnpl_installment', true, now()),

  ('Credit Card Payment', 'expense', '(?:^|[^a-z0-9])credit\s*card.{0,40}(?:payment|pmt|autopay|auto\s+pay)(?:$|[^a-z0-9])', 9, 'money_movement_credit_card_payment', true, now()),
  ('Credit Card Payment', 'expense', '(?:^|[^a-z0-9])(?:payment|pmt|autopay|auto\s+pay).{0,40}credit\s*card(?:$|[^a-z0-9])', 10, 'money_movement_credit_card_payment_reversed', true, now()),
  ('Credit Card Payment', 'expense', '(?:^|[^a-z0-9])(?:cc|cardmember|card\s+member|amex|american\s+express|visa|mastercard|master\s+card).{0,32}(?:payment|pmt|autopay|auto\s+pay)(?:$|[^a-z0-9])', 11, 'money_movement_card_issuer_payment', true, now()),
  ('Credit Card Payment', 'expense', '(?:^|[^a-z0-9])(?:payment|pmt|autopay|auto\s+pay).{0,32}(?:amex|american\s+express|visa|mastercard|master\s+card)(?:$|[^a-z0-9])', 12, 'money_movement_card_issuer_payment_reversed', true, now()),

  ('Loan Payment', 'expense', '(?:^|[^a-z0-9])loan.{0,40}(?:payment|repayment|pmt|autopay|auto\s+pay)(?:$|[^a-z0-9])', 13, 'money_movement_loan_payment', true, now()),
  ('Loan Payment', 'expense', '(?:^|[^a-z0-9])(?:payment|repayment|pmt|autopay|auto\s+pay).{0,40}loan(?:$|[^a-z0-9])', 14, 'money_movement_loan_payment_reversed', true, now()),
  ('Loan Payment', 'expense', '(?:^|[^a-z0-9])(?:mortgage|student\s+loan|auto\s+loan|car\s+loan|personal\s+loan)(?:$|[^a-z0-9])', 15, 'money_movement_named_loan', true, now()),

  ('Debt', 'expense', '(?:^|[^a-z0-9])debt.{0,40}(?:payment|repayment|recovery|collection|settlement|payoff)(?:$|[^a-z0-9])', 20, 'money_movement_debt_payment', true, now()),
  ('Debt', 'expense', '(?:^|[^a-z0-9])(?:collection\s+payment|debt\s+recovery|debt\s+repayment|debt\s+payment|creditor\s+payment|settlement\s+payment|payoff\s+payment)(?:$|[^a-z0-9])', 21, 'money_movement_debt_specific', true, now())
ON CONFLICT (side, pattern_regex)
DO UPDATE SET
  category_key = EXCLUDED.category_key,
  priority = EXCLUDED.priority,
  reason = EXCLUDED.reason,
  is_active = EXCLUDED.is_active,
  updated_at = now();

COMMIT;
