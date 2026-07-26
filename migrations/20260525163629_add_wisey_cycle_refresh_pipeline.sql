create or replace function public.process_wisey_cycle_dirty_queue(
  p_limit integer default 100
)
returns table (
  processed_count integer,
  deleted_count integer,
  missing_fx_count integer,
  deferred_open_cycle_count integer,
  failed_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_processed_count integer := 0;
  v_deleted_count integer := 0;
  v_missing_fx_count integer := 0;
  v_deferred_open_cycle_count integer := 0;
  v_failed_count integer := 0;
  v_queue_row record;
  v_cycle_start_day integer := 1;
  v_cycle_start_date date;
  v_cycle_end_date date;
  v_current_cycle_start date;
  v_status text;
begin
  for v_queue_row in
    select
      q.user_id,
      q.affected_date
    from public.wisey_cycle_dirty_queue q
    where q.last_attempt_at is null
       or q.last_attempt_at <= now() - interval '6 hours'
    order by q.last_enqueued_at asc
    limit greatest(1, p_limit)
    for update skip locked
  loop
    begin
      v_cycle_start_day := public.wisey_get_user_cycle_start_day(v_queue_row.user_id);

      select
        cycle_window.cycle_start_date,
        cycle_window.cycle_end_date
      into
        v_cycle_start_date,
        v_cycle_end_date
      from public.wisey_cycle_window_for_reference_date(
        v_queue_row.affected_date,
        v_cycle_start_day
      ) cycle_window;

      v_current_cycle_start := public.wisey_current_cycle_start(current_date, v_cycle_start_day);
      if v_cycle_end_date >= v_current_cycle_start then
        v_deferred_open_cycle_count := v_deferred_open_cycle_count + 1;
        continue;
      end if;

      select result.status
      into v_status
      from public.recompute_wisey_cycle_score(
        v_queue_row.user_id,
        v_cycle_start_date,
        v_cycle_end_date,
        'dirty_queue'
      ) result
      limit 1;

      if v_status = 'upserted' then
        v_processed_count := v_processed_count + 1;
      elsif v_status = 'deleted_no_valid_data' then
        v_deleted_count := v_deleted_count + 1;
      elsif v_status = 'skipped_missing_fx' then
        v_missing_fx_count := v_missing_fx_count + 1;
      end if;
    exception
      when others then
        update public.wisey_cycle_dirty_queue
        set
          attempt_count = attempt_count + 1,
          last_attempt_at = now(),
          last_error = sqlerrm,
          updated_at = now()
        where user_id = v_queue_row.user_id
          and affected_date = v_queue_row.affected_date;

        v_failed_count := v_failed_count + 1;
      end;
  end loop;

  return query
  select
    v_processed_count,
    v_deleted_count,
    v_missing_fx_count,
    v_deferred_open_cycle_count,
    v_failed_count;
end;
$$;

revoke all on function public.process_wisey_cycle_dirty_queue(integer) from public;
grant execute on function public.process_wisey_cycle_dirty_queue(integer) to service_role;

create or replace function public.catch_up_wisey_cycle_scores(
  p_user_limit integer default 200
)
returns table (
  refreshed_count integer,
  already_present_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_refreshed_count integer := 0;
  v_already_present_count integer := 0;
  v_user_row record;
  v_status text;
begin
  for v_user_row in
    with active_users as (
      select distinct
        wt.user_id,
        public.wisey_get_user_cycle_start_day(wt.user_id) as cycle_start_day
      from public.wallet_transactions wt
    ),
    latest_windows as (
      select
        au.user_id,
        latest.cycle_start_date,
        latest.cycle_end_date
      from active_users au
      cross join lateral public.wisey_latest_completed_cycle_window(current_date, au.cycle_start_day) latest
    )
    select
      lw.user_id,
      lw.cycle_start_date,
      lw.cycle_end_date
    from latest_windows lw
    left join public.user_cycle_scores ucs
      on ucs.user_id = lw.user_id
     and ucs.cycle_start_date = lw.cycle_start_date
     and ucs.cycle_end_date = lw.cycle_end_date
    where ucs.user_id is null
    order by lw.cycle_end_date desc, lw.user_id
    limit greatest(1, p_user_limit)
  loop
    select result.status
    into v_status
    from public.recompute_wisey_cycle_score(
      v_user_row.user_id,
      v_user_row.cycle_start_date,
      v_user_row.cycle_end_date,
      'catch_up_missing'
    ) result
    limit 1;

    if v_status = 'upserted' then
      v_refreshed_count := v_refreshed_count + 1;
    else
      v_already_present_count := v_already_present_count + 1;
    end if;
  end loop;

  return query
  select
    v_refreshed_count,
    v_already_present_count;
end;
$$;

revoke all on function public.catch_up_wisey_cycle_scores(integer) from public;
grant execute on function public.catch_up_wisey_cycle_scores(integer) to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (
      select 1
      from cron.job
      where jobname = 'process_wisey_cycle_dirty_queue_hourly'
    ) then
      perform cron.schedule(
        'process_wisey_cycle_dirty_queue_hourly',
        '17 * * * *',
        $cron$select public.process_wisey_cycle_dirty_queue(250);$cron$
      );
    end if;

    if not exists (
      select 1
      from cron.job
      where jobname = 'catch_up_wisey_cycle_scores_daily'
    ) then
      perform cron.schedule(
        'catch_up_wisey_cycle_scores_daily',
        '47 3 * * *',
        $cron$select public.catch_up_wisey_cycle_scores(500);$cron$
      );
    end if;
  end if;
end;
$$;
