alter table if exists public.subscriptions
    add column if not exists current_cycle_key text not null default '';

update public.subscriptions
set current_cycle_key = next_billing_date
where coalesce(current_cycle_key, '') = ''
  and coalesce(next_billing_date, '') <> '';
