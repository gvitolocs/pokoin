-- Desk illustrator on marketplace_search_candidates, keyed by Pokoin
-- public card_id (leftover × 2). OCR / pokemontcg.io / CLIP still write
-- marketplace_blueprint_artists only. Do not join leftover ct_id on the
-- card-page hot path.
--
-- ct_id stays on candidates for CDN filenames and CardTrader blueprint
-- calls. It is not the marketplace identity.

set statement_timeout = 0;

alter table public.marketplace_search_candidates
  add column if not exists artist text not null default '';

alter table public.marketplace_search_candidates
  add column if not exists illustrator text not null default '';

update public.marketplace_search_candidates c
set
  artist = a.artist,
  illustrator = a.illustrator
from public.marketplace_blueprint_artists a
where c.card_id = a.card_id
  and (
    c.artist is distinct from a.artist
    or c.illustrator is distinct from a.illustrator
  );

create or replace function public.marketplace_candidates_sync_artist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    update public.marketplace_search_candidates
    set artist = '', illustrator = ''
    where card_id = old.card_id;
    return old;
  end if;
  update public.marketplace_search_candidates
  set
    artist = new.artist,
    illustrator = new.illustrator
  where card_id = new.card_id;
  return new;
end;
$$;

drop trigger if exists marketplace_blueprint_artists_sync_candidate
  on public.marketplace_blueprint_artists;
create trigger marketplace_blueprint_artists_sync_candidate
after insert or update of artist, illustrator or delete
on public.marketplace_blueprint_artists
for each row
execute function public.marketplace_candidates_sync_artist();

create or replace function public.marketplace_candidates_pull_artist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  src_artist text;
  src_illustrator text;
begin
  select a.artist, a.illustrator
  into src_artist, src_illustrator
  from public.marketplace_blueprint_artists a
  where a.card_id = new.card_id;
  if found then
    new.artist := src_artist;
    new.illustrator := src_illustrator;
  end if;
  return new;
end;
$$;

drop trigger if exists marketplace_search_candidates_pull_artist
  on public.marketplace_search_candidates;
create trigger marketplace_search_candidates_pull_artist
before insert on public.marketplace_search_candidates
for each row
execute function public.marketplace_candidates_pull_artist();

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

grant execute on function public.marketplace_candidates_sync_artist()
  to pokoin_marketplace;
grant execute on function public.marketplace_candidates_pull_artist()
  to pokoin_marketplace;
