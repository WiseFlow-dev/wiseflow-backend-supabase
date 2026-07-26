-- Receipts + receipt-linked transactions (multiple item transactions per receipt)

-- 1) Receipts header table
create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  wallet_id uuid not null,

  merchant_name text,
  purchase_date date,
  currency text,

  total_amount_cents bigint,
  tax_amount_cents bigint,

  created_at timestamptz not null default now()
);

create index if not exists receipts_user_id_idx on public.receipts(user_id);
create index if not exists receipts_wallet_id_idx on public.receipts(wallet_id);

-- 2) Add receipt linkage to wallet_transactions
alter table public.wallet_transactions
  add column if not exists receipt_id uuid null,
  add column if not exists receipt_item_index int null;

-- 3) FK with cascade delete (hard delete receipt deletes all item transactions)
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'wallet_transactions_receipt_id_fkey'
  ) then
    alter table public.wallet_transactions
      add constraint wallet_transactions_receipt_id_fkey
      foreign key (receipt_id) references public.receipts(id)
      on delete cascade;
  end if;
end $$;

-- 4) RLS policies for receipts
alter table public.receipts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'receipts'
      and policyname = 'Receipts: read own'
  ) then
    create policy "Receipts: read own"
    on public.receipts for select
    using (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'receipts'
      and policyname = 'Receipts: insert own'
  ) then
    create policy "Receipts: insert own"
    on public.receipts for insert
    with check (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'receipts'
      and policyname = 'Receipts: update own'
  ) then
    create policy "Receipts: update own"
    on public.receipts for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'receipts'
      and policyname = 'Receipts: delete own'
  ) then
    create policy "Receipts: delete own"
    on public.receipts for delete
    using (auth.uid() = user_id);
  end if;
end $$;
