-- The per-game CardTrader price cache written nightly by
-- `pokoin-cardtrader-price-cache` (`pokoin-rust/apps/cardtrader-price-cache`,
-- docs/CARDTRADER_DAILY_DUMP.md), which created this table and replaced the
-- view itself before every run until 2026-10-15. Its role (pokoin_jobs) has no
-- DDL rights now (migration 124).
--
-- Apply on the nezopt writer to pokoin_marketplace and every CardTrader game
-- database (the price cache's game list), as pokoin_migrator. Idempotent; the
-- definitions are the ones the job created.
create table if not exists public.cardtrader_blueprint_listing_cache (
    provider text DEFAULT 'cardtrader'::text NOT NULL,
    blueprint_id bigint NOT NULL,
    pokoin_card_id text DEFAULT ''::text NOT NULL,
    cheapest_price_eur numeric,
    cheapest_price_pkn numeric,
    eligible_listing_count integer DEFAULT 0 NOT NULL,
    eligible_quantity integer DEFAULT 0 NOT NULL,
    sample_listing_id text DEFAULT ''::text NOT NULL,
    sample_product_id text DEFAULT ''::text NOT NULL,
    shipping_mode text DEFAULT ''::text NOT NULL,
    seller_country_code text DEFAULT ''::text NOT NULL,
    source_snapshot_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cardtrader_blueprint_listing_cache_pkey PRIMARY KEY (blueprint_id),
    CONSTRAINT cardtrader_blueprint_listing_cache_eligible_listing_count_check CHECK ((eligible_listing_count >= 0)),
    CONSTRAINT cardtrader_blueprint_listing_cache_eligible_quantity_check CHECK ((eligible_quantity >= 0))
);
create index if not exists cardtrader_blueprint_listing_cache_available_idx
  ON public.cardtrader_blueprint_listing_cache USING btree (blueprint_id)
  WHERE ((eligible_listing_count > 0) AND (cheapest_price_pkn IS NOT NULL));
create index if not exists cardtrader_blueprint_listing_cache_pokoin_available_idx
  ON public.cardtrader_blueprint_listing_cache USING btree (pokoin_card_id)
  WHERE ((provider = ANY (ARRAY['cardtrader'::text, 'pokoin_native'::text]))
    AND (pokoin_card_id <> ''::text) AND (eligible_listing_count > 0) AND (cheapest_price_pkn IS NOT NULL));
create index if not exists cardtrader_blueprint_listing_cache_provider_updated_idx
  ON public.cardtrader_blueprint_listing_cache USING btree (provider, updated_at DESC);
create or replace view public.cheapest_homepage_cache_blueprint AS
 SELECT provider, blueprint_id, pokoin_card_id, cheapest_price_eur, cheapest_price_pkn, eligible_listing_count,
    eligible_quantity, sample_listing_id, sample_product_id, shipping_mode, seller_country_code, source_snapshot_at, updated_at
   FROM public.cardtrader_blueprint_listing_cache;
