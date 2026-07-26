-- Backfill missing wallet_transactions mirror rows for bank-imported transactions.
-- Why:
-- - user_transactions (transactions + txn_categorization) can contain more rows than wallet_transactions.
-- - On logout/login, Android restore reads wallet_transactions and can lose rows that were never mirrored.
--
-- Strategy:
-- 1) Infer (user_id, account_id) -> wallet_id mapping from already mirrored rows.
-- 2) Infer per-account sign convention from mirrored rows:
--    - If mirrored amount sign is usually opposite of transactions.amount, multiply by -1.
--    - Otherwise keep as-is.
-- 3) Insert only missing rows (where provider_txn_id is absent in wallet_transactions).
-- 4) Carry category + suggested state from txn_categorization, preferring category_user over category_model.

with account_wallet_map as (
  select
    wt.user_id,
    t.account_id,
    min(wt.wallet_id::text)::uuid as wallet_id,
    case
      when sum(case when t.amount <> 0 and (wt.amount * t.amount) < 0 then 1 else 0 end)
           > sum(case when t.amount <> 0 then 1 else 0 end) / 2.0
      then -1::numeric
      else 1::numeric
    end as sign_multiplier
  from public.wallet_transactions wt
  join public.transactions t
    on t.user_id = wt.user_id
   and t.txn_id = wt.provider_txn_id
  where wt.provider_txn_id is not null
    and wt.wallet_id is not null
  group by wt.user_id, t.account_id
),
missing as (
  select
    t.user_id,
    t.txn_id,
    t.account_id,
    t.txn_date,
    t.authorized_date,
    t.name,
    t.merchant,
    t.merchant_name,
    t.amount,
    t.pending,
    map.wallet_id,
    map.sign_multiplier,
    lower(
      coalesce(
        nullif(trim(t.provider), ''),
        case when t.txn_id like 'tl_%' then 'truelayer' else 'plaid' end
      )
    ) as provider_norm,
    coalesce(
      nullif(trim(tc.category_user), ''),
      nullif(trim(tc.category_model), ''),
      'Uncategorized'
    ) as category_name,
    case
      when nullif(trim(tc.category_user), '') is not null then false
      else coalesce(tc.is_suggested, false)
    end as is_suggested
  from public.transactions t
  join account_wallet_map map
    on map.user_id = t.user_id
   and map.account_id = t.account_id
  left join public.txn_categorization tc
    on tc.user_id = t.user_id
   and tc.txn_id = t.txn_id
  where not exists (
    select 1
    from public.wallet_transactions wt
    where wt.user_id = t.user_id
      and wt.provider_txn_id = t.txn_id
  )
)
insert into public.wallet_transactions (
  id,
  user_id,
  wallet_id,
  amount,
  category,
  category_id,
  title,
  note,
  date,
  is_budget_rollover,
  is_opening_balance,
  is_manual_topup,
  is_suggested,
  source,
  provider,
  provider_txn_id,
  sync_status
)
select
  gen_random_uuid(),
  m.user_id,
  m.wallet_id,
  (m.amount * m.sign_multiplier),
  m.category_name,
  cat.id,
  coalesce(
    nullif(trim(m.name), ''),
    nullif(trim(m.merchant_name), ''),
    nullif(trim(m.merchant), ''),
    'Transaction'
  ) as title,
  format(
    'Synced from %s on %s [source:bank] [provider:%s] [sync_status:%s]',
    coalesce(
      nullif(trim(m.merchant_name), ''),
      nullif(trim(m.merchant), ''),
      nullif(trim(m.name), ''),
      'bank'
    ),
    coalesce(m.authorized_date, m.txn_date)::text,
    case
      when m.provider_norm in ('plaid', 'truelayer', 'gocardless') then m.provider_norm
      when m.txn_id like 'tl_%' then 'truelayer'
      else 'plaid'
    end,
    case when m.pending then 'pending' else 'posted' end
  ) as note,
  (coalesce(m.authorized_date, m.txn_date)::timestamp at time zone 'UTC') as date,
  false as is_budget_rollover,
  false as is_opening_balance,
  false as is_manual_topup,
  m.is_suggested,
  'bank' as source,
  case
    when m.provider_norm in ('plaid', 'truelayer', 'gocardless') then m.provider_norm
    when m.txn_id like 'tl_%' then 'truelayer'
    else 'plaid'
  end as provider,
  m.txn_id as provider_txn_id,
  case when m.pending then 'pending' else 'posted' end as sync_status
from missing m
left join lateral (
  select c.id
  from public.categories c
  where (c.user_id = m.user_id or c.is_system = true)
    and lower(trim(c.name)) = lower(trim(m.category_name))
  order by
    case when c.user_id = m.user_id then 0 else 1 end,
    c.created_at desc
  limit 1
) cat on true;
