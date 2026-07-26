-- Transactions-4c0: atomic receipt and obligation-link remote commands.

alter table public.receipts
  add column if not exists transaction_id uuid references public.wallet_transactions(id) on delete cascade,
  add column if not exists address text,
  add column if not exists phone text,
  add column if not exists receipt_number text,
  add column if not exists country_region text,
  add column if not exists receipt_type text,
  add column if not exists receipt_date_millis bigint,
  add column if not exists tip_amount_cents bigint,
  add column if not exists total_manually_edited boolean not null default false,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists client_updated_at_millis bigint not null default 0;

create unique index if not exists receipts_user_transaction_uidx
  on public.receipts (user_id, transaction_id)
  where transaction_id is not null;

alter table public.card_settlement_links
  add column if not exists client_command_version bigint not null default 0;

-- The original Android-compatible table key omitted user_id. Correct it
-- before the new RPC uses ON CONFLICT so two accounts can never share or
-- overwrite one settlement-link identity.
alter table public.card_settlement_links
  drop constraint if exists card_settlement_links_pkey;
alter table public.card_settlement_links
  add constraint card_settlement_links_pkey
  primary key (user_id, card_type, card_id, provider_txn_id);
-- Android allowed one provider transaction to remain active against several
-- obligations. Preserve the newest link and reverse older duplicates before
-- installing the constraint that prevents the defect going forward.
with ranked_active_links as (
  select ctid,
         row_number() over (
           partition by user_id, provider_txn_id
           order by linked_at_millis desc, card_type, card_id
         ) as position
    from public.card_settlement_links
   where not is_reversed
)
update public.card_settlement_links link
   set is_reversed = true
  from ranked_active_links ranked
 where link.ctid = ranked.ctid and ranked.position > 1;

create unique index if not exists card_settlement_links_active_provider_uidx
  on public.card_settlement_links (user_id, provider_txn_id)
  where not is_reversed;

create table if not exists public.receipt_line_items (
  id text primary key,
  receipt_id uuid not null references public.receipts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  description text,
  amount_cents bigint not null,
  category_id text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists receipt_line_items_user_receipt_idx
  on public.receipt_line_items (user_id, receipt_id, sort_order);

alter table public.receipt_line_items enable row level security;

create policy "Receipt line items: read own"
  on public.receipt_line_items for select
  using (auth.uid() = user_id);
create policy "Receipt line items: insert own"
  on public.receipt_line_items for insert
  with check (auth.uid() = user_id);
create policy "Receipt line items: update own"
  on public.receipt_line_items for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy "Receipt line items: delete own"
  on public.receipt_line_items for delete
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.receipt_line_items,
  public.receipts, public.card_settlement_links to authenticated;
grant select, update on public.wallet_transactions, public.wallets,
  public.bills, public.planned_payments, public.incomes, public.subscriptions,
  public.debts, public.receivables to authenticated;

create or replace function public.apply_transaction_obligation_command(
  p_command jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_action text := upper(coalesce(p_command->>'action', ''));
  v_type text := upper(coalesce(p_command->>'obligation_type', ''));
  v_id uuid;
  v_changed integer;
  v_paid boolean := coalesce((p_command->>'is_paid_or_received')::boolean, false);
  v_actual bigint := nullif(p_command->>'actual_amount_cents', '')::bigint;
  v_cycle text := coalesce(p_command->>'cycle_key', '');
  v_provider text := coalesce(p_command->>'provider_txn_id', '');
  v_command_version bigint := coalesce(
    nullif(p_command->>'client_command_version', '')::bigint,
    0
  );
  v_existing_command_version bigint;
  v_existing_reversed boolean;
begin
  if v_user is null or p_command->>'user_id' is distinct from v_user::text then
    raise exception 'transaction_obligation_unauthorized';
  end if;
  if v_action not in ('LINK', 'UNLINK') then
    raise exception 'transaction_obligation_invalid_action';
  end if;
  if v_provider = '' then
    raise exception 'transaction_obligation_invalid_provider';
  end if;
  if v_action = 'LINK' and (
    coalesce((p_command->>'allocation_cents')::bigint, 0) <= 0
    or coalesce(p_command->>'currency_code', '') = ''
  ) then
    raise exception 'transaction_obligation_invalid_allocation';
  end if;
  if upper(coalesce(p_command->>'card_type', '')) <> v_type
     or p_command->>'card_id' is distinct from p_command->>'obligation_id' then
    raise exception 'transaction_obligation_identity_mismatch';
  end if;
  v_id := (p_command->>'obligation_id')::uuid;

  select client_command_version, is_reversed
    into v_existing_command_version, v_existing_reversed
    from public.card_settlement_links
   where user_id = v_user
     and card_type = v_type
     and card_id = p_command->>'card_id'
     and provider_txn_id = v_provider
   for update;
  if found and v_command_version > 0 then
    if v_existing_command_version > v_command_version then
      return;
    end if;
    if v_existing_command_version = v_command_version then
      if (v_action = 'LINK' and not v_existing_reversed)
         or (v_action = 'UNLINK' and v_existing_reversed) then
        return;
      end if;
      raise exception 'transaction_obligation_command_version_conflict';
    end if;
  end if;

  if v_action = 'LINK' then
    if exists (
      select 1 from public.card_settlement_links
       where user_id = v_user
         and provider_txn_id = v_provider
         and not is_reversed
         and (card_type, card_id) is distinct from
             (v_type, p_command->>'card_id')
    ) then
      raise exception 'transaction_provider_already_linked';
    end if;

    insert into public.card_settlement_links (
      user_id, card_type, card_id, provider_txn_id, allocation_cents,
      currency_code, linked_at_millis, is_reversed, billing_cycle_key,
      client_command_version
    ) values (
      v_user, v_type, p_command->>'card_id', v_provider,
      (p_command->>'allocation_cents')::bigint,
      p_command->>'currency_code',
      (p_command->>'linked_at_millis')::bigint,
      false,
      coalesce(p_command->>'billing_cycle_key', ''),
      v_command_version
    )
    on conflict (user_id, card_type, card_id, provider_txn_id) do update
      set user_id = excluded.user_id,
          allocation_cents = excluded.allocation_cents,
          currency_code = excluded.currency_code,
          linked_at_millis = excluded.linked_at_millis,
          is_reversed = false,
          billing_cycle_key = excluded.billing_cycle_key,
          client_command_version = excluded.client_command_version
      where public.card_settlement_links.user_id = v_user
        and (
          excluded.client_command_version = 0
          or public.card_settlement_links.client_command_version <=
             excluded.client_command_version
        );
    get diagnostics v_changed = row_count;
    if v_changed = 0 then
      return;
    end if;
  else
    update public.card_settlement_links
       set is_reversed = true,
           client_command_version = case
             when v_command_version > 0 then v_command_version
             else client_command_version
           end
     where user_id = v_user
       and card_type = v_type
       and card_id = p_command->>'card_id'
       and provider_txn_id = v_provider;
    get diagnostics v_changed = row_count;
    if v_changed = 0 then
      raise exception 'transaction_obligation_link_not_found';
    end if;
  end if;

  if coalesce((p_command->>'reconcile_obligation')::boolean, true) then
    case v_type
    when 'BILL' then
      update public.bills
         set is_paid = v_paid,
             actual_amount_paid_cents = v_actual,
             current_cycle_key = v_cycle,
             updated_at = now()
       where user_id = v_user and id = v_id;
    when 'PLANNED_PAYMENT' then
      update public.planned_payments
         set is_paid = v_paid,
             actual_amount_paid_cents = v_actual,
             current_cycle_key = v_cycle,
             updated_at = now()
       where user_id = v_user and id = v_id;
    when 'PLANNED_INCOME' then
      update public.incomes
         set is_received = v_paid,
             actual_amount_received_cents = v_actual,
             current_cycle_key = v_cycle,
             updated_at = now()
       where user_id = v_user and id = v_id;
    when 'SUBSCRIPTION' then
      update public.subscriptions
         set current_cycle_key = v_cycle,
             updated_at = now()
       where user_id = v_user and id = v_id;
    when 'DEBT' then
      update public.debts
         set remaining_amount_cents =
               greatest(total_amount_cents - coalesce(v_actual, 0), 0),
             updated_at = now()
       where user_id = v_user and id = v_id;
    when 'RECEIVABLE' then
      update public.receivables
         set amount_received_cents = coalesce(v_actual, 0),
             updated_at = now()
       where user_id = v_user and id = v_id;
    else
      raise exception 'transaction_obligation_unknown_type';
    end case;

    get diagnostics v_changed = row_count;
    if v_changed = 0 then
      raise exception 'transaction_obligation_target_not_found';
    end if;
  end if;
end;
$$;

revoke all on function public.apply_transaction_obligation_command(jsonb)
  from public, anon;
grant execute on function public.apply_transaction_obligation_command(jsonb)
  to authenticated;

create or replace function public.apply_transaction_receipt_replace(
  p_command jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_receipt jsonb := p_command->'receipt';
  v_txn jsonb := p_command->'transaction';
  v_expected_txn jsonb := p_command->'expected_transaction';
  v_receipt_id uuid;
  v_transaction_id uuid;
  v_new_wallet_id uuid;
  v_new_amount_cents bigint;
  v_new_category_id uuid;
  v_new_receipt_id uuid;
  v_current_wallet_id uuid;
  v_current_amount_cents bigint;
  v_current_category_id uuid;
  v_current_receipt_id uuid;
  v_expected_wallet_id uuid;
  v_expected_amount_cents bigint;
  v_expected_category_id uuid;
  v_expected_receipt_id uuid;
  v_receipt_version bigint := coalesce(
    nullif(v_receipt->>'client_updated_at_millis', '')::bigint,
    0
  );
  v_existing_receipt_version bigint;
  v_item jsonb;
  v_wallet jsonb;
  v_current_balance_cents bigint;
  v_expected_balance_cents bigint;
  v_final_balance_cents bigint;
  v_changed integer;
begin
  if v_user is null or p_command->>'user_id' is distinct from v_user::text then
    raise exception 'transaction_receipt_unauthorized';
  end if;
  v_receipt_id := (v_receipt->>'id')::uuid;
  v_transaction_id := (v_receipt->>'transaction_id')::uuid;
  if v_txn->>'id' is distinct from v_transaction_id::text then
    raise exception 'transaction_receipt_identity_mismatch';
  end if;
  if exists (
    select 1 from public.receipts
     where id = v_receipt_id and user_id <> v_user
  ) then
    raise exception 'transaction_receipt_owned_by_another_user';
  end if;
  if exists (
    select 1 from public.receipts
     where id = v_receipt_id
       and user_id = v_user
       and transaction_id is distinct from v_transaction_id
  ) then
    raise exception 'transaction_receipt_identity_mismatch';
  end if;

  select client_updated_at_millis
    into v_existing_receipt_version
    from public.receipts
   where id = v_receipt_id and user_id = v_user
   for update;
  if v_existing_receipt_version is not null
     and v_existing_receipt_version > v_receipt_version then
    return;
  end if;

  v_new_wallet_id := (v_txn->>'wallet_id')::uuid;
  v_new_amount_cents := (v_txn->>'amount_cents')::bigint;
  v_new_category_id := nullif(v_txn->>'category_id', '')::uuid;
  v_new_receipt_id := nullif(v_txn->>'receipt_id', '')::uuid;
  if (v_receipt->>'wallet_id')::uuid is distinct from v_new_wallet_id then
    raise exception 'transaction_receipt_identity_mismatch';
  end if;
  if v_new_receipt_id is distinct from v_receipt_id then
    raise exception 'transaction_receipt_identity_mismatch';
  end if;

  select wallet_id, round(amount * 100)::bigint, category_id, receipt_id
    into v_current_wallet_id, v_current_amount_cents,
         v_current_category_id, v_current_receipt_id
    from public.wallet_transactions
   where id = v_transaction_id and user_id = v_user
   for update;
  if not found then
    raise exception 'transaction_receipt_transaction_not_found';
  end if;
  if not exists (
    select 1 from public.wallets
     where id = v_new_wallet_id and user_id = v_user
  ) then
    raise exception 'transaction_receipt_wallet_not_found';
  end if;

  if v_expected_txn is not null then
    v_expected_wallet_id := (v_expected_txn->>'wallet_id')::uuid;
    v_expected_amount_cents := (v_expected_txn->>'amount_cents')::bigint;
    v_expected_category_id := nullif(v_expected_txn->>'category_id', '')::uuid;
    v_expected_receipt_id := nullif(v_expected_txn->>'receipt_id', '')::uuid;
    if not (
      (
        v_current_wallet_id = v_expected_wallet_id
        and v_current_amount_cents = v_expected_amount_cents
        and v_current_category_id is not distinct from v_expected_category_id
        and v_current_receipt_id is not distinct from v_expected_receipt_id
      ) or (
        v_current_wallet_id = v_new_wallet_id
        and v_current_amount_cents = v_new_amount_cents
        and v_current_category_id is not distinct from v_new_category_id
        and v_current_receipt_id is not distinct from v_new_receipt_id
      )
    ) then
      raise exception 'transaction_receipt_transaction_conflict';
    end if;
  end if;

  insert into public.receipts (
    id, user_id, transaction_id, wallet_id, merchant_name, address, phone,
    receipt_number, country_region, receipt_type, receipt_date_millis,
    purchase_date, currency, total_amount_cents, tax_amount_cents,
    tip_amount_cents, total_manually_edited, updated_at,
    client_updated_at_millis
  ) values (
    v_receipt_id, v_user, v_transaction_id, (v_receipt->>'wallet_id')::uuid,
    v_receipt->>'merchant_name', v_receipt->>'address', v_receipt->>'phone',
    v_receipt->>'receipt_number', v_receipt->>'country_region',
    v_receipt->>'receipt_type',
    nullif(v_receipt->>'receipt_date_millis', '')::bigint,
    nullif(v_receipt->>'purchase_date', '')::date,
    v_receipt->>'currency',
    nullif(v_receipt->>'total_amount_cents', '')::bigint,
    nullif(v_receipt->>'tax_amount_cents', '')::bigint,
    nullif(v_receipt->>'tip_amount_cents', '')::bigint,
    coalesce((v_receipt->>'total_manually_edited')::boolean, false),
    now(), v_receipt_version
  )
  on conflict (id) do update set
    transaction_id = excluded.transaction_id,
    wallet_id = excluded.wallet_id,
    merchant_name = excluded.merchant_name,
    address = excluded.address,
    phone = excluded.phone,
    receipt_number = excluded.receipt_number,
    country_region = excluded.country_region,
    receipt_type = excluded.receipt_type,
    receipt_date_millis = excluded.receipt_date_millis,
    purchase_date = excluded.purchase_date,
    currency = excluded.currency,
    total_amount_cents = excluded.total_amount_cents,
    tax_amount_cents = excluded.tax_amount_cents,
    tip_amount_cents = excluded.tip_amount_cents,
    total_manually_edited = excluded.total_manually_edited,
    updated_at = now(),
    client_updated_at_millis = excluded.client_updated_at_millis
  where public.receipts.user_id = v_user
    and public.receipts.client_updated_at_millis <=
        excluded.client_updated_at_millis;

  delete from public.receipt_line_items
   where receipt_id = v_receipt_id and user_id = v_user;
  for v_item in select value from jsonb_array_elements(
    coalesce(p_command->'line_items', '[]'::jsonb)
  ) loop
    insert into public.receipt_line_items (
      id, receipt_id, user_id, description, amount_cents, category_id,
      sort_order, updated_at
    ) values (
      v_item->>'id', v_receipt_id, v_user, v_item->>'description',
      (v_item->>'amount_cents')::bigint,
      nullif(v_item->>'category_id', ''),
      coalesce((v_item->>'sort_order')::integer, 0),
      now()
    );
  end loop;

  update public.wallet_transactions set
    wallet_id = v_new_wallet_id,
    amount = (v_new_amount_cents::numeric / 100),
    category_id = v_new_category_id,
    category = v_txn->>'category',
    receipt_id = v_receipt_id,
    receipt_item_index = nullif(v_txn->>'receipt_item_index', '')::integer
  where id = v_transaction_id and user_id = v_user;
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    raise exception 'transaction_receipt_transaction_update_failed';
  end if;

  for v_wallet in select value from jsonb_array_elements(
    coalesce(p_command->'wallets', '[]'::jsonb)
  ) loop
    v_final_balance_cents := (v_wallet->>'balance_cents')::bigint;
    select round(balance * 100)::bigint
      into v_current_balance_cents
      from public.wallets
     where id = (v_wallet->>'id')::uuid and user_id = v_user
     for update;
    if not found then
      raise exception 'transaction_receipt_wallet_update_failed';
    end if;
    if v_wallet ? 'expected_balance_cents' then
      v_expected_balance_cents :=
        (v_wallet->>'expected_balance_cents')::bigint;
      if v_current_balance_cents <> v_expected_balance_cents
         and v_current_balance_cents <> v_final_balance_cents then
        raise exception 'transaction_receipt_wallet_conflict';
      end if;
    end if;
    update public.wallets set
      balance = (v_final_balance_cents::numeric / 100),
      updated_at = now()
    where id = (v_wallet->>'id')::uuid and user_id = v_user;
  end loop;
end;
$$;

revoke all on function public.apply_transaction_receipt_replace(jsonb)
  from public, anon;
grant execute on function public.apply_transaction_receipt_replace(jsonb)
  to authenticated;

create or replace function public.get_transaction_foundation_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'links', coalesce((
      select jsonb_agg(to_jsonb(link_row))
      from (
        select user_id, card_type, card_id, provider_txn_id,
               allocation_cents, currency_code, linked_at_millis,
               is_reversed, billing_cycle_key
        from public.card_settlement_links
        where user_id = auth.uid()
      ) link_row
    ), '[]'::jsonb),
    'obligations', coalesce((
      select jsonb_agg(to_jsonb(state_row))
      from (
        select auth.uid() as user_id, 'BILL'::text as obligation_type,
               id::text as obligation_id, is_paid as is_paid_or_received,
               actual_amount_paid_cents as actual_amount_cents,
               current_cycle_key as cycle_key,
               floor(extract(epoch from coalesce(updated_at, now())) * 1000)::bigint
                 as updated_at_millis
          from public.bills where user_id = auth.uid()
        union all
        select auth.uid(), 'PLANNED_PAYMENT', id::text, is_paid,
               actual_amount_paid_cents, current_cycle_key,
               floor(extract(epoch from coalesce(updated_at, now())) * 1000)::bigint
          from public.planned_payments where user_id = auth.uid()
        union all
        select auth.uid(), 'PLANNED_INCOME', id::text, is_received,
               actual_amount_received_cents, current_cycle_key,
               floor(extract(epoch from coalesce(updated_at, now())) * 1000)::bigint
          from public.incomes where user_id = auth.uid()
        union all
        select auth.uid(), 'SUBSCRIPTION', subscription.id::text,
               exists (
                 select 1 from public.card_settlement_links link
                  where link.user_id = auth.uid()
                    and link.card_type = 'SUBSCRIPTION'
                    and link.card_id = subscription.id::text
                    and link.billing_cycle_key = subscription.current_cycle_key
                    and not link.is_reversed
               ),
               nullif((
                 select sum(link.allocation_cents)
                   from public.card_settlement_links link
                  where link.user_id = auth.uid()
                    and link.card_type = 'SUBSCRIPTION'
                    and link.card_id = subscription.id::text
                    and link.billing_cycle_key = subscription.current_cycle_key
                    and not link.is_reversed
               ), 0),
               subscription.current_cycle_key,
               floor(extract(epoch from coalesce(subscription.updated_at, now())) * 1000)::bigint
          from public.subscriptions subscription
         where subscription.user_id = auth.uid()
        union all
        select auth.uid(), 'DEBT', id::text,
               remaining_amount_cents < total_amount_cents,
               total_amount_cents - remaining_amount_cents, ''::text,
               floor(extract(epoch from coalesce(updated_at, now())) * 1000)::bigint
          from public.debts where user_id = auth.uid()
        union all
        select auth.uid(), 'RECEIVABLE', id::text,
               amount_received_cents > 0, amount_received_cents, ''::text,
               floor(extract(epoch from coalesce(updated_at, now())) * 1000)::bigint
          from public.receivables where user_id = auth.uid()
      ) state_row
    ), '[]'::jsonb),
    'receipts', coalesce((
      select jsonb_agg(to_jsonb(receipt_row))
      from (
        select id, user_id, transaction_id, merchant_name, address, phone,
               receipt_number, country_region, receipt_type,
               receipt_date_millis, currency as currency_code,
               coalesce(total_amount_cents, 0) as total_cents,
               tax_amount_cents as tax_cents,
               tip_amount_cents as tip_cents, total_manually_edited,
               floor(extract(epoch from created_at) * 1000)::bigint as created_at,
               case when client_updated_at_millis > 0
                    then client_updated_at_millis
                    else floor(extract(epoch from coalesce(updated_at, now())) * 1000)::bigint
                end as updated_at
        from public.receipts
        where user_id = auth.uid() and transaction_id is not null
      ) receipt_row
    ), '[]'::jsonb),
    'line_items', coalesce((
      select jsonb_agg(to_jsonb(item_row))
      from (
        select id, receipt_id, user_id, description, amount_cents,
               category_id, sort_order
        from public.receipt_line_items
        where user_id = auth.uid()
      ) item_row
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_transaction_foundation_snapshot()
  from public, anon;
grant execute on function public.get_transaction_foundation_snapshot()
  to authenticated;
