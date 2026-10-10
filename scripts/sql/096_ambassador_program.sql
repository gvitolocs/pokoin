-- 096: Pokoin Ambassador program (missions + City Ambassadors).
--
-- Ambassadors are no longer a copy of the distributor royalty deal: they
-- progress by completing missions (pokoin-rust/crates/accounts/src/domain/ambassador.rs).
-- "Bring 3 collectors" counts itself from rewarded Firestore referrals; every
-- other mission is a row here, added by the Pokoin team once verified.
-- marketplace_associates.city promotes a roster ambassador to City Ambassador.
--
-- Apply on the nezopt writer:
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace \
--     -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/096_ambassador_program.sql

alter table public.marketplace_associates
  add column if not exists city text not null default '';

create table if not exists public.marketplace_ambassador_contributions (
  id           bigserial primary key,
  email        text not null,
  mission      text not null check (mission in ('content', 'bug_report', 'seller_onboard', 'community_event', 'feedback')),
  note         text not null default '',
  link         text not null default '',
  verified_at  timestamptz not null default now(),
  verified_by  text not null default ''
);

create index if not exists marketplace_ambassador_contributions_email_idx
  on public.marketplace_ambassador_contributions (lower(email), verified_at desc);
