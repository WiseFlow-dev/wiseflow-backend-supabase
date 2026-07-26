-- Remap accidental user-created copies of built-in categories back to the
-- canonical system category IDs, then delete the duplicate user rows.

create temporary table duplicate_system_category_map
on commit drop
as
select
  c.id as duplicate_id,
  c.user_id,
  c.name,
  c.is_income,
  s.id as system_id
from public.categories c
join public.categories s
  on s.user_id is null
 and s.is_system = true
 and s.name = c.name
 and s.is_income = c.is_income
where c.user_id is not null
  and coalesce(c.is_system, false) = false;

update public.wallet_transactions wt
set category_id = m.system_id
from duplicate_system_category_map m
where wt.category_id = m.duplicate_id;

update public.budgets b
set category_id = m.system_id
from duplicate_system_category_map m
where b.category_id = m.duplicate_id;

update public.subscriptions s
set category_id = m.system_id
from duplicate_system_category_map m
where s.category_id = m.duplicate_id;

update public.insight_snoozes i
set category_id = m.system_id
from duplicate_system_category_map m
where i.category_id = m.duplicate_id;

delete from public.categories c
using duplicate_system_category_map m
where c.id = m.duplicate_id;
