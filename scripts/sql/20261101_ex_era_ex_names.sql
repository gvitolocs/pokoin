-- JP EX-era (ADV / PCG, 2003-2007) and EX-era promo printings that CardTrader named
-- with an uppercase " EX" suffix, although they are Pokémon-ex (EX-era mechanic).
-- cluster-name-version-sets name_key keeps XY/BW-era "EX" apart from EX-era / SV-era
-- "ex", so e.g. Undone Seal 039/083 "Kyogre EX" (288246) could never join the same
-- Hikaru Koike painting EX Hidden Legends 94/101 "Kyogre ex" (232734).
-- Same shape as 069 (WCD XY EX named "ex"), reversed. Eras per tcgEra() / TCG_ERAS.md:
-- every set below classifies as "EX" (ADV, PCG, EX EN, POP Series 1-4).
--
-- Renames name = '<X> EX' -> '<X> ex' in the projection tables, guarded by the old
-- name so re-runs are no-ops. The old spelling stays findable as a nickname (bound to
-- the printing's set + number). It does NOT touch pokoin_version_sets or the `version`
-- column: re-cluster (cluster-name-version-sets.py) afterwards to merge buckets.
-- search_text is already lower-cased ("kyogre ex undone seal ...") so it does not change.
-- Not renamed: delta-species names ("Latias EX δ Delta Species" already folds to the
-- same name_key as "ex δ"), XY/BW/SM/SV/Mega-era sets, products, trainers.
--
-- 86 printings renamed, per set (card_ids):
-- ADV Expansion Pack (1): 276040
-- Clash of the Blue Sky (6): 272744, 272824, 272826, 272832, 272862, 272878
-- EX Deoxys (3): 230640, 230642, 230644
-- EX Emerald (1): 231840
-- EX Hidden Legends (1): 232748
-- Flight of Legends (5): 276666, 276668, 276682, 276692, 276728
-- Golden Sky, Silvery Ocean (9): 278212, 278226, 278254, 278350, 278352, 278354, 278358, 278362,
--   278364
-- Magma VS Aqua: Two Ambitions (7): 280016, 280022, 280040, 280056, 280058, 280100, 280104
-- Miracle Crystal (7): 280382, 280418, 280426, 280450, 280454, 280458, 280468
-- Miracle of the Desert (5): 280744, 280760, 280764, 280774, 280810
-- Mirage Forest (6): 280844, 280856, 280882, 280940, 280956, 280960
-- POP Series 1 (3): 248560, 248556, 248558
-- POP Series 2 (2): 248608, 248606
-- POP Series 3 (2): 248656, 248654
-- POP Series 4 (1): 248704
-- Rocket Gang Strikes Back (9): 283996, 283998, 284000, 284002, 284004, 284008, 284010, 284012,
--   284014
-- Rulers of the Heavens (4): 284076, 284096, 284122, 284140
-- Undone Seal (8): 288178, 288204, 288244, 288246, 288278, 288280, 288284, 288312
-- World Champions Pack (6): 288866, 288896, 288934, 288944, 288972, 288984
--
-- Follow-up for the re-cluster: STAMP_EX_PINS pins 824970 (30th Celebration JP 145/103,
-- still "Scizor EX") with 278364 (Golden Sky, Silvery Ocean, renamed here to "Scizor ex").
-- The pin still holds; its label "Scizor EX" can become "Scizor ex".

set statement_timeout = 0;

create temp table ex_era_ex_rename (
  card_id  bigint primary key,
  ct_id    bigint not null,
  old_name text   not null,
  new_name text   not null
);

insert into ex_era_ex_rename (card_id, ct_id, old_name, new_name) values
  (276040, 138020, 'Chansey EX', 'Chansey ex'), -- ADV Expansion Pack 036/055
  (272744, 136372, 'Crobat EX', 'Crobat ex'), -- Clash of the Blue Sky 005/082
  (272824, 136412, 'Deoxys EX', 'Deoxys ex'), -- Clash of the Blue Sky 045/082
  (272826, 136413, 'Deoxys EX', 'Deoxys ex'), -- Clash of the Blue Sky 046/082
  (272832, 136416, 'Hariyama EX', 'Hariyama ex'), -- Clash of the Blue Sky 049/082
  (272862, 136431, 'Salamence EX', 'Salamence ex'), -- Clash of the Blue Sky 064/082
  (272878, 136439, 'Sharpedo EX', 'Sharpedo ex'), -- Clash of the Blue Sky 072/082
  (230640, 115320, 'Deoxys EX', 'Deoxys ex'), -- EX Deoxys 97/107
  (230642, 115321, 'Deoxys EX', 'Deoxys ex'), -- EX Deoxys 98/107
  (230644, 115322, 'Deoxys EX', 'Deoxys ex'), -- EX Deoxys 99/107
  (231840, 115920, 'Deoxys EX', 'Deoxys ex'), -- EX Emerald 93/106
  (232748, 116374, 'Wigglytuff EX', 'Wigglytuff ex'), -- EX Hidden Legends 101/101
  (276666, 138333, 'Gyarados EX', 'Gyarados ex'), -- Flight of Legends 035/082
  (276668, 138334, 'Articuno EX', 'Articuno ex'), -- Flight of Legends 036/082
  (276682, 138341, 'Zapdos EX', 'Zapdos ex'), -- Flight of Legends 043/082
  (276692, 138346, 'Gengar EX', 'Gengar ex'), -- Flight of Legends 048/082
  (276728, 138364, 'Clefable EX', 'Clefable ex'), -- Flight of Legends 066/082
  (278212, 139106, 'Ho-Oh EX', 'Ho-Oh ex'), -- Golden Sky, Silvery Ocean 20/106
  (278226, 139113, 'Politoed EX', 'Politoed ex'), -- Golden Sky, Silvery Ocean 27/106
  (278254, 139127, 'Espeon EX', 'Espeon ex'), -- Golden Sky, Silvery Ocean 41/106
  (278350, 139175, 'Blissey EX', 'Blissey ex'), -- Golden Sky, Silvery Ocean 89/106
  (278352, 139176, 'Lugia EX', 'Lugia ex'), -- Golden Sky, Silvery Ocean 90/106
  (278354, 139177, 'Umbreon EX', 'Umbreon ex'), -- Golden Sky, Silvery Ocean 91/106
  (278358, 139179, 'Tyranitar EX', 'Tyranitar ex'), -- Golden Sky, Silvery Ocean 93/106
  (278362, 139181, 'Steelix EX', 'Steelix ex'), -- Golden Sky, Silvery Ocean 95/106
  (278364, 139182, 'Scizor EX', 'Scizor ex'), -- Golden Sky, Silvery Ocean 96/106
  (280016, 140008, 'Sceptile EX', 'Sceptile ex'), -- Magma VS Aqua: Two Ambitions 006/080
  (280022, 140011, 'Cradily EX', 'Cradily ex'), -- Magma VS Aqua: Two Ambitions 009/080
  (280040, 140020, 'Blaziken EX', 'Blaziken ex'), -- Magma VS Aqua: Two Ambitions 018/080
  (280056, 140028, 'Kabutops EX', 'Kabutops ex'), -- Magma VS Aqua: Two Ambitions 026/080
  (280058, 140029, 'Suicune EX', 'Suicune ex'), -- Magma VS Aqua: Two Ambitions 027/080
  (280100, 140050, 'Golem EX', 'Golem ex'), -- Magma VS Aqua: Two Ambitions 048/080
  (280104, 140052, 'Swampert EX', 'Swampert ex'), -- Magma VS Aqua: Two Ambitions 050/080
  (280382, 140191, 'Swampert EX', 'Swampert ex'), -- Miracle Crystal 023/075
  (280418, 140209, 'Jirachi EX', 'Jirachi ex'), -- Miracle Crystal 041/075
  (280426, 140213, 'Blaziken EX', 'Blaziken ex'), -- Miracle Crystal 045/075
  (280450, 140225, 'Exploud EX', 'Exploud ex'), -- Miracle Crystal 057/075
  (280454, 140227, 'Delcatty EX', 'Delcatty ex'), -- Miracle Crystal 059/075
  (280458, 140229, 'Shiftry EX', 'Shiftry ex'), -- Miracle Crystal 061/075
  (280468, 140234, 'Aggron EX', 'Aggron ex'), -- Miracle Crystal 066/075
  (280744, 140372, 'Typhlosion EX', 'Typhlosion ex'), -- Miracle of the Desert 13/053
  (280760, 140380, 'Wailord EX', 'Wailord ex'), -- Miracle of the Desert 21/053
  (280764, 140382, 'Raichu EX', 'Raichu ex'), -- Miracle of the Desert 23/053
  (280774, 140387, 'Gardevoir EX', 'Gardevoir ex'), -- Miracle of the Desert 28/053
  (280810, 140405, 'Aggron EX', 'Aggron ex'), -- Miracle of the Desert 46/053
  (280844, 140422, 'Dustox EX', 'Dustox ex'), -- Mirage Forest 10/086
  (280856, 140428, 'Arcanine EX', 'Arcanine ex'), -- Mirage Forest 16/086
  (280882, 140441, 'Walrein EX', 'Walrein ex'), -- Mirage Forest 29/086
  (280940, 140470, 'Armaldo EX', 'Armaldo ex'), -- Mirage Forest 58/086
  (280956, 140478, 'Flygon EX', 'Flygon ex'), -- Mirage Forest 66/086
  (280960, 140480, 'Altaria EX', 'Altaria ex'), -- Mirage Forest 68/086
  (248560, 124280, 'Tyranitar EX', 'Tyranitar ex'), -- POP Series 1 17/17
  (248556, 124278, 'Armaldo EX', 'Armaldo ex'), -- POP Series 1 16/17
  (248558, 124279, 'Tyranitar EX', 'Tyranitar ex'), -- POP Series 1 17/17
  (248608, 124304, 'Celebi EX', 'Celebi ex'), -- POP Series 2 17/17
  (248606, 124303, 'Celebi EX', 'Celebi ex'), -- POP Series 2 17/17
  (248656, 124328, 'Ho-Oh EX', 'Ho-Oh ex'), -- POP Series 3 17/17
  (248654, 124327, 'Ho-Oh EX', 'Ho-Oh ex'), -- POP Series 3 17/17
  (248704, 124352, 'Deoxys EX', 'Deoxys ex'), -- POP Series 4 17/17
  (283996, 141998, 'Rocket''s Hitmonchan EX', 'Rocket''s Hitmonchan ex'), -- Rocket Gang Strikes Back 060/084
  (283998, 141999, 'Rocket''s Scyther EX', 'Rocket''s Scyther ex'), -- Rocket Gang Strikes Back 061/084
  (284000, 142000, 'Rocket''s Snorlax EX', 'Rocket''s Snorlax ex'), -- Rocket Gang Strikes Back 062/084
  (284002, 142001, 'Rocket''s Zapdos EX', 'Rocket''s Zapdos ex'), -- Rocket Gang Strikes Back 063/084
  (284004, 142002, 'Rocket''s Mewtwo EX', 'Rocket''s Mewtwo ex'), -- Rocket Gang Strikes Back 064/084
  (284008, 142004, 'Rocket''s Scizor EX', 'Rocket''s Scizor ex'), -- Rocket Gang Strikes Back 066/084
  (284010, 142005, 'Rocket''s Sneasel EX', 'Rocket''s Sneasel ex'), -- Rocket Gang Strikes Back 067/084
  (284012, 142006, 'Rocket''s Entei EX', 'Rocket''s Entei ex'), -- Rocket Gang Strikes Back 068/084
  (284014, 142007, 'Rocket''s Suicune EX', 'Rocket''s Suicune ex'), -- Rocket Gang Strikes Back 069/084
  (284076, 142038, 'Kingdra EX', 'Kingdra ex'), -- Rulers of the Heavens 15/054
  (284096, 142048, 'Ampharos EX', 'Ampharos ex'), -- Rulers of the Heavens 25/054
  (284122, 142061, 'Dragonite EX', 'Dragonite ex'), -- Rulers of the Heavens 38/054
  (284140, 142070, 'Rayquaza EX', 'Rayquaza ex'), -- Rulers of the Heavens 47/054
  (288178, 144089, 'Vileplume EX', 'Vileplume ex'), -- Undone Seal 005/083
  (288204, 144102, 'Ninetales EX', 'Ninetales ex'), -- Undone Seal 018/083
  (288244, 144122, 'Regice EX', 'Regice ex'), -- Undone Seal 038/083
  (288246, 144123, 'Kyogre EX', 'Kyogre ex'), -- Undone Seal 039/083
  (288278, 144139, 'Regirock EX', 'Regirock ex'), -- Undone Seal 055/083
  (288280, 144140, 'Groudon EX', 'Groudon ex'), -- Undone Seal 056/083
  (288284, 144142, 'Wigglytuff EX', 'Wigglytuff ex'), -- Undone Seal 058/083
  (288312, 144156, 'Registeel EX', 'Registeel ex'), -- Undone Seal 072/083
  (288866, 144433, 'Walrein EX', 'Walrein ex'), -- World Champions Pack 022/108
  (288896, 144448, 'Claydol EX', 'Claydol ex'), -- World Champions Pack 037/108
  (288934, 144467, 'Shiftry EX', 'Shiftry ex'), -- World Champions Pack 056/108
  (288944, 144472, 'Skarmory EX', 'Skarmory ex'), -- World Champions Pack 061/108
  (288972, 144486, 'Flygon EX', 'Flygon ex'), -- World Champions Pack 075/108
  (288984, 144492, 'Salamence EX', 'Salamence ex'); -- World Champions Pack 081/108

update public.pokoin_pokemon_blueprints b
   set name = r.new_name
  from ex_era_ex_rename r
 where b.id = r.ct_id
   and b.name = r.old_name;

update public.marketplace_cards c
   set name = r.new_name,
       projected_at = now()
  from ex_era_ex_rename r
 where c.card_id = r.card_id
   and c.name = r.old_name;

update public.marketplace_card_versions v
   set name = r.new_name,
       projected_at = now()
  from ex_era_ex_rename r
 where v.card_id = r.card_id
   and v.name = r.old_name;

update public.marketplace_search_candidates c
   set name = r.new_name,
       projected_at = now()
  from ex_era_ex_rename r
 where c.card_id = r.card_id
   and c.name = r.old_name;

update public.marketplace_card_urls u
   set name = r.new_name
  from ex_era_ex_rename r
 where u.card_id = r.card_id
   and u.name = r.old_name;

update public.marketplace_hot_blueprints h
   set name = r.new_name
  from ex_era_ex_rename r
 where h.blueprint_id = r.ct_id
   and h.name = r.old_name;

-- New names normally exist already (SV-era "ex"); add any that do not.
insert into public.marketplace_card_names (
  name, normalized_name, compact_name, emoji, name_tokens, updated_at
)
select
  n.new_name,
  public.marketplace_search_normalize(n.new_name),
  public.marketplace_search_compact(n.new_name),
  coalesce(public.marketplace_card_name_emoji(n.new_name), ''),
  public.marketplace_search_tokenize(n.new_name),
  now()
from (select distinct new_name from ex_era_ex_rename) n
on conflict (name) do update set updated_at = now();

-- Sort / language tables key on the name; copy the uppercase row when "ex" is missing.
insert into public.pokoin_pokedex_name_sort (name, pokedex_num)
select distinct r.new_name, s.pokedex_num
  from ex_era_ex_rename r
  join public.pokoin_pokedex_name_sort s on s.name = r.old_name
on conflict (name) do nothing;

insert into public.card_name_languages (name, language, localized_name, source, source_id, updated_at)
select distinct r.new_name, l.language, l.localized_name, l.source, l.source_id, now()
  from ex_era_ex_rename r
  join public.card_name_languages l on l.name = r.old_name
on conflict (name, language) do nothing;

-- Old CT spelling stays findable, bound to its printing.
insert into public.marketplace_card_nicknames (
  nickname, normalized_nickname, compact_nickname, card_name,
  expansion_name, card_number, source, updated_at
)
select
  r.old_name,
  public.marketplace_search_normalize(r.old_name),
  public.marketplace_search_compact(r.old_name),
  r.new_name,
  c.set_name,
  regexp_replace(c.card_number, '^.*\| *', ''),
  'ex_era_uppercase_ex',
  now()
from ex_era_ex_rename r
join public.marketplace_search_candidates c on c.card_id = r.card_id
where c.name = r.new_name
  and exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'marketplace_card_nicknames'
  )
on conflict do nothing;

select c.set_name, count(*) filter (where c.name ~ ' ex$') as now_ex,
       count(*) filter (where c.name ~ ' EX$') as still_big_ex
  from ex_era_ex_rename r
  join public.marketplace_search_candidates c on c.card_id = r.card_id
 group by c.set_name
 order by c.set_name;

drop table ex_era_ex_rename;
