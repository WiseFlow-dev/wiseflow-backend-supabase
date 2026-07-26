-- Phase 0B: Persist bank account subtype/class on wallets for cloud-first restore.
ALTER TABLE public.wallets
ADD COLUMN IF NOT EXISTS bank_sub_type TEXT NOT NULL DEFAULT 'UNKNOWN';

ALTER TABLE public.wallets
ADD COLUMN IF NOT EXISTS account_class TEXT NOT NULL DEFAULT 'ASSET';

