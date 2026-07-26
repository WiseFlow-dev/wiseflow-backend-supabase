alter table public.user_cycle_scores
  add column if not exists last_refresh_reason text;

create or replace function public.wisey_get_user_cycle_start_day(
  p_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_cycle_start_day integer := 1;
begin
  select greatest(1, least(31, coalesce(up.cycle_start_day, 1)))::integer
  into v_cycle_start_day
  from public.user_preferences up
  where up.user_id = p_user_id;

  return coalesce(v_cycle_start_day, 1);
end;
$$;

revoke all on function public.wisey_get_user_cycle_start_day(uuid) from public;
grant execute on function public.wisey_get_user_cycle_start_day(uuid) to service_role;

create or replace function public.wisey_next_cycle_start(
  p_cycle_start date,
  p_cycle_start_day integer
)
returns date
language plpgsql
immutable
as $$
declare
  v_next_month_ref date;
begin
  v_next_month_ref := (date_trunc('month', p_cycle_start)::date + interval '1 month')::date;
  return public.wisey_cycle_anchor_for_month(v_next_month_ref, p_cycle_start_day);
end;
$$;

create or replace function public.wisey_cycle_window_for_reference_date(
  p_reference_date date,
  p_cycle_start_day integer
)
returns table (
  cycle_start_date date,
  cycle_end_date date,
  bucket_month date
)
language plpgsql
immutable
as $$
declare
  v_cycle_start date;
  v_next_cycle_start date;
begin
  v_cycle_start := public.wisey_current_cycle_start(p_reference_date, p_cycle_start_day);
  v_next_cycle_start := public.wisey_next_cycle_start(v_cycle_start, p_cycle_start_day);

  return query
  select
    v_cycle_start,
    (v_next_cycle_start - interval '1 day')::date,
    date_trunc(
      'month',
      (
        v_cycle_start
        + (((v_next_cycle_start - interval '1 day')::date - v_cycle_start) / 2)
      )::timestamp
    )::date;
end;
$$;

create or replace function public.wisey_latest_completed_cycle_window(
  p_reference_date date,
  p_cycle_start_day integer
)
returns table (
  cycle_start_date date,
  cycle_end_date date,
  bucket_month date
)
language plpgsql
immutable
as $$
declare
  v_current_cycle_start date;
  v_previous_cycle_start date;
begin
  v_current_cycle_start := public.wisey_current_cycle_start(p_reference_date, p_cycle_start_day);
  v_previous_cycle_start := public.wisey_previous_cycle_start(v_current_cycle_start, p_cycle_start_day);

  return query
  select
    v_previous_cycle_start,
    (v_current_cycle_start - interval '1 day')::date,
    date_trunc(
      'month',
      (
        v_previous_cycle_start
        + (((v_current_cycle_start - interval '1 day')::date - v_previous_cycle_start) / 2)
      )::timestamp
    )::date;
end;
$$;

create or replace function public.recompute_wisey_cycle_score(
  p_user_id uuid,
  p_cycle_start_date date,
  p_cycle_end_date date,
  p_refresh_reason text default 'manual'
)
returns table (
  status text,
  cycle_start_date date,
  cycle_end_date date,
  calculated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle_start_day integer := 1;
  v_current_cycle_start date;
  v_target_exists boolean := false;
  v_target_has_txns boolean := false;
  v_target_has_valid_fx boolean := false;
  v_target_calculated_at timestamptz := null;
  v_deleted_existing boolean := false;
  v_refresh_reason text := coalesce(nullif(trim(p_refresh_reason), ''), 'manual');
begin
  if p_user_id is null or p_cycle_start_date is null or p_cycle_end_date is null then
    return query
    select 'invalid_input'::text, p_cycle_start_date, p_cycle_end_date, null::timestamptz;
    return;
  end if;

  if p_cycle_end_date < p_cycle_start_date then
    return query
    select 'invalid_window'::text, p_cycle_start_date, p_cycle_end_date, null::timestamptz;
    return;
  end if;

  if (p_cycle_end_date - p_cycle_start_date + 1) < 20 then
    delete from public.wisey_cycle_dirty_queue
    where user_id = p_user_id
      and affected_date >= p_cycle_start_date
      and affected_date <= p_cycle_end_date;

    return query
    select 'skipped_short_cycle'::text, p_cycle_start_date, p_cycle_end_date, null::timestamptz;
    return;
  end if;

  v_cycle_start_day := public.wisey_get_user_cycle_start_day(p_user_id);
  v_current_cycle_start := public.wisey_current_cycle_start(current_date, v_cycle_start_day);

  if p_cycle_end_date >= v_current_cycle_start then
    return query
    select 'skipped_open_cycle'::text, p_cycle_start_date, p_cycle_end_date, null::timestamptz;
    return;
  end if;

  with recursive active_user as (
    select
      p_user_id as user_id,
      v_cycle_start_day as cycle_start_day,
      min((wt.date at time zone 'UTC')::date) as first_txn_date
    from public.wallet_transactions wt
    where wt.user_id = p_user_id
  ),
  cycle_seed as (
    select
      au.user_id,
      au.cycle_start_day,
      au.first_txn_date,
      public.wisey_current_cycle_start(current_date, au.cycle_start_day) as current_cycle_start
    from active_user au
    where au.first_txn_date is not null
  ),
  generated_cycles as (
    select
      cs.user_id,
      cs.cycle_start_day,
      cs.first_txn_date,
      public.wisey_previous_cycle_start(cs.current_cycle_start, cs.cycle_start_day) as cycle_start_date,
      (cs.current_cycle_start - interval '1 day')::date as cycle_end_date,
      1 as depth
    from cycle_seed cs

    union all

    select
      gc.user_id,
      gc.cycle_start_day,
      gc.first_txn_date,
      public.wisey_previous_cycle_start(gc.cycle_start_date, gc.cycle_start_day) as cycle_start_date,
      (gc.cycle_start_date - interval '1 day')::date as cycle_end_date,
      gc.depth + 1
    from generated_cycles gc
    where gc.cycle_start_date > (gc.first_txn_date - interval '40 day')::date
      and gc.depth < 240
  ),
  all_cycles as (
    select
      gc.user_id,
      gc.cycle_start_day,
      gc.cycle_start_date,
      gc.cycle_end_date,
      (gc.cycle_end_date - gc.cycle_start_date + 1)::integer as cycle_days
    from generated_cycles gc
    where gc.cycle_end_date >= gc.cycle_start_date
  ),
  valid_cycles as (
    select
      ac.*,
      date_trunc('month', (ac.cycle_start_date + ((ac.cycle_end_date - ac.cycle_start_date) / 2))::timestamp)::date as bucket_month,
      row_number() over (partition by ac.user_id order by ac.cycle_end_date desc) as cycle_rank_desc,
      row_number() over (partition by ac.user_id order by ac.cycle_end_date asc) as cycle_rank_asc
    from all_cycles ac
    where ac.cycle_days >= 20
  ),
  cycle_txns as (
    select
      vc.user_id,
      vc.cycle_start_date,
      vc.cycle_end_date,
      vc.cycle_rank_desc,
      vc.cycle_rank_asc,
      vc.bucket_month,
      wt.id as txn_id,
      wt.amount,
      lower(coalesce(wt.category, '')) as category_key,
      (wt.date at time zone 'UTC')::date as txn_date,
      w.type as wallet_type,
      c.expense_tier,
      public.wisey_txn_amount_to_usd(
        wt.amount,
        wt.reporting_amount,
        upper(wt.reporting_currency),
        upper(w.currency_code),
        (wt.date at time zone 'UTC')::date
      ) as amount_usd
    from valid_cycles vc
    left join public.wallet_transactions wt
      on wt.user_id = vc.user_id
     and (wt.date at time zone 'UTC')::date >= vc.cycle_start_date
     and (wt.date at time zone 'UTC')::date <= vc.cycle_end_date
    left join public.wallets w
      on w.id = wt.wallet_id
    left join public.categories c
      on c.id = wt.category_id
  ),
  cycle_metrics as (
    select
      ct.user_id,
      ct.cycle_start_date,
      ct.cycle_end_date,
      ct.cycle_rank_desc,
      ct.cycle_rank_asc,
      ct.bucket_month,
      count(*) filter (where ct.txn_id is not null) as txn_count,
      count(*) filter (where ct.txn_id is not null and ct.amount_usd is null) as missing_fx_rows,
      coalesce(sum(case when ct.amount > 0 and ct.amount_usd is not null then ct.amount_usd else 0 end), 0) as income_total_normalized,
      coalesce(sum(case when ct.amount < 0 and ct.amount_usd is not null and ct.category_key not in ('transfer', 'balance-adjustment') then abs(ct.amount_usd) else 0 end), 0) as spending_total_normalized,
      coalesce(sum(case when ct.amount < 0 and ct.amount_usd is not null and ct.category_key not in ('transfer', 'balance-adjustment') and extract(isodow from ct.txn_date) in (6, 7) then abs(ct.amount_usd) else 0 end), 0) as weekend_spending_normalized,
      coalesce(sum(case when ct.wallet_type = 'savings' and ct.amount_usd is not null then ct.amount_usd else 0 end), 0) as net_savings_wallet_normalized,
      coalesce(sum(case when ct.amount < 0 and ct.amount_usd is not null and ct.category_key not in ('transfer', 'balance-adjustment') and ct.expense_tier in ('essential', 'flexible_essential') then abs(ct.amount_usd) else 0 end), 0) as essential_spending_normalized,
      coalesce(sum(case when ct.amount < 0 and ct.amount_usd is not null and ct.category_key not in ('transfer', 'balance-adjustment') and ct.expense_tier = 'discretionary' then abs(ct.amount_usd) else 0 end), 0) as discretionary_spending_normalized
    from cycle_txns ct
    group by
      ct.user_id,
      ct.cycle_start_date,
      ct.cycle_end_date,
      ct.cycle_rank_desc,
      ct.cycle_rank_asc,
      ct.bucket_month
  ),
  cycle_metrics_scored as (
    select
      cm.*,
      ums.total_wisey_score
    from cycle_metrics cm
    left join public.user_monthly_scores ums
      on ums.user_id = cm.user_id
     and ums.month = to_char(cm.cycle_end_date, 'YYYY-MM')
  ),
  cycle_with_anchors as (
    select
      cms.*,
      case
        when cms.income_total_normalized > 0 then cms.income_total_normalized
        else 0
      end as income_for_anchor,
      avg(
        case
          when cms.income_total_normalized > 0 then cms.income_total_normalized
          else 0
        end
      ) over (
        partition by cms.user_id
        order by cms.cycle_end_date asc
        rows between 2 preceding and current row
      ) as rolling_income_3
    from cycle_metrics_scored cms
  ),
  target_cycle as (
    select *
    from cycle_with_anchors cwa
    where cwa.cycle_start_date = p_cycle_start_date
      and cwa.cycle_end_date = p_cycle_end_date
  ),
  to_upsert as (
    select
      tc.user_id,
      tc.cycle_start_date,
      tc.cycle_end_date,
      tc.bucket_month,
      case
        when tc.income_total_normalized > 0
          then tc.net_savings_wallet_normalized / tc.income_total_normalized
        else null
      end as savings_rate_v2,
      case
        when tc.income_total_normalized > 0
          then tc.spending_total_normalized / tc.income_total_normalized
        else null
      end as spending_ratio,
      case
        when tc.spending_total_normalized > 0
          then tc.weekend_spending_normalized / tc.spending_total_normalized
        else null
      end as weekend_ratio,
      tc.total_wisey_score,
      case
        when tc.spending_total_normalized > 0
          then tc.essential_spending_normalized / tc.spending_total_normalized
        else null
      end as essentials_ratio,
      case
        when tc.spending_total_normalized > 0
          then tc.discretionary_spending_normalized / tc.spending_total_normalized
        else null
      end as discretionary_ratio,
      case
        when tc.income_total_normalized > 0
          then greatest(tc.income_total_normalized - tc.spending_total_normalized, 0) / tc.income_total_normalized
        else null
      end as savings_ratio,
      tc.income_total_normalized,
      case
        when tc.cycle_rank_asc <= 3 then tc.income_for_anchor
        else tc.rolling_income_3
      end as income_anchor_normalized,
      case
        when tc.cycle_rank_asc <= 3 then 1
        else 3
      end as anchor_window_size,
      'USD'::text as reference_currency_code,
      tc.txn_count,
      tc.missing_fx_rows
    from target_cycle tc
    where tc.txn_count > 0
      and (tc.txn_count - tc.missing_fx_rows) > 0
  ),
  upserted as (
    insert into public.user_cycle_scores (
      user_id,
      cycle_start_date,
      cycle_end_date,
      bucket_month,
      savings_rate_v2,
      spending_ratio,
      weekend_ratio,
      total_wisey_score,
      essentials_ratio,
      discretionary_ratio,
      savings_ratio,
      income_total_normalized,
      income_anchor_normalized,
      anchor_window_size,
      reference_currency_code,
      calculated_at,
      created_at,
      updated_at,
      last_refresh_reason
    )
    select
      tu.user_id,
      tu.cycle_start_date,
      tu.cycle_end_date,
      tu.bucket_month,
      tu.savings_rate_v2,
      tu.spending_ratio,
      tu.weekend_ratio,
      tu.total_wisey_score,
      tu.essentials_ratio,
      tu.discretionary_ratio,
      tu.savings_ratio,
      tu.income_total_normalized,
      tu.income_anchor_normalized,
      tu.anchor_window_size,
      tu.reference_currency_code,
      now(),
      now(),
      now(),
      v_refresh_reason
    from to_upsert tu
    on conflict (user_id, cycle_start_date, cycle_end_date) do update
    set
      bucket_month = excluded.bucket_month,
      savings_rate_v2 = excluded.savings_rate_v2,
      spending_ratio = excluded.spending_ratio,
      weekend_ratio = excluded.weekend_ratio,
      total_wisey_score = excluded.total_wisey_score,
      essentials_ratio = excluded.essentials_ratio,
      discretionary_ratio = excluded.discretionary_ratio,
      savings_ratio = excluded.savings_ratio,
      income_total_normalized = excluded.income_total_normalized,
      income_anchor_normalized = excluded.income_anchor_normalized,
      anchor_window_size = excluded.anchor_window_size,
      reference_currency_code = excluded.reference_currency_code,
      calculated_at = now(),
      updated_at = now(),
      last_refresh_reason = excluded.last_refresh_reason
    returning calculated_at
  ),
  deleted as (
    delete from public.user_cycle_scores ucs
    where ucs.user_id = p_user_id
      and ucs.cycle_start_date = p_cycle_start_date
      and ucs.cycle_end_date = p_cycle_end_date
      and (
        not exists (select 1 from target_cycle)
        or not exists (select 1 from target_cycle where txn_count > 0)
      )
    returning true as deleted
  )
  select
    exists(select 1 from target_cycle),
    exists(select 1 from target_cycle where txn_count > 0),
    exists(select 1 from to_upsert),
    (select calculated_at from upserted limit 1),
    exists(select 1 from deleted)
  into
    v_target_exists,
    v_target_has_txns,
    v_target_has_valid_fx,
    v_target_calculated_at,
    v_deleted_existing;

  if v_target_calculated_at is not null then
    delete from public.wisey_cycle_dirty_queue
    where user_id = p_user_id
      and affected_date >= p_cycle_start_date
      and affected_date <= p_cycle_end_date;

    return query
    select 'upserted'::text, p_cycle_start_date, p_cycle_end_date, v_target_calculated_at;
    return;
  end if;

  if v_target_exists and v_target_has_txns and not v_target_has_valid_fx then
    delete from public.wisey_cycle_dirty_queue
    where user_id = p_user_id
      and affected_date >= p_cycle_start_date
      and affected_date <= p_cycle_end_date;

    perform public.enqueue_wisey_cycle_dirty_date(p_user_id, p_cycle_start_date);

    update public.wisey_cycle_dirty_queue
    set
      attempt_count = attempt_count + 1,
      last_attempt_at = now(),
      last_error = 'missing_fx_rows',
      updated_at = now()
    where user_id = p_user_id
      and affected_date = p_cycle_start_date;

    return query
    select 'skipped_missing_fx'::text, p_cycle_start_date, p_cycle_end_date, null::timestamptz;
    return;
  end if;

  if v_deleted_existing or not v_target_exists or not v_target_has_txns then
    delete from public.wisey_cycle_dirty_queue
    where user_id = p_user_id
      and affected_date >= p_cycle_start_date
      and affected_date <= p_cycle_end_date;

    perform public.enqueue_wisey_cycle_dirty_date(p_user_id, p_cycle_start_date);

    update public.wisey_cycle_dirty_queue
    set
      attempt_count = attempt_count + 1,
      last_attempt_at = now(),
      last_error = 'no_valid_data',
      updated_at = now()
    where user_id = p_user_id
      and affected_date = p_cycle_start_date;

    return query
    select 'deleted_no_valid_data'::text, p_cycle_start_date, p_cycle_end_date, null::timestamptz;
    return;
  end if;

  return query
  select 'no_change'::text, p_cycle_start_date, p_cycle_end_date, null::timestamptz;
exception
  when others then
    update public.wisey_cycle_dirty_queue
    set
      attempt_count = attempt_count + 1,
      last_attempt_at = now(),
      last_error = sqlerrm,
      updated_at = now()
    where user_id = p_user_id
      and affected_date >= p_cycle_start_date
      and affected_date <= p_cycle_end_date;

    raise;
end;
$$;

revoke all on function public.recompute_wisey_cycle_score(uuid, date, date, text) from public;
grant execute on function public.recompute_wisey_cycle_score(uuid, date, date, text) to service_role;

create or replace function public.recompute_wisey_latest_completed_cycle_score(
  p_user_id uuid,
  p_reference_date date default current_date,
  p_refresh_reason text default 'latest_completed_cycle'
)
returns table (
  status text,
  cycle_start_date date,
  cycle_end_date date,
  calculated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle_start_day integer := 1;
  v_cycle_start_date date;
  v_cycle_end_date date;
begin
  v_cycle_start_day := public.wisey_get_user_cycle_start_day(p_user_id);

  select
    latest.cycle_start_date,
    latest.cycle_end_date
  into
    v_cycle_start_date,
    v_cycle_end_date
  from public.wisey_latest_completed_cycle_window(
    coalesce(p_reference_date, current_date),
    v_cycle_start_day
  ) latest;

  return query
  select *
  from public.recompute_wisey_cycle_score(
    p_user_id,
    v_cycle_start_date,
    v_cycle_end_date,
    p_refresh_reason
  );
end;
$$;

revoke all on function public.recompute_wisey_latest_completed_cycle_score(uuid, date, text) from public;
grant execute on function public.recompute_wisey_latest_completed_cycle_score(uuid, date, text) to service_role;
