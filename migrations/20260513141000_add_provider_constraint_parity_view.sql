-- Phase 0 guardrail: detect provider allowlist drift across shared bank tables.
-- This is read-only and safe; it does not modify runtime data.

create or replace view public.provider_constraint_parity as
with target_constraints as (
  select
    n.nspname as schema_name,
    t.relname as table_name,
    c.conname as constraint_name,
    pg_get_constraintdef(c.oid) as constraint_def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and (
      (t.relname = 'accounts' and c.conname = 'accounts_provider_check')
      or (t.relname = 'transactions' and c.conname = 'transactions_provider_check')
      or (t.relname = 'wallet_transactions' and c.conname = 'wallet_transactions_provider_check')
    )
)
select
  schema_name,
  table_name,
  constraint_name,
  constraint_def,
  position('finverse' in lower(constraint_def)) > 0 as allows_finverse,
  position('plaid' in lower(constraint_def)) > 0 as allows_plaid,
  position('truelayer' in lower(constraint_def)) > 0 as allows_truelayer,
  position('gocardless' in lower(constraint_def)) > 0 as allows_gocardless,
  (
    position('finverse' in lower(constraint_def)) > 0
    and position('plaid' in lower(constraint_def)) > 0
    and position('truelayer' in lower(constraint_def)) > 0
    and position('gocardless' in lower(constraint_def)) > 0
  ) as parity_ok
from target_constraints;

comment on view public.provider_constraint_parity is
'Pre-release parity check for provider allowlists on accounts/transactions/wallet_transactions.';
