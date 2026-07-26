-- Move certain flexible-essential categories into essential based on product direction.
UPDATE public.categories
SET expense_tier = 'essential'
WHERE is_system = true
  AND is_income = false
  AND lower(name) IN (
    'debt',
    'insurance (other)',
    'lawn & garden',
    'education',
    'dental care',
    'vision care'
  );
