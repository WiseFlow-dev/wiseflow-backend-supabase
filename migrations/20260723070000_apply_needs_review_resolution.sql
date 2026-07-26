-- Resolves one bank-categorization review as a single remote transaction.
-- The Flutter outbox calls this RPC after the same decision is committed to
-- its local cache, so an offline resolution cannot leave queue state and the
-- visible transaction category disagreeing.
create or replace function public.apply_needs_review_resolution(
  p_command jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_category_id uuid;
  v_category_name text;
  v_merchant text := btrim(coalesce(p_command->>'merchant_normalized', ''));
  v_remember boolean := coalesce((p_command->>'remember_merchant')::boolean, false);
  v_txn_ids text[];
begin
  if v_user is null or p_command->>'user_id' is distinct from v_user::text then
    raise exception 'needs_review_unauthorized';
  end if;
  if jsonb_typeof(p_command->'provider_txn_ids') is distinct from 'array' then
    raise exception 'needs_review_invalid_transactions';
  end if;

  select array_agg(distinct btrim(value))
    into v_txn_ids
    from jsonb_array_elements_text(p_command->'provider_txn_ids') value
   where btrim(value) <> '';
  if coalesce(array_length(v_txn_ids, 1), 0) = 0 then
    raise exception 'needs_review_invalid_transactions';
  end if;

  begin
    v_category_id := (p_command->>'category_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'needs_review_invalid_category';
  end;
  select name into v_category_name
    from public.categories
   where id = v_category_id
     and (user_id = v_user or is_system = true);
  if v_category_name is null then
    raise exception 'needs_review_category_not_available';
  end if;
  if btrim(coalesce(p_command->>'category_name', '')) <> v_category_name then
    raise exception 'needs_review_category_name_mismatch';
  end if;

  -- The user decision always wins over model output. The primary key makes a
  -- replay idempotent: the same command can safely be delivered again after
  -- a process dies between the server success and local outbox deletion.
  insert into public.txn_categorization (
    user_id, txn_id, category_user, updated_at
  )
  select v_user, txn_id, v_category_name, now()
    from unnest(v_txn_ids) txn_id
  on conflict (user_id, txn_id) do update
    set category_user = excluded.category_user,
        updated_at = excluded.updated_at;

  update public.ai_categorization_queue
     set ai_needs_review = false
   where user_id = v_user and txn_id = any(v_txn_ids);

  update public.wallet_transactions
     set category_id = v_category_id,
         category = v_category_name,
         is_suggested = false
   where user_id = v_user and provider_txn_id = any(v_txn_ids);

  if v_remember and v_merchant <> '' then
    insert into public.user_merchant_rules (
      user_id, merchant_normalized, category_key, confidence, updated_at
    ) values (v_user, v_merchant, v_category_name, 1.0, now())
    on conflict (user_id, merchant_normalized) do update
      set category_key = excluded.category_key,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at;
  end if;
end;
$$;

revoke all on function public.apply_needs_review_resolution(jsonb)
  from public, anon;
grant execute on function public.apply_needs_review_resolution(jsonb)
  to authenticated;
