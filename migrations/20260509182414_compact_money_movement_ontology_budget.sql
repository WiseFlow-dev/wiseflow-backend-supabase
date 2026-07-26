BEGIN;

UPDATE public.category_ontology
SET
  parent_concept = 'Own Transfer',
  definition = CASE
    WHEN side = 'expense' THEN 'Verified outgoing movement to another user-owned linked account.'
    ELSE 'Verified incoming movement from another user-owned linked account.'
  END,
  multilingual_hints = '["internal transfer","own transfer","account transfer"]'::jsonb,
  seed_version = '2026-05-money-movement-guardrails-v2',
  updated_at = now()
WHERE category_key = 'Transfer'
  AND side IN ('expense', 'income');

UPDATE public.category_ontology
SET
  parent_concept = 'Debt',
  definition = 'Generic borrowed-money repayment when the exact debt type is unclear.',
  multilingual_hints = '["debt","repayment","debt payment"]'::jsonb,
  seed_version = '2026-05-money-movement-guardrails-v2',
  updated_at = now()
WHERE category_key = 'Debt'
  AND side = 'expense';

UPDATE public.category_ontology
SET
  parent_concept = 'BNPL',
  definition = 'Installment repayment to BNPL providers such as Klarna or Afterpay.',
  multilingual_hints = '["bnpl","klarna","afterpay"]'::jsonb,
  seed_version = '2026-05-money-movement-guardrails-v2',
  updated_at = now()
WHERE category_key = 'Buy Now Pay Later'
  AND side = 'expense';

UPDATE public.category_ontology
SET
  parent_concept = 'Interest',
  definition = 'Borrowing interest charged on a card, loan, overdraft, or financing balance.',
  multilingual_hints = '["interest charge","finance charge","apr interest"]'::jsonb,
  seed_version = '2026-05-money-movement-guardrails-v2',
  updated_at = now()
WHERE category_key = 'Interest Paid'
  AND side = 'expense';

UPDATE public.category_ontology
SET
  parent_concept = 'Card Payment',
  definition = 'Payment toward a credit card balance; not card fees or interest.',
  multilingual_hints = '["credit card payment","amex payment","cardmember payment"]'::jsonb,
  seed_version = '2026-05-money-movement-guardrails-v2',
  updated_at = now()
WHERE category_key = 'Credit Card Payment'
  AND side = 'expense';

UPDATE public.category_ontology
SET
  parent_concept = 'Loan Payment',
  definition = 'Repayment toward a mortgage, auto, student, personal, or similar loan.',
  multilingual_hints = '["loan payment","loan repayment","mortgage payment"]'::jsonb,
  seed_version = '2026-05-money-movement-guardrails-v2',
  updated_at = now()
WHERE category_key = 'Loan Payment'
  AND side = 'expense';

COMMIT;
