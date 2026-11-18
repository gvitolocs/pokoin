-- Cardmarket price guide history for the Cardmarket-only game databases
-- (docs/CARDMARKET_GAMES.md). One row per Cardmarket idProduct and price-guide
-- day, exactly as Cardmarket publishes it (EUR; null = no value):
-- https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_<idGame>.json
--
-- Written by `pokoin-cardmarket-catalog prices --apply`
-- (pokoin-rust/apps/cardmarket-catalog), which also sets each priced card's
-- display price in public.marketplace_card_daily_median (migration 112).
-- Catalog rows reach a product through cardmarket_products.card_market_ids.
--
-- Apply to each pokoin_<game> DB that loads prices (first: pokoin_battle_spirits_saga)
-- on the nezopt writer as the migrator. Idempotent.

create table if not exists public.cardmarket_price_guide_daily (
  id_product bigint not null,
  day date not null,
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
  loaded_at timestamptz not null default now(),
  primary key (id_product, day)
);

create index if not exists cardmarket_price_guide_daily_day_idx
  on public.cardmarket_price_guide_daily (day);

-- The daily job logs in as pokoin_jobs once the least-privilege roles
-- (migration 124) exist; until then it uses the container login.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'pokoin_jobs') then
    grant select, insert, update on public.cardmarket_price_guide_daily to pokoin_jobs;
    grant select, insert, update, delete on public.marketplace_card_daily_median to pokoin_jobs;
  end if;
end $$;
