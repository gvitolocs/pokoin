-- Card desk: printing, Pokoin listings, sold graph, CardTrader book.
\set n random_zipfian(1, 70728, 1.1)
select card_id, name, set_name, card_number, rarity
  from marketplace_search_candidates where card_id = 2 * (100000 + :n);
select id, price_pkn, condition, language, quantity_available
  from marketplace_user_listings
 where card_id = (2 * (100000 + :n))::text and status = 'active'
 order by price_pkn limit 50;
select observed_day, condition, language, median_pkn, sold_qty
  from cardtrader_sold_daily
 where blueprint_id = 100000 + :n and observed_day >= current_date - 90
 order by observed_day;
select external_listing_id, price, condition, language, quantity
  from cardtrader_market_listing_snapshots
 where coalesce(blueprint_id, cardtrader_blueprint_id) = 100000 + :n
 order by last_seen_at desc limit 100;
