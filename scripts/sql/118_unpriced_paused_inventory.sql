-- Inventory may exist before a price is known. Unpriced stock cannot be on sale.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE marketplace_user_listings DROP CONSTRAINT marketplace_user_listings_price_pkn_check;
ALTER TABLE marketplace_user_listings ADD CONSTRAINT marketplace_user_listings_price_pkn_check
  CHECK (price_pkn >= 0 AND (price_pkn > 0 OR status <> 'active'));
COMMIT;
