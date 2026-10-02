-- Listing mutations commit this row in the same transaction as the stock change.
-- A missing table must not be created on the replica. Apply on the nezopt writer.
-- Valkey, Meili, CardTrader, and SSE run after commit.

create table if not exists public.marketplace_outbox (
  id bigserial primary key,
  event_type text not null,
  aggregate_id text not null,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text,
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  last_error text
);

create index if not exists marketplace_outbox_pending_idx
  on public.marketplace_outbox (available_at, id)
  where processed_at is null;

create unique index if not exists marketplace_outbox_pending_key
  on public.marketplace_outbox (idempotency_key)
  where processed_at is null and idempotency_key is not null;
