-- 092: Poko Telegram profile links.
--
-- Lets a signed-in Pokoin account link its profile to a Telegram user so the
-- Poko assistant (website chat, Telegram, YouTube) can recognize the person.
-- Raw link codes are never stored — only their SHA-256 hashes, short-lived.
-- Apply on the nezopt writer:
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace \
--     -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/092_poko_telegram_links.sql

create table if not exists public.poko_telegram_link_codes (
  code_hash   text primary key,
  firebase_uid text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  redeemed_at timestamptz
);

create index if not exists poko_telegram_link_codes_uid_idx
  on public.poko_telegram_link_codes (firebase_uid);

create table if not exists public.poko_telegram_links (
  id                    bigserial primary key,
  firebase_uid          text not null unique,
  telegram_user_id      text not null unique,
  telegram_username     text not null default '',
  telegram_display_name text not null default '',
  linked_at             timestamptz not null default now(),
  unlinked_at           timestamptz
);

create index if not exists poko_telegram_links_unlinked_idx
  on public.poko_telegram_links (unlinked_at) where unlinked_at is null;
