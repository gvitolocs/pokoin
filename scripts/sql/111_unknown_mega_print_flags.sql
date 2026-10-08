-- Catalog rows still stored nationality=unknown, so the set desk and the
-- sets index paint no print flag.
--
-- Japanese leftovers:
--   30th Celebration Premium Deck Set (44 JP scans, 30th CELEBRATION deck)
--   Aura Seeker (Mega Lucario Z, 27 Nov 2026)
--   MEGA x MEGA Parade (JP High Class Pack)
-- Simplified Chinese, same family as CSV9: Master Ball Reverse:
--   CSV9.5: Master Ball Reverse
--
-- Product buckets (Pokémon Center, * Products) stay product and stay flagless.
-- Exact names only. Do not regex "premium" or "parade".

begin;
set local statement_timeout = 0;

update public.pokoin_pokemon_expansions
set nationality = 'japanese',
    milo_gallery = public.pokoin_expansion_milo_gallery('japanese', kind),
    updated_at = now()
where lower(name) in (
  '30th celebration premium deck set',
  'aura seeker',
  'mega x mega parade'
)
  and coalesce(nationality, '') in ('', 'unknown');

update public.pokoin_pokemon_expansions
set nationality = 'chinese',
    milo_gallery = public.pokoin_expansion_milo_gallery('chinese', kind),
    updated_at = now()
where lower(name) = 'csv9.5: master ball reverse'
  and coalesce(nationality, '') in ('', 'unknown');

commit;

select name, nationality, milo_gallery
from public.pokoin_pokemon_expansions
where lower(name) in (
  '30th celebration premium deck set',
  'aura seeker',
  'mega x mega parade',
  'csv9.5: master ball reverse'
);
