create table if not exists public.card_settlement_links (
    user_id uuid not null references auth.users(id) on delete cascade,
    card_type text not null,
    card_id text not null,
    provider_txn_id text not null,
    allocation_cents bigint not null,
    currency_code text not null,
    linked_at_millis bigint not null,
    is_reversed boolean not null default false,
    billing_cycle_key text not null default '',
    primary key (card_type, card_id, provider_txn_id)
);

create index if not exists idx_csl_user_card
    on public.card_settlement_links (user_id, card_type, card_id);

create index if not exists idx_csl_user_provider_txn
    on public.card_settlement_links (user_id, provider_txn_id);

create index if not exists idx_csl_user_card_cycle
    on public.card_settlement_links (user_id, card_type, card_id, is_reversed, billing_cycle_key);

alter table public.card_settlement_links enable row level security;

do $$
begin
    if not exists (
        select 1
        from pg_policies
        where schemaname = 'public'
          and tablename = 'card_settlement_links'
          and policyname = 'Users can read their own settlement links'
    ) then
        create policy "Users can read their own settlement links"
            on public.card_settlement_links
            for select
            using (auth.uid() = user_id);
    end if;
end $$;

do $$
begin
    if not exists (
        select 1
        from pg_policies
        where schemaname = 'public'
          and tablename = 'card_settlement_links'
          and policyname = 'Users can insert their own settlement links'
    ) then
        create policy "Users can insert their own settlement links"
            on public.card_settlement_links
            for insert
            with check (auth.uid() = user_id);
    end if;
end $$;

do $$
begin
    if not exists (
        select 1
        from pg_policies
        where schemaname = 'public'
          and tablename = 'card_settlement_links'
          and policyname = 'Users can update their own settlement links'
    ) then
        create policy "Users can update their own settlement links"
            on public.card_settlement_links
            for update
            using (auth.uid() = user_id)
            with check (auth.uid() = user_id);
    end if;
end $$;
