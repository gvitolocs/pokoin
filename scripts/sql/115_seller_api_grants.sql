-- Seller API grants: a revocable, seller-approved token an inventory tool
-- (Card Rails, or any other platform) uses in place of the seller's sign-in.
-- The token itself is never stored, only its sha256. Each grant has its own
-- webhook URL and shared secret, like a CardTrader API application.
-- Apply on the nezopt writer; the Pi replica receives it by replication.

create table if not exists public.seller_api_grants (
  id uuid primary key default gen_random_uuid(),
  seller_uid text not null,
  client text not null,
  label text not null default '',
  scope text not null,
  token_hash text not null,
  token_prefix text not null,
  shared_secret jsonb not null,
  webhook_url text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create unique index if not exists seller_api_grants_token_key
  on public.seller_api_grants (token_hash);

create index if not exists seller_api_grants_seller_idx
  on public.seller_api_grants (seller_uid)
  where revoked_at is null;

-- What happened to a seller's stock and orders, in order. Written only for
-- sellers with a live grant. Grants read it back with a cursor (the `events`
-- and `sales` actions), so a missed webhook is never a missed sale.
create table if not exists public.seller_api_events (
  id bigserial primary key,
  seller_uid text not null,
  event_id text not null,
  cause text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists seller_api_events_event_key
  on public.seller_api_events (seller_uid, event_id);

create index if not exists seller_api_events_seller_idx
  on public.seller_api_events (seller_uid, id);

-- One row per (grant, event). Signed and posted to the grant's webhook URL by
-- the API's delivery worker; retried with backoff, never blocking the listing
-- outbox on a slow third-party endpoint.
create table if not exists public.seller_webhook_deliveries (
  id bigserial primary key,
  grant_id uuid not null references public.seller_api_grants (id) on delete cascade,
  event_pk bigint not null references public.seller_api_events (id) on delete cascade,
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  delivered_at timestamptz,
  attempts integer not null default 0,
  last_status integer,
  last_error text
);

create unique index if not exists seller_webhook_deliveries_event_key
  on public.seller_webhook_deliveries (grant_id, event_pk);

create index if not exists seller_webhook_deliveries_pending_idx
  on public.seller_webhook_deliveries (available_at, id)
  where delivered_at is null;

-- A tool's `list` call is claimed here before the listing is created, so a
-- retry with the same key never creates a second listing.
create table if not exists public.seller_api_listing_keys (
  grant_id uuid not null references public.seller_api_grants (id) on delete cascade,
  idempotency_key text not null,
  listing_id uuid,
  created_at timestamptz not null default now(),
  primary key (grant_id, idempotency_key)
);
