-- "Fight Gong" 059/063 is the JP Mega Brave printing of Fighting Gong, the
-- 2025 Mega-era parallel-set trainer. CardTrader named the JP print "Fight
-- Gong", so CLIP kept it a singleton (v689398) even though the illustration is
-- the same painting as Fighting Gong v703278. Scanning the EN card put the JP
-- twin within the 0.08 between-artworks margin, so resolvePrintings refused to
-- decide and the scan landed on the desk as "Check match" instead of the phone
-- printing picker (2026-10-04 desk session).
-- Rename both JP Mega Brave prints to the official English name (D00001T) and
-- pin the regular print into the Fighting Gong artwork group. The Ultra Rares
-- (689444 JP, 703352 EN) stay their own full-art groups.
-- Public card_id = CT blueprint × 2: 344699 → 689398, 344722 → 689444.

set statement_timeout = 0;

update public.pokoin_pokemon_blueprints
   set name = 'Fighting Gong'
 where id in (344699, 344722)
   and name = 'Fight Gong';

update public.marketplace_cards
   set name = 'Fighting Gong',
       projected_at = now()
 where card_id in (689398, 689444)
   and name = 'Fight Gong';

update public.marketplace_card_versions
   set name = 'Fighting Gong',
       projected_at = now()
 where card_id in (689398, 689444)
   and name = 'Fight Gong';

update public.marketplace_search_candidates
   set name = 'Fighting Gong',
       search_text = case card_id
         when 689398 then 'fighting gong fight gong mega brave 059/063  card trading card single card'
         when 689444 then 'fighting gong fight gong mega brave ultra rare | 082/063  card trading card single card'
       end,
       projected_at = now()
 where card_id in (689398, 689444)
   and name = 'Fight Gong';

insert into public.marketplace_card_names (
  name, normalized_name, compact_name, emoji, name_tokens, updated_at
)
select
  'Fighting Gong',
  public.marketplace_search_normalize('Fighting Gong'),
  public.marketplace_search_compact('Fighting Gong'),
  coalesce(public.marketplace_card_name_emoji('Fighting Gong'), ''),
  public.marketplace_search_tokenize('Fighting Gong'),
  now()
on conflict (name) do update set updated_at = now();

-- Old CT title stays findable.
insert into public.marketplace_card_nicknames (
  nickname, normalized_nickname, compact_nickname, card_name, source, updated_at
)
select
  'Fight Gong',
  public.marketplace_search_normalize('Fight Gong'),
  public.marketplace_search_compact('Fight Gong'),
  'Fighting Gong',
  'jp_english_title',
  now()
where exists (
  select 1 from information_schema.tables
  where table_schema = 'public' and table_name = 'marketplace_card_nicknames'
)
on conflict do nothing;

-- Artwork pin: the JP regular print joins the Fighting Gong group.
insert into public.pokoin_version_sets (version, gameplay_name, member_count, source)
values ('v703278', 'Fighting Gong', 7, 'clip+artbox-pin')
on conflict (version) do update
  set gameplay_name = excluded.gameplay_name,
      member_count = excluded.member_count,
      source = excluded.source,
      updated_at = now();

update public.marketplace_search_candidates
   set version = 'v703278',
       projected_at = now()
 where card_id = 689398
   and version = 'v689398';

delete from public.pokoin_version_sets s
 where s.version = 'v689398'
   and not exists (
     select 1 from public.marketplace_search_candidates c where c.version = s.version
   );

-- Optional sort refresh when the helper exists.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'marketplace_refresh_artwork_cluster_sort'
  ) then
    perform public.marketplace_refresh_artwork_cluster_sort(
      array[689398, 703278, 718450, 728640, 741650, 782130, 782132]::bigint[]
    );
  end if;
end $$;

select c.card_id, c.name, c.set_name, c.card_number, c.version,
       s.gameplay_name, s.member_count, s.source
  from public.marketplace_search_candidates c
  left join public.pokoin_version_sets s on s.version = c.version
 where c.card_id in (689398, 703278, 718450, 728640, 741650, 782130, 782132)
 order by c.card_id;
