-- 008_user_ai_preferences.sql
-- Create table to persist Wisey AI personality mode per user

begin;

create table if not exists public.user_ai_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  personality_mode text not null default 'friendly' check (personality_mode in ('friendly','focused','expert')),
  updated_at timestamptz not null default now()
);

-- Enable Row Level Security
alter table public.user_ai_preferences enable row level security;

-- Policies: users can manage only their own row
create policy if not exists "ai_prefs_select_own"
  on public.user_ai_preferences for select
  using (auth.uid() = user_id);

create policy if not exists "ai_prefs_insert_own"
  on public.user_ai_preferences for insert
  with check (auth.uid() = user_id);

create policy if not exists "ai_prefs_update_own"
  on public.user_ai_preferences for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy if not exists "ai_prefs_delete_own"
  on public.user_ai_preferences for delete
  using (auth.uid() = user_id);

commit;
