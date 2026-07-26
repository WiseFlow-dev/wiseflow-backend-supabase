BEGIN;

-- Add the debt/payment categories that already exist in Android's fallback
-- list to the global system category seed so every user can sync them.
INSERT INTO public.categories (
  id,
  user_id,
  name,
  icon_key,
  color,
  is_income,
  is_system,
  section,
  expense_tier
)
VALUES
  (
    get_canonical_category_uuid('expense', 'debt'),
    NULL,
    'Debt',
    '📉',
    '#E53935',
    false,
    true,
    'Professional & Financial',
    'essential'
  ),
  (
    get_canonical_category_uuid('expense', 'bnpl'),
    NULL,
    'Buy Now Pay Later',
    '💳',
    '#EF5350',
    false,
    true,
    'Professional & Financial',
    'essential'
  ),
  (
    get_canonical_category_uuid('expense', 'interest-paid'),
    NULL,
    'Interest Paid',
    '💸',
    '#B71C1C',
    false,
    true,
    'Professional & Financial',
    'essential'
  ),
  (
    get_canonical_category_uuid('expense', 'credit-card-payment'),
    NULL,
    'Credit Card Payment',
    '💳',
    '#1565C0',
    false,
    true,
    'Professional & Financial',
    'essential'
  ),
  (
    get_canonical_category_uuid('expense', 'loan-payment'),
    NULL,
    'Loan Payment',
    '🏦',
    '#37474F',
    false,
    true,
    'Professional & Financial',
    'essential'
  )
ON CONFLICT (id) DO UPDATE
SET
  user_id = NULL,
  name = EXCLUDED.name,
  icon_key = EXCLUDED.icon_key,
  color = EXCLUDED.color,
  is_income = false,
  is_system = true,
  section = EXCLUDED.section,
  expense_tier = EXCLUDED.expense_tier;

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
    '["debt","repayment","owed balance","debt payment","deuda","schuld","dette"]'::jsonb,
    '["Debt Payment","Debt Repayment","Payment Due"]'::jsonb,
    true,
    '2026-05-debt-payment-v1',
    now()
  ),
  (
    'Buy Now Pay Later',
    'expense',
    'Banking',
    'Consumer Debt',
    'Installment repayment to buy-now-pay-later providers and short-term consumer financing services.',
    '["bnpl","buy now pay later","installment","klarna","afterpay","affirm","tabby","tamara"]'::jsonb,
    '["Klarna Payment","Afterpay Installment","Affirm Loan Payment","Tabby Installment"]'::jsonb,
    true,
    '2026-05-debt-payment-v1',
    now()
  ),
  (
    'Interest Paid',
    'expense',
    'Banking',
    'Interest Expense',
    'Interest charged on a credit card, loan, overdraft, financing balance, or similar debt.',
    '["interest paid","interest charge","finance charge","apr interest","loan interest"]'::jsonb,
    '["Credit Card Interest","Loan Interest Charge","APR Interest"]'::jsonb,
    true,
    '2026-05-debt-payment-v1',
    now()
  ),
  (
    'Credit Card Payment',
    'expense',
    'Banking',
    'Card Repayment',
    'Payment toward a credit card balance when it is not confidently matched as an internal transfer between the user''s own accounts.',
    '["credit card payment","card payment","cc payment","visa payment","mastercard payment","amex payment"]'::jsonb,
    '["CREDIT CARD PAYMENT","AMEX PAYMENT","VISA AUTOPAY","CARDMEMBER PAYMENT"]'::jsonb,
    true,
    '2026-05-debt-payment-v1',
    now()
  ),
  (
    'Loan Payment',
    'expense',
    'Banking',
    'Loan Repayment',
    'Scheduled repayment toward a mortgage, auto loan, student loan, personal loan, or similar debt.',
    '["loan payment","loan repayment","mortgage payment","auto loan","student loan","personal loan"]'::jsonb,
    '["LOAN REPAYMENT","Mortgage AutoPay","Student Loan Payment","Car Loan Payment"]'::jsonb,
    true,
    '2026-05-debt-payment-v1',
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

COMMIT;
