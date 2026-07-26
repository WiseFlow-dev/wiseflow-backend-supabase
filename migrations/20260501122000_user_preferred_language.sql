begin;

alter table public.user_preferences
  add column if not exists preferred_language text;

comment on column public.user_preferences.preferred_language is
  'Preferred app language code for the user, including system default when selected.';

commit;
