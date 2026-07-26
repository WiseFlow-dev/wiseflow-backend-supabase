begin;

-- Earlier seed files stored JS-style escaped Unicode classes in Postgres
-- (\\p{L}) instead of the regex text the Edge Function should read (\p{L}).
-- Normalize the stored rules so "merchant contains X" matching works reliably.
update public.deterministic_category_patterns
set
  pattern_regex = replace(pattern_regex, '\\p{', '\p{'),
  updated_at = now()
where pattern_regex like '%\\p{%';

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
  ('Coffee & Cafes', 'expense', '(?:^|[^\p{L}\p{N}])brewed hong kong(?:$|[^\p{L}\p{N}])', 12, 'brand_brewed_hong_kong', true, now()),
  ('Groceries', 'expense', '(?:^|[^\p{L}\p{N}])ds groceries(?:$|[^\p{L}\p{N}])', 12, 'brand_ds_groceries', true, now()),
  ('Shopping', 'expense', '(?:^|[^\p{L}\p{N}])marks spencer(?:$|[^\p{L}\p{N}])', 12, 'brand_marks_spencer', true, now())
on conflict (side, pattern_regex)
do update set
  category_key = excluded.category_key,
  priority = excluded.priority,
  reason = excluded.reason,
  is_active = excluded.is_active,
  updated_at = now();

commit;
