-- Revert of 20261020_classic_deck_version_joins.sql: puts every moved card back on its old key,
-- restores the touched pokoin_version_sets rows and the deleted same_artwork illustrator rows.
-- Run on the nezopt writer only. Leaves the backup tables in place (drop them by hand).
begin;
set local lock_timeout = '5s';

do $$ begin
  if pg_is_in_recovery() then raise exception 'refusing to run on a replica'; end if;
end $$;

-- Illustrator rows the forward migration's refill wrote for touched cards.
delete from public.marketplace_blueprint_artists a
using public.marketplace_search_candidates c, public.version_artwork_join_20261020_sets t
where a.source = 'same_artwork' and c.ct_id = a.blueprint_id and c.version = t.version
  and a.matched_at >= (select min(applied_at) from public.version_artwork_join_20261020);

-- Restore the deleted copies before cards move back, so the version trigger cannot fill them first.
insert into public.marketplace_blueprint_artists
  (blueprint_id, ct_id, artist, illustrator, normalized_artist, source, source_card_id, source_url,
   confidence, match_reason, matched_at, raw_metadata, created_at, updated_at, artist_card_count)
select r.blueprint_id, r.ct_id, r.artist, r.illustrator, r.normalized_artist, r.source, r.source_card_id, r.source_url,
       r.confidence, r.match_reason, r.matched_at, r.raw_metadata, r.created_at, r.updated_at, r.artist_card_count
from public.version_artwork_join_20261020_artists b, jsonb_populate_record(null::public.marketplace_blueprint_artists, b.row) r
on conflict (blueprint_id) do nothing;

-- Old rows (they may have been deleted by a later clustering pass).
insert into public.pokoin_version_sets (version, gameplay_name, member_count, source, art_layout, art_layout_source)
select r.version, r.gameplay_name, r.member_count, r.source, r.art_layout, r.art_layout_source
from public.version_artwork_join_20261020_sets t, jsonb_populate_record(null::public.pokoin_version_sets, t.row) r
where t.existed
on conflict (version) do update
  set gameplay_name = excluded.gameplay_name, source = excluded.source,
      art_layout = excluded.art_layout, art_layout_source = excluded.art_layout_source, updated_at = now();

update public.marketplace_search_candidates c
set version = b.old_version
from public.version_artwork_join_20261020 b
where c.card_id = b.card_id and c.version = b.new_version;

update public.pokoin_version_sets s
set member_count = (select count(*) from public.marketplace_search_candidates c where c.version = s.version),
    updated_at = now()
where s.version in (select version from public.version_artwork_join_20261020_sets);

delete from public.pokoin_version_sets s
using public.version_artwork_join_20261020_sets t
where s.version = t.version and not t.existed
  and not exists (select 1 from public.marketplace_search_candidates c where c.version = s.version);

select public.marketplace_refresh_artwork_cluster_sort(array_agg(version)) from public.version_artwork_join_20261020_sets;
delete from public.marketplace_page_snapshots where kind = 'version' and key in (select version from public.version_artwork_join_20261020_sets);
commit;
