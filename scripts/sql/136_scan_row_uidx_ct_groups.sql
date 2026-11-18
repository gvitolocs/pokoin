-- 136: Scan Connect listings may share a CardTrader product (2026-10-22).
--
-- marketplace_user_listings_scan_row_uidx (cardvault oracle-postgres/schema
-- 082_scan_connect.sql) made source_listing_id unique for every
-- `pokoin_scan_batch` listing. That is Scan Connect's submit idempotency key
-- (`scan:<item id>`, one listing per staged scan row). Once such a listing is
-- on CardTrader its source is the product's `ct:<id>` (or a push claim
-- `ct:pending:…`), and since migration 133 identical copies share one product
-- and one claim (cardtrader::group): two scan copies of the same card then
-- collided on this index ("duplicate key value violates unique constraint
-- marketplace_user_listings_scan_row_uidx": the group push and
-- `job cardtrader-group-products` relink, PeppeV, Nest Ball 123/149).
--
-- The index keeps the submit key unique and leaves CardTrader sources out.
-- Same name, so the scan migration's `create … if not exists` stays a no-op.
-- The submit's `on conflict (source_listing_id) where source =
-- 'pokoin_scan_batch' and source_listing_id not like 'ct:%'`
-- (pokoin-rust/crates/external/src/scan_store.rs) matches this index and,
-- because its predicate implies the old one, the old index too.
--
-- 16k rows (2026-10-22): the rebuild holds the table for milliseconds.

begin;

drop index if exists public.marketplace_user_listings_scan_row_uidx;

create unique index marketplace_user_listings_scan_row_uidx
  on public.marketplace_user_listings (source_listing_id)
  where source = 'pokoin_scan_batch' and source_listing_id not like 'ct:%';

commit;
