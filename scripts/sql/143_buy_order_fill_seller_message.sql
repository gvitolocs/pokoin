-- 143: BuySell "Sell now" — the seller's private note to the buyer.
--
-- A seller listing into someone's buy order (or into Pokoin's starting offer)
-- may add one short free-text note: "ships Monday", "sleeved and toploaded",
-- "the corner is a bit dented". It belongs to the fill, not to the listing:
-- the listing row, its price and its own seller_comment stay exactly as they
-- were, and the note is private to the order's buyer.
--
-- Nothing here is public. The book, the board and `for-my-listings` read the
-- order table, never this column; the note leaves the database only through
-- `GET /api/marketplace-buy-orders/mine` (the buyer's own orders) and through
-- the buyer's notification email. A 240-character ceiling is the API's, so a
-- note cannot outgrow one email.
--
-- Apply on the nezopt writer (the replica follows):
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace \
--     -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/143_buy_order_fill_seller_message.sql

alter table public.marketplace_buy_order_fills
  add column if not exists seller_message text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.marketplace_buy_order_fills'::regclass
      and conname = 'marketplace_buy_order_fills_seller_message_length'
  ) then
    alter table public.marketplace_buy_order_fills
      add constraint marketplace_buy_order_fills_seller_message_length
      check (char_length(seller_message) <= 240);
  end if;
end
$$;
