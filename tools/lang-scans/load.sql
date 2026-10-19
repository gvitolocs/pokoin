-- Load tools/lang-scans mapping.tsv (ct_id, language, scan_path) into
-- public.marketplace_leftover_lang_scans (scripts/sql/127). Replaces the
-- tcgdex rows in one transaction: new pairs are added, changed paths updated,
-- pairs the tool no longer emits removed.
--   psql -v ON_ERROR_STOP=1 -d pokoin_marketplace -f load.sql < mapping.tsv
begin;
create temp table lang_scans_in (ct_id bigint, language text, scan_path text) on commit drop;
\copy lang_scans_in from pstdin
insert into public.marketplace_leftover_lang_scans as t (ct_id, language, scan_path, source)
select ct_id, language, scan_path, 'tcgdex' from lang_scans_in
on conflict (ct_id, language) do update
  set scan_path = excluded.scan_path, loaded_at = now()
  where t.scan_path is distinct from excluded.scan_path;
delete from public.marketplace_leftover_lang_scans t
where t.source = 'tcgdex'
  and not exists (select 1 from lang_scans_in i where i.ct_id = t.ct_id and i.language = t.language);
select language, count(*) from public.marketplace_leftover_lang_scans group by language order by language;
commit;
