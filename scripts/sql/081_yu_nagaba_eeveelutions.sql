-- Yu NAGABA x Pokemon Card Game promos are all Yu Nagaba line art, and every
-- artist fill pipeline skips them: TCGdex has no svp entries for 062-070,
-- GPU OCR needs printed English "Illus.", and pkmncards lists English
-- printings only. Stamp the whole campaign from the expansion itself:
-- Pikachu 208/S-P (2021 Pokemon Center campaign) plus the nine Eeveelutions
-- 062-070/SV-P (Eeveelution Special Box). The two Special Box rows are
-- sealed products, not singles, so they stay unsigned.
-- https://bulbapedia.bulbagarden.net/wiki/Pikachu_(S-P_Promo_208)

begin;
set local statement_timeout = 0;

alter table marketplace_blueprint_artists
  disable trigger marketplace_blueprint_artists_copy_same_art;

insert into marketplace_blueprint_artists (
  blueprint_id, ct_id, artist, illustrator, normalized_artist,
  source, source_card_id, source_url, confidence, match_reason, raw_metadata
)
select
  c.ct_id, c.ct_id, 'Yu Nagaba', 'Yu Nagaba', 'yu nagaba',
  'catalog', c.ct_id::text,
  'https://bulbapedia.bulbagarden.net/wiki/Pikachu_(S-P_Promo_208)',
  0.99, 'nagaba_campaign_expansion',
  jsonb_build_object(
    'note', 'Yu NAGABA x Pokemon Card Game campaign; every promo in the expansion is Nagaba line art.',
    'card_number', c.card_number
  )
from marketplace_search_candidates c
left join marketplace_blueprint_artists a on a.blueprint_id = c.ct_id
where c.set_name = 'YU NAGABA x Pokemon Card Game'
  and c.item_kind = 'single'
  and coalesce(c.product_type, 'card') in ('card', '')
  and a.blueprint_id is null
on conflict (blueprint_id) do nothing;

alter table marketplace_blueprint_artists
  enable trigger marketplace_blueprint_artists_copy_same_art;

select public.marketplace_copy_same_art_artists() as same_art_copied;
select public.refresh_marketplace_artist_card_counts() as artist_counts_refreshed;

commit;

select c.card_number, c.name, a.artist, a.source
from marketplace_search_candidates c
join marketplace_blueprint_artists a on a.card_id = c.card_id
where c.set_name = 'YU NAGABA x Pokemon Card Game'
order by c.card_number;
