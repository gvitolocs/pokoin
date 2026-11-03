-- CardTrader dump persist: upsert a live listing into the book.
\set i random(1, 1500000)
insert into cardtrader_market_listing_snapshots
  (provider, external_listing_id, blueprint_id, quantity, price, last_seen_at, updated_at)
values ('cardtrader', (10000000 + :i)::text, 100000 + (:i % 70728) + 1, 2, 9.99, now(), now())
on conflict (provider, external_listing_id) do update
  set quantity = excluded.quantity, price = excluded.price,
      last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at;
