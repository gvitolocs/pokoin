-- Written after the apply (PH-V001, 2026-11-18); not run on production, at most on a throwaway copy.
-- reverts: scripts/sql/144_listing_external_identity.sql
-- db: writer
-- destructive: drops the two partial unique indexes, the trigger and the guard function
-- migration 144 added; no table, column or row is removed, so no data is lost.

-- Reverting undoes the three refusals migration 144 installed: the database stops refusing a second
-- live CardTrader import of one product, stops refusing an import next to the seller's own native
-- listing of the same product, and stops refusing two item keys for one listing.

begin;
set local lock_timeout = '3s';

do $$ begin
  if pg_is_in_recovery() then raise exception 'refusing to run on a replica'; end if;
end $$;

-- Rule 1 and 2: the trigger first (it depends on the guard function), then the function.
drop trigger if exists marketplace_user_listings_ct_identity_trg on public.marketplace_user_listings;
drop function if exists public.marketplace_listing_ct_identity_guard();

-- Rule 1: at most one live CardTrader import per seller and product.
drop index if exists public.marketplace_user_listings_ct_import_uidx;

-- Rule 3: a granted listing is named by at most one item key.
drop index if exists public.seller_api_listing_keys_listing_uidx;

commit;
