-- Tag seller listings with which TCG marketplace they belong to.
-- CardTrader sync imports every supported game into the shared listings table
-- (satellite DBs do not have marketplace_user_listings yet); My listings / shop
-- reads filter by marketplace_game for the active site.

alter table public.marketplace_user_listings
  add column if not exists marketplace_game text not null default 'pokemon';

create index if not exists marketplace_user_listings_seller_game_idx
  on public.marketplace_user_listings (seller_uid, marketplace_game, status);
