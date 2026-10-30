-- Synthetic marketplace data for the Postgres benchmark, deterministic for a
-- given scale. Names and sets are the real typeahead dictionary
-- (market/src/data/suggest-{names,sets}.js): one printing per unit of a
-- name's prior, 70,728 printings at any scale, the size of the catalog.
-- The CardTrader book, its removal history, the price observations and the
-- Pokoin listings grow with :scale (1 = 1.5M live listings, 1.2M removals).
--
--   psql -v scale=1 -v names_tsv=/path/names.tsv -v sets_tsv=/path/sets.tsv -f seed.sql
-- (superuser: the TSVs are read by the server with COPY, so give paths it can read)
\set ON_ERROR_STOP on
set client_min_messages = warning;
set maintenance_work_mem = '1GB';
select setseed(0.42);

create temp table seed_names (name text, prior int);
copy seed_names from :'names_tsv';
create temp table seed_sets (name text, prior int, nationality text);
copy seed_sets from :'sets_tsv';

-- n is the printing's index (1..70,728); ct_id the CardTrader blueprint id,
-- card_id the public id (ct_id * 2, docs/marketplace-public-ids.md).
create temp table s as
select name as set_name, nationality, row_number() over (order by random()) as rn
from seed_sets, generate_series(1, greatest(prior, 1));
create temp table printings as
with n as (
  select name, row_number() over (order by random()) as rn
  from seed_names, generate_series(1, prior)
)
select n.rn::bigint as n, 100000 + n.rn::bigint as ct_id, 2 * (100000 + n.rn::bigint) as card_id,
       n.name, s.set_name, s.nationality,
       (1 + floor(random() * 250))::int as number_int,
       (array['Common','Uncommon','Rare','Holo Rare','Ultra Rare','Secret Rare','Illustration Rare','Special Illustration Rare'])
         [1 + floor(random() * 8)::int] as rarity
from n join s on s.rn = ((n.rn - 1) % (select count(*) from s)) + 1;
create unique index on printings (n);
analyze printings;

insert into public.marketplace_search_candidates (
  card_id, ct_id, name, display_name, canonical_name, set_name, card_number, rarity,
  item_kind, product_type, search_text, name_prefix, set_prefix, expansion_name,
  search_weight, imported_at)
select card_id, ct_id, name, name, name, set_name, number_int || '/250', rarity,
       'single', 'card',
       lower(name || ' ' || set_name || ' ' || number_int || '/250 ' || rarity),
       lower(left(regexp_replace(name, '[^A-Za-z0-9]', '', 'g'), 3)),
       lower(left(regexp_replace(set_name, '[^A-Za-z0-9]', '', 'g'), 3)),
       set_name, round((random() * 100)::numeric, 2),
       now() - random() * interval '400 days'
from printings;

insert into public.marketplace_card_versions (
  card_id, ct_id, name, display_name, canonical_name, expansion_name, expansion_number,
  expansion_number_int, blueprint_id, product_type)
select card_id, ct_id, name, name, name, set_name, number_int || '/250', number_int,
       ct_id, 'card'
from printings;

-- Popularity skew: random()^3 puts most listings on a small set of cards.
-- In the tables below "card_id" is the printing index n.
create temp table popular as
select g as i, 1 + floor(70728 * power(random(), 3))::bigint as card_id
from generate_series(1, (1500000 * :scale)::int) g;

insert into public.cardtrader_market_listing_snapshots (
  provider, external_listing_id, external_product_id, blueprint_id, pokoin_card_id,
  seller_account_id, seller_account_name, seller_country, quantity, condition, language,
  price, price_cents, currency, properties, first_seen_at, last_seen_at, imported_at, updated_at)
select 'cardtrader', (10000000 + p.i)::text, (5000000 + p.i)::text, 100000 + p.card_id, (2 * (100000 + p.card_id))::text,
       's' || floor(random() * 20000)::int, 'seller ' || floor(random() * 20000)::int,
       (array['IT','DE','FR','ES','NL','BE','AT','PL'])[1 + floor(random() * 8)::int],
       1 + floor(random() * 4)::int,
       (array['Near Mint','Near Mint','Near Mint','Slightly Played','Moderately Played','Played','Poor'])[1 + floor(random() * 7)::int],
       (array['en','en','en','it','de','fr','es','jp'])[1 + floor(random() * 8)::int],
       round((0.1 + power(random(), 4) * 400)::numeric, 2), 0, 'EUR',
       jsonb_build_object('pokemon_reverse', random() < 0.1, 'first_edition', random() < 0.03),
       now() - random() * interval '90 days', now(), now(), now()
from popular p;
update public.cardtrader_market_listing_snapshots set price_cents = (price * 100)::int;

-- Removed listings: 1.2M per scale over the last 60 days; 10% are ids that
-- are still live (the backstop the rebuild must exclude).
create temp table removed as
select g as i,
       case when random() < 0.1 then (10000000 + 1 + floor(random() * 1500000 * :scale))::bigint
            else (20000000 + g)::bigint end as listing_id,
       1 + floor(70728 * power(random(), 3))::bigint as card_id,
       current_date - floor(random() * 60)::int as removed_day,
       case when random() < 0.7 then 'inferred_sale' else 'quantity_decreased' end as reason,
       case when random() < 0.8 then 'confirmed' when random() < 0.75 then 'provisional' else 'rejected' end as status
from generate_series(1, (1200000 * :scale)::int) g;

insert into public.cardtrader_market_listing_removed_history (
  provider, external_listing_id, blueprint_id, pokoin_card_id, seller_account_id,
  quantity, condition, language, price, currency, properties, first_seen_at, last_seen_at,
  removed_day, archive_reason, status)
select 'cardtrader', r.listing_id::text, 100000 + r.card_id, (2 * (100000 + r.card_id))::text,
       's' || floor(random() * 20000)::int, 1 + floor(random() * 3)::int,
       (array['Near Mint','Near Mint','Slightly Played','Moderately Played','Played'])[1 + floor(random() * 5)::int],
       (array['en','en','it','de','fr','jp'])[1 + floor(random() * 6)::int],
       round((0.1 + power(random(), 4) * 400)::numeric, 2), 'EUR',
       jsonb_build_object('pokemon_reverse', random() < 0.1),
       (r.removed_day - (1 + floor(random() * 30))::int)::timestamptz,
       r.removed_day::timestamptz, r.removed_day, r.reason, r.status
from removed r
on conflict do nothing;

-- One removed-sale observation per removal; 20% of the inferred sales get a
-- second observation day, which the once_sold rule must drop.
insert into public.marketplace_price_observations (
  blueprint_id, source, source_item_id, observed_at, currency, price, price_pkn, quantity,
  condition, language, reverse, first_edition, graded, metadata)
select 100000 + r.card_id, 'cardtrader_removed_sale',
       'cardtrader:' || r.listing_id || ':' || d.day || ':' || r.reason,
       d.day + random() * interval '20 hours', 'PKN', p.price, p.price, 1 + floor(random() * 3)::int,
       (array['Near Mint','Slightly Played','Moderately Played','Played','Poor'])[1 + floor(random() * 5)::int],
       (array['en','en','it','de','fr','jp'])[1 + floor(random() * 6)::int],
       random() < 0.1, random() < 0.03, random() < 0.02, '{}'::jsonb
from removed r
cross join lateral (select round((1 + power(random(), 4) * 4000)::numeric, 2) as price) p
cross join lateral (
  select r.removed_day as day
  union all
  select r.removed_day - 1 where r.reason = 'inferred_sale' and r.i % 5 = 0
) d;

insert into public.marketplace_user_listings (
  card_id, seller_uid, seller_name, condition, language, price_pkn, quantity_available,
  reverse, first_edition, status, card_name, set_name, collector_number, created_at, updated_at)
select pr.card_id::text, 'u' || floor(random() * 5000)::int, 'seller',
       (array['NM','NM','EX','GD','LP','PL'])[1 + floor(random() * 6)::int],
       (array['EN','EN','IT','DE','FR','JP'])[1 + floor(random() * 6)::int],
       round((1 + power(random(), 4) * 4000)::numeric, 2), 1 + floor(random() * 3)::int,
       random() < 0.1, random() < 0.03,
       case when random() < 0.9 then 'active' when random() < 0.5 then 'paused' else 'sold_out' end,
       pr.name, pr.set_name, pr.number_int || '/250',
       now() - random() * interval '120 days', now() - random() * interval '30 days'
from (select 1 + floor(70728 * power(random(), 3))::bigint as n
      from generate_series(1, (200000 * :scale)::int)) l
join printings pr using (n);

vacuum analyze;
select 'seeded' as status,
  (select count(*) from public.marketplace_search_candidates) as printings,
  (select count(*) from public.cardtrader_market_listing_snapshots) as live_book,
  (select count(*) from public.cardtrader_market_listing_removed_history) as removed,
  (select count(*) from public.marketplace_price_observations) as observations,
  (select count(*) from public.marketplace_user_listings) as listings;
