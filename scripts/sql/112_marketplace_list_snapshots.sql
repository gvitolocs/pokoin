-- List snapshots: set and artist desks are fixed catalog data, built (with
-- prices applied) by `pokoin-api job build-lists` (k3s CronJobs on nezopt) and
-- served by GET /api/marketplace-list as plain JSON or c1. The job creates
-- these tables in every game database itself; this file documents them.
create table if not exists public.marketplace_list_snapshots (
  kind text not null,
  key text not null,
  body text not null,
  c1 bytea not null,
  card_count integer not null default 0,
  version text not null,
  built_at timestamptz not null default now(),
  primary key (kind, key)
);

-- One display median per card: the last day of the card-sales series, refreshed
-- daily. Fills tile prices instead of one card-sales request per card.
create table if not exists public.marketplace_card_daily_median (
  card_id bigint primary key,
  last_day date,
  last_median_pkn numeric not null,
  refreshed_at timestamptz not null default now()
);
