-- More price sources for the pricer (docs/PRICING.md "Price sources"):
-- Cardmarket's public price guide for every game, and a daily EUR reference
-- rate so TCGplayer's USD prices convert the same way on the server and on
-- the web.
--
-- * `cardmarket_price_guide`: Cardmarket's daily price guide
--   (downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_<idGame>.json),
--   EUR, for the Cardmarket products our catalogs reference
--   (`card_market_ids`). A row is written only when a product's values
--   change: it holds from `day` until that product's next row, so the newest
--   row on or before a day is the guide of that day. Written by
--   `pokoin-cardmarket-catalog guides --apply` (pokoin-rust/apps/cardmarket-catalog).
-- * `cardmarket_price_guide_runs`: one row per game and guide day the job
--   loaded; the pricer trusts a game's guide only while its last run is recent.
-- * `fx_rates_daily`: the ECB euro reference rates
--   (www.ecb.europa.eu/stats/eurofxref), 1 EUR = `rate` units of `quote`.
--   Written by `pokoin-api job fx-rates-daily`.
--
-- Apply on the nezopt writer, pokoin_marketplace database. Idempotent.
--
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace \
--     -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/139_pricer_sources.sql

create table if not exists public.cardmarket_price_guide (
    -- Pokoin game slug (`pokemon`, `magic`, …), as `cardtrader_facet_prices.game`.
    game text NOT NULL,
    id_product bigint NOT NULL,
    -- The first price-guide day these values were seen.
    day date NOT NULL,
    id_category integer,
    avg numeric,
    low numeric,
    trend numeric,
    avg1 numeric,
    avg7 numeric,
    avg30 numeric,
    avg_foil numeric,
    low_foil numeric,
    trend_foil numeric,
    avg1_foil numeric,
    avg7_foil numeric,
    avg30_foil numeric,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cardmarket_price_guide_pkey PRIMARY KEY (game, id_product, day)
);

create table if not exists public.cardmarket_price_guide_runs (
    game text NOT NULL,
    day date NOT NULL,
    id_game integer NOT NULL,
    -- Guide rows for products our catalog references.
    products integer NOT NULL,
    -- Of those, rows written because their values changed.
    changed integer NOT NULL,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cardmarket_price_guide_runs_pkey PRIMARY KEY (game, day)
);

create table if not exists public.fx_rates_daily (
    day date NOT NULL,
    base text DEFAULT 'EUR' NOT NULL,
    quote text NOT NULL,
    rate numeric NOT NULL CHECK (rate > 0),
    source text DEFAULT 'ecb' NOT NULL,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fx_rates_daily_pkey PRIMARY KEY (day, base, quote)
);

-- Explicit grants for the least-privilege roles, where they exist.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'pokoin_jobs') then
    grant select, insert, update, delete on public.cardmarket_price_guide,
      public.cardmarket_price_guide_runs, public.fx_rates_daily to pokoin_jobs;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pokoin_api_read') then
    grant select on public.cardmarket_price_guide, public.cardmarket_price_guide_runs,
      public.fx_rates_daily to pokoin_api_read;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pokoin_api_write') then
    grant select on public.cardmarket_price_guide, public.cardmarket_price_guide_runs,
      public.fx_rates_daily to pokoin_api_write;
  end if;
end $$;
