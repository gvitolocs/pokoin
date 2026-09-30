-- 095: Poko personal snapshot (cart / watchlist / desk) for linked channels.
--
-- Website chat syncs browser cart/watchlist/desk so Hermes can personalize
-- Telegram/Discord turns for the same Firebase uid. Recents, inventory, and
-- collection stay live reads — not stored here.
-- Apply on the nezopt writer:
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace \
--     -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/095_poko_personal_snapshot.sql

create table if not exists public.poko_user_personal_snapshot (
  firebase_uid text primary key,
  watchlist_card_ids bigint[] not null default '{}',
  cart_items jsonb not null default '[]'::jsonb,
  desk_card_id bigint,
  desk_card_name text,
  desk_set_name text,
  updated_at timestamptz not null default now()
);

create index if not exists poko_user_personal_snapshot_updated_idx
  on public.poko_user_personal_snapshot (updated_at desc);
