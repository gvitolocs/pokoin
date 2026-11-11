-- Listings table for buy_orders_flow.rs, recreated on a throwaway database
-- only. The buy-order tables come from scripts/sql/142_marketplace_buy_orders.sql
-- and the outbox from 096, applied by the test itself.
drop table if exists public.marketplace_buy_order_fills, public.marketplace_buy_orders,
  public.marketplace_outbox, public.marketplace_user_listings cascade;
create table public.marketplace_user_listings (
  id uuid primary key default gen_random_uuid(),
  card_id text not null,
  seller_uid text not null,
  seller_name text not null default 'Pokoin seller',
  seller_country text not null default 'EU',
  seller_reputation_label text not null default 'New',
  condition text not null default 'NM',
  language text not null default 'EN',
  price_pkn numeric not null check (price_pkn > 0),
  quantity_available integer not null default 1 check (quantity_available >= 0),
  signed boolean not null default false,
  reverse boolean not null default false,
  first_edition boolean not null default false,
  foil_state text not null default 'standard',
  variant_state text not null default '',
  sealed boolean not null default false,
  graded boolean not null default false,
  grading_company text,
  grade text,
  certification_id text,
  shipping_available boolean not null default true,
  reserve_available boolean not null default false,
  nft_available boolean not null default false,
  seller_comment text not null default '',
  source text not null default 'pokoin_user_listing',
  source_listing_id text not null default '',
  status text not null default 'active' check (status in ('active', 'paused', 'inactive', 'sold_out')),
  card_name text not null default '',
  card_image_url text not null default '',
  set_name text not null default '',
  collector_number text not null default '',
  location text not null default '',
  altered boolean not null default false,
  marketplace_game text not null default 'pokemon',
  photo_urls text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create or replace function public.refresh_marketplace_blueprint_price_summary(text)
  returns void language sql as 'select';
