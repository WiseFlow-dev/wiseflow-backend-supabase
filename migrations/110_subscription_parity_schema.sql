-- Phase 7: bring subscriptions to the same durable recurring-card contract
-- used by planned payments, bills, and planned incomes.

alter table public.subscriptions
    add column if not exists client_subscription_id text,
    add column if not exists currency_code text not null default 'USD',
    add column if not exists icon_key text,
    add column if not exists notes text,
    add column if not exists category text,
    add column if not exists day_of_month integer,
    add column if not exists month_of_year integer,
    add column if not exists current_cycle_key text not null default '';

update public.subscriptions
set client_subscription_id = id::text
where coalesce(client_subscription_id, '') = '';

update public.subscriptions
set currency_code = 'USD'
where coalesce(currency_code, '') = '';

update public.subscriptions
set current_cycle_key = next_billing_date::text
where coalesce(current_cycle_key, '') = ''
  and next_billing_date is not null;

update public.subscriptions
set current_cycle_key = ''
where current_cycle_key is null;

update public.subscriptions
set day_of_month = extract(day from next_billing_date)::integer
where day_of_month is null
  and next_billing_date is not null;

update public.subscriptions
set month_of_year = extract(month from next_billing_date)::integer
where month_of_year is null
  and billing_cycle = 'YEARLY'
  and next_billing_date is not null;

update public.subscriptions s
set category = c.name
from public.categories c
where s.category is null
  and s.category_id = c.id;

alter table public.subscriptions
    alter column client_subscription_id set not null,
    alter column currency_code set default 'USD',
    alter column currency_code set not null,
    alter column current_cycle_key set default '',
    alter column current_cycle_key set not null;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'subscriptions_day_of_month_check'
          and conrelid = 'public.subscriptions'::regclass
    ) then
        alter table public.subscriptions
            add constraint subscriptions_day_of_month_check
            check (day_of_month is null or day_of_month between 1 and 31);
    end if;

    if not exists (
        select 1
        from pg_constraint
        where conname = 'subscriptions_month_of_year_check'
          and conrelid = 'public.subscriptions'::regclass
    ) then
        alter table public.subscriptions
            add constraint subscriptions_month_of_year_check
            check (month_of_year is null or month_of_year between 1 and 12);
    end if;
end $$;

do $$
begin
    if not exists (
        select 1
        from pg_index i
        join pg_class t on t.oid = i.indrelid
        join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public'
          and t.relname = 'subscriptions'
          and i.indisunique
          and (
              select array_agg(a.attname order by k.ord)
              from unnest(i.indkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          ) = array['user_id', 'client_subscription_id']
    ) then
        create unique index subscriptions_user_client_subscription_id_key
            on public.subscriptions (user_id, client_subscription_id);
    end if;
end $$;

create index if not exists subscriptions_user_current_cycle_key_idx
    on public.subscriptions (user_id, current_cycle_key);

create index if not exists subscriptions_user_wallet_idx
    on public.subscriptions (user_id, wallet_id);

comment on column public.subscriptions.client_subscription_id is
    'Stable client-side subscription id used for offline-first sync.';

comment on column public.subscriptions.current_cycle_key is
    'Durable current billing cycle key for recurring subscription settlement.';
