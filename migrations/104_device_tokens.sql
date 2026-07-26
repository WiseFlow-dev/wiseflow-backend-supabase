-- Migration 104: FCM device tokens for instant bank sync push notifications
--
-- Stores one token per physical device per user. When a Plaid webhook fires
-- and transactions are synced server-side, the edge function looks up the
-- user's tokens here and sends a silent FCM push so the app updates Room
-- instantly without waiting for the 1-hour BankRefreshWorker.

create table if not exists device_tokens (
    id          uuid        primary key default gen_random_uuid(),
    user_id     uuid        not null references auth.users(id) on delete cascade,
    token       text        not null,
    platform    text        not null default 'android',
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    constraint device_tokens_user_token_unique unique (user_id, token)
);

-- Users can only read/write their own tokens
alter table device_tokens enable row level security;

create policy if not exists "users manage own device tokens"
    on device_tokens for all
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- Index for the common edge-function lookup: all tokens for a given user_id
create index if not exists device_tokens_user_id_idx on device_tokens (user_id);
