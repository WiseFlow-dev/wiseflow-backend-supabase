-- DB tail cleanup: sync-event retention + remaining RLS perf cleanup + safe policy consolidation.

create index if not exists idx_sync_event_logs_created_at_brin
  on public.sync_event_logs using brin (created_at);

create or replace function public.cleanup_old_sync_event_logs(p_retention_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
begin
  delete from public.sync_event_logs
  where created_at < now() - make_interval(days => greatest(p_retention_days, 1));

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.cleanup_old_sync_event_logs(integer) is
  'Deletes old sync_event_logs rows older than the requested retention window. Scheduled daily via pg_cron.';

revoke all on function public.cleanup_old_sync_event_logs(integer) from public;
grant execute on function public.cleanup_old_sync_event_logs(integer) to service_role;

do $$
declare
  v_job_id bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    select jobid
      into v_job_id
      from cron.job
     where jobname = 'cleanup_sync_event_logs_daily'
     limit 1;

    if v_job_id is not null then
      perform cron.unschedule(v_job_id);
    end if;

    perform cron.schedule(
      'cleanup_sync_event_logs_daily',
      '17 3 * * *',
      $cron$select public.cleanup_old_sync_event_logs(30);$cron$
    );
  end if;
end
$$;

select public.cleanup_old_sync_event_logs(30);

-- Safe multiple-permissive-policy consolidation on hot paths -----------------

alter policy acc_select on public.accounts
  using (
    (user_id = (select auth.uid()))
    or exists (
      select 1
      from public.plaid_items pi
      where pi.item_id = accounts.item_id
        and pi.user_id = (select auth.uid())
    )
  );

drop policy if exists accounts_select_via_item on public.accounts;

alter policy acc_upsert on public.accounts
  with check (
    (user_id = (select auth.uid()))
    or exists (
      select 1
      from public.plaid_items pi
      where pi.item_id = accounts.item_id
        and pi.user_id = (select auth.uid())
    )
  );

drop policy if exists accounts_insert_via_item on public.accounts;

alter policy txn_select on public.transactions
  using (
    (user_id = (select auth.uid()))
    or exists (
      select 1
      from public.plaid_items pi
      where pi.item_id = transactions.item_id
        and pi.user_id = (select auth.uid())
    )
  );

drop policy if exists txns_select_via_item on public.transactions;

alter policy txn_upsert on public.transactions
  with check (
    (user_id = (select auth.uid()))
    or exists (
      select 1
      from public.plaid_items pi
      where pi.item_id = transactions.item_id
        and pi.user_id = (select auth.uid())
    )
  );

drop policy if exists txns_insert_via_item on public.transactions;

alter policy read_canonical_categories on public.categories
  using (
    ((is_system = true) and (user_id is null))
    or ((is_system = false) and (user_id = (select auth.uid())))
  );

drop policy if exists read_own_custom_categories on public.categories;

drop policy if exists select_outcomes_via_own_queue on public.action_outcomes;

-- Remaining auth.uid() initplan wrappers ------------------------------------

do $$
declare
  rec record;
  v_using text;
  v_check text;
begin
  for rec in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (
        (coalesce(qual, '') like '%auth.uid()%' and coalesce(qual, '') not like '%( SELECT auth.uid()%')
        or (coalesce(with_check, '') like '%auth.uid()%' and coalesce(with_check, '') not like '%( SELECT auth.uid()%')
      )
    order by tablename, policyname
  loop
    v_using := case
      when rec.qual is not null then replace(rec.qual, 'auth.uid()', '(SELECT auth.uid())')
      else null
    end;

    v_check := case
      when rec.with_check is not null then replace(rec.with_check, 'auth.uid()', '(SELECT auth.uid())')
      else null
    end;

    if v_using is not null and v_check is not null then
      execute format(
        'alter policy %I on %I.%I using (%s) with check (%s)',
        rec.policyname,
        rec.schemaname,
        rec.tablename,
        v_using,
        v_check
      );
    elsif v_using is not null then
      execute format(
        'alter policy %I on %I.%I using (%s)',
        rec.policyname,
        rec.schemaname,
        rec.tablename,
        v_using
      );
    elsif v_check is not null then
      execute format(
        'alter policy %I on %I.%I with check (%s)',
        rec.policyname,
        rec.schemaname,
        rec.tablename,
        v_check
      );
    end if;
  end loop;
end
$$;
