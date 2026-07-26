create or replace view public.wisey_comparison_cohort_density as
select
  ucs.bucket_month,
  band.base_label as income_band_label,
  count(*)::integer as user_count,
  count(ucs.savings_ratio)::integer as savings_rate_count,
  count(ucs.spending_ratio)::integer as spending_control_count,
  count(ucs.weekend_ratio)::integer as weekend_spend_share_count
from public.user_cycle_scores ucs
cross join lateral public.wisey_income_band_for_anchor(ucs.income_anchor_normalized) band
where not exists (
  select 1
  from public.internal_test_users itu
  where itu.user_id = ucs.user_id
)
group by
  ucs.bucket_month,
  band.base_label;

create or replace function public.get_wisey_comparison_cards_health_snapshot(
  p_min_peer_count integer default 25
)
returns table (
  active_user_count integer,
  completed_cycle_user_count integer,
  fresh_cycle_row_user_count integer,
  renderable_cohort_user_count integer,
  stale_queue_entry_count integer,
  refresh_success_24h integer,
  refresh_failure_24h integer
)
language sql
security definer
set search_path = public
as $$
  with active_users as (
    select count(distinct wt.user_id)::integer as active_user_count
    from public.wallet_transactions wt
    where not exists (
      select 1
      from public.internal_test_users itu
      where itu.user_id = wt.user_id
    )
  ),
  latest_cycle_rows as (
    select distinct on (ucs.user_id)
      ucs.user_id,
      ucs.cycle_start_date,
      ucs.cycle_end_date,
      ucs.bucket_month,
      ucs.income_anchor_normalized
    from public.user_cycle_scores ucs
    where not exists (
      select 1
      from public.internal_test_users itu
      where itu.user_id = ucs.user_id
    )
    order by
      ucs.user_id,
      ucs.cycle_end_date desc
  ),
  fresh_cycle_rows as (
    select lcr.*
    from latest_cycle_rows lcr
    where not exists (
      select 1
      from public.wisey_cycle_dirty_queue q
      where q.user_id = lcr.user_id
        and q.affected_date >= lcr.cycle_start_date
        and q.affected_date <= lcr.cycle_end_date
    )
  ),
  renderable_cycle_rows as (
    select count(*)::integer as renderable_cohort_user_count
    from fresh_cycle_rows fcr
    cross join lateral public.get_wisey_comparison_peer_cohort(
      fcr.user_id,
      fcr.bucket_month,
      fcr.income_anchor_normalized,
      p_min_peer_count
    ) cohort
    where cohort.savings_rate_available
      or cohort.spending_control_available
      or cohort.weekend_spend_share_available
  ),
  queue_counts as (
    select
      count(*)::integer as stale_queue_entry_count,
      count(*) filter (
        where q.last_error is not null
          and q.last_attempt_at is not null
          and q.last_attempt_at >= now() - interval '1 day'
      )::integer as refresh_failure_24h
    from public.wisey_cycle_dirty_queue q
  ),
  refresh_counts as (
    select
      count(*) filter (
        where ucs.calculated_at >= now() - interval '1 day'
      )::integer as refresh_success_24h
    from public.user_cycle_scores ucs
  )
  select
    au.active_user_count,
    (select count(*)::integer from latest_cycle_rows),
    (select count(*)::integer from fresh_cycle_rows),
    rcr.renderable_cohort_user_count,
    qc.stale_queue_entry_count,
    rc.refresh_success_24h,
    qc.refresh_failure_24h
  from active_users au
  cross join renderable_cycle_rows rcr
  cross join queue_counts qc
  cross join refresh_counts rc;
$$;

revoke all on function public.get_wisey_comparison_cards_health_snapshot(integer) from public;
grant execute on function public.get_wisey_comparison_cards_health_snapshot(integer) to service_role;
