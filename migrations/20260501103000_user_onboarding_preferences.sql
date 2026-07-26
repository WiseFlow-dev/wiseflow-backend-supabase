begin;

alter table public.user_preferences
  add column if not exists onboarding_goals text[] not null default '{}'::text[],
  add column if not exists onboarding_completed_at timestamptz;

comment on column public.user_preferences.onboarding_goals is
  'User-selected onboarding goals captured before or during onboarding.';

comment on column public.user_preferences.onboarding_completed_at is
  'Timestamp when the user completed onboarding for this account.';

commit;
