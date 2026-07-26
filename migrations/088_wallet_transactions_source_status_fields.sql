-- Phase 3/4 reliability: persist transaction origin and sync status explicitly
-- so client chips do not rely on note parsing.

alter table public.wallet_transactions
  add column if not exists source text not null default 'manual',
  add column if not exists provider text,
  add column if not exists provider_txn_id text,
  add column if not exists sync_status text;

-- Backfill source/status from legacy note markers where present.
update public.wallet_transactions
set source = 'bank'
where source = 'manual'
  and (
    note ilike '%[source:bank]%'
    or note ilike '%[sync_status:pending]%'
    or note ilike '%[sync_status:posted]%'
  );

update public.wallet_transactions
set sync_status = case
  when note ilike '%[sync_status:pending]%' then 'pending'
  when note ilike '%[sync_status:posted]%' then 'posted'
  else sync_status
end
where sync_status is null;

update public.wallet_transactions
set provider = case
  when note ilike '%[provider:truelayer]%' then 'truelayer'
  when note ilike '%[provider:plaid]%' then 'plaid'
  when note ilike '%[provider:gocardless]%' then 'gocardless'
  else provider
end
where provider is null;

-- Keep values well-formed.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'wallet_transactions_source_check'
  ) then
    alter table public.wallet_transactions
      add constraint wallet_transactions_source_check
      check (source in ('manual', 'bank'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'wallet_transactions_provider_check'
  ) then
    alter table public.wallet_transactions
      add constraint wallet_transactions_provider_check
      check (provider is null or provider in ('plaid', 'truelayer', 'gocardless'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'wallet_transactions_sync_status_check'
  ) then
    alter table public.wallet_transactions
      add constraint wallet_transactions_sync_status_check
      check (sync_status is null or sync_status in ('pending', 'posted'));
  end if;
end $$;

create index if not exists wallet_transactions_user_source_idx
  on public.wallet_transactions(user_id, source);

create index if not exists wallet_transactions_user_provider_txn_idx
  on public.wallet_transactions(user_id, provider_txn_id)
  where provider_txn_id is not null;
