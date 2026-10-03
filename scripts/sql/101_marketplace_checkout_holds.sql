-- 101: Units reserved by an unpaid EUR checkout.
--
-- CardTrader sync writes an absolute quantity. Without this ledger it puts a
-- held card back on sale, and the hold release then adds that unit again.
-- Apply on the nezopt writer (the replica follows):
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace \
--     -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/101_marketplace_checkout_holds.sql

create table if not exists public.marketplace_checkout_holds (
  order_id text not null,
  listing_id uuid not null,
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now(),
  primary key (order_id, listing_id)
);

create index if not exists marketplace_checkout_holds_listing_idx
  on public.marketplace_checkout_holds (listing_id);
