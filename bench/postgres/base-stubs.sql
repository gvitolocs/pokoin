-- Objects the writer has but no migration in either repository creates
-- (they came from importer code or a hand-run step). Created before the
-- migrations so the schema replay reaches the later files. Bench only.

-- The CardTrader blueprint table under its current name; 001 still creates
-- the old cardtrader_pokemon_blueprints, which later files no longer use.
create table if not exists public.pokoin_pokemon_blueprints (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null default 5,
  category_id integer,
  expansion_id integer,
  image_url text,
  cardtrader_image_url text,
  cdn_image_url text,
  cdn_object_key text,
  preview_image_url text,
  preview_object_key text,
  homepage_image_url text,
  homepage_object_key text,
  card_palette jsonb not null default '{}'::jsonb,
  emoji text not null default '',
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null default '{}'::jsonb,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

-- Collector number cleanup used by 004 and the projections: the shape only.
create or replace function public.marketplace_clean_collector_number(value text)
returns text
language sql
immutable
as $$ select nullif(btrim(coalesce(value, '')), '') $$;
