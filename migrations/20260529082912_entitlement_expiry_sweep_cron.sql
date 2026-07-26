create or replace function public.sweep_expired_entitlements()
returns table (
  changed_count integer,
  failed_count integer
)
language plpgsql
security definer
set search_path = public, auth, pg_catalog
as $$
declare
  v_changed_count integer := 0;
  v_failed_count integer := 0;
  v_row record;
  v_fields jsonb;
begin
  for v_row in
    select
      ue.user_id,
      ue.tier,
      ue.valid_until
    from public.user_entitlements ue
    where ue.tier <> 'free'
      and ue.valid_until is not null
      and ue.valid_until < now()
    order by ue.valid_until asc, ue.user_id
  loop
    begin
      update public.user_entitlements
      set
        tier = 'free',
        source = 'expiry_sweep',
        valid_until = null,
        updated_at = now()
      where user_id = v_row.user_id;

      v_fields := jsonb_build_object(
        'plan', 'free',
        'tier', 'free',
        'subscription_tier', 'free',
        'plan_tier', 'free',
        'is_pro', false,
        'pro', false,
        'is_premium', false,
        'premium', false
      );

      update auth.users
      set
        raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || v_fields,
        raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || v_fields
      where id = v_row.user_id;

      v_changed_count := v_changed_count + 1;
    exception
      when others then
        v_failed_count := v_failed_count + 1;
    end;
  end loop;

  return query
  select
    v_changed_count,
    v_failed_count;
end;
$$;

revoke all on function public.sweep_expired_entitlements() from public;
grant execute on function public.sweep_expired_entitlements() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (
      select 1
      from cron.job
      where jobname = 'sweep_expired_entitlements_daily'
    ) then
      perform cron.schedule(
        'sweep_expired_entitlements_daily',
        '7 2 * * *',
        $cron$select public.sweep_expired_entitlements();$cron$
      );
    end if;
  end if;
end;
$$;
