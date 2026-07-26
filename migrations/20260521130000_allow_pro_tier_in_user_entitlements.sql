alter table public.user_entitlements drop constraint if exists user_entitlements_tier_check;

alter table public.user_entitlements
  add constraint user_entitlements_tier_check
  check (tier = any (array['free'::text, 'pro'::text, 'premium'::text]));
