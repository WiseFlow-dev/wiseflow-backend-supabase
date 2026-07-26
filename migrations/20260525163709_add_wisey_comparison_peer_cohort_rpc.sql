create or replace function public.wisey_format_income_band_label(
  p_min numeric,
  p_max numeric
)
returns text
language plpgsql
immutable
as $$
begin
  return '$' || trim(to_char(coalesce(p_min, 0), 'FM999999990'))
    || '-$'
    || trim(to_char(coalesce(p_max, 0), 'FM999999990'));
end;
$$;

create or replace function public.wisey_income_band_for_anchor(
  p_income_anchor_usd numeric
)
returns table (
  base_min numeric,
  base_max numeric,
  widened_min numeric,
  widened_max numeric,
  base_label text,
  widened_label text
)
language plpgsql
immutable
as $$
declare
  v_anchor numeric := greatest(coalesce(p_income_anchor_usd, 0), 0);
  v_step numeric := 2000;
begin
  if v_anchor < 500 then
    return query
    select 0::numeric, 500::numeric, 0::numeric, 1500::numeric, '$0-$500'::text, '$0-$1500'::text;
    return;
  end if;

  if v_anchor < 1500 then
    return query
    select 500::numeric, 1500::numeric, 0::numeric, 3000::numeric, '$500-$1500'::text, '$0-$3000'::text;
    return;
  end if;

  if v_anchor < 3000 then
    return query
    select 1500::numeric, 3000::numeric, 500::numeric, 5000::numeric, '$1500-$3000'::text, '$500-$5000'::text;
    return;
  end if;

  if v_anchor < 5000 then
    return query
    select 3000::numeric, 5000::numeric, 1500::numeric, 7000::numeric, '$3000-$5000'::text, '$1500-$7000'::text;
    return;
  end if;

  if v_anchor < 7000 then
    return query
    select 5000::numeric, 7000::numeric, 3000::numeric, 9000::numeric, '$5000-$7000'::text, '$3000-$9000'::text;
    return;
  end if;

  base_min := floor((v_anchor - 7000) / v_step) * v_step + 7000;
  base_max := base_min + v_step;
  widened_min := greatest(7000, base_min - v_step);
  widened_max := base_max + v_step;
  base_label := public.wisey_format_income_band_label(base_min, base_max);
  widened_label := public.wisey_format_income_band_label(widened_min, widened_max);
  return next;
end;
$$;

create or replace function public.get_wisey_comparison_peer_cohort(
  p_user_id uuid,
  p_bucket_month date,
  p_income_anchor_usd numeric,
  p_min_peer_count integer default 25
)
returns table (
  peer_count integer,
  peer_band_label text,
  has_sufficient_peers boolean,
  used_income_band_widening boolean,
  used_adjacent_month_widening boolean,
  median_savings_ratio numeric,
  median_spending_ratio numeric,
  median_weekend_ratio numeric,
  savings_rate_available boolean,
  spending_control_available boolean,
  weekend_spend_share_available boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base_min numeric;
  v_base_max numeric;
  v_widened_min numeric;
  v_widened_max numeric;
  v_base_label text;
  v_widened_label text;
begin
  select
    band.base_min,
    band.base_max,
    band.widened_min,
    band.widened_max,
    band.base_label,
    band.widened_label
  into
    v_base_min,
    v_base_max,
    v_widened_min,
    v_widened_max,
    v_base_label,
    v_widened_label
  from public.wisey_income_band_for_anchor(p_income_anchor_usd) band;

  return query
  with cohort_base as (
    select
      ucs.savings_ratio,
      ucs.spending_ratio,
      ucs.weekend_ratio
    from public.user_cycle_scores ucs
    where ucs.bucket_month = p_bucket_month
      and ucs.income_anchor_normalized >= v_base_min
      and ucs.income_anchor_normalized < v_base_max
      and ucs.user_id <> p_user_id
      and not exists (
        select 1
        from public.internal_test_users itu
        where itu.user_id = ucs.user_id
      )
  ),
  cohort_widened_band as (
    select
      ucs.savings_ratio,
      ucs.spending_ratio,
      ucs.weekend_ratio
    from public.user_cycle_scores ucs
    where ucs.bucket_month = p_bucket_month
      and ucs.income_anchor_normalized >= v_widened_min
      and ucs.income_anchor_normalized < v_widened_max
      and ucs.user_id <> p_user_id
      and not exists (
        select 1
        from public.internal_test_users itu
        where itu.user_id = ucs.user_id
      )
  ),
  cohort_adjacent_months as (
    select
      ucs.savings_ratio,
      ucs.spending_ratio,
      ucs.weekend_ratio
    from public.user_cycle_scores ucs
    where ucs.bucket_month in (
      (date_trunc('month', p_bucket_month) - interval '1 month')::date,
      p_bucket_month,
      (date_trunc('month', p_bucket_month) + interval '1 month')::date
    )
      and ucs.income_anchor_normalized >= v_widened_min
      and ucs.income_anchor_normalized < v_widened_max
      and ucs.user_id <> p_user_id
      and not exists (
        select 1
        from public.internal_test_users itu
        where itu.user_id = ucs.user_id
      )
  ),
  agg_base as (
    select
      1 as stage,
      count(*)::integer as peer_count,
      v_base_label::text as peer_band_label,
      false as used_income_band_widening,
      false as used_adjacent_month_widening,
      count(savings_ratio)::integer as savings_count,
      count(spending_ratio)::integer as spending_count,
      count(weekend_ratio)::integer as weekend_count,
      percentile_cont(0.5) within group (order by savings_ratio) filter (where savings_ratio is not null) as median_savings_ratio,
      percentile_cont(0.5) within group (order by spending_ratio) filter (where spending_ratio is not null) as median_spending_ratio,
      percentile_cont(0.5) within group (order by weekend_ratio) filter (where weekend_ratio is not null) as median_weekend_ratio
    from cohort_base
  ),
  agg_widened_band as (
    select
      2 as stage,
      count(*)::integer as peer_count,
      (v_widened_label || ' (widened)')::text as peer_band_label,
      true as used_income_band_widening,
      false as used_adjacent_month_widening,
      count(savings_ratio)::integer as savings_count,
      count(spending_ratio)::integer as spending_count,
      count(weekend_ratio)::integer as weekend_count,
      percentile_cont(0.5) within group (order by savings_ratio) filter (where savings_ratio is not null) as median_savings_ratio,
      percentile_cont(0.5) within group (order by spending_ratio) filter (where spending_ratio is not null) as median_spending_ratio,
      percentile_cont(0.5) within group (order by weekend_ratio) filter (where weekend_ratio is not null) as median_weekend_ratio
    from cohort_widened_band
  ),
  agg_adjacent_months as (
    select
      3 as stage,
      count(*)::integer as peer_count,
      (v_widened_label || ' + adjacent months')::text as peer_band_label,
      true as used_income_band_widening,
      true as used_adjacent_month_widening,
      count(savings_ratio)::integer as savings_count,
      count(spending_ratio)::integer as spending_count,
      count(weekend_ratio)::integer as weekend_count,
      percentile_cont(0.5) within group (order by savings_ratio) filter (where savings_ratio is not null) as median_savings_ratio,
      percentile_cont(0.5) within group (order by spending_ratio) filter (where spending_ratio is not null) as median_spending_ratio,
      percentile_cont(0.5) within group (order by weekend_ratio) filter (where weekend_ratio is not null) as median_weekend_ratio
    from cohort_adjacent_months
  ),
  candidate_sets as (
    select * from agg_base
    union all
    select * from agg_widened_band
    union all
    select * from agg_adjacent_months
  ),
  picked as (
    select *
    from candidate_sets cs
    where cs.peer_count >= greatest(1, p_min_peer_count)
    order by cs.stage
    limit 1
  ),
  fallback as (
    select *
    from candidate_sets
    order by stage desc
    limit 1
  ),
  chosen as (
    select * from picked
    union all
    select * from fallback
    where not exists (select 1 from picked)
  )
  select
    chosen.peer_count,
    chosen.peer_band_label,
    (chosen.peer_count >= greatest(1, p_min_peer_count)) as has_sufficient_peers,
    chosen.used_income_band_widening,
    chosen.used_adjacent_month_widening,
    case
      when chosen.savings_count >= greatest(1, p_min_peer_count)
        then chosen.median_savings_ratio::numeric
      else null
    end as median_savings_ratio,
    case
      when chosen.spending_count >= greatest(1, p_min_peer_count)
        then chosen.median_spending_ratio::numeric
      else null
    end as median_spending_ratio,
    case
      when chosen.weekend_count >= greatest(1, p_min_peer_count)
        then chosen.median_weekend_ratio::numeric
      else null
    end as median_weekend_ratio,
    (chosen.savings_count >= greatest(1, p_min_peer_count)) as savings_rate_available,
    (chosen.spending_count >= greatest(1, p_min_peer_count)) as spending_control_available,
    (chosen.weekend_count >= greatest(1, p_min_peer_count)) as weekend_spend_share_available
  from chosen;
end;
$$;

revoke all on function public.get_wisey_comparison_peer_cohort(uuid, date, numeric, integer) from public;
grant execute on function public.get_wisey_comparison_peer_cohort(uuid, date, numeric, integer) to service_role;
