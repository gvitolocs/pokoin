-- 094: Poko Discord profile links.
--
-- Same shape as Telegram (092): one Pokoin Firebase account ↔ one Discord user.
-- Link codes stay in poko_telegram_link_codes (shared one-time codes from the
-- profile page); redeem from Discord consumes that same code.
-- Apply on the nezopt writer:
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace \
--     -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/094_poko_discord_links.sql

create table if not exists public.poko_discord_links (
  id                   bigserial primary key,
  firebase_uid         text not null unique,
  discord_user_id      text not null unique,
  discord_username     text not null default '',
  discord_display_name text not null default '',
  linked_at            timestamptz not null default now(),
  unlinked_at          timestamptz
);

create index if not exists poko_discord_links_unlinked_idx
  on public.poko_discord_links (unlinked_at) where unlinked_at is null;
