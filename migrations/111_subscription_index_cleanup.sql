-- Phase 7 follow-up: clean duplicate subscription indexes and cover
-- the legacy category_id foreign key surfaced by Supabase advisors.

create index if not exists subscriptions_category_id_idx
    on public.subscriptions (category_id);

do $$
begin
    if exists (
        select 1
        from pg_constraint
        where conrelid = 'public.subscriptions'::regclass
          and conname = 'subscriptions_user_client_id_unique'
    ) and exists (
        select 1
        from pg_constraint
        where conrelid = 'public.subscriptions'::regclass
          and conname = 'subscriptions_user_client_subscription_id_key'
    ) then
        alter table public.subscriptions
            drop constraint subscriptions_user_client_subscription_id_key;
    end if;

    if to_regclass('public.subscriptions_client_id_idx') is not null
       and to_regclass('public.subscriptions_client_subscription_id_idx') is not null then
        drop index public.subscriptions_client_subscription_id_idx;
    end if;
end $$;
