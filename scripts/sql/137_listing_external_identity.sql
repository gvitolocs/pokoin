-- 137: One live listing per external identity (2026-10-23).
--
-- A listing that stands for a seller's CardTrader product carries
-- source_listing_id = 'ct:<product id>': the CardTrader import writes it, a
-- push or group writes it on the Pokoin listings it puts on CardTrader, and
-- since 2026-10-23 the seller connector writes it on a Card Rails copy that
-- names its CardTrader product (`ctProductId`). The CardTrader reconcile keys
-- every listing on it, so a product already on the shelf is updated, never
-- imported again.
--
-- On 2026-10-22 Card Rails re-listed a seller's whole CardTrader stock
-- through the connector without that id: 12,115 native listings next to the
-- 12,333 imports of the same products (redshakkio). These rules make the
-- database refuse that shape whatever writes it:
--
-- 1. At most one live CardTrader import per seller and product.
-- 2. A product is on the shelf as its import OR as Pokoin's own listings
--    (one, or several copies of a group, see 133), never both at once.
-- 3. A connector grant names a listing with at most one item key, so two
--    tool copies can never both be the same listing.
--
-- Live = active, paused or sold_out (what the reconcile and the shop read).
-- Checked on the 15T primary before writing this file: no row breaks any rule.

begin;

create unique index if not exists marketplace_user_listings_ct_import_uidx
  on public.marketplace_user_listings (seller_uid, source_listing_id)
  where source = 'cardtrader_seller_import'
    and source_listing_id like 'ct:%'
    and status in ('active', 'paused', 'sold_out');

-- Rule 2 compares rows of different kinds, which no index can express. The
-- advisory lock serializes writers of one (seller, product), so two
-- concurrent inserts cannot both pass the check.
create or replace function public.marketplace_listing_ct_identity_guard()
returns trigger
language plpgsql
as $$
begin
  if new.source_listing_id not like 'ct:%'
     or new.status not in ('active', 'paused', 'sold_out') then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.seller_uid || '|' || new.source_listing_id, 137));
  if exists (
    select 1
    from public.marketplace_user_listings other
    where other.seller_uid = new.seller_uid
      and other.source_listing_id = new.source_listing_id
      and other.id <> new.id
      and other.status in ('active', 'paused', 'sold_out')
      and (other.source = 'cardtrader_seller_import') <> (new.source = 'cardtrader_seller_import')
  ) then
    raise exception using
      errcode = '23505',
      message = 'listing_ct_identity_taken',
      detail = format('seller %s already has a live listing for %s', new.seller_uid, new.source_listing_id),
      constraint = 'marketplace_user_listings_ct_identity';
  end if;
  return new;
end;
$$;

drop trigger if exists marketplace_user_listings_ct_identity_trg on public.marketplace_user_listings;
create trigger marketplace_user_listings_ct_identity_trg
  before insert or update of source_listing_id, source, status, seller_uid
  on public.marketplace_user_listings
  for each row execute function public.marketplace_listing_ct_identity_guard();

create unique index if not exists seller_api_listing_keys_listing_uidx
  on public.seller_api_listing_keys (grant_id, listing_id)
  where listing_id is not null;

commit;
