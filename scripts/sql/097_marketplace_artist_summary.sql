-- Precomputed artist index. The hot read is this table, not the window over
-- every artist card. Rebuild with select public.refresh_marketplace_artist_summary().
-- Apply on the nezopt writer. Safe to run again.

create table if not exists public.marketplace_artist_summary (
  normalized_artist text primary key,
  artist text,
  illustrator text,
  artist_slug text,
  artist_card_count integer not null default 0,
  visible_card_count integer not null default 0,
  profile_display_name text,
  profile_image_url text,
  image_url text,
  cover_name text,
  art_shade text,
  refreshed_at timestamptz not null default now()
);

create index if not exists marketplace_artist_summary_count_idx
  on public.marketplace_artist_summary (artist_card_count desc, artist, artist_slug);

create or replace function public.refresh_marketplace_artist_summary()
returns integer
language plpgsql
as $$
declare
  inserted integer;
begin
  delete from public.marketplace_artist_summary;
  insert into public.marketplace_artist_summary (
    normalized_artist, artist, illustrator, artist_slug, artist_card_count,
    visible_card_count, profile_display_name, profile_image_url, image_url,
    cover_name, art_shade, refreshed_at
  )
  with cheap as (
    select blueprint_id, max(cheapest_price_pkn) as cheapest_price_pkn
    from public.cheapest_homepage_cache_blueprint
    where provider in ('cardtrader', 'pokoin_native')
      and cheapest_price_pkn is not null
      and cheapest_price_pkn > 0
      and coalesce(eligible_listing_count, 0) > 0
    group by blueprint_id
  ),
  artist_cards as (
    select
      artist.artist,
      artist.illustrator,
      artist.normalized_artist,
      trim(both '-' from regexp_replace(lower(coalesce(artist.normalized_artist, '')), '[^a-z0-9]+', '-', 'g')) as artist_slug,
      artist.artist_card_count,
      versions.blueprint_id,
      versions.ct_id,
      versions.name,
      versions.projected_at,
      coalesce(nullif(versions.cdn_image_url, ''), nullif(versions.image_url, ''), nullif(versions.homepage_image_url, '')) as image_url,
      shades.shade as art_shade,
      case
        when lower(versions.name) ~ '^pikachu([[:space:]]|$)' then 1
        when lower(versions.name) ~ '^(bulbasaur|charmander|squirtle)([[:space:]]|$)' then 2
        when lower(versions.name) ~ '^eevee([[:space:]]|$)' then 3
        else 4
      end as cover_tier,
      cheap.cheapest_price_pkn,
      count(*) over (partition by artist.normalized_artist)::integer as visible_card_count
    from public.marketplace_blueprint_artists artist
    join public.marketplace_card_versions versions
      on versions.blueprint_id = artist.blueprint_id
    left join public.marketplace_leftover_art_shades shades
      on shades.ct_id = versions.ct_id
    left join cheap
      on cheap.blueprint_id = versions.blueprint_id
    where versions.product_type = 'card'
      and coalesce(nullif(versions.cdn_image_url, ''), nullif(versions.image_url, ''), nullif(versions.homepage_image_url, '')) is not null
      and coalesce(versions.cdn_image_url, versions.image_url, versions.homepage_image_url, '') !~* '/previews/|/preview_'
  ),
  picked as (
    select distinct on (artist_cards.normalized_artist)
      artist_cards.artist,
      artist_cards.illustrator,
      artist_cards.normalized_artist,
      artist_cards.artist_slug,
      greatest(coalesce(artist_cards.artist_card_count, 0), coalesce(artist_cards.visible_card_count, 0))::integer as artist_card_count,
      artist_cards.visible_card_count,
      profiles.display_name as profile_display_name,
      coalesce(nullif(profiles.profile_image_cdn_url, ''), profiles.profile_image_url) as profile_image_url,
      artist_cards.image_url,
      artist_cards.name as cover_name,
      artist_cards.art_shade
    from artist_cards
    left join public.marketplace_artist_profiles profiles
      on profiles.normalized_artist = artist_cards.normalized_artist
    order by
      artist_cards.normalized_artist asc,
      artist_cards.cover_tier asc,
      artist_cards.cheapest_price_pkn desc nulls last,
      artist_cards.projected_at desc nulls last,
      artist_cards.blueprint_id asc
  )
  select
    normalized_artist, artist, illustrator, artist_slug, artist_card_count,
    visible_card_count, profile_display_name, profile_image_url, image_url,
    cover_name, art_shade, now()
  from picked
  where coalesce(normalized_artist, '') <> '';

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;
