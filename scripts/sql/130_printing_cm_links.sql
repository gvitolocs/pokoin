-- Printing → Cardmarket product page by public card id, for satellite game
-- databases (same shape as pokoin_marketplace.public.pokoin_printing_cm_links,
-- the Pokémon table). `/api/cardmarket-redirect` reads this table first
-- (pokoin-rust/crates/external/src/cardmarket.rs `stored_url`), so a row here
-- sends the CM button straight to that page.
--
-- Unlike marketplace_cm_verified_links, one Cardmarket page may serve several
-- printings: Weiss Schwarz Japanese printings share the page of their English
-- twin with the same artwork (Cardmarket lists only the English edition).
--
-- Written by `pokoin-cardmarket-catalog links --game weiss_schwarz --jp-twins --apply-jp`
-- (pokoin-rust/apps/cardmarket-catalog, docs/CARDMARKET_GAMES.md).
--
-- Apply to pokoin_weiss_schwarz on the nezopt writer as the table owner
-- (physical replication carries it to the Pi). Idempotent.

create table if not exists public.pokoin_printing_cm_links (
  public_id bigint primary key,
  ct_id bigint,
  cm_url text not null,
  cm_product_id bigint,
  n_candidates integer default 1,
  method text,
  all_urls jsonb,
  series text,
  source text,
  created_at timestamptz default now()
);

create index if not exists pokoin_printing_cm_links_ct_idx
  on public.pokoin_printing_cm_links (ct_id);
