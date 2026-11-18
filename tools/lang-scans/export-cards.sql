-- Western leftover printings for lang-scans (docs/CARD_LANGUAGE_SCANS.md).
-- Read-only; run against pokoin_marketplace with psql -A -F '\t'.
select c.ct_id, e.nationality, e.official_id, e.official_source, c.name, c.card_number, c.image_url, c.set_name
from public.marketplace_search_candidates c
join public.pokoin_pokemon_expansions e on e.name = c.set_name
where c.ct_id is not null
  and c.product_type = 'card'
  and e.nationality in ('western', 'american')
  and e.official_id <> ''
order by c.ct_id;
