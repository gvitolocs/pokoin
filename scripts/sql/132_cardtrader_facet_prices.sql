-- CardTrader reference price per listing facet, for every game: the store the
-- MyPokoin inventory pricer, the Seller API price quote (Card Rails) and the
-- price check read with one indexed lookup per page (docs/PRICING.md "Price
-- store").
--
-- `pokoin-api job cardtrader-facet-prices` (pokoin-rust/apps/api/src/jobs/
-- facet_prices.rs, pokoin_external::facet_store) refills it:
--   * Pokémon: the professional-seller floor (price_check::pro_floor_sql) over
--     the complete daily book `cardtrader_market_listing_snapshots`, computed
--     on the writer, keyed by public card id through
--     `marketplace_search_candidates.ct_id` (basis 'pro');
--   * every other game: source 7 of the CardRails PKP3 price file, the
--     cheapest CardTrader Zero ask per language, condition and finish (basis
--     'zero').
-- Only changed rows are written, and rows a refill no longer produces are
-- deleted, so the Pi streaming replica sees a small WAL per run.
--
-- Apply on the nezopt writer, pokoin_marketplace database. Idempotent.
--
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace \
--     -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/132_cardtrader_facet_prices.sql
create table if not exists public.cardtrader_facet_prices (
    game text NOT NULL,
    -- Public Pokoin card id, as `marketplace_user_listings.card_id` holds it.
    card_id bigint NOT NULL,
    -- EN IT FR DE ES PT JP ZH KO ID NL PL RU ZHT TH VI (price_book::LANGS).
    language text NOT NULL,
    -- NM SP MP PL Poor (price_check::condition_key).
    condition text NOT NULL,
    -- Pokémon reverse holo; foil of the other games.
    foil boolean NOT NULL,
    first_edition boolean NOT NULL,
    min_pkn numeric NOT NULL CHECK (min_pkn > 0),
    offers integer NOT NULL DEFAULT 0,
    -- 'pro': same condition only; 'zero': this condition or a better one.
    basis text NOT NULL CHECK (basis in ('pro', 'zero')),
    refreshed_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT cardtrader_facet_prices_pkey
      PRIMARY KEY (game, card_id, language, condition, foil, first_edition)
);

-- The Seller API price quote looks a card up before it knows the game (Card
-- Rails sends only the card id): CardTrader blueprint ids are unique across
-- games, so the card id alone almost always names one game.
create index if not exists cardtrader_facet_prices_card_idx
  on public.cardtrader_facet_prices (card_id);

-- One row per game: when its prices were last refilled. A game with no row
-- has no store yet; the price check then reads the old live path.
create table if not exists public.cardtrader_facet_price_runs (
    game text PRIMARY KEY,
    refreshed_at timestamp with time zone NOT NULL,
    source_at timestamp with time zone,
    row_count integer NOT NULL DEFAULT 0,
    written integer NOT NULL DEFAULT 0,
    deleted integer NOT NULL DEFAULT 0
);

-- Explicit grants for the least-privilege roles, where they exist.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'pokoin_jobs') then
    grant select, insert, update, delete on public.cardtrader_facet_prices, public.cardtrader_facet_price_runs to pokoin_jobs;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pokoin_api_read') then
    grant select on public.cardtrader_facet_prices, public.cardtrader_facet_price_runs to pokoin_api_read;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pokoin_api_write') then
    grant select on public.cardtrader_facet_prices, public.cardtrader_facet_price_runs to pokoin_api_write;
  end if;
end $$;
