drop trigger trigger_invalidate_cache_on_update
  on public.wallet_transactions;

drop view public.category_spending_view;

alter table public.wallet_transactions
  alter column amount type numeric(18, 2),
  alter column reporting_amount type numeric(24, 6);

create view public.category_spending_view
with (security_invoker = true)
as
select
  wt.user_id,
  coalesce(c.name, wt.category) as category_name,
  to_char(wt.date, 'YYYY-MM') as month_key,
  sum(
    case
      when wt.amount < 0 then -wt.amount
      else 0
    end
  ) as total_spent,
  count(*) as transaction_count
from public.wallet_transactions wt
left join public.categories c
  on c.user_id = wt.user_id
  and c.name = wt.category
group by
  wt.user_id,
  coalesce(c.name, wt.category),
  to_char(wt.date, 'YYYY-MM');

revoke all on table public.category_spending_view from anon, authenticated;
grant all on table public.category_spending_view to service_role;

create trigger trigger_invalidate_cache_on_update
after update on public.wallet_transactions
for each row
when (
  old.amount is distinct from new.amount
  or old.date is distinct from new.date
  or old.category is distinct from new.category
)
execute function public.trigger_invalidate_aggregate_on_txn_change_v2();

comment on column public.wallet_transactions.amount is
  'Transaction amount in the wallet currency, stored as an exact decimal.';

comment on column public.wallet_transactions.reporting_amount is
  'Transaction amount converted to reporting_currency using fx_rate_used.';
