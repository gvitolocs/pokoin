-- Energy leftovers do not inherit a CLIP sibling illustrator.
-- Fighting Energy / Double Colorless Energy / Rainbow Energy stay empty
-- unless OCR, pokemontcg.io, pokemon_tcg_data, TCGdex, or pkmncards wrote
-- the name. Trainers (Energy Removal, Energy Retrieval) still copy.
-- Function skip lives in 068_same_art_copy_artists.sql; apply that DDL
-- first, then this delete.

begin;
set local statement_timeout = 0;

create or replace function public.marketplace_is_energy_name(p_name text)
returns boolean
language sql
immutable
parallel safe
as $$
  select trim(coalesce(p_name, '')) ~* 'energy$'
$$;

delete from public.marketplace_blueprint_artists a
using public.marketplace_search_candidates c
where a.card_id = c.card_id
  and a.source = 'same_artwork'
  and public.marketplace_is_energy_name(c.name);

select public.refresh_marketplace_artist_card_counts() as artist_counts_refreshed;

commit;

select
  public.marketplace_is_energy_name('Fighting Energy') as fighting,
  public.marketplace_is_energy_name('Double Colorless Energy') as dce,
  public.marketplace_is_energy_name('Energy Removal') as removal;

select a.source, count(*)
from public.marketplace_blueprint_artists a
join public.marketplace_search_candidates c on c.card_id = a.card_id
where public.marketplace_is_energy_name(c.name)
group by 1
order by 2 desc;

select count(*) as kinebuchi_energy
from public.marketplace_blueprint_artists a
join public.marketplace_search_candidates c on c.card_id = a.card_id
where lower(a.artist) like '%kinebuchi%'
  and public.marketplace_is_energy_name(c.name);
