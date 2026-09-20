-- CardTrader seller inventory sync: durable links + last sync status.
-- Applied on the nezopt NVMe writer; Pi replica follows.
-- Owned by gvitolocs/pokoin (scripts/sql). Next free numbered migration after 081.

create table if not exists public.marketplace_cardtrader_seller_sync (
  seller_uid text primary key,
  last_sync_at timestamptz,
  last_sync_ok boolean not null default false,
  last_sync_incomplete boolean not null default false,
  last_sync_error text not null default '',
  last_sync_summary jsonb not null default '{}'::jsonb,
  last_complete_export_at timestamptz,
  last_export_product_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.marketplace_cardtrader_product_links (
  seller_uid text not null,
  ct_product_id text not null,
  listing_id uuid not null,
  blueprint_id text not null default '',
  last_ct_quantity integer not null default 0,
  last_seen_at timestamptz not null default now(),
  origin text not null default 'import'
    check (origin in ('import', 'push', 'match')),
  missing_from_ct boolean not null default false,
  unresolved_reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (seller_uid, ct_product_id)
);

create unique index if not exists marketplace_cardtrader_product_links_listing_uidx
  on public.marketplace_cardtrader_product_links (listing_id);

create index if not exists marketplace_cardtrader_product_links_seller_idx
  on public.marketplace_cardtrader_product_links (seller_uid, last_seen_at desc);

create unique index if not exists marketplace_user_listings_ct_product_uidx
  on public.marketplace_user_listings (seller_uid, source_listing_id)
  where source_listing_id like 'ct:%' and source_listing_id <> '';
