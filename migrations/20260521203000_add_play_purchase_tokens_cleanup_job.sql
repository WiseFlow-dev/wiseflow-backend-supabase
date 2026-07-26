create index if not exists idx_play_purchase_tokens_last_seen_at
  on public.play_purchase_tokens(last_seen_at);

create or replace function public.cleanup_stale_play_purchase_tokens(p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer := 0;
begin
  delete from public.play_purchase_tokens
  where last_seen_at < now() - make_interval(days => p_days);

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.cleanup_stale_play_purchase_tokens(integer) from public;
grant execute on function public.cleanup_stale_play_purchase_tokens(integer) to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (
      select 1
      from cron.job
      where jobname = 'cleanup_stale_play_purchase_tokens_daily'
    ) then
      perform cron.schedule(
        'cleanup_stale_play_purchase_tokens_daily',
        '17 3 * * *',
        $cron$select public.cleanup_stale_play_purchase_tokens(90);$cron$
      );
    end if;
  end if;
end;
$$;
