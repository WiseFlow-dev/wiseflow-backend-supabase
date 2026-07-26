alter table if exists public.planned_payments
    add column if not exists current_cycle_key text not null default '';

alter table if exists public.bills
    add column if not exists current_cycle_key text not null default '';

alter table if exists public.incomes
    add column if not exists current_cycle_key text not null default '';

update public.planned_payments
set current_cycle_key = due_date::text
where is_recurring = true
  and coalesce(current_cycle_key, '') = ''
  and due_date is not null;

update public.bills
set current_cycle_key = due_date::text
where is_recurring = true
  and coalesce(current_cycle_key, '') = ''
  and due_date is not null;

update public.incomes
set current_cycle_key = expected_date::text
where is_recurring = true
  and coalesce(current_cycle_key, '') = ''
  and expected_date is not null;
