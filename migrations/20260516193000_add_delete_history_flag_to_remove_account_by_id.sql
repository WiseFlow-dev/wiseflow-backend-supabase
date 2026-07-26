CREATE OR REPLACE FUNCTION public.remove_account_by_id(
  p_account_id text,
  p_delete_history boolean DEFAULT false
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  del_acc int := 0;
  remaining_accounts int := 0;
  target_item_id text := null;
begin
  select a.item_id
    into target_item_id
  from public.accounts a
  where a.user_id = auth.uid()
    and a.account_id = p_account_id
  limit 1;

  if coalesce(p_delete_history, false) then
    delete from public.transactions t
    where t.user_id = auth.uid()
      and t.account_id = p_account_id;
  end if;

  delete from public.accounts a
  where a.user_id = auth.uid()
    and a.account_id = p_account_id;

  get diagnostics del_acc = ROW_COUNT;

  -- If this was the last account under the linked item, fully unlink that item
  -- so background/provider sync cannot recreate the same accounts on next app open.
  if del_acc > 0 and target_item_id is not null then
    select count(*)
      into remaining_accounts
    from public.accounts a
    where a.user_id = auth.uid()
      and a.item_id = target_item_id;

    if remaining_accounts = 0 then
      delete from public.plaid_items p
      where p.user_id = auth.uid()
        and p.item_id = target_item_id;

      delete from public.finverse_connections f
      where f.user_id = auth.uid()
        and f.login_identity_id = target_item_id;
    end if;
  end if;

  return del_acc;
end;
$function$;
