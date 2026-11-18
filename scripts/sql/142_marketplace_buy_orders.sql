-- 142: BuySell buy orders (version 1, non-binding, moves no money).
--
-- A signed-in buyer posts a standing offer "I pay X PKN for this card, in this
-- language and condition, up to N copies, for D days". Anyone who owns the card
-- can "Sell now": that creates an ordinary marketplace listing at the offer
-- price and records a fill row linking it to the order. The buyer then buys
-- that listing through the normal cart and checkout. Placing an order locks no
-- funds and touches no balance.
--
-- Nothing derived is stored. A fill counts while its listing is active or
-- sold_out (a paused/inactive/deleted listing means the seller withdrew);
-- remaining = quantity - sum(counting fills). An order is live while
-- status = 'open', not expired and remaining > 0.
--
-- Apply on the nezopt writer (the replica follows):
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace \
--     -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/142_marketplace_buy_orders.sql

create table if not exists public.marketplace_buy_orders (
  id uuid primary key default gen_random_uuid(),
  buyer_uid text not null,
  buyer_name text not null default '',
  marketplace_game text not null default 'pokemon',
  card_id text not null,
  condition text not null check (condition in ('NM', 'SP', 'MP', 'PL', 'Poor')),
  language text not null,
  reverse boolean not null default false,
  first_edition boolean not null default false,
  price_pkn numeric not null check (price_pkn > 0),
  quantity integer not null check (quantity between 1 and 10),
  expires_at timestamptz,
  status text not null default 'open' check (status in ('open', 'cancelled')),
  card_name text not null default '',
  card_image_url text not null default '',
  set_name text not null default '',
  collector_number text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketplace_buy_orders_card_open_idx
  on public.marketplace_buy_orders (marketplace_game, card_id)
  where status = 'open';

create index if not exists marketplace_buy_orders_buyer_idx
  on public.marketplace_buy_orders (buyer_uid, created_at desc);

create table if not exists public.marketplace_buy_order_fills (
  id uuid primary key default gen_random_uuid(),
  buy_order_id uuid not null references public.marketplace_buy_orders (id),
  listing_id uuid not null,
  seller_uid text not null,
  quantity integer not null check (quantity > 0),
  price_pkn numeric not null,
  created_at timestamptz not null default now()
);

create index if not exists marketplace_buy_order_fills_order_idx
  on public.marketplace_buy_order_fills (buy_order_id);

create unique index if not exists marketplace_buy_order_fills_listing_uidx
  on public.marketplace_buy_order_fills (listing_id);
