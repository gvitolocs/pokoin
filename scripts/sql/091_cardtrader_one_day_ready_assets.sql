-- CardTrader 1-Day Ready inventory: seller dashboard assets, never Pokoin listings.
-- A 1-Day Ready account's stock sits in CardTrader's warehouse and CardTrader
-- sells and ships it, so the inventory sync (server/pokoin-api/
-- _cardtrader_inventory_sync.js) mirrors it here instead of creating
-- marketplace_user_listings rows. Additive; applied on the nezopt writer
-- (pokoin-marketplace-postgres-15t), Pi replica follows. Owned by
-- gvitolocs/pokoin (scripts/sql), like 089.

create table if not exists public.marketplace_cardtrader_1dr_assets (
  seller_uid text not null,
  ct_product_id text not null,
  blueprint_id text not null default '',
  card_id text not null default '',
  card_name text not null default '',
  set_name text not null default '',
  collector_number text not null default '',
  card_image_url text not null default '',
  condition text not null default '',
  language text not null default '',
  reverse boolean not null default false,
  first_edition boolean not null default false,
  signed boolean not null default false,
  altered boolean not null default false,
  graded boolean not null default false,
  quantity integer not null default 0 check (quantity >= 0 and quantity <= 999999),
  price_pkn numeric not null default 0 check (price_pkn >= 0),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (seller_uid, ct_product_id)
);

create index if not exists marketplace_cardtrader_1dr_assets_seller_idx
  on public.marketplace_cardtrader_1dr_assets (seller_uid, price_pkn desc);
