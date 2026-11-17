-- 133: several Pokoin listings may hold one CardTrader product (2026-10-21).
--
-- A seller's identical copies (same game, card, condition, language, finishes
-- and price) are one CardTrader product whose quantity is the sum of theirs;
-- the storage position is not a CardTrader characteristic. Every member
-- listing holds the product's source `ct:<id>`, and a group's in-flight create
-- holds one shared `ct:pending:…` claim, so the source is no longer unique per
-- seller. The product-link row stays one per product (listing_id = the
-- primary member the product's user_data_field names).
--
-- pokoin-rust/crates/external/src/cardtrader/group.rs, docs/CARDTRADER_SELLER_SYNC.md.

drop index if exists public.marketplace_user_listings_ct_product_uidx;

create index if not exists marketplace_user_listings_ct_product_idx
  on public.marketplace_user_listings (seller_uid, source_listing_id)
  where source_listing_id like 'ct:%' and source_listing_id <> '';
