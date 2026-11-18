-- Targeted visual corrections, verified against the existing CDN masters.
-- Run on the nezopt writer only. The Pi follows replication.
-- Manaphy SWSH275 and JP 286/S-P share the NC Empire painting. The four
-- Shining Legends printings in v254856 have a different painting.
-- artbox-pin is protected by cluster-name-version-sets.protected_card_ids().
-- Espathra's older exact-number master has the original printed edges;
-- the short espathra-ex.jpg key has an added green matte and clips text.
begin;

do $$
begin
  if (select count(*) from public.marketplace_search_candidates
      where card_id in (473078, 477518) and name = 'Manaphy') <> 2 then
    raise exception 'Unexpected Manaphy identities';
  end if;
  if exists (select 1 from public.marketplace_search_candidates
             where version = 'v473078' and card_id not in (473078, 477518)) then
    raise exception 'Target version already contains other cards';
  end if;
  if not exists (select 1 from public.marketplace_search_candidates
                 where card_id = 548380 and ct_id = 274190 and name = 'Espathra ex') then
    raise exception 'Unexpected Espathra identity';
  end if;
end $$;

insert into public.pokoin_version_sets
  (version, gameplay_name, member_count, source, art_layout, art_layout_source)
values ('v473078', 'Manaphy', 0, 'artbox-pin', 'window', 'visual-verification')
on conflict (version) do update set source = 'artbox-pin', updated_at = now();

update public.marketplace_search_candidates
set version = 'v473078'
where card_id in (473078, 477518) and version is distinct from 'v473078';

update public.pokoin_version_sets s
set member_count = (select count(*) from public.marketplace_search_candidates c where c.version = s.version),
    updated_at = now()
where s.version in ('v473078', 'v254856', 'v477518');

update public.marketplace_card_versions
set image_url = 'https://cdn.pokoin.com/274190_espathra-ex-006-091-paldean-fates.jpg?v=esp-original-20261018',
    cdn_image_url = 'https://cdn.pokoin.com/274190_espathra-ex-006-091-paldean-fates.jpg?v=esp-original-20261018',
    preview_image_url = 'https://cdn.pokoin.com/274190_espathra-ex-006-091-paldean-fates.jpg?v=esp-original-20261018',
    homepage_image_url = 'https://cdn.pokoin.com/274190_espathra-ex-006-091-paldean-fates_homepage.webp?v=esp-original-20261018'
where card_id = 548380 and ct_id = 274190;

update public.marketplace_search_candidates
set image_url = 'https://cdn.pokoin.com/274190_espathra-ex-006-091-paldean-fates.jpg?v=esp-original-20261018',
    cdn_image_url = 'https://cdn.pokoin.com/274190_espathra-ex-006-091-paldean-fates.jpg?v=esp-original-20261018'
where card_id = 548380 and ct_id = 274190;

select public.marketplace_refresh_artwork_cluster_sort(array['v473078', 'v254856', 'v477518']);
commit;
