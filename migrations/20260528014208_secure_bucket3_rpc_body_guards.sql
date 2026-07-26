-- Bucket 3 hardening: close body-level authorization holes in the remaining
-- risky write RPCs. This migration is intentionally narrow.

create or replace function public.upsert_txn_categorization_model_guarded(
  p_user_id uuid,
  p_txn_id text,
  p_category_model text,
  p_category_confidence real,
  p_is_suggested boolean,
  p_merchant_normalized text
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows integer;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'forbidden';
  end if;

  insert into public.txn_categorization (
    user_id,
    txn_id,
    category_model,
    category_confidence,
    is_suggested,
    merchant_normalized,
    updated_at
  )
  values (
    p_user_id,
    p_txn_id,
    p_category_model,
    p_category_confidence,
    coalesce(p_is_suggested, false),
    p_merchant_normalized,
    now()
  )
  on conflict (user_id, txn_id)
  do update set
    category_model = excluded.category_model,
    category_confidence = excluded.category_confidence,
    is_suggested = excluded.is_suggested,
    merchant_normalized = excluded.merchant_normalized,
    updated_at = excluded.updated_at
  where public.txn_categorization.category_user is null;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$function$;

create or replace function public.apply_user_merchant_rule_backfill(
  p_user_id uuid,
  p_merchant_normalized text,
  p_category_key text
)
returns table(scanned_count integer, updated_count integer, preserved_count integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_norm_merchant text;
  v_scanned integer := 0;
  v_updated integer := 0;
  v_preserved integer := 0;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'forbidden';
  end if;

  v_norm_merchant := normalize_merchant(p_merchant_normalized);
  if v_norm_merchant is null or v_norm_merchant = '' then
    return query select 0, 0, 0;
    return;
  end if;

  with matched as (
    select t.txn_id
    from public.transactions t
    where t.user_id = p_user_id
      and normalize_merchant(coalesce(t.merchant_name, t.merchant, t.name, '')) = v_norm_merchant
  ),
  preserved as (
    select count(*)::integer as cnt
    from matched m
    join public.txn_categorization tc
      on tc.user_id = p_user_id
     and tc.txn_id = m.txn_id
    where tc.category_user is not null
  ),
  upserted as (
    insert into public.txn_categorization (
      user_id,
      txn_id,
      category_model,
      category_confidence,
      merchant_normalized,
      updated_at
    )
    select
      p_user_id,
      m.txn_id,
      p_category_key,
      1.0,
      v_norm_merchant,
      now()
    from matched m
    left join public.txn_categorization tc
      on tc.user_id = p_user_id
     and tc.txn_id = m.txn_id
    where tc.txn_id is null or tc.category_user is null
    on conflict (user_id, txn_id)
    do update set
      category_model = excluded.category_model,
      category_confidence = excluded.category_confidence,
      merchant_normalized = excluded.merchant_normalized,
      updated_at = excluded.updated_at
    where public.txn_categorization.category_user is null
    returning 1
  )
  select
    (select count(*)::integer from matched),
    coalesce((select count(*)::integer from upserted), 0),
    coalesce((select cnt from preserved), 0)
  into v_scanned, v_updated, v_preserved;

  return query select v_scanned, v_updated, v_preserved;
end;
$function$;

create or replace function public.wallet_adjust(
  p_wallet_id uuid,
  p_delta numeric,
  p_note text default null::text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.wallets
     set balance = balance + p_delta
   where id = p_wallet_id
     and user_id = auth.uid();

  if not found then
    raise exception 'forbidden';
  end if;

  insert into public.wallet_movements(wallet_id, delta, note)
  values (p_wallet_id, p_delta, p_note);
end;
$function$;

-- Keep intended client usage for signed-in users and explicit backend usage.
revoke execute on function public.upsert_txn_categorization_model_guarded(uuid, text, text, real, boolean, text) from public, anon;
grant execute on function public.upsert_txn_categorization_model_guarded(uuid, text, text, real, boolean, text) to authenticated, service_role;

revoke execute on function public.apply_user_merchant_rule_backfill(uuid, text, text) from public, anon;
grant execute on function public.apply_user_merchant_rule_backfill(uuid, text, text) to authenticated, service_role;

revoke execute on function public.wallet_adjust(uuid, numeric, text) from public, anon;
grant execute on function public.wallet_adjust(uuid, numeric, text) to authenticated, service_role;
