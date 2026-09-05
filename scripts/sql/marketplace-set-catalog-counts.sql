-- Catalog card counts for set desks. This is how many singles the marketplace
-- grid shows (search_candidates with an image), not TCGDex printedTotal
-- (marketplace_blueprint_tcg_metadata.set_official_card_count).
-- Request handlers read these columns. Do not COUNT(*) on expansion-page.

begin;

set local statement_timeout = 0;

do $$
begin
  if to_regclass('public.pokoin_pokemon_expansions') is not null then
    alter table public.pokoin_pokemon_expansions
      add column if not exists catalog_card_count integer not null default 0;
  end if;
end $$;

create table if not exists public.marketplace_set_card_counts (
  set_name text primary key,
  slug text not null default '',
  catalog_card_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists marketplace_set_card_counts_slug_idx
  on public.marketplace_set_card_counts (slug);

create or replace function public.refresh_marketplace_set_catalog_counts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
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
$$;

select public.refresh_marketplace_set_catalog_counts();

create or replace function public.refresh_marketplace_oracle_projections()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cards_count integer;
  versions_count integer;
  candidates_count integer;
  card_urls_count integer;
  tokens_count integer;
  ngrams_count integer;
  price_summary_count integer;
  hot_blueprints_count integer;
  artist_card_counts_count integer;
  set_catalog_counts_count integer;
begin
  cards_count := public.refresh_marketplace_cards_from_blueprints();
  versions_count := public.refresh_marketplace_card_versions();
  candidates_count := public.refresh_marketplace_search_candidates();
  card_urls_count := public.refresh_marketplace_card_urls();
  artist_card_counts_count := public.refresh_marketplace_artist_card_counts();
  set_catalog_counts_count := public.refresh_marketplace_set_catalog_counts();
  tokens_count := public.refresh_marketplace_token_search_index();
  ngrams_count := public.refresh_marketplace_name_ngrams();
  price_summary_count := public.refresh_marketplace_blueprint_price_summary();
  hot_blueprints_count := public.refresh_marketplace_hot_blueprints();

  return jsonb_build_object(
    'marketplaceCards', cards_count,
    'marketplaceCardVersions', versions_count,
    'searchCandidates', candidates_count,
    'marketplaceCardUrls', card_urls_count,
    'artistCardCounts', artist_card_counts_count,
    'setCatalogCounts', set_catalog_counts_count,
    'tokenDimensions', tokens_count,
    'nameNgrams', ngrams_count,
    'priceSummaries', price_summary_count,
    'hotBlueprints', hot_blueprints_count,
    'refreshedAt', now()
  );
end;
$$;

commit;
