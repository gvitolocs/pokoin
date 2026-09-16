-- One-shot copy of a unique illustrator onto CLIP siblings that have none.
-- Live path is marketplace_copy_same_art_artists() in 068_same_art_copy_artists.sql
-- (trigger on candidates.version). Donor join is artist.card_id = c.card_id
-- (public leftover×2), not leftover blueprint_id = ct_id. INSERT PK is still
-- leftover c.ct_id. Groups with two names stay empty.
-- Never overwrite an existing marketplace_blueprint_artists row.

begin;
set local statement_timeout = 0;

with donors as (
  select
    c.version,
    min(artist.artist) as artist,
    min(artist.illustrator) as illustrator,
    min(artist.normalized_artist) as normalized_artist,
    min(artist.blueprint_id) as donor_blueprint_id,
    min(artist.source) as donor_source,
    min(artist.confidence) as confidence
  from public.marketplace_search_candidates c
  join public.marketplace_blueprint_artists artist
    on artist.card_id = c.card_id
  where c.item_kind = 'single'
    and c.product_type = 'card'
    and coalesce(c.version, '') <> ''
    and coalesce(artist.normalized_artist, '') <> ''
  group by c.version
  having count(distinct artist.normalized_artist) = 1
)
insert into public.marketplace_blueprint_artists (
  blueprint_id,
  ct_id,
  artist,
  illustrator,
  normalized_artist,
  source,
  source_card_id,
  confidence,
  match_reason,
  raw_metadata
)
select
  c.ct_id,
  c.ct_id,
  d.artist,
  d.illustrator,
  d.normalized_artist,
  'same_artwork',
  d.donor_blueprint_id::text,
  least(coalesce(d.confidence, 0.9), 0.95),
  'clip_version_set',
  jsonb_build_object(
    'version', c.version,
    'donor_blueprint_id', d.donor_blueprint_id,
    'donor_source', d.donor_source
  )
from public.marketplace_search_candidates c
join donors d on d.version = c.version
join public.pokoin_pokemon_blueprints b on b.id = c.ct_id
left join public.marketplace_blueprint_artists existing
  on existing.blueprint_id = c.ct_id
where existing.blueprint_id is null
  and c.item_kind = 'single'
  and c.product_type = 'card'
on conflict (blueprint_id) do nothing;

select public.refresh_marketplace_artist_card_counts() as artist_counts_refreshed;

commit;

select
  count(*) filter (where source = 'same_artwork')::integer as same_artwork_rows,
  count(*)::integer as artist_rows
from public.marketplace_blueprint_artists;

select c.ct_id, c.card_id, c.set_name, artist.artist, artist.source
from public.marketplace_search_candidates c
join public.marketplace_blueprint_artists artist
  on artist.card_id = c.card_id
where c.version = (
  select version from public.marketplace_search_candidates where ct_id = 395787
)
order by c.ct_id;
