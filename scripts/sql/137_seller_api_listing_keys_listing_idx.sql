-- 137: Card Rails origin on the owner's book reads keys by listing (2026-11-01).
--
-- seller_api_listing_keys (115) is keyed (grant_id, idempotency_key). The
-- owner's listings read (`GET /api/marketplace-listings?sellerUid=`,
-- pokoin-rust/crates/commerce/src/handlers/listings.rs `CARDRAILS_KEY_SQL`)
-- asks, per listing row, whether a `cardrails:` connector key points at it,
-- so it looks keys up by listing_id. Without this index that is a scan of
-- the key table for every row of the book. docs/INVENTORY_ORIGIN.md.
create index if not exists seller_api_listing_keys_listing_idx
  on public.seller_api_listing_keys (listing_id)
  where listing_id is not null;
