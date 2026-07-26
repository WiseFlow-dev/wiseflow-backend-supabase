-- Reclassify expense tiers to better reflect real-world spending behaviour.
-- Applies to system categories only; custom user categories are untouched.

-- Move to essential: Car Maintenance (necessary, can't opt out)
UPDATE public.categories
SET expense_tier = 'essential'
WHERE is_system = true
  AND is_income = false
  AND lower(name) IN (
    'car maintenance'
  );

-- Move to discretionary: Fitness & Gym, Home Improvement, Furniture, Software & Apps
-- (optional / lifestyle spending, user can cut these)
UPDATE public.categories
SET expense_tier = 'discretionary'
WHERE is_system = true
  AND is_income = false
  AND lower(name) IN (
    'fitness & gym',
    'home improvement',
    'furniture',
    'software & apps'
  );

-- Move to flexible_essential: Lawn & Garden
-- (was incorrectly set to essential in migration 061)
UPDATE public.categories
SET expense_tier = 'flexible_essential'
WHERE is_system = true
  AND is_income = false
  AND lower(name) IN (
    'lawn & garden'
  );
