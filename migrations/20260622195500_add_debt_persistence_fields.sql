alter table if exists public.debts
    add column if not exists wallet_id uuid references public.wallets(id) on delete set null,
    add column if not exists linked_payment_id text,
    add column if not exists due_day_of_month integer,
    add column if not exists currency_code text not null default 'USD';

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'debts_due_day_of_month_check'
    ) then
        alter table public.debts
            add constraint debts_due_day_of_month_check
            check (due_day_of_month is null or due_day_of_month between 1 and 31);
    end if;
end $$;

update public.debts
set due_day_of_month = extract(day from due_date)::integer
where due_day_of_month is null
  and due_date is not null;

create index if not exists debts_user_wallet_idx
    on public.debts (user_id, wallet_id);
