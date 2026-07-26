create table if not exists public.wisey_cycle_dirty_queue (
  user_id uuid not null references auth.users(id) on delete cascade,
  affected_date date not null,
  first_enqueued_at timestamptz not null default now(),
  last_enqueued_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, affected_date)
);

create index if not exists idx_wisey_cycle_dirty_queue_last_enqueued_at
  on public.wisey_cycle_dirty_queue(last_enqueued_at);

alter table public.wisey_cycle_dirty_queue enable row level security;

create or replace function public.enqueue_wisey_cycle_dirty_date(
  p_user_id uuid,
  p_affected_date date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null or p_affected_date is null then
    return;
  end if;

  insert into public.wisey_cycle_dirty_queue (
    user_id,
    affected_date,
    first_enqueued_at,
    last_enqueued_at,
    created_at,
    updated_at
  )
  values (
    p_user_id,
    p_affected_date,
    now(),
    now(),
    now(),
    now()
  )
  on conflict (user_id, affected_date) do update
  set
    last_enqueued_at = now(),
    last_attempt_at = null,
    last_error = null,
    attempt_count = 0,
    updated_at = now();
end;
$$;

revoke all on function public.enqueue_wisey_cycle_dirty_date(uuid, date) from public;
grant execute on function public.enqueue_wisey_cycle_dirty_date(uuid, date) to service_role;

create or replace function public.enqueue_wisey_cycle_dirty_queue_from_wallet_transactions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.enqueue_wisey_cycle_dirty_date(
      new.user_id,
      (new.date at time zone 'UTC')::date
    );
    return new;
  end if;

  if tg_op = 'UPDATE' then
    perform public.enqueue_wisey_cycle_dirty_date(
      old.user_id,
      (old.date at time zone 'UTC')::date
    );
    perform public.enqueue_wisey_cycle_dirty_date(
      new.user_id,
      (new.date at time zone 'UTC')::date
    );
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform public.enqueue_wisey_cycle_dirty_date(
      old.user_id,
      (old.date at time zone 'UTC')::date
    );
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists trg_wallet_transactions_enqueue_wisey_cycle_dirty_queue
  on public.wallet_transactions;

create trigger trg_wallet_transactions_enqueue_wisey_cycle_dirty_queue
after insert or update or delete
on public.wallet_transactions
for each row
execute function public.enqueue_wisey_cycle_dirty_queue_from_wallet_transactions();
