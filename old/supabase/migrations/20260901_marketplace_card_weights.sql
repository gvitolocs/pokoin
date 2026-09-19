-- Ranked browse weights published from Oracle. Snapshots stay on Oracle.

create table if not exists public.marketplace_card_weights (
  card_id text primary key,
  weight numeric not null default 0,
  sold_7d integer not null default 0,
  new_7d integer not null default 0,
  listed integer not null default 0,
  native_listed integer not null default 0,
  stats jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.marketplace_card_weights enable row level security;

drop policy if exists marketplace_card_weights_read on public.marketplace_card_weights;
create policy marketplace_card_weights_read
  on public.marketplace_card_weights
  for select
  to anon, authenticated
  using (true);

grant select on public.marketplace_card_weights to anon, authenticated;

create index if not exists marketplace_card_weights_weight_idx
  on public.marketplace_card_weights (weight desc, card_id desc);
