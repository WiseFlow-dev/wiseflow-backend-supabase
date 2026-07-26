-- Phase 1 follow-up:
-- 1) Keep SQL merchant normalization aligned with the edge-function Phase 1 normalizer.
-- 2) Introduce a stable statement-noise sentinel.
-- 3) Provide observability views that exclude statement-noise rows from accuracy denominators.

create or replace function public.normalize_merchant(raw text)
returns text
language sql
immutable
as $function$
  with normalized as (
    select trim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              lower(coalesce(raw, '')),
              '[_*]+',
              ' ',
              'g'
            ),
            '[^a-z0-9\s]',
            ' ',
            'g'
          ),
          '\m(inc|llc|ltd|co|corp|the)\M',
          ' ',
          'g'
        ),
        '\s+',
        ' ',
        'g'
      )
    ) as s
  ),
  stripped as (
    select trim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              s,
              '(^|\s)(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[ _-]?[0-9]{1,2}$',
              '',
              'i'
            ),
            '(^|\s)(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[0-9]{4}$',
            '',
            'i'
          ),
          '(^|\s)[0-9]{4}[/-][0-9]{1,2}[/-][0-9]{1,2}$',
          '',
          'i'
        ),
        '(^|\s)[0-9]{1,2}[/-][0-9]{1,2}([/-][0-9]{2,4})?$',
        '',
        'i'
      )
    ) as s
    from normalized
  )
  select case
    when s in ('payment thank you', 'autopay', 'automatic payment', 'auto payment', 'thank you')
      then '__statement_noise__'
    else s
  end
  from stripped
$function$;

create or replace view public.txn_categorization_observability as
select
  t.user_id,
  t.provider,
  t.txn_id,
  t.item_id,
  t.account_id,
  t.txn_date,
  tc.category_user,
  tc.category_model,
  tc.category_confidence,
  coalesce(tc.category_user, tc.category_model) as effective_category,
  coalesce(tc.merchant_normalized, '') as merchant_normalized,
  (coalesce(tc.merchant_normalized, '') = '__statement_noise__') as is_statement_noise,
  case
    when coalesce(tc.merchant_normalized, '') = '__statement_noise__' then false
    when coalesce(tc.category_user, tc.category_model) is null then false
    when coalesce(tc.category_user, tc.category_model) = 'Uncategorized' then false
    else true
  end as is_categorized_for_accuracy
from public.transactions t
left join public.txn_categorization tc
  on tc.user_id = t.user_id
 and tc.txn_id = t.txn_id
where coalesce(t.is_removed, false) = false;

create or replace view public.txn_categorization_accuracy_by_provider as
select
  provider,
  count(*) filter (where not is_statement_noise) as denominator_rows,
  count(*) filter (where not is_statement_noise and is_categorized_for_accuracy) as categorized_rows,
  count(*) filter (where not is_statement_noise and not is_categorized_for_accuracy) as uncategorized_rows,
  round(
    100.0 * count(*) filter (where not is_statement_noise and is_categorized_for_accuracy)::numeric
    / nullif(count(*) filter (where not is_statement_noise), 0),
    2
  ) as categorized_pct,
  round(
    100.0 * count(*) filter (where not is_statement_noise and not is_categorized_for_accuracy)::numeric
    / nullif(count(*) filter (where not is_statement_noise), 0),
    2
  ) as uncategorized_pct
from public.txn_categorization_observability
group by provider;
