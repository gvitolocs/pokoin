-- Signed-in recently seen. Writes go to nezopt 15T; Pi replica streams.
-- Browser keeps only 24 public ids for first paint. Tile JSON is not stored.

set statement_timeout = 0;

create table if not exists public.marketplace_user_recents (
  user_uid text primary key,
  card_ids bigint[] not null default '{}'::bigint[],
  updated_at timestamptz not null default now()
);

create index if not exists marketplace_user_recents_updated_idx
  on public.marketplace_user_recents (updated_at desc);
