-- Operator/debug tables of the admin routes (`pokoin-rust/crates/admin-api/src/debug/`):
-- the artist debug desk, the Cardmarket refinement desk and the extension's
-- scrape observations. The Node handlers, and their Rust ports until
-- 2026-10-15, ran these `create table if not exists` guards on every request
-- (on the read pool, which on the Pi is the hot standby). The API roles have
-- no DDL rights (migration 124), so the tables live here.
--
-- Apply on the nezopt writer, database pokoin_marketplace only (the FKs name
-- public.cardtrader_pokemon_blueprints), as pokoin_migrator. Idempotent; the
-- definitions are the ones the handlers created, so production already has them.

create table if not exists public.marketplace_blueprint_classification_overrides (
  blueprint_id bigint primary key references public.cardtrader_pokemon_blueprints(id) on delete cascade,
  item_kind text not null default 'single' check (item_kind in ('single', 'product')),
  product_type text not null default 'card',
  source text not null default '',
  reason text not null default '',
  debug_uid text not null default '',
  debug_email text not null default '',
  debug_username text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists marketplace_blueprint_classification_overrides_source_idx
  on public.marketplace_blueprint_classification_overrides (source, updated_at desc);

create table if not exists public.marketplace_artist_debug_skips (
  id bigserial primary key,
  blueprint_id bigint not null references public.cardtrader_pokemon_blueprints(id) on delete cascade,
  debug_uid text not null default '',
  debug_email text not null default '',
  debug_username text not null default '',
  reason text not null default '',
  skipped_at timestamptz not null default now()
);
create index if not exists marketplace_artist_debug_skips_recent_idx
  on public.marketplace_artist_debug_skips (blueprint_id, debug_uid, debug_email, skipped_at desc);

create table if not exists public.marketplace_cm_scrape_observations (
  id uuid primary key default gen_random_uuid(),
  cardmarket_url text not null,
  cardmarket_locale text not null default 'en',
  cardmarket_expansion_slug text not null default '',
  cardmarket_product_slug text not null default '',
  page_title text not null default '',
  scraped_name text not null default '',
  scraped_expansion text not null default '',
  collector_number text not null default '',
  collector_prefix text not null default '',
  numeric_collector_number text not null default '',
  raw_title text not null default '',
  structured_payload jsonb not null default '{}'::jsonb,
  page_context jsonb not null default '{}'::jsonb,
  matched_blueprint_id bigint references public.cardtrader_pokemon_blueprints(id) on delete set null,
  match_confidence numeric,
  match_payload jsonb not null default '{}'::jsonb,
  source text not null default 'pokemon-card-extension',
  extension_version text not null default '',
  user_agent text not null default '',
  debug_uid text not null default '',
  debug_email text not null default '',
  status text not null default 'observed' check (
    status in ('observed', 'matched', 'verified', 'rejected')
  ),
  notes text not null default '',
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists marketplace_cm_scrape_observations_url_idx
  on public.marketplace_cm_scrape_observations (cardmarket_url);
create index if not exists marketplace_cm_scrape_observations_status_idx
  on public.marketplace_cm_scrape_observations (status, observed_at desc);

create table if not exists public.marketplace_cm_refinement_log (
  id bigserial primary key,
  blueprint_id bigint not null references public.cardtrader_pokemon_blueprints(id) on delete cascade,
  cardmarket_locale text not null default 'en',
  pasted_cardmarket_url text not null,
  candidate_cardmarket_url text not null default '',
  card_name text not null default '',
  expansion_name text not null default '',
  collector_number text not null default '',
  cardmarket_ids text[] not null default '{}',
  status text not null default 'pending' check (
    status in ('pending', 'implemented', 'rejected')
  ),
  debug_uid text not null default '',
  debug_email text not null default '',
  debug_username text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  implemented_at timestamptz
);
create index if not exists marketplace_cm_refinement_log_blueprint_idx
  on public.marketplace_cm_refinement_log (blueprint_id, status, created_at desc);
create index if not exists marketplace_cm_refinement_log_status_idx
  on public.marketplace_cm_refinement_log (status, created_at desc);

create table if not exists public.marketplace_cm_verified_links (
  blueprint_id bigint not null references public.cardtrader_pokemon_blueprints(id) on delete cascade,
  cardmarket_locale text not null default 'en',
  cardmarket_url text not null,
  cardmarket_product_slug text not null default '',
  card_name text not null default '',
  expansion_name text not null default '',
  collector_number text not null default '',
  source text not null default '',
  confidence text not null default 'verified' check (
    confidence in ('verified', 'manual')
  ),
  notes text not null default '',
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (blueprint_id, cardmarket_locale)
);
create unique index if not exists marketplace_cm_verified_links_url_idx
  on public.marketplace_cm_verified_links (cardmarket_url);
