-- scripts/sql/145_cardmarket_offer_daily.sql
-- db: writer
-- phase: expand
--
-- Cardmarket's cheapest offer per product facet, kept per day: what the
-- cheapest NM-or-better private ask of this printing was on 12 November.
-- `cardmarket_offer_minimums` (141) answers "what is the price now" and holds
-- one row per facet; this holds one row per facet per day, which is the series
-- the card-page graph reads (reports/cm-conditions/site-side.md §4.1, finding
-- PRICE-03, owner's decision of 2026-11-18: all conditions, every day, for the
-- products on the daily watchlist).
--
-- One row is one line of the collector's per-day file
-- `<state-dir>/daily/daily-minimums-YYYY-MM-DD.jsonl`, loaded by
-- `pokoin-cardmarket-catalog cm-daily --file <that file> --apply`. The key is
-- exactly that file's key — (day, idProduct, language, condition, finish,
-- firstEdition, sellerType) — and `asked` keeps the two kinds of line apart.
--
-- Absence is not "no offers", it is "no observation": the collector writes a
-- line only for a facet its pages showed that day and carries nothing over from
-- the day before, so a missing day stays missing (docs/PRICE_DUMPS.md,
-- "Conventions a new feed should follow"). Nothing here prunes history.
--
-- Apply on the nezopt writer, pokoin_marketplace database. Idempotent; the
-- loader replays a file unchanged. The API reads it on the Pi replica, which
-- physical replication carries from this writer.
--
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace \
--     -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/145_cardmarket_offer_daily.sql

create table if not exists public.cardmarket_offer_daily (
    -- Cardmarket idProduct, as in 141.
    cm_product_id bigint not null,
    -- The UTC day of `observed_at`, which is the day of the file the row came
    -- from. In the key, because the graph's x axis is this.
    day date not null,
    -- Pokoin's language key of Cardmarket's facet: EN, IT, DE, FR, ES, ZH, ZHT,
    -- JP, PT, RU, KO, NL, PL, or '*' when the page was fetched with no
    -- language filter. Checked for shape, not against a list, so a language
    -- Cardmarket adds is loaded by the existing map and needs no migration.
    language text not null,
    -- Cardmarket's minCondition facet: 'NM', 'SP', 'MP', 'PL', 'Poor' or '*'.
    -- It is a floor, not a grade — see the column comment below.
    condition text not null,
    -- 'pro' (Cardmarket's professional and powerseller offers, folded) or
    -- 'private'.
    seller_type text not null,
    -- 'Y', 'N' or '*': Pokémon reverse holo, other games' foil.
    finish text not null,
    -- 'Y', 'N' or '*'.
    first_edition text not null,
    -- Cheapest offer the day's pages showed for this facet, EUR cents.
    min_cents integer not null,
    -- Offers behind that minimum; null when the collector could not count them.
    offer_count integer,
    -- False when an offer page was truncated: then min_cents is the cheapest
    -- seen (a cheaper one may exist) and offer_count is a lower bound.
    counts_complete boolean,
    -- True when the collector fetched this facet's own page and it came back
    -- ok; false when the price only rode along on a wider page (another floor,
    -- language or seller type). An `asked` day is one the walk meant to have.
    asked boolean not null,
    -- The moment within the day the page was read.
    observed_at timestamp with time zone not null,
    loaded_at timestamp with time zone not null default now(),
    constraint cardmarket_offer_daily_pkey
      primary key (cm_product_id, day, language, condition, seller_type, finish, first_edition),
    -- A facet with no price is the collector's answer to re-ask, not a price:
    -- the loader skips it, and so it never reaches here.
    constraint cardmarket_offer_daily_min_cents_positive check (min_cents > 0),
    constraint cardmarket_offer_daily_condition_known
      check (condition in ('NM', 'SP', 'MP', 'PL', 'Poor', '*')),
    constraint cardmarket_offer_daily_seller_type_known
      check (seller_type in ('pro', 'private')),
    constraint cardmarket_offer_daily_finish_known check (finish in ('Y', 'N', '*')),
    constraint cardmarket_offer_daily_first_edition_known
      check (first_edition in ('Y', 'N', '*')),
    -- Shape only, and the keys 141 stores: two- or three-letter caps, or the
    -- '*' facet. Cardmarket's own `ZH-TW` arrives as Pokoin's `ZHT`.
    constraint cardmarket_offer_daily_language_shape
      check (language = '*' or language ~ '^[A-Z]{2,3}$')
);

comment on table public.cardmarket_offer_daily is
  'Cardmarket offer minima per product facet per UTC day, one row per line of the collector''s daily-minimums file. Money is EUR cents. A facet absent on a day was not observed that day; absence is not "no offers".';
comment on column public.cardmarket_offer_daily.min_cents is
  'EUR cents: the unit Cardmarket prices in, so no currency or scale is implied anywhere downstream.';
comment on column public.cardmarket_offer_daily.condition is
  'A floor, never an exact grade: Cardmarket''s minCondition, so an ''NM'' row is the cheapest offer at NM or better and a ''Poor'' row is the cheapest of anything. Read a better floor as a subset of the worse one next to it; ''*'' is a page fetched with no condition filter and answers no grade.';
comment on column public.cardmarket_offer_daily.asked is
  'True when this facet''s own page was fetched and came back ok for that day, false when the price was only carried on a wider page. Not a quality mark on the price: a false row is the same collector observation, just one the run did not aim at.';

-- The graph read is one product across a range of days, which the primary key
-- already answers with its (cm_product_id, day) prefix, so no product-side
-- index is added. What that prefix cannot answer is a read that starts from the
-- day instead of the product: "did feed land today, and over how many products"
-- — the freshness and coverage check of the loader's own report and of the
-- endpoint's status — which would otherwise scan the whole table, and grows a
-- full scan every day it is asked. This one index serves it, `day` first so the
-- range is a scan and `cm_product_id` next so a distinct-product count of one
-- day stays index-only.
create index if not exists cardmarket_offer_daily_day_idx
    on public.cardmarket_offer_daily (day, cm_product_id);

-- Explicit grants for the least-privilege roles, where they exist: the loader
-- runs as pokoin_jobs (the cm-daily unit), the API reads on the replica.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'pokoin_jobs') then
    grant select, insert, update, delete on public.cardmarket_offer_daily
      to pokoin_jobs;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pokoin_api_read') then
    grant select on public.cardmarket_offer_daily to pokoin_api_read;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pokoin_api_write') then
    grant select on public.cardmarket_offer_daily to pokoin_api_write;
  end if;
end $$;
