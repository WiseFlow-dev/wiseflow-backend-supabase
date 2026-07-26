BEGIN;

-- Vietnam money-movement language pack.
-- These patterns catch protected payment categories only. Vietnamese transfer
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
  ('Interest Paid', 'expense', '(?:^|[^a-z0-9])(?:lai|lai\\s+suat|phi\\s+lai|tien\\s+lai|lai\\s+vay|lai\\s+the\\s+tin\\s+dung|phi\\s+tai\\s+chinh)(?:$|[^a-z0-9])', 5, 'money_movement_vn_interest_paid_ascii', true, now()),
  ('Interest Paid', 'expense', '(lãi|lãi\\s+suất|phí\\s+lãi|tiền\\s+lãi|lãi\\s+vay|lãi\\s+thẻ\\s+tín\\s+dụng|phí\\s+tài\\s+chính)', 5, 'money_movement_vn_interest_paid', true, now()),

  ('Buy Now Pay Later', 'expense', '(?:^|[^a-z0-9])(?:fundiin|momo\\s+paylater|zalopay\\s+paylater|shopee\\s+tra\\s+sau|spaylater)(?:$|[^a-z0-9])', 8, 'money_movement_vn_bnpl_provider', true, now()),
  ('Buy Now Pay Later', 'expense', '(trả\\s+góp|mua\\s+trước\\s+trả\\s+sau|thanh\\s+toán\\s+trả\\s+góp|trả\\s+sau)', 8, 'money_movement_vn_bnpl_phrase', true, now()),
  ('Buy Now Pay Later', 'expense', '(?:^|[^a-z0-9])(?:tra\\s+gop|mua\\s+truoc\\s+tra\\s+sau|thanh\\s+toan\\s+tra\\s+gop|tra\\s+sau)(?:$|[^a-z0-9])', 8, 'money_movement_vn_bnpl_phrase_ascii', true, now()),

  ('Credit Card Payment', 'expense', '(?:^|[^a-z0-9])(?:thanh\\s+toan|tra\\s+no|tat\\s+toan).{0,40}(?:the\\s+tin\\s+dung|credit\\s+card)(?:$|[^a-z0-9])', 9, 'money_movement_vn_credit_card_payment_ascii', true, now()),
  ('Credit Card Payment', 'expense', '(?:^|[^a-z0-9])(?:the\\s+tin\\s+dung|credit\\s+card).{0,40}(?:thanh\\s+toan|tra\\s+no|tat\\s+toan)(?:$|[^a-z0-9])', 10, 'money_movement_vn_credit_card_payment_ascii_reversed', true, now()),
  ('Credit Card Payment', 'expense', '(thanh\\s+toán|trả\\s+nợ|tất\\s+toán).{0,40}(thẻ\\s+tín\\s+dụng)', 9, 'money_movement_vn_credit_card_payment', true, now()),
  ('Credit Card Payment', 'expense', '(thẻ\\s+tín\\s+dụng).{0,40}(thanh\\s+toán|trả\\s+nợ|tất\\s+toán)', 10, 'money_movement_vn_credit_card_payment_reversed', true, now()),

  ('Loan Payment', 'expense', '(?:^|[^a-z0-9])(?:thanh\\s+toan|tra\\s+no|tat\\s+toan|tra\\s+gop).{0,40}(?:khoan\\s+vay|vay|tin\\s+dung|the\\s+chap|vay\\s+mua\\s+nha|vay\\s+mua\\s+xe)(?:$|[^a-z0-9])', 13, 'money_movement_vn_loan_payment_ascii', true, now()),
  ('Loan Payment', 'expense', '(?:^|[^a-z0-9])(?:khoan\\s+vay|vay|tin\\s+dung|the\\s+chap|vay\\s+mua\\s+nha|vay\\s+mua\\s+xe).{0,40}(?:thanh\\s+toan|tra\\s+no|tat\\s+toan|tra\\s+gop)(?:$|[^a-z0-9])', 14, 'money_movement_vn_loan_payment_ascii_reversed', true, now()),
  ('Loan Payment', 'expense', '(thanh\\s+toán|trả\\s+nợ|tất\\s+toán|trả\\s+góp).{0,40}(khoản\\s+vay|vay|tín\\s+dụng|thế\\s+chấp|vay\\s+mua\\s+nhà|vay\\s+mua\\s+xe)', 13, 'money_movement_vn_loan_payment', true, now()),
  ('Loan Payment', 'expense', '(khoản\\s+vay|vay|tín\\s+dụng|thế\\s+chấp|vay\\s+mua\\s+nhà|vay\\s+mua\\s+xe).{0,40}(thanh\\s+toán|trả\\s+nợ|tất\\s+toán|trả\\s+góp)', 14, 'money_movement_vn_loan_payment_reversed', true, now()),

  ('Debt', 'expense', '(?:^|[^a-z0-9])(?:no|khoan\\s+no|cong\\s+no).{0,40}(?:thanh\\s+toan|tra\\s+no|tat\\s+toan|thu\\s+hoi)(?:$|[^a-z0-9])', 20, 'money_movement_vn_debt_payment_ascii', true, now()),
  ('Debt', 'expense', '(?:^|[^a-z0-9])(?:thanh\\s+toan|tra\\s+no|tat\\s+toan|thu\\s+hoi).{0,40}(?:no|khoan\\s+no|cong\\s+no)(?:$|[^a-z0-9])', 21, 'money_movement_vn_debt_payment_ascii_reversed', true, now()),
  ('Debt', 'expense', '(nợ|khoản\\s+nợ|công\\s+nợ).{0,40}(thanh\\s+toán|trả\\s+nợ|tất\\s+toán|thu\\s+hồi)', 20, 'money_movement_vn_debt_payment', true, now()),
  ('Debt', 'expense', '(thanh\\s+toán|trả\\s+nợ|tất\\s+toán|thu\\s+hồi).{0,40}(nợ|khoản\\s+nợ|công\\s+nợ)', 21, 'money_movement_vn_debt_payment_reversed', true, now())
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
  seed_version = '2026-05-money-movement-vn-v1',
  updated_at = now()
FROM (
  VALUES
    ('Debt', 'expense', '["nợ","khoản nợ","trả nợ"]'::jsonb, '["Trả nợ"]'::jsonb),
    ('Buy Now Pay Later', 'expense', '["fundiin","trả góp","mua trước trả sau"]'::jsonb, '["Thanh toán trả góp"]'::jsonb),
    ('Interest Paid', 'expense', '["lãi","phí lãi","lãi thẻ tín dụng"]'::jsonb, '["Phí lãi"]'::jsonb),
    ('Credit Card Payment', 'expense', '["thanh toán thẻ tín dụng","trả nợ thẻ tín dụng","tất toán thẻ tín dụng"]'::jsonb, '["Thanh toán thẻ tín dụng"]'::jsonb),
    ('Loan Payment', 'expense', '["thanh toán khoản vay","trả nợ vay","trả góp khoản vay"]'::jsonb, '["Thanh toán khoản vay"]'::jsonb)
) AS additions(category_key, side, hints, examples)
WHERE category_ontology.category_key = additions.category_key
  AND category_ontology.side = additions.side;

COMMIT;
