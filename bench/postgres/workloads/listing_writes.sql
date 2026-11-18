-- Pokoin listing writes: create a listing, reprice the card's newest one
-- (the audit trigger fires on both).
\set n random_zipfian(1, 70728, 1.1)
\set price random(100, 400000)
begin;
insert into marketplace_user_listings (card_id, seller_uid, price_pkn, card_name)
values ((2 * (100000 + :n))::text, 'bench', :price / 100.0, 'bench');
update marketplace_user_listings set price_pkn = price_pkn + 1, updated_at = now()
 where id = (select id from marketplace_user_listings
              where card_id = (2 * (100000 + :n))::text and status = 'active'
              order by created_at desc limit 1);
end;
