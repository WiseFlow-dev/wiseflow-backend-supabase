-- Backfill expense tiers for canonical/system EXPENSE categories.
-- Scope: system categories only; custom user categories are untouched.

-- 1) Essential
UPDATE public.categories
SET expense_tier = 'essential'
WHERE is_system = true
  AND is_income = false
  AND lower(name) IN (
    'rent',
    'mortgage',
    'electricity',
    'water',
    'gas & heating',
    'internet',
    'phone',
    'property tax',
    'hoa fees',
    'home insurance',
    'health insurance',
    'doctor visits',
    'prescriptions',
    'child support',
    'childcare',
    'car payment',
    'car insurance',
    'gas & fuel',
    'public transit',
    'taxes',
    'bank fees',
    'credit card fees'
  );

-- 2) Discretionary
UPDATE public.categories
SET expense_tier = 'discretionary'
WHERE is_system = true
  AND is_income = false
  AND lower(name) IN (
    'restaurants',
    'fast food',
    'food delivery',
    'snacks',
    'coffee & cafes',
    'alcohol & bars',
    'shopping',
    'clothing',
    'shoes',
    'accessories',
    'beauty & cosmetics',
    'electronics',
    'hair care',
    'entertainment',
    'movies & events',
    'streaming services',
    'games',
    'hobbies',
    'memberships',
    'books & media',
    'subscriptions',
    'travel',
    'vacation',
    'flights',
    'hotels & lodging',
    'rideshare',
    'gifts',
    'charity & donations',
    'religious donations',
    'wellness & spa'
  );

-- 3) Remaining system expense categories default to flexible essential.
UPDATE public.categories
SET expense_tier = 'flexible_essential'
WHERE is_system = true
  AND is_income = false
  AND expense_tier IS DISTINCT FROM 'essential'
  AND expense_tier IS DISTINCT FROM 'discretionary';

