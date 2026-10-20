-- Channel sync (TCGplayer first): one live box per seller, a coalesced job
-- queue, listing↔SKU links, a per-channel price rule, and the orders the box
-- posts back. The box authenticates with a seller API grant (pkn_…, sha256
-- stored). These tables never hold a TCGplayer password, cookie, or session.
-- Apply on the nezopt writer; the Pi replica receives it by replication.
-- Idempotent.

create table if not exists public.seller_channel_devices (
  id uuid primary key default gen_random_uuid(),
  seller_uid text not null,
  channel text not null,
  grant_id uuid not null references public.seller_api_grants (id) on delete cascade,
  label text not null default '',
  enabled boolean not null default false,
  signed_in boolean not null default false,
  running boolean not null default false,
  worker_version text not null default '',
  last_heartbeat_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- One live box per seller and channel. Revoking it (or its grant) frees the slot.
create unique index if not exists seller_channel_devices_live_key
  on public.seller_channel_devices (seller_uid, channel)
  where revoked_at is null;

create index if not exists seller_channel_devices_grant_idx
  on public.seller_channel_devices (grant_id)
  where revoked_at is null;

-- Absolute targets, read at claim time. At most one pending row per
-- (seller, channel, kind, listing); a second edit bumps available_at.
-- A claimed row may sit beside that newer pending edit. A disabled device
-- keeps one skipped row per key and counts the edits.
create table if not exists public.channel_sync_jobs (
  id bigserial primary key,
  seller_uid text not null,
  channel text not null,
  kind text not null check (kind in ('push_listing', 'set_qty', 'set_price', 'pull_orders', 'full_resync')),
  listing_key text not null default '',
  status text not null default 'pending' check (status in ('pending', 'claimed', 'done', 'skipped', 'failed', 'dead')),
  skip_reason text,
  skip_count integer not null default 0,
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  claimed_by uuid,
  -- Kind the box was handed (push_listing when set_qty/set_price had no link).
  claimed_kind text,
  result jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.channel_sync_jobs add column if not exists claimed_kind text;

-- Pending only, so a claimed job and one new pending job can coexist.
-- Drop first: an earlier draft indexed pending and claimed together.
drop index if exists public.channel_sync_jobs_open_key;
create unique index channel_sync_jobs_open_key
  on public.channel_sync_jobs (seller_uid, channel, kind, listing_key)
  where status = 'pending';

create unique index if not exists channel_sync_jobs_skipped_disabled_key
  on public.channel_sync_jobs (seller_uid, channel, kind, listing_key)
  where status = 'skipped' and skip_reason = 'device_not_enabled';

create index if not exists channel_sync_jobs_claim_idx
  on public.channel_sync_jobs (seller_uid, channel, available_at, id)
  where status in ('pending', 'claimed');

-- The TCGplayer SKU a Pokoin listing was pushed to. last_* is what the box
-- last wrote, so a later absolute push can be compared. created_at is when
-- the link first appeared; a later upsert must not move it. Orders placed
-- before that moment do not change Pokoin stock.
create table if not exists public.channel_listing_links (
  channel text not null,
  listing_id uuid not null,
  seller_uid text not null,
  external_id text not null,
  last_qty integer,
  last_price_cents integer,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (channel, listing_id)
);

alter table public.channel_listing_links
  add column if not exists created_at timestamptz not null default now();

create index if not exists channel_listing_links_external_idx
  on public.channel_listing_links (seller_uid, channel, external_id);

-- On top of price_pkn. No row means the pegged base price.
create table if not exists public.channel_price_rules (
  seller_uid text not null,
  channel text not null,
  percent_bp integer not null default 0 check (percent_bp between -5000 and 20000),
  fixed_cents integer not null default 0 check (fixed_cents between -100000 and 100000),
  round_mode text not null default 'cent' check (round_mode in ('cent', 'up_cent', 'charm_99')),
  updated_at timestamptz not null default now(),
  primary key (seller_uid, channel)
);

-- Orders the box read out of the seller's portal. Buyer fields are only what
-- fulfilment needs, readable by that seller's own calls.
create table if not exists public.channel_orders (
  id uuid primary key default gen_random_uuid(),
  seller_uid text not null,
  channel text not null,
  external_order_id text not null,
  status text not null default '',
  placed_at timestamptz,
  buyer_name text not null default '',
  ship_to jsonb not null default '{}'::jsonb,
  shipping_method text not null default '',
  total_cents bigint,
  currency text not null default 'USD',
  lines jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, seller_uid, external_order_id)
);

create index if not exists channel_orders_seller_placed_idx
  on public.channel_orders (seller_uid, placed_at desc);

-- One stock decrement per order line. Written in the same transaction as the
-- listing update, so a replayed order does not lower quantity twice.
create table if not exists public.channel_order_stock_applied (
  channel text not null,
  seller_uid text not null,
  external_order_id text not null,
  line_key text not null,
  listing_id uuid not null,
  quantity integer not null,
  applied_at timestamptz not null default now(),
  primary key (channel, seller_uid, external_order_id, line_key)
);

-- pokoin_api_write can use these tables when 124 has created the role.
-- Same guard as 124's per-table grants: a missing role is a no-op, a missing
-- table is skipped. Do not edit 124; rerunning 124's "all tables" grants does
-- not see tables created after it.
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_roles where rolname = 'pokoin_api_write') then
    raise notice 'channel sync: pokoin_api_write does not exist, grants skipped';
    return;
  end if;
  foreach t in array array[
    'seller_channel_devices', 'channel_sync_jobs', 'channel_listing_links',
    'channel_price_rules', 'channel_orders', 'channel_order_stock_applied'
  ] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('grant select, insert, update, delete on public.%I to pokoin_api_write', t);
      if exists (select 1 from pg_roles where rolname = 'pokoin_jobs') then
        execute format('grant select, insert, update, delete on public.%I to pokoin_jobs', t);
      end if;
      if exists (select 1 from pg_roles where rolname = 'pokoin_api_read') then
        execute format('grant select on public.%I to pokoin_api_read', t);
      end if;
    else
      raise notice 'channel sync: public.% does not exist here, skipped', t;
    end if;
  end loop;
  if to_regclass('public.channel_sync_jobs_id_seq') is not null then
    execute 'grant usage, select on sequence public.channel_sync_jobs_id_seq to pokoin_api_write';
    if exists (select 1 from pg_roles where rolname = 'pokoin_jobs') then
      execute 'grant usage, select, update on sequence public.channel_sync_jobs_id_seq to pokoin_jobs';
    end if;
  end if;
end $$;
