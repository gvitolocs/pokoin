-- 138: MyPokoin pricing groups (2026-11-04).
--
-- A seller picks listings into a named group; each group is priced by one of
-- the seller's named strategies (Firestore users/{uid}.pricingStrategies, by
-- id), on Apply or every day (`auto_daily`, job `pricing-groups-daily`).
-- A listing is in at most one group (the members' primary key), and leaves
-- its group when the listing row is deleted. Rules: docs/PRICING.md, "Pricer";
-- code: pokoin-rust/crates/external/src/pricing.rs and pricing_store.rs.
create table if not exists public.seller_pricing_groups (
  id text primary key,
  seller_uid text not null,
  name text not null,
  strategy_id text not null,
  auto_daily boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_applied_at timestamptz,
  -- `{ changed, activated, noComp, unchanged, failed, trigger }` of the last apply.
  last_applied jsonb
);

create unique index if not exists seller_pricing_groups_name_uidx
  on public.seller_pricing_groups (seller_uid, lower(name));
create index if not exists seller_pricing_groups_daily_idx
  on public.seller_pricing_groups (seller_uid) where auto_daily;

create table if not exists public.seller_pricing_group_members (
  listing_id uuid primary key references public.marketplace_user_listings (id) on delete cascade,
  group_id text not null references public.seller_pricing_groups (id) on delete cascade,
  seller_uid text not null,
  added_at timestamptz not null default now()
);

create index if not exists seller_pricing_group_members_group_idx
  on public.seller_pricing_group_members (group_id);
create index if not exists seller_pricing_group_members_seller_idx
  on public.seller_pricing_group_members (seller_uid);

-- A Scan desk row's own pricing choice, overriding its batch's
-- (`pricingGroupId` / `pricingStrategyId` in scan_batches.defaults):
-- { "groupId": … } | { "strategyId": … } | { "none": true }; null = the batch's.
-- So one batch can mix strategies (scan_connect::row_pricing).
do $$ begin
  if to_regclass('public.scan_items') is not null then
    alter table public.scan_items add column if not exists pricing jsonb;
  end if;
end $$;
