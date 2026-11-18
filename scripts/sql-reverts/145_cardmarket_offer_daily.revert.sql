-- Written with the migration (PH-R040, 2026-11-18); never run on production, at most on a throwaway copy.
-- reverts: scripts/sql/145_cardmarket_offer_daily.sql
-- db: writer
-- destructive: drops the table public.cardmarket_offer_daily with its primary key and its day
-- index. Nothing reads it yet — the endpoint leg (report §6 W5) and the graph line (W6) are
-- later work — and the collector's daily-minimums files stay on disk, so the whole series can be
-- re-loaded with `pokoin-cardmarket-catalog cm-daily --file … --apply` after a mistaken run.

-- Reverting stops the daily per-condition feed: `cm-daily` then refuses to load, because its table
-- is missing, and prints the name of this migration.

begin;
set local lock_timeout = '3s';

do $$ begin
  if pg_is_in_recovery() then raise exception 'refusing to run on a replica'; end if;
end $$;

-- The day index and the primary key are owned by the table, so this drops all three.
drop table if exists public.cardmarket_offer_daily;

commit;
