-- Abyss Eye 079/081 is the JP printing of Pitch Black Fossil Quarry 076/084.
-- CardTrader left the JP title as "Fossil Excavation Site"; English name everywhere
-- is Fossil Quarry (D00001T). CLIP never joined them — pin as same artwork so
-- Scan Desk EN remaps to western Pitch Black art.
-- Public card_id = CT blueprint × 2: 391469 → 782938, 399422 → 798844.

set statement_timeout = 0;

update public.pokoin_pokemon_blueprints
   set name = 'Fossil Quarry'
 where id = 391469
   and name = 'Fossil Excavation Site';

update public.marketplace_cards
   set name = 'Fossil Quarry',
       projected_at = now()
 where card_id = 782938
   and name = 'Fossil Excavation Site';

update public.marketplace_card_versions
   set name = 'Fossil Quarry',
       projected_at = now()
 where card_id = 782938
   and name = 'Fossil Excavation Site';

update public.marketplace_search_candidates
   set name = 'Fossil Quarry',
       search_text = 'fossil quarry abyss eye 079/081  card trading card single card',
       projected_at = now()
 where card_id = 782938
   and name = 'Fossil Excavation Site';

insert into public.marketplace_card_names (
  name, normalized_name, compact_name, emoji, name_tokens, updated_at
)
select
  'Fossil Quarry',
  public.marketplace_search_normalize('Fossil Quarry'),
  public.marketplace_search_compact('Fossil Quarry'),
  coalesce(public.marketplace_card_name_emoji('Fossil Quarry'), ''),
  public.marketplace_search_tokenize('Fossil Quarry'),
  now()
on conflict (name) do update set updated_at = now();

-- Old CT title stays findable.
insert into public.marketplace_card_nicknames (
  nickname, normalized_nickname, compact_nickname, card_name, source, updated_at
)
select
  'Fossil Excavation Site',
  public.marketplace_search_normalize('Fossil Excavation Site'),
  public.marketplace_search_compact('Fossil Excavation Site'),
  'Fossil Quarry',
  'jp_english_title',
  now()
where exists (
  select 1 from information_schema.tables
  where table_schema = 'public' and table_name = 'marketplace_card_nicknames'
)
on conflict do nothing;

insert into public.pokoin_version_sets (version, gameplay_name, member_count, source)
values ('v798844', 'Fossil Quarry', 2, 'artbox-pin')
on conflict (version) do update
  set gameplay_name = excluded.gameplay_name,
      member_count = excluded.member_count,
      source = excluded.source,
      updated_at = now();

update public.marketplace_search_candidates
   set version = 'v798844',
       projected_at = now()
 where card_id in (782938, 798844);

delete from public.pokoin_version_sets s
 where s.version = 'v782938'
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
    perform public.marketplace_refresh_artwork_cluster_sort(array[782938, 798844]::bigint[]);
  end if;
end $$;

select c.card_id, c.name, c.set_name, c.card_number, c.version,
       s.gameplay_name, s.member_count, s.source
  from public.marketplace_search_candidates c
  left join public.pokoin_version_sets s on s.version = c.version
 where c.card_id in (782938, 798844)
 order by c.card_id;
