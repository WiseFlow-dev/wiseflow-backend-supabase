BEGIN;

-- Transfer is intentionally strict in WiseFlow. It means proven movement
-- between the user's own accounts, not every row with "payment" or "loan".
UPDATE public.category_ontology
SET
  parent_concept = 'Verified Own-Account Movement',
  definition = CASE
    WHEN side = 'expense' THEN 'Outgoing movement between the user''s own linked accounts or wallets, supported by a matching opposite-side transaction.'
    ELSE 'Incoming movement between the user''s own linked accounts or wallets, supported by a matching opposite-side transaction.'
  END,
  multilingual_hints = '["internal transfer","own account transfer","between accounts","account transfer","wallet transfer","xfer"]'::jsonb,
  examples = CASE
    WHEN side = 'expense' THEN '["Transfer to Savings","Internal Transfer Out","XFER TO OWN ACCOUNT"]'::jsonb
    ELSE '["Transfer from Checking","Internal Transfer In","XFER FROM OWN ACCOUNT"]'::jsonb
  END,
  seed_version = '2026-05-money-movement-guardrails-v1',
  updated_at = now()
WHERE category_key = 'Transfer'
  AND side IN ('expense', 'income');

INSERT INTO public.category_ontology (
  category_key,
  side,
  section,
  parent_concept,
  definition,
  multilingual_hints,
  examples,
  is_active,
  seed_version,
  updated_at
)
VALUES
  (
    'Debt',
    'expense',
    'Banking',
    'Debt Repayment',
    'Generic repayment of borrowed money when the exact debt product is unclear.',
    '["debt","repayment","owed balance","debt payment","debt repayment","debt recovery","collection payment","creditor payment","payoff","settlement payment"]'::jsonb,
    '["Debt Payment","Debt Repayment","Debt Recovery Payment","Collection Payment","Creditor Payment"]'::jsonb,
    true,
    '2026-05-money-movement-guardrails-v1',
    now()
  ),
  (
    'Buy Now Pay Later',
    'expense',
    'Banking',
    'Consumer Debt',
    'Installment repayment to buy-now-pay-later providers and short-term consumer financing services.',
    '["bnpl","buy now pay later","installment","instalment","klarna","afterpay","affirm","tabby","tamara","sezzle","clearpay","zip pay","pay later"]'::jsonb,
    '["Klarna Payment","Afterpay Installment","Affirm Loan Payment","Tabby Installment","Tamara Payment","Sezzle Payment"]'::jsonb,
    true,
    '2026-05-money-movement-guardrails-v1',
    now()
  ),
  (
    'Interest Paid',
    'expense',
    'Banking',
    'Interest Expense',
    'Interest charged on a credit card, loan, overdraft, financing balance, or similar debt. This is the borrowing cost, not the principal payment.',
    '["interest paid","interest charge","finance charge","apr interest","purchase interest","cash advance interest","loan interest","overdraft interest"]'::jsonb,
    '["Credit Card Interest","Finance Charge","APR Interest","Loan Interest Charge","Overdraft Interest"]'::jsonb,
    true,
    '2026-05-money-movement-guardrails-v1',
    now()
  ),
  (
    'Credit Card Payment',
    'expense',
    'Banking',
    'Card Repayment',
    'Payment toward a credit card balance when it is not proven to be a paired internal transfer between the user''s own linked accounts.',
    '["credit card payment","cc payment","card payment","cardmember payment","amex payment","american express payment","visa payment","mastercard payment","card autopay"]'::jsonb,
    '["CREDIT CARD PAYMENT","AMEX PAYMENT","VISA AUTOPAY","CARDMEMBER PAYMENT","MASTERCARD PAYMENT"]'::jsonb,
    true,
    '2026-05-money-movement-guardrails-v1',
    now()
  ),
  (
    'Loan Payment',
    'expense',
    'Banking',
    'Loan Repayment',
    'Scheduled repayment toward a mortgage, auto loan, student loan, personal loan, or similar debt.',
    '["loan payment","loan repayment","mortgage payment","auto loan","car loan","student loan","personal loan","lending payment","loan autopay"]'::jsonb,
    '["LOAN REPAYMENT","Mortgage AutoPay","Student Loan Payment","Car Loan Payment","Personal Loan Payment"]'::jsonb,
    true,
    '2026-05-money-movement-guardrails-v1',
    now()
  )
ON CONFLICT (category_key, side) DO UPDATE
SET
  section = EXCLUDED.section,
  parent_concept = EXCLUDED.parent_concept,
  definition = EXCLUDED.definition,
  multilingual_hints = EXCLUDED.multilingual_hints,
  examples = EXCLUDED.examples,
  is_active = EXCLUDED.is_active,
  seed_version = EXCLUDED.seed_version,
  updated_at = now();

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
