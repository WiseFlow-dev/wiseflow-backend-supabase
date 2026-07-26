-- Phase 2 follow-up: compact ontology payload to enforce token budget
-- Target: full ontology payload <= 500 tokens (hard ceiling <= 750)

insert into public.category_ontology (
  category_key,
  side,
  section,
  parent_concept,
  definition,
  multilingual_hints,
  examples,
  is_active,
  seed_version
) values
  ('Shopping','expense','Lifestyle','Retail','Retail goods spend.','["shopping","retail","店铺"]'::jsonb,'["Amazon"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Groceries','expense','Food','Groceries','Food and staples.','["grocery","supermarket","超市"]'::jsonb,'["Carrefour"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Entertainment','expense','Lifestyle','Leisure','Leisure and fun.','["entertainment","cinema","娱乐"]'::jsonb,'["Netflix"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Refund','income','Income','Reversal','Charge reversed in.','["refund","reversal","退款"]'::jsonb,'["Card Refund"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Transfer','expense','Transfers','Movement','Own-account transfer out.','["transfer out","bank transfer","转账"]'::jsonb,'["Internal Move"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Transfer','income','Transfers','Movement','Own-account transfer in.','["transfer in","bank transfer","入金"]'::jsonb,'["Wallet Top-up"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Tax Refund','income','Income','Tax','Tax refund received.','["tax refund","irs refund","退税"]'::jsonb,'["IRS Refund"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Balance Adjustment','expense','Banking','Adjustment','Bank correction debit.','["adjustment","correction","调整"]'::jsonb,'["Posting Adjustment"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Balance Adjustment','income','Income','Adjustment','Bank correction credit.','["credit adjustment","correction","調整"]'::jsonb,'["Ledger Credit"]'::jsonb,true,'2026-05-phase2-v1'),
  ('ATM Withdrawals','expense','Cash','Withdrawal','Cash withdrawn.','["atm withdrawal","cash out","取款"]'::jsonb,'["ATM Cash"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Insurance (Other)','expense','Protection','Insurance','General insurance premium.','["insurance","premium","保险费"]'::jsonb,'["Policy Premium"]'::jsonb,true,'2026-05-phase2-v1'),
  ('Phone','expense','Utilities','Telecom','Phone service charges.','["phone bill","mobile","电话费"]'::jsonb,'["Singtel"]'::jsonb,true,'2026-05-phase2-v1')
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