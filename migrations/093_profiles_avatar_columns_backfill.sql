alter table public.profiles
  add column if not exists display_name text;

alter table public.profiles
  add column if not exists avatar_url text;

alter table public.profiles
  add column if not exists updated_at timestamptz default now();

update public.profiles
set updated_at = now()
where updated_at is null;

alter table public.profiles
  alter column updated_at set default now();
