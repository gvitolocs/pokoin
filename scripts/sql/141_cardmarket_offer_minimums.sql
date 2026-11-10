-- Cardmarket's cheapest professional offer per product facet, as the CTCMDeals
-- worker saw it while walking the listing pages (docs/PRICING.md "Price
-- sources").
--
-- The official guide and TCGNotify both answer "what is the cheapest copy of
-- this card", which includes the private seller with an idea of the price. The
-- number a restocking seller needs is the other one: the cheapest copy a
-- *professional* seller offers, because that is the competition. Cardmarket
-- publishes it only inside a filtered listing page, and CTCMDeals already
-- navigates those pages — so its scan keeps what it passed.
--
-- One row per facet, holding the newest observation only; the worker's
-- `minimums.jsonl` stays the append-only history (CTCMDeals README, "What a
-- run leaves behind"). A facet is
-- product × language × condition × finish × first edition × seller type:
--
--   * `condition` is Cardmarket's `minCondition` filter: the *worst* grade
--     acceptable, so an 'NM' row is an NM-or-better minimum and can never be
--     read as a 'Poor' one.
--   * '*' means the page was fetched unfiltered for that dimension, so its
--     minimum mixes finishes, languages or conditions. The pricer keeps a '*'
--     facet out of any specific item's comp and only counts it into the
--     "cheapest professional offer of this card" figure.
--   * `min_cents` is EUR cents, the unit Cardmarket prices in. Only facets that
--     found at least one offer are stored: a facet with no offers is the
--     engine's own answer to re-ask, not a price.
--   * Freshness is per row (`observed_at`), not per run, because the harvest is
--     on demand: a scan of two products and a scan of six thousand differ in
--     age per facet, not per feed.
--
-- Loaded by `pokoin-cardmarket-catalog cm-offers --file minimums.jsonl
-- --apply`. Apply on the nezopt writer, pokoin_marketplace database. Idempotent.
--
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace \
--     -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/141_cardmarket_offer_minimums.sql

create table if not exists public.cardmarket_offer_minimums (
    -- Cardmarket idProduct, as `cardmarket_price_guide.id_product`.
    cm_product_id bigint NOT NULL,
    -- Pokoin's language key of the facet: EN, IT, DE, FR, ES, JP, KO, PT, NL,
    -- PL, RU, ZH, ZHT, or '*' when the page was not language-filtered.
    language text NOT NULL,
    -- 'NM', 'SP', 'MP', 'PL', 'Poor' or '*' — see the header on the ordering.
    condition text NOT NULL,
    -- 'Y', 'N' or '*': Pokémon reverse holo, other games' foil.
    finish text NOT NULL,
    first_edition text NOT NULL,
    -- 'pro' (professional and powerseller offers) or 'private'.
    seller_type text NOT NULL,
    -- Cheapest offer of the facet, EUR cents.
    min_cents integer NOT NULL,
    -- Offers seen at that minimum facet; null when the count was not reliable.
    offers integer,
    -- False when the scan stopped on a full page, so cheaper offers may exist.
    counts_complete boolean,
    observed_at timestamp with time zone NOT NULL,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cardmarket_offer_minimums_pkey
      PRIMARY KEY (cm_product_id, language, condition, finish, first_edition, seller_type)
);

-- Explicit grants for the least-privilege roles, where they exist.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'pokoin_jobs') then
    grant select, insert, update, delete on public.cardmarket_offer_minimums
      to pokoin_jobs;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pokoin_api_read') then
    grant select on public.cardmarket_offer_minimums to pokoin_api_read;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pokoin_api_write') then
    grant select on public.cardmarket_offer_minimums to pokoin_api_write;
  end if;
end $$;
