-- The compressed formats of marketplace_list_snapshots (migration 112), which
-- `pokoin-api job build-lists` added with `alter table … add column if not
-- exists` on every run until 2026-10-15. That takes an access-exclusive lock
-- even when the columns exist, and the Pi standby replays it; the job's role
-- has no DDL rights now (migration 124).
--
--   c1v2      c1 format 2 (template columns)
--   br_*      brotli-11 copies served as-is
--   dcb_c1v2  RFC 9842 dcb of c1v2 against the shared dictionary `dcb_dict` (its id)
--
-- Apply on the nezopt writer to EVERY game database (pokoin_marketplace and
-- each pokoin_<game>), after 112 and 114, as pokoin_migrator. Idempotent.
alter table public.marketplace_list_snapshots
  add column if not exists c1v2 bytea,
  add column if not exists br_json bytea,
  add column if not exists br_c1 bytea,
  add column if not exists br_c1v2 bytea,
  add column if not exists dcb_c1v2 bytea,
  add column if not exists dcb_dict text;
