-- Bucket 1 lockdown: stop public cross-user reads first.
-- Review-only at this stage: do not apply live until approved.

-- Plaid tokens should never be world-readable. Keep this idempotent in case
-- the live project already dropped the accidental dev policy.
drop policy if exists dev_read_plaid_items on public.plaid_items;

-- Cross-user SECURITY DEFINER views should not be client-readable.
revoke all on table public.category_spending_view from anon, authenticated;
revoke all on table public.obligation_source_v1 from anon, authenticated;
revoke all on table public.txn_categorization_observability from anon, authenticated;
revoke all on table public.txn_statement_noise_user_weekly from anon, authenticated;

-- Belt-and-braces: even if a grant drifts back later, these views should
-- evaluate using the caller's permissions and underlying RLS.
alter view public.category_spending_view set (security_invoker = true);
alter view public.obligation_source_v1 set (security_invoker = true);
alter view public.txn_categorization_observability set (security_invoker = true);
alter view public.txn_statement_noise_user_weekly set (security_invoker = true);

-- These three are live app paths. Keep the grants for now, but make the view
-- execution model safer so they respect caller permissions and base-table RLS.
alter view public.user_transactions set (security_invoker = true);
alter view public.user_wallets set (security_invoker = true);
alter view public.user_challenges set (security_invoker = true);
