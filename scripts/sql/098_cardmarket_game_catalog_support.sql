-- Catalog support tables for the nine Cardmarket-only game databases
-- (pokoin_weiss_schwarz, pokoin_final_fantasy, … — docs/CARDMARKET_GAMES.md).
--
-- The shared Pi API reads these for every satellite game (set lists, set
-- counts, Cardmarket links, expansion language joins). CardTrader game DBs
-- already have them; the Cardmarket DBs were created with only the raw
-- cardmarket_products table plus the 027 projections. Same definitions as
-- pokoin_palworld (pg_dump 2026-10-02). Idempotent.
--
-- Apply to each pokoin_<game> DB on the nezopt writer, then:
--   select public.refresh_marketplace_set_catalog_counts();

create table if not exists public.marketplace_cm_verified_links (
  blueprint_id bigint not null,
  cardmarket_locale text default 'en' not null,
  cardmarket_url text not null,
  cardmarket_product_slug text default '' not null,
  card_name text default '' not null,
  expansion_name text default '' not null,
  collector_number text default '' not null,
  source text default '' not null,
  confidence text default 'verified' not null
    check (confidence = any (array['verified', 'manual'])),
  notes text default '' not null,
  verified_at timestamptz default now() not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  primary key (blueprint_id, cardmarket_locale)
);
create unique index if not exists marketplace_cm_verified_links_url_idx
  on public.marketplace_cm_verified_links (cardmarket_url);

create table if not exists public.marketplace_set_card_counts (
  set_name text primary key,
  slug text default '' not null,
  catalog_card_count integer default 0 not null,
  updated_at timestamptz default now() not null
);
create index if not exists marketplace_set_card_counts_slug_idx
  on public.marketplace_set_card_counts (slug);

create table if not exists public.pokoin_expansions (
  expansion_id integer primary key,
  game_id integer,
  game_slug text default '' not null,
  code text default '' not null,
  name text default '' not null,
  nationality text default 'unknown' not null
    check (nationality = any (array['western', 'japanese', 'chinese', 'korean', 'unknown'])),
  milo_gallery text default 'none' not null
    check (milo_gallery = any (array['western', 'japanese', 'chinese', 'none'])),
  print_lang_source text default '' not null,
  ocr_label text default '' not null
    check (ocr_label = any (array['', 'en', 'jp', 'zh', 'ko', 'other'])),
  sample_ct_id bigint,
  sample_image_path text,
  ocr_confidence numeric,
  ocr_raw text,
  listed boolean default true not null,
  updated_at timestamptz default now() not null
);
create index if not exists pokoin_expansions_game_slug_idx on public.pokoin_expansions (game_slug);
create index if not exists pokoin_expansions_nationality_idx on public.pokoin_expansions (nationality, milo_gallery);

create table if not exists public.pokoin_pokemon_expansions (
  name text primary key,
  symbol_image_url text,
  logo_image_url text,
  catalog_card_count integer default 0 not null,
  nationality text default '' not null,
  updated_at timestamptz default now() not null
);

CREATE OR REPLACE FUNCTION public.refresh_marketplace_set_catalog_counts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  upserted integer := 0;
  expanded integer := 0;
begin
  insert into public.marketplace_set_card_counts (
    set_name,
    slug,
    catalog_card_count,
    updated_at
  )
  select
    c.set_name,
    trim(both '-' from regexp_replace(
      lower(replace(c.set_name, '&', ' and ')),
      '[^a-z0-9]+',
      '-',
      'g'
    )),
    count(*)::integer,
    now()
  from public.marketplace_search_candidates c
  where c.item_kind = 'single'
    and c.product_type = 'card'
    and coalesce(c.cdn_image_url, c.image_url) is not null
    and coalesce(c.set_name, '') <> ''
  group by c.set_name
  on conflict (set_name) do update
    set slug = excluded.slug,
      catalog_card_count = excluded.catalog_card_count,
      updated_at = now();

  get diagnostics upserted = row_count;

  delete from public.marketplace_set_card_counts counts
  where not exists (
    select 1
    from public.marketplace_search_candidates c
    where c.set_name = counts.set_name
      and c.item_kind = 'single'
      and c.product_type = 'card'
      and coalesce(c.cdn_image_url, c.image_url) is not null
  );

  if to_regclass('public.pokoin_pokemon_expansions') is not null then
    update public.pokoin_pokemon_expansions expansions
    set catalog_card_count = coalesce(counts.catalog_card_count, 0),
      updated_at = now()
    from public.marketplace_set_card_counts counts
    where counts.set_name = expansions.name
      and expansions.catalog_card_count is distinct from coalesce(counts.catalog_card_count, 0);

    get diagnostics expanded = row_count;

    update public.pokoin_pokemon_expansions expansions
    set catalog_card_count = 0,
      updated_at = now()
    where expansions.catalog_card_count is distinct from 0
      and not exists (
        select 1
        from public.marketplace_set_card_counts counts
        where counts.set_name = expansions.name
      );
  end if;

  return upserted + expanded;
end;
$function$

;
