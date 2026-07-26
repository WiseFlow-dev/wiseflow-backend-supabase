-- Schedule the currency-rebase-worker edge function.
--
-- Migration 064 added the trigger that enqueues currency_rebase_jobs whenever
-- user_preferences.currency changes, and the worker function exists and is
-- deployed — but nothing ever invoked it, so jobs sat in 'queued' forever and
-- wallet_transactions.reporting_amount stayed in the user's OLD main currency
-- after a currency switch (observed in production: job 136 queued for 7 days,
-- job 145 queued with 0/18 rows processed).
--
-- The worker authenticates with header 'x-cron-key' matching its CRON_SECRET
-- env var. It self-limits to MAX_JOBS_PER_RUN=2 and MAX_RETRY_ROWS_PER_RUN=50,
-- so a minutely schedule is cheap when the queues are empty.

create or replace function public.invoke_currency_rebase_worker()
returns void
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'wisey_cron_secret'
  limit 1;

  if v_secret is null then
    raise warning 'invoke_currency_rebase_worker: wisey_cron_secret not found in vault, skipping';
    return;
  end if;

  perform net.http_post(
    url := 'https://gkwjbnvvluknfwnaxmay.supabase.co/functions/v1/currency-rebase-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 110000
  );
end;
$$;

revoke all on function public.invoke_currency_rebase_worker() from public;
grant execute on function public.invoke_currency_rebase_worker() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net') then
    if not exists (
      select 1
      from cron.job
      where jobname = 'currency_rebase_worker_minutely'
    ) then
      perform cron.schedule(
        'currency_rebase_worker_minutely',
        '* * * * *',
        $cron$select public.invoke_currency_rebase_worker();$cron$
      );
    end if;
  end if;
end;
$$;
