-- Bucket 2 lockdown: internal worker / maintenance / recompute RPCs should
-- not be callable from client roles. Review first; do not apply live until
-- approved.

-- Stop future drift for newly created functions in public.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

alter default privileges for role supabase_admin in schema public
  revoke execute on functions from public, anon, authenticated;

-- Internal worker / cleanup / recompute RPCs: service-role only.
revoke execute on function public.cleanup_old_aggregates_and_cache() from public, anon, authenticated;
revoke execute on function public.cleanup_old_llm_jobs(integer) from public, anon, authenticated;
revoke execute on function public.cleanup_old_sync_event_logs(integer) from public, anon, authenticated;
revoke execute on function public.cleanup_stale_play_purchase_tokens(integer) from public, anon, authenticated;

revoke execute on function public.get_next_llm_job() from public, anon, authenticated;
revoke execute on function public.mark_llm_job_processing(bigint) from public, anon, authenticated;
revoke execute on function public.mark_llm_job_completed(bigint) from public, anon, authenticated;
revoke execute on function public.mark_llm_job_failed(bigint, text) from public, anon, authenticated;

revoke execute on function public.process_wisey_cycle_dirty_queue(integer) from public, anon, authenticated;
revoke execute on function public.recompute_wisey_cycle_score(uuid, date, date, text) from public, anon, authenticated;
revoke execute on function public.recompute_wisey_latest_completed_cycle_score(uuid, date, text) from public, anon, authenticated;

-- Preserve the intended backend path explicitly.
grant execute on function public.cleanup_old_aggregates_and_cache() to service_role;
grant execute on function public.cleanup_old_llm_jobs(integer) to service_role;
grant execute on function public.cleanup_old_sync_event_logs(integer) to service_role;
grant execute on function public.cleanup_stale_play_purchase_tokens(integer) to service_role;

grant execute on function public.get_next_llm_job() to service_role;
grant execute on function public.mark_llm_job_processing(bigint) to service_role;
grant execute on function public.mark_llm_job_completed(bigint) to service_role;
grant execute on function public.mark_llm_job_failed(bigint, text) to service_role;

grant execute on function public.process_wisey_cycle_dirty_queue(integer) to service_role;
grant execute on function public.recompute_wisey_cycle_score(uuid, date, date, text) to service_role;
grant execute on function public.recompute_wisey_latest_completed_cycle_score(uuid, date, text) to service_role;
