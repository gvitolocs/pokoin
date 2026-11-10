-- TCGNotify's Cardmarket cheapest ask, preferred over the official price
-- guide's `low` basis (docs/PRICING.md "Price sources").
--
-- TCGNotify (tcgnotify.com) tracks Cardmarket itself and publishes a global
-- `min_price` per product — the cheapest current listing across languages,
-- which is the same number Cardmarket's guide calls `low`. Its `id` is the
-- Cardmarket idProduct, so it joins the existing `card_market_ids` crosswalk
-- with no new mapping.
--
-- Only `low` is taken. TCGNotify's dump carries no trend, no 1/7/30-day
-- averages and no foil prices (low_price, high_price and both foil fields are
-- zero on every row), so those bases and every foil value stay with the
-- official guide.
--
-- * `tcgnotify_price_guide`: change-only history like `cardmarket_price_guide`
--   — a row holds from `day` until that product's next row, so the newest row
--   is the current ask. Written by `pokoin-cardmarket-catalog tcgnotify --apply`.
-- * `tcgnotify_price_guide_runs`: one row per game and day loaded; the pricer
--   trusts the feed only while its last run is recent, independently of the
--   official guide's run.
--
-- Apply on the nezopt writer, pokoin_marketplace database. Idempotent.
--
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace \
--     -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/140_tcgnotify_price_guide.sql

create table if not exists public.tcgnotify_price_guide (
    -- Pokoin game slug. TCGNotify tracks pokemon, lorcana and riftbound only.
    game text NOT NULL,
    -- Cardmarket idProduct, as `cardmarket_price_guide.id_product`.
    id_product bigint NOT NULL,
    -- The product's own `updated_at` day, not the load day.
    day date NOT NULL,
    -- Global cheapest ask, EUR. Null when TCGNotify has no listing.
    min_price numeric,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tcgnotify_price_guide_pkey PRIMARY KEY (game, id_product, day)
);

create table if not exists public.tcgnotify_price_guide_runs (
    game text NOT NULL,
    day date NOT NULL,
    -- Products loaded for this game.
    products integer NOT NULL,
    -- Of those, rows written because the ask changed.
    changed integer NOT NULL,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tcgnotify_price_guide_runs_pkey PRIMARY KEY (game, day)
);

-- Explicit grants for the least-privilege roles, where they exist.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'pokoin_jobs') then
    grant select, insert, update, delete on public.tcgnotify_price_guide,
      public.tcgnotify_price_guide_runs to pokoin_jobs;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pokoin_api_read') then
    grant select on public.tcgnotify_price_guide, public.tcgnotify_price_guide_runs
      to pokoin_api_read;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pokoin_api_write') then
    grant select on public.tcgnotify_price_guide, public.tcgnotify_price_guide_runs
      to pokoin_api_write;
  end if;
end $$;