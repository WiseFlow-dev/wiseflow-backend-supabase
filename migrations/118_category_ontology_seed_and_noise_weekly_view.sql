-- Phase 2 foundation:
-- 1) DB-backed category ontology with multilingual hints.
-- 2) Seed top categories with compact, meaning-first entries.
-- 3) Weekly statement-noise observability view for future alerting.

create table if not exists public.category_ontology (
  id bigserial primary key,
  category_key text not null,
  side text not null check (side in ('income', 'expense')),
  section text not null,
  parent_concept text not null,
  definition text not null,
  multilingual_hints jsonb not null default '[]'::jsonb,
  examples jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  seed_version text not null default '2026-05-phase2-v1',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (category_key, side)
);

alter table public.category_ontology enable row level security;

drop policy if exists "read category ontology" on public.category_ontology;
create policy "read category ontology"
  on public.category_ontology
  for select
  to authenticated
  using (true);

insert into public.category_ontology (
  category_key, side, section, parent_concept, definition, multilingual_hints, examples, is_active, seed_version
) values
  ('Shopping','expense','Lifestyle','Consumer Purchases','General retail purchases of goods in stores or online.','["shopping","retail","tienda","magaza","店铺","belanja"]'::jsonb,'["Amazon","Target","IKEA"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Groceries','expense','Food','Household Essentials','Supermarket and grocery spending for daily food and home staples.','["grocery","supermarket","market","超市","슈퍼마켓","kedai runcit"]'::jsonb,'["Walmart Grocery","Carrefour","NTUC FairPrice"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Entertainment','expense','Lifestyle','Leisure','Leisure spending such as games, shows, events, and media fun.','["entertainment","cinema","movie","娱乐","映画","hiburan"]'::jsonb,'["Netflix","Steam","Cinema XXI"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Refund','income','Income','Reversals','Money returned after a prior charge reversal or product return.','["refund","reversal","money back","退款","환불","pengembalian"]'::jsonb,'["Card Refund","Merchant Reversal","Purchase Return"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Transfer','expense','Transfers','Internal Movement','Outgoing transfer between own accounts, wallets, or cash holdings.','["transfer","bank transfer","internal transfer","转账","振込","transfer dana"]'::jsonb,'["Wise Transfer","Internal Move","Account Transfer Out"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Transfer','income','Transfers','Internal Movement','Incoming transfer between own accounts, wallets, or cash holdings.','["transfer","bank transfer","incoming transfer","转账","入金","transfer masuk"]'::jsonb,'["Account Transfer In","Wallet Top-up","Cash Deposit Transfer"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Tax Refund','income','Income','Government Returns','Refunded taxes received from a tax authority.','["tax refund","tax return","irs refund","退税","税金還付","pengembalian pajak"]'::jsonb,'["IRS Refund","HMRC Refund","Inland Revenue Return"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Balance Adjustment','expense','Banking','Account Corrections','Negative correction or manual debit adjustment from institution records.','["balance adjustment","correction","adjustment","调整","調整","penyesuaian"]'::jsonb,'["Manual Debit Correction","Posting Adjustment","Ledger Correction"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Balance Adjustment','income','Income','Account Corrections','Positive correction or credit adjustment from institution records.','["balance adjustment","credit correction","adjustment","调整","調整","pelarasan kredit"]'::jsonb,'["Manual Credit Correction","Ledger Credit","Adjustment Credit"]'::jsonb,true,'2026-05-phase2-v1'),
  ('ATM Withdrawals','expense','Cash','Cash Access','Cash withdrawn from ATM or teller cash dispensing channels.','["atm withdrawal","cash withdrawal","teller cash","取款","出金","tarik tunai"]'::jsonb,'["ATM Cash","Cash Out","Branch Cash Withdrawal"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Insurance (Other)','expense','Protection','Insurance Premiums','Insurance premium payments not covered by more specific insurance categories.','["insurance","premium","policy","保险费","保険料","insurans"]'::jsonb,'["General Insurance","Policy Premium","Coverage Payment"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Phone','expense','Utilities','Telecom','Mobile or landline telecom bills and related phone service charges.','["phone bill","mobile","telecom","电话费","携帯","telco"]'::jsonb,'["AT&T","Vodafone","Singtel"]'::jsonb,true,'2026-05-phase2-v1')
on conflict (category_key, side) do update
set
  section = excluded.section,
  parent_concept = excluded.parent_concept,
  definition = excluded.definition,
  multilingual_hints = excluded.multilingual_hints,
  examples = excluded.examples,
  is_active = excluded.is_active,
  seed_version = excluded.seed_version,
  updated_at = now();

create or replace view public.txn_statement_noise_user_weekly as
select
  tco.user_id,
  tco.provider,
  date_trunc('week', tco.txn_date::timestamp)::date as week_start,
  count(*)::int as sentinel_rows
from public.txn_categorization_observability tco
where tco.is_statement_noise = true
group by tco.user_id, tco.provider, date_trunc('week', tco.txn_date::timestamp)::date;
