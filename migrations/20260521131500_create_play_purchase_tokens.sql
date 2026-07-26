create table if not exists public.play_purchase_tokens (
  purchase_token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null,
  package_name text not null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_play_purchase_tokens_user_id
  on public.play_purchase_tokens(user_id);
