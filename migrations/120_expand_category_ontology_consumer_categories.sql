create table if not exists public.category_ontology (
  id uuid primary key default gen_random_uuid(),
  category_key text not null,
  side text not null check (side in ('income', 'expense')),
  section text not null,
  parent_concept text not null,
  definition text not null,
  multilingual_hints jsonb not null default '[]'::jsonb,
  examples jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (category_key, side)
);

insert into public.category_ontology (
  category_key,
  side,
  section,
  parent_concept,
  definition,
  multilingual_hints,
  examples,
  is_active,
  updated_at
)
values
  ('Shopping', 'expense', 'Lifestyle', 'Retail', 'General retail shopping for consumer goods.', '["shopping","retail","店铺"]'::jsonb, '["Amazon"]'::jsonb, true, now()),
  ('Groceries', 'expense', 'Food', 'Groceries', 'Supermarkets and everyday food staples bought for home.', '["grocery","supermarket","超市"]'::jsonb, '["Carrefour"]'::jsonb, true, now()),
  ('Entertainment', 'expense', 'Lifestyle', 'Leisure', 'General leisure spending not better matched to a more specific media or event category.', '["entertainment","leisure","娱乐"]'::jsonb, '["Arcade"]'::jsonb, true, now()),
  ('Refund', 'income', 'Income', 'Reversal', 'Money returned for a prior purchase or charge reversal.', '["refund","reversal","退款"]'::jsonb, '["Card Refund"]'::jsonb, true, now()),
  ('Transfer', 'expense', 'Transfers', 'Movement', 'Money moved out between your own accounts or wallets.', '["transfer out","bank transfer","转账"]'::jsonb, '["Internal Move"]'::jsonb, true, now()),
  ('Transfer', 'income', 'Transfers', 'Movement', 'Money moved in between your own accounts or wallets.', '["transfer in","bank transfer","入金"]'::jsonb, '["Wallet Top-up"]'::jsonb, true, now()),
  ('Tax Refund', 'income', 'Income', 'Tax', 'Tax refund received from a government authority.', '["tax refund","irs refund","退税"]'::jsonb, '["IRS Refund"]'::jsonb, true, now()),
  ('Balance Adjustment', 'expense', 'Banking', 'Adjustment', 'Bank or ledger correction that reduces available funds.', '["adjustment","correction","调整"]'::jsonb, '["Posting Adjustment"]'::jsonb, true, now()),
  ('Balance Adjustment', 'income', 'Income', 'Adjustment', 'Bank or ledger correction that increases available funds.', '["credit adjustment","correction","調整"]'::jsonb, '["Ledger Credit"]'::jsonb, true, now()),
  ('ATM Withdrawals', 'expense', 'Cash', 'Withdrawal', 'Cash taken out from an ATM or cash machine.', '["atm withdrawal","cash out","取款"]'::jsonb, '["ATM Cash"]'::jsonb, true, now()),
  ('Insurance (Other)', 'expense', 'Protection', 'Insurance', 'General insurance premiums that are not better matched to a specific policy type.', '["insurance","premium","保险费"]'::jsonb, '["Policy Premium"]'::jsonb, true, now()),
  ('Phone', 'expense', 'Utilities', 'Telecom', 'Mobile or phone service charges.', '["phone bill","mobile","电话费"]'::jsonb, '["Singtel"]'::jsonb, true, now()),
  ('Coffee & Cafes', 'expense', 'Food', 'Cafe', 'Coffee shops, cafes, tea houses, and similar drink-first stops.', '["coffee","cafe","咖啡"]'::jsonb, '["Starbucks"]'::jsonb, true, now()),
  ('Restaurants', 'expense', 'Food', 'Dining', 'Sit-down dining, casual restaurants, and meal-focused eateries.', '["restaurant","dining","餐厅"]'::jsonb, '["Din Tai Fung"]'::jsonb, true, now()),
  ('Fast Food', 'expense', 'Food', 'Quick Service', 'Quick-service chains and takeaway meal counters.', '["fast food","burger","快餐"]'::jsonb, '["McDonald''s"]'::jsonb, true, now()),
  ('Movies & Events', 'expense', 'Lifestyle', 'Events', 'Cinema tickets, live events, and ticketed outings.', '["cinema","movie","电影"]'::jsonb, '["CINEMA.COM"]'::jsonb, true, now()),
  ('Streaming Services', 'expense', 'Lifestyle', 'Digital Media', 'Recurring audio or video streaming platforms.', '["streaming","netflix","流媒体"]'::jsonb, '["Spotify"]'::jsonb, true, now()),
  ('Flights', 'expense', 'Travel', 'Air Travel', 'Airline tickets and flight-related travel bookings.', '["flight","airline","航班"]'::jsonb, '["United Airlines"]'::jsonb, true, now()),
  ('Internet', 'expense', 'Utilities', 'Connectivity', 'Home, office, or broadband internet service charges.', '["internet","broadband","宽带"]'::jsonb, '["HKBN"]'::jsonb, true, now()),
  ('Salary', 'income', 'Income', 'Payroll', 'Employer payroll deposits and salary payments.', '["salary","payroll","工资"]'::jsonb, '["GUSTO PAY"]'::jsonb, true, now()),
  ('Public Transit', 'expense', 'Transport', 'Transit', 'Subway, rail, bus, ferry, and other public transport fares.', '["transit","metro","地铁"]'::jsonb, '["MTR"]'::jsonb, true, now()),
  ('Bank Fees', 'expense', 'Banking', 'Fees', 'Bank service fees, finance charges, and transaction fees.', '["bank fee","finance charge","手续费"]'::jsonb, '["Overseas Fee"]'::jsonb, true, now())
on conflict (category_key, side)
do update set
  section = excluded.section,
  parent_concept = excluded.parent_concept,
  definition = excluded.definition,
  multilingual_hints = excluded.multilingual_hints,
  examples = excluded.examples,
  is_active = excluded.is_active,
  updated_at = now();
