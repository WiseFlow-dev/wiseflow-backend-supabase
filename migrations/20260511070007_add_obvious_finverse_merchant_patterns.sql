begin;

insert into public.deterministic_category_patterns (
  category_key,
  side,
  pattern_regex,
  priority,
  reason,
  is_active,
  updated_at
)
values
  ('Groceries', 'expense', '(?:^|[^\\p{L}\\p{N}])grocer(?:y|ies)(?:$|[^\\p{L}\\p{N}])', 30, 'keyword_grocery_family', true, now()),
  ('Groceries', 'expense', '(?:^|[^\\p{L}\\p{N}])supermarket(?:$|[^\\p{L}\\p{N}])', 31, 'keyword_supermarket', true, now()),
  ('Groceries', 'expense', '(?:^|[^\\p{L}\\p{N}])wellcome(?:$|[^\\p{L}\\p{N}])', 12, 'brand_wellcome', true, now()),
  ('Groceries', 'expense', '(?:^|[^\\p{L}\\p{N}])best mart(?:$|[^\\p{L}\\p{N}])', 13, 'brand_best_mart', true, now()),
  ('Restaurants', 'expense', '(?:^|[^\\p{L}\\p{N}])food drinks(?:$|[^\\p{L}\\p{N}])', 22, 'keyword_food_drinks', true, now()),
  ('Restaurants', 'expense', '(?:^|[^\\p{L}\\p{N}])food and drinks(?:$|[^\\p{L}\\p{N}])', 23, 'keyword_food_and_drinks', true, now()),
  ('Restaurants', 'expense', '(?:^|[^\\p{L}\\p{N}])dinner(?:$|[^\\p{L}\\p{N}])', 24, 'keyword_dinner', true, now()),
  ('Restaurants', 'expense', '(?:^|[^\\p{L}\\p{N}])lunch(?:$|[^\\p{L}\\p{N}])', 25, 'keyword_lunch', true, now()),
  ('Restaurants', 'expense', '(?:^|[^\\p{L}\\p{N}])black sheep(?:$|[^\\p{L}\\p{N}])', 12, 'brand_black_sheep', true, now()),
  ('Restaurants', 'expense', '(?:^|[^\\p{L}\\p{N}])knead hk(?:$|[^\\p{L}\\p{N}])', 13, 'brand_knead_hk', true, now()),
  ('Restaurants', 'expense', '(?:^|[^\\p{L}\\p{N}])ebeneezer(?:$|[^\\p{L}\\p{N}])', 14, 'brand_ebeneezer', true, now()),
  ('Fast Food', 'expense', '(?:^|[^\\p{L}\\p{N}])burger(?:$|[^\\p{L}\\p{N}])', 20, 'keyword_burger', true, now()),
  ('Streaming Services', 'expense', '(?:^|[^\\p{L}\\p{N}])netflicks(?:$|[^\\p{L}\\p{N}])', 12, 'brand_netflicks_sandbox_variant', true, now()),
  ('Prescriptions', 'expense', '(?:^|[^\\p{L}\\p{N}])mannings(?:$|[^\\p{L}\\p{N}])', 12, 'brand_mannings', true, now()),
  ('Fitness & Gym', 'expense', '(?:^|[^\\p{L}\\p{N}])decathlon(?:$|[^\\p{L}\\p{N}])', 12, 'brand_decathlon', true, now()),
  ('Shopping', 'expense', '(?:^|[^\\p{L}\\p{N}])wing on dept store(?:$|[^\\p{L}\\p{N}])', 12, 'brand_wing_on_dept_store', true, now()),
  ('Shopping', 'expense', '(?:^|[^\\p{L}\\p{N}])living plaza(?:$|[^\\p{L}\\p{N}])', 13, 'brand_living_plaza', true, now()),
  ('Home Improvement', 'expense', '(?:^|[^\\p{L}\\p{N}])japan home centre(?:$|[^\\p{L}\\p{N}])', 12, 'brand_japan_home_centre', true, now()),
  ('Bank Fees', 'expense', '(?:^|[^\\p{L}\\p{N}])late charge(?:$|[^\\p{L}\\p{N}])', 12, 'keyword_late_charge', true, now())
on conflict (side, pattern_regex)
do update set
  category_key = excluded.category_key,
  priority = excluded.priority,
  reason = excluded.reason,
  is_active = excluded.is_active,
  updated_at = now();

commit;
