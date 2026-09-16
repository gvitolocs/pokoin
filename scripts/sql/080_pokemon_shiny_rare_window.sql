-- Pokémon Shiny Rare leftovers are a framed illustration box.
-- Classify leftover JPEGs on nezopt NVMe (not 15T objects). Persist layout
-- rows on 15T; Pi replica streams. Do not write the Pi. Do not glob mybook.

begin;
set local statement_timeout = 0;

create temp table pokemon_shiny_rare_ct as
select c.ct_id, c.card_id, coalesce(s.version, '') as version
from public.marketplace_search_candidates s
join public.marketplace_cards c on c.card_id = s.card_id
where c.product_type = 'card'
  and s.pokedex_num > 0
  and s.pokedex_num < 10000
  and c.name !~* '\m(gx|vmax)\M'
  and (
    coalesce(s.card_number, c.card_number, '') ~* 'shiny[[:space:]-]*(holo[[:space:]]*)?rare'
    or coalesce(s.rarity, '') ~* 'shiny[[:space:]-]*(holo[[:space:]]*)?rare'
  )
  and coalesce(s.card_number, c.card_number, '') !~* 'shiny[[:space:]-]*ultra[[:space:]]*rare'
  and coalesce(s.rarity, '') !~* 'shiny[[:space:]-]*ultra[[:space:]]*rare';

update public.marketplace_search_candidates s
set
  art_layout = 'window',
  projected_at = now()
from pokemon_shiny_rare_ct g
where s.card_id = g.card_id
  and s.art_layout is distinct from 'window';

insert into public.marketplace_leftover_art_layouts (ct_id, layout, source, version, sampled_at)
select
  g.ct_id,
  'window',
  'catalog_shiny_rare',
  g.version,
  now()
from pokemon_shiny_rare_ct g
on conflict (ct_id) do update
  set layout = 'window',
      source = 'catalog_shiny_rare',
      version = excluded.version,
      sampled_at = now()
  where marketplace_leftover_art_layouts.layout is distinct from 'window'
     or marketplace_leftover_art_layouts.source is distinct from 'catalog_shiny_rare';

commit;

select count(*) as leftovers
from public.marketplace_leftover_art_layouts
where source = 'catalog_shiny_rare';
