-- Artist Pokédex / same-artwork order lives on marketplace_search_candidates.
-- The SPA does not recompute CLIP cluster-oldest or TCG era ranks. Pipeline
-- Node `scripts/refresh-pokedex-sort.mjs` fills name/set caches and the
-- numeric parts; this function packs CLIP cluster-oldest when versions change.

set statement_timeout = 0;

alter table public.marketplace_search_candidates
  add column if not exists pokedex_num integer not null default 10000;

alter table public.marketplace_search_candidates
  add column if not exists expansion_sort integer not null default 0;

alter table public.marketplace_search_candidates
  add column if not exists collector_sort integer not null default 0;

alter table public.marketplace_search_candidates
  add column if not exists artwork_cluster_sort integer not null default 0;

alter table public.marketplace_search_candidates
  add column if not exists pokedex_sort bigint not null default 0;

create table if not exists public.pokoin_pokedex_name_sort (
  name text primary key,
  pokedex_num integer not null
);

create table if not exists public.pokoin_expansion_name_sort (
  expansion_name text primary key,
  expansion_sort integer not null
);

grant select, insert, update, delete on public.pokoin_pokedex_name_sort to pokoin_marketplace;
grant select, insert, update, delete on public.pokoin_expansion_name_sort to pokoin_marketplace;

create index if not exists marketplace_search_candidates_pokedex_sort_idx
  on public.marketplace_search_candidates (pokedex_sort, version, expansion_sort, collector_sort, card_id);

create or replace function public.marketplace_pack_pokedex_sort(
  pokedex_num integer,
  cluster_oldest integer
)
returns bigint
language sql
immutable
as $$
  select (greatest(coalesce(pokedex_num, 10000), 0)::bigint * 1000000)
       + greatest(coalesce(cluster_oldest, 0), 0)::bigint;
$$;

create or replace function public.marketplace_refresh_artwork_cluster_sort(
  p_versions text[] default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer := 0;
begin
  update public.marketplace_search_candidates c
  set
    artwork_cluster_sort = s.cluster_oldest,
    pokedex_sort = public.marketplace_pack_pokedex_sort(c.pokedex_num, s.cluster_oldest)
  from (
    select
      version,
      min(expansion_sort)::integer as cluster_oldest
    from public.marketplace_search_candidates
    where version is not null
      and version <> ''
      and (p_versions is null or version = any(p_versions))
    group by version
  ) s
  where c.version = s.version
    and (
      c.artwork_cluster_sort is distinct from s.cluster_oldest
      or c.pokedex_sort is distinct from public.marketplace_pack_pokedex_sort(c.pokedex_num, s.cluster_oldest)
    );
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

create or replace function public.marketplace_candidates_pull_pokedex_sort()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  dex integer;
  era integer;
begin
  select pokedex_num into dex
    from public.pokoin_pokedex_name_sort
   where name = new.name;
  if found then
    new.pokedex_num := dex;
  elsif tg_op = 'INSERT' then
    new.pokedex_num := 10000;
  end if;

  select expansion_sort into era
    from public.pokoin_expansion_name_sort
   where expansion_name = new.expansion_name;
  if found then
    new.expansion_sort := era;
  end if;

  return new;
end;
$$;

drop trigger if exists marketplace_search_candidates_pull_pokedex_sort
  on public.marketplace_search_candidates;
create trigger marketplace_search_candidates_pull_pokedex_sort
before insert or update of name, expansion_name
on public.marketplace_search_candidates
for each row
execute function public.marketplace_candidates_pull_pokedex_sort();

create or replace function public.marketplace_candidates_pokedex_sort_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  perform public.marketplace_refresh_artwork_cluster_sort(
    array(select distinct version from new_table where coalesce(version, '') <> '')
  );
  return null;
end;
$$;

create or replace function public.marketplace_candidates_pokedex_sort_after_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  perform public.marketplace_refresh_artwork_cluster_sort(
    array(
      select distinct version
      from (
        select version from new_table
        union
        select version from old_table
      ) s
      where coalesce(version, '') <> ''
    )
  );
  return null;
end;
$$;

drop trigger if exists marketplace_search_candidates_pokedex_sort_ins
  on public.marketplace_search_candidates;
create trigger marketplace_search_candidates_pokedex_sort_ins
after insert on public.marketplace_search_candidates
referencing new table as new_table
for each statement
execute function public.marketplace_candidates_pokedex_sort_after_insert();

drop trigger if exists marketplace_search_candidates_pokedex_sort_upd
  on public.marketplace_search_candidates;
create trigger marketplace_search_candidates_pokedex_sort_upd
after update on public.marketplace_search_candidates
referencing new table as new_table old table as old_table
for each statement
execute function public.marketplace_candidates_pokedex_sort_after_update();

grant execute on function public.marketplace_pack_pokedex_sort(integer, integer)
  to pokoin_marketplace;
grant execute on function public.marketplace_refresh_artwork_cluster_sort(text[])
  to pokoin_marketplace;
grant execute on function public.marketplace_candidates_pull_pokedex_sort()
  to pokoin_marketplace;
grant execute on function public.marketplace_candidates_pokedex_sort_after_insert()
  to pokoin_marketplace;
grant execute on function public.marketplace_candidates_pokedex_sort_after_update()
  to pokoin_marketplace;
