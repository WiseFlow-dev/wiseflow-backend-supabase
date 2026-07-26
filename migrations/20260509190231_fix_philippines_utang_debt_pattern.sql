BEGIN;

DELETE FROM public.deterministic_category_patterns
WHERE reason IN (
  'money_movement_ph_loan_payment',
  'money_movement_ph_loan_payment_reversed'
);

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
  ('Loan Payment', 'expense', '(?:^|[^a-z0-9])(?:bayad|pagbabayad|hulog|settlement).{0,40}(?:loan|pautang|home\s+loan|car\s+loan|personal\s+loan)(?:$|[^a-z0-9])', 13, 'money_movement_ph_loan_payment', true, now()),
  ('Loan Payment', 'expense', '(?:^|[^a-z0-9])(?:loan|pautang|home\s+loan|car\s+loan|personal\s+loan).{0,40}(?:bayad|pagbabayad|hulog|settlement)(?:$|[^a-z0-9])', 14, 'money_movement_ph_loan_payment_reversed', true, now())
ON CONFLICT (side, pattern_regex)
DO UPDATE SET
  category_key = EXCLUDED.category_key,
  priority = EXCLUDED.priority,
  reason = EXCLUDED.reason,
  is_active = EXCLUDED.is_active,
  updated_at = now();

COMMIT;
