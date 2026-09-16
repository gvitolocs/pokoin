-- Copy a unique illustrator onto CLIP siblings that have none.
-- 066 was a one-shot; CLIP later joined 30th Celebration JP Charizard
-- 137/103 (public 790994) into v243508 and left it empty.
-- marketplace_search_candidates.version is the same-artwork key.
-- Donor join is artist.card_id = c.card_id (public leftover × 2).
-- INSERT PK is leftover c.ct_id. Groups with two illustrators or two names
-- stay empty. Never overwrite an existing marketplace_blueprint_artists row.
-- Energy cards (Fighting Energy, Double Colorless Energy, …) do not inherit
-- a CLIP sibling. Only OCR / pokemontcg.io / TCGdex / pkmncards credits
-- show on the illustrator desk. Trainers named Energy Removal stay copyable.

set statement_timeout = 0;

create or replace function public.marketplace_is_energy_name(p_name text)
returns boolean
language sql
immutable
parallel safe
as $$
  select trim(coalesce(p_name, '')) ~* 'energy$'
$$;

create or replace function public.marketplace_copy_same_art_artists(p_version text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer := 0;
begin
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
      and (p_version is null or c.version = p_version)
      and not public.marketplace_is_energy_name(c.name)
      and coalesce(artist.normalized_artist, '') <> ''
    group by c.version
    having count(distinct artist.normalized_artist) = 1
  ),
  named as (
    select c.version
    from public.marketplace_search_candidates c
    where c.item_kind = 'single'
      and c.product_type = 'card'
      and coalesce(c.version, '') <> ''
      and (p_version is null or c.version = p_version)
      and not public.marketplace_is_energy_name(c.name)
    group by c.version
    having count(distinct public.marketplace_search_normalize(c.name)) = 1
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
  join named n on n.version = c.version
  join public.pokoin_pokemon_blueprints b on b.id = c.ct_id
  left join public.marketplace_blueprint_artists existing
    on existing.blueprint_id = c.ct_id
  where existing.blueprint_id is null
    and c.item_kind = 'single'
    and c.product_type = 'card'
    and not public.marketplace_is_energy_name(c.name)
  on conflict (blueprint_id) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.marketplace_search_candidates_copy_same_art_artist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(old.version, '') <> '' then
      perform public.marketplace_copy_same_art_artists(old.version);
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.version is not distinct from new.version then
    return new;
  end if;
  if coalesce(new.version, '') <> '' then
    perform public.marketplace_copy_same_art_artists(new.version);
  end if;
  if tg_op = 'UPDATE'
    and coalesce(old.version, '') <> ''
    and old.version is distinct from new.version
  then
    perform public.marketplace_copy_same_art_artists(old.version);
  end if;
  return new;
end;
$$;

drop trigger if exists marketplace_search_candidates_copy_same_art_artist
  on public.marketplace_search_candidates;
create trigger marketplace_search_candidates_copy_same_art_artist
after insert or update of version or delete
on public.marketplace_search_candidates
for each row
execute function public.marketplace_search_candidates_copy_same_art_artist();

create or replace function public.marketplace_blueprint_artists_copy_same_art()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v text;
begin
  if new.source = 'same_artwork' or pg_trigger_depth() > 1 then
    return new;
  end if;
  select c.version into v
  from public.marketplace_search_candidates c
  where c.card_id = new.card_id
  limit 1;
  if coalesce(v, '') <> '' then
    perform public.marketplace_copy_same_art_artists(v);
  end if;
  return new;
end;
$$;

drop trigger if exists marketplace_blueprint_artists_copy_same_art
  on public.marketplace_blueprint_artists;
create trigger marketplace_blueprint_artists_copy_same_art
after insert
on public.marketplace_blueprint_artists
for each row
execute function public.marketplace_blueprint_artists_copy_same_art();

grant execute on function public.marketplace_is_energy_name(text)
  to pokoin_marketplace;
grant execute on function public.marketplace_copy_same_art_artists(text)
  to pokoin_marketplace;

select public.marketplace_copy_same_art_artists() as same_art_artists_copied;
select public.refresh_marketplace_artist_card_counts() as artist_counts_refreshed;

select
  c.card_id,
  c.ct_id,
  c.set_name,
  artist.artist,
  artist.source,
  artist.match_reason
from public.marketplace_search_candidates c
join public.marketplace_blueprint_artists artist
  on artist.card_id = c.card_id
where c.card_id = 790994;
