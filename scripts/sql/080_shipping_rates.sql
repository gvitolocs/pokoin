-- Seed stub for production Postgres when rates move off JSON.
-- Quote service currently loads server/pokoin-api/shipping-rates.json (fail closed).

create table if not exists public.shipping_rates (
  id text primary key,
  from_country char(2) not null,
  to_country char(2) not null,
  package_tier text not null,
  max_cards integer not null,
  max_weight_grams integer,
  price_eur_cents integer not null check (price_eur_cents > 0),
  carrier text,
  service_name text,
  active boolean not null default true,
  unique (from_country, to_country, package_tier)
);

create index if not exists shipping_rates_route_idx
  on public.shipping_rates (from_country, to_country, active);
