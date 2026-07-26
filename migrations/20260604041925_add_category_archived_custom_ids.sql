alter table public.user_preferences
add column if not exists category_archived_custom_ids text not null default '';

comment on column public.user_preferences.category_archived_custom_ids is
'Comma-separated custom category IDs archived by the user.';
