-- Backfill existing statement-noise transactions so observability and queue behavior
-- reflect the sentinel immediately (not only for new syncs).

-- 1) Ensure existing rows that normalize to statement-noise are categorized as
--    Uncategorized (without touching user overrides).
update public.txn_categorization tc
set
  category_model = 'Uncategorized',
  category_confidence = 1.0,
  merchant_normalized = '__statement_noise__',
  is_suggested = false,
  updated_at = now()
from public.transactions t
where t.user_id = tc.user_id
  and t.txn_id = tc.txn_id
  and coalesce(t.is_removed, false) = false
  and normalize_merchant(coalesce(t.merchant_name, t.merchant, t.name, '')) = '__statement_noise__'
  and tc.category_user is null;

-- 2) Insert missing categorization rows for statement-noise transactions.
insert into public.txn_categorization (
  user_id,
  txn_id,
  category_model,
  category_confidence,
  merchant_normalized,
  is_suggested,
  updated_at
)
select
  t.user_id,
  t.txn_id,
  'Uncategorized',
  1.0,
  '__statement_noise__',
  false,
  now()
from public.transactions t
left join public.txn_categorization tc
  on tc.user_id = t.user_id
 and tc.txn_id = t.txn_id
where tc.txn_id is null
  and coalesce(t.is_removed, false) = false
  and normalize_merchant(coalesce(t.merchant_name, t.merchant, t.name, '')) = '__statement_noise__';

-- 3) Stop spending AI queue budget on statement-noise rows.
update public.ai_categorization_queue q
set
  status = 'done',
  result_category_key = 'Uncategorized',
  result_confidence = 1.0,
  is_suggested = false,
  merchant_normalized = '__statement_noise__',
  claimed_at = null,
  processed_at = now()
where normalize_merchant(coalesce(q.merchant_normalized, q.merchant_raw, '')) = '__statement_noise__'
  and q.status in ('pending', 'processing', 'failed');
