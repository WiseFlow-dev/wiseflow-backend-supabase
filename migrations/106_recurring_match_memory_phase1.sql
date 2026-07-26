-- Phase 1 foundation for durable recurring settlement match memory.
-- Adds one profile row per user/card and a companion feedback table for
-- declines and reversals.

create extension if not exists pgcrypto;

create table if not exists public.recurring_match_profiles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    card_type text not null,
    card_id text not null,
    recurring_series_id text,
    direction text not null check (direction in ('EXPENSE', 'INCOME')),
    wallet_id uuid,
    currency_code text not null,
    merchant_normalized text not null,
    merchant_aliases_json jsonb not null default '[]'::jsonb,
    amount_target_cents bigint not null,
    amount_min_cents bigint not null,
    amount_max_cents bigint not null,
    cadence_days integer,
    expected_cycle_anchor date,
    window_days_before integer not null default 0,
    window_days_after integer not null default 0,
    confirmed_link_count integer not null default 0,
    last_confirmed_link_at timestamptz,
    last_used_at timestamptz,
    status text not null default 'active' check (status in ('active', 'paused', 'disabled')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint recurring_match_profiles_user_card_unique
        unique (user_id, card_type, card_id)
);

create table if not exists public.recurring_match_feedback (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    profile_id uuid not null references public.recurring_match_profiles(id) on delete cascade,
    provider_txn_id text,
    merchant_normalized text,
    wallet_id uuid,
    amount_bucket_key text,
    decision text not null check (decision in ('declined', 'reversed', 'not_a_match')),
    created_at timestamptz not null default now(),
    expires_at timestamptz
);

create index if not exists idx_recurring_match_profiles_user_card
    on public.recurring_match_profiles (user_id, card_type, card_id);

create index if not exists idx_recurring_match_profiles_active_user_status
    on public.recurring_match_profiles (user_id, status, updated_at desc)
    where status = 'active';

create index if not exists idx_recurring_match_profiles_user_wallet_merchant
    on public.recurring_match_profiles (user_id, wallet_id, merchant_normalized);

create index if not exists idx_recurring_match_profiles_user_merchant
    on public.recurring_match_profiles (user_id, merchant_normalized);

create index if not exists idx_recurring_match_feedback_user_profile_created
    on public.recurring_match_feedback (user_id, profile_id, created_at desc);

create index if not exists idx_recurring_match_feedback_user_provider_txn
    on public.recurring_match_feedback (user_id, provider_txn_id)
    where provider_txn_id is not null;

create index if not exists idx_recurring_match_feedback_user_expires
    on public.recurring_match_feedback (user_id, expires_at);

create or replace function public.set_recurring_match_profiles_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_recurring_match_profiles_updated_at
    on public.recurring_match_profiles;

create trigger trg_recurring_match_profiles_updated_at
before update on public.recurring_match_profiles
for each row
execute function public.set_recurring_match_profiles_updated_at();

alter table public.recurring_match_profiles enable row level security;
alter table public.recurring_match_feedback enable row level security;

do $$
begin
    if not exists (
        select 1
        from pg_policies
        where schemaname = 'public'
          and tablename = 'recurring_match_profiles'
          and policyname = 'recurring_match_profiles_manage_own'
    ) then
        create policy recurring_match_profiles_manage_own
            on public.recurring_match_profiles
            for all
            using (auth.uid() is not null and auth.uid() = user_id)
            with check (auth.uid() is not null and auth.uid() = user_id);
    end if;
end $$;

do $$
begin
    if not exists (
        select 1
        from pg_policies
        where schemaname = 'public'
          and tablename = 'recurring_match_feedback'
          and policyname = 'recurring_match_feedback_manage_own'
    ) then
        create policy recurring_match_feedback_manage_own
            on public.recurring_match_feedback
            for all
            using (auth.uid() is not null and auth.uid() = user_id)
            with check (auth.uid() is not null and auth.uid() = user_id);
    end if;
end $$;
