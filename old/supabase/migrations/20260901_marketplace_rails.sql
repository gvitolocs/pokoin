-- Read replicas for marketplace browse rails. Oracle Postgres remains search + source of truth.

create table if not exists public.marketplace_rails (
  id text primary key,
  cards jsonb not null default '[]'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.marketplace_card_tiles (
  card_id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.marketplace_rails enable row level security;
alter table public.marketplace_card_tiles enable row level security;

drop policy if exists marketplace_rails_read on public.marketplace_rails;
create policy marketplace_rails_read
  on public.marketplace_rails
  for select
  to anon, authenticated
  using (true);

drop policy if exists marketplace_card_tiles_read on public.marketplace_card_tiles;
create policy marketplace_card_tiles_read
  on public.marketplace_card_tiles
  for select
  to anon, authenticated
  using (true);

grant select on public.marketplace_rails to anon, authenticated;
grant select on public.marketplace_card_tiles to anon, authenticated;
