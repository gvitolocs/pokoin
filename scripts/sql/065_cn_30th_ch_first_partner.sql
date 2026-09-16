-- CardTrader `30th-ch` is the Simplified Chinese 30th Anniversary
-- Celebration: First Partner Illustration Collection. The classifier already
-- pinned `30thc` (30th Celebration Simplified Chinese) but not `30th-ch`.
-- 31 blueprints, zero pokemon_language votes → western EUUS flag on CN scans.
-- English First Partner Pack (`1stpp`) stays western. Do not regex
-- "first partner" in the SPA.

begin;
set local statement_timeout = 0;

update public.pokoin_pokemon_expansions
set nationality = 'chinese',
    milo_gallery = public.pokoin_expansion_milo_gallery('chinese', kind),
    updated_at = now()
where lower(code) = '30th-ch'
   or lower(name) = '30th anniversary celebration: first partner illustration collection';

select public.pokoin_refresh_expansion_nationality() as expansions_updated;

commit;

select code, name, nationality, milo_gallery, kind, listed
from public.pokoin_pokemon_expansions
where lower(code) = '30th-ch'
   or lower(name) = '30th anniversary celebration: first partner illustration collection';
