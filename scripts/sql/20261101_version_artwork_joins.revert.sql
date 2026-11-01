-- Revert of 20261101_version_artwork_joins.sql: puts every moved card back on its old key,
-- restores the touched pokoin_version_sets rows and removes the same_artwork illustrator copies
-- the version trigger wrote while the joins were applied. Run on the nezopt writer only.
-- Leaves the backup tables in place (drop them by hand).
begin;
set local lock_timeout = '5s';

do $$ begin
  if pg_is_in_recovery() then raise exception 'refusing to run on a replica'; end if;
end $$;

-- Copies the trigger wrote for cards in touched groups during the apply (23:35:44-23:35:52 UTC).
delete from public.marketplace_blueprint_artists a
using public.marketplace_search_candidates c, public.version_artwork_join_20261101_sets t
where a.source = 'same_artwork' and c.ct_id = a.blueprint_id and c.version = t.version
  and a.matched_at >= (select min(applied_at) from public.version_artwork_join_20261101)
  and a.matched_at < '2026-10-31 23:36:00+00';

insert into public.pokoin_version_sets (version, gameplay_name, member_count, source, art_layout, art_layout_source)
select version, gameplay_name, member_count, source, art_layout, art_layout_source
from public.version_artwork_join_20261101_sets
where existed
on conflict (version) do update
  set gameplay_name = excluded.gameplay_name, source = excluded.source,
      art_layout = excluded.art_layout, art_layout_source = excluded.art_layout_source, updated_at = now();

update public.marketplace_search_candidates c
set version = b.old_version
from public.version_artwork_join_20261101 b
where c.card_id = b.card_id and c.version = b.new_version;

update public.pokoin_version_sets s
set member_count = (select count(*) from public.marketplace_search_candidates c where c.version = s.version),
    updated_at = now()
where s.version in (select version from public.version_artwork_join_20261101_sets);

delete from public.pokoin_version_sets s
using public.version_artwork_join_20261101_sets t
where s.version = t.version and not t.existed
  and not exists (select 1 from public.marketplace_search_candidates c where c.version = s.version);

select public.marketplace_refresh_artwork_cluster_sort(array_agg(version)) from public.version_artwork_join_20261101_sets;
delete from public.marketplace_page_snapshots where kind = 'version' and key in (select version from public.version_artwork_join_20261101_sets);
commit;
