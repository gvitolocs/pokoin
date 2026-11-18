-- Expansions imported after the last nationality pass stayed `unknown`
-- (scripts/refresh-all-cardtrader-catalogues.cjs inserted them and never ran
-- the classifier; it does now). On 2026-11-07 that was 7 sets, among them the
-- JP leftovers 30th Celebration Premium Deck Set (mf, 44 cards), Aura Seeker
-- (m7) and MEGA x MEGA Parade (m7a), plus four CSV Chinese sets. Their Redis
-- documents carry effective_print_bucket=unknown, so a Japanese/Chinese print
-- filter never matches them and search flags them as unknown.
--
-- Run on the writer (nezopt :25433). Re-runnable. Bumping projected_at makes
-- the Pi's search-delta timer (every ~2 min, 10 min window) rewrite those Redis
-- documents with the new nationality; no full reindex or projection refresh.

begin;
set local statement_timeout = 0;

create temp table unknown_before on commit drop as
select name from public.pokoin_pokemon_expansions where nationality = 'unknown';

select public.pokoin_refresh_expansion_nationality() as expansions_updated;

update public.marketplace_search_candidates c
set projected_at = now()
from public.pokoin_pokemon_expansions e
join unknown_before b on b.name = e.name
where c.set_name = e.name
  and e.nationality <> 'unknown';

select e.code, e.name, e.nationality, e.milo_gallery
from public.pokoin_pokemon_expansions e
join unknown_before b on b.name = e.name
order by e.name;

commit;
