create table if not exists public.marketing_email_subscribers (
    user_id         uuid primary key references auth.users(id) on delete cascade,
    email           text not null,
    status          text not null default 'subscribed'
                    check (status in ('subscribed', 'unsubscribed')),
    source          text not null default 'signup',
    consented_at    timestamptz,
    unsubscribed_at timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create unique index if not exists marketing_email_subscribers_email_lower_idx
    on public.marketing_email_subscribers (lower(email));

create or replace function public.set_marketing_email_subscribers_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_marketing_email_subscribers_updated_at
    on public.marketing_email_subscribers;

create trigger trg_marketing_email_subscribers_updated_at
before update on public.marketing_email_subscribers
for each row
execute function public.set_marketing_email_subscribers_updated_at();

alter table public.marketing_email_subscribers enable row level security;

revoke delete, truncate, references, trigger on public.marketing_email_subscribers from authenticated;
grant select, insert, update on public.marketing_email_subscribers to authenticated;
grant select, insert, update, delete on public.marketing_email_subscribers to service_role;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public'
          and tablename = 'marketing_email_subscribers'
          and policyname = 'users view own marketing email subscription'
    ) then
        create policy "users view own marketing email subscription"
            on public.marketing_email_subscribers
            for select
            to authenticated
            using ((select auth.uid()) = user_id);
    end if;
end
$$;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public'
          and tablename = 'marketing_email_subscribers'
          and policyname = 'users insert own marketing email subscription'
    ) then
        create policy "users insert own marketing email subscription"
            on public.marketing_email_subscribers
            for insert
            to authenticated
            with check ((select auth.uid()) = user_id);
    end if;
end
$$;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public'
          and tablename = 'marketing_email_subscribers'
          and policyname = 'users update own marketing email subscription'
    ) then
        create policy "users update own marketing email subscription"
            on public.marketing_email_subscribers
            for update
            to authenticated
            using ((select auth.uid()) = user_id)
            with check ((select auth.uid()) = user_id);
    end if;
end
$$;
