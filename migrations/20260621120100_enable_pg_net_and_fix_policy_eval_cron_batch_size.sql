create extension if not exists pg_net schema extensions;

create or replace function public.invoke_policy_eval_cron()
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
    raise warning 'invoke_policy_eval_cron: wisey_cron_secret not found in vault, skipping';
    return;
  end if;

  -- Small page/batch size so this single call returns in seconds; the function
  -- chains itself in the background (EdgeRuntime.waitUntil) to cover every
  -- remaining user without this caller needing to stay connected.
  perform net.http_post(
    url := 'https://gkwjbnvvluknfwnaxmay.supabase.co/functions/v1/policy-eval-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', v_secret
    ),
    body := jsonb_build_object(
      'perPage', 25,
      'pageBudget', 1,
      'policyBatchSize', 25
    ),
    timeout_milliseconds := 30000
  );
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net') then
    if not exists (
      select 1
      from cron.job
      where jobname = 'policy_eval_cron_daily'
    ) then
      perform cron.schedule(
        'policy_eval_cron_daily',
        '30 4 * * *',
        $cron$select public.invoke_policy_eval_cron();$cron$
      );
    end if;
  end if;
end;
$$;
