-- Satellite catalog schemas of the admin game ingest (`pokoin-rust/crates/external/src/game_ingest.rs`),
-- generated from `ingest_schemas.json` by the test `migration_123_matches_ingest_schemas`; do not edit.
-- The ingest ran this DDL itself when asked (`ensureSchema`) until 2026-10-15; it runs no DDL now
-- and reports a blocker when its target table is missing.
--
-- psql only (`\gset`/`\if`): apply to every pokoin_<game> database on the nezopt writer as
-- pokoin_migrator; each database runs only its own block. Idempotent.

select current_database() = 'pokoin_magic' as is_magic \gset
\if :is_magic
create schema if not exists "marketplace_magic";

create table if not exists "marketplace_magic"."cardtrader_blueprints" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_magic_cardtrader_blueprints_expansion_id_idx"
  on "marketplace_magic"."cardtrader_blueprints" (expansion_id);

create index if not exists "marketplace_magic_cardtrader_blueprints_category_id_idx"
  on "marketplace_magic"."cardtrader_blueprints" (category_id);
\endif

select current_database() = 'pokoin_yugioh' as is_yugioh \gset
\if :is_yugioh
create schema if not exists "marketplace_yugioh";

create table if not exists "marketplace_yugioh"."cardtrader_blueprints" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_yugioh_cardtrader_blueprints_expansion_id_idx"
  on "marketplace_yugioh"."cardtrader_blueprints" (expansion_id);

create index if not exists "marketplace_yugioh_cardtrader_blueprints_category_id_idx"
  on "marketplace_yugioh"."cardtrader_blueprints" (category_id);
\endif

select current_database() = 'pokoin_flesh_and_blood' as is_flesh_and_blood \gset
\if :is_flesh_and_blood
create schema if not exists "marketplace_flesh_and_blood";

create table if not exists "marketplace_flesh_and_blood"."cardtrader_blueprints" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_flesh_and_blood_cardtrader_blueprints_expansion_id_idx"
  on "marketplace_flesh_and_blood"."cardtrader_blueprints" (expansion_id);

create index if not exists "marketplace_flesh_and_blood_cardtrader_blueprints_category_id_idx"
  on "marketplace_flesh_and_blood"."cardtrader_blueprints" (category_id);
\endif

select current_database() = 'pokoin_digimon' as is_digimon \gset
\if :is_digimon
create schema if not exists "marketplace_digimon";

create table if not exists "marketplace_digimon"."cardtrader_blueprints" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_digimon_cardtrader_blueprints_expansion_id_idx"
  on "marketplace_digimon"."cardtrader_blueprints" (expansion_id);

create index if not exists "marketplace_digimon_cardtrader_blueprints_category_id_idx"
  on "marketplace_digimon"."cardtrader_blueprints" (category_id);
\endif

select current_database() = 'pokoin_dragon_ball_super' as is_dragon_ball_super \gset
\if :is_dragon_ball_super
create schema if not exists "marketplace_dragon_ball_super";

create table if not exists "marketplace_dragon_ball_super"."cardtrader_blueprints" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_dragon_ball_super_cardtrader_blueprints_expansion_id_idx"
  on "marketplace_dragon_ball_super"."cardtrader_blueprints" (expansion_id);

create index if not exists "marketplace_dragon_ball_super_cardtrader_blueprints_category_id_idx"
  on "marketplace_dragon_ball_super"."cardtrader_blueprints" (category_id);
\endif

select current_database() = 'pokoin_vanguard' as is_vanguard \gset
\if :is_vanguard
create schema if not exists "marketplace_vanguard";

create table if not exists "marketplace_vanguard"."cardtrader_blueprints" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_vanguard_cardtrader_blueprints_expansion_id_idx"
  on "marketplace_vanguard"."cardtrader_blueprints" (expansion_id);

create index if not exists "marketplace_vanguard_cardtrader_blueprints_category_id_idx"
  on "marketplace_vanguard"."cardtrader_blueprints" (category_id);
\endif

select current_database() = 'pokoin_one_piece' as is_one_piece \gset
\if :is_one_piece
create schema if not exists "marketplace_one_piece";

create table if not exists "marketplace_one_piece"."cardtrader_blueprints" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_one_piece_cardtrader_blueprints_expansion_id_idx"
  on "marketplace_one_piece"."cardtrader_blueprints" (expansion_id);

create index if not exists "marketplace_one_piece_cardtrader_blueprints_category_id_idx"
  on "marketplace_one_piece"."cardtrader_blueprints" (category_id);
\endif

select current_database() = 'pokoin_lorcana' as is_lorcana \gset
\if :is_lorcana
create schema if not exists "marketplace_lorcana";

create table if not exists "marketplace_lorcana"."cardtrader_blueprints" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_lorcana_cardtrader_blueprints_expansion_id_idx"
  on "marketplace_lorcana"."cardtrader_blueprints" (expansion_id);

create index if not exists "marketplace_lorcana_cardtrader_blueprints_category_id_idx"
  on "marketplace_lorcana"."cardtrader_blueprints" (category_id);
\endif

select current_database() = 'pokoin_star_wars' as is_star_wars \gset
\if :is_star_wars
create schema if not exists "marketplace_star_wars";

create table if not exists "marketplace_star_wars"."cardtrader_blueprints" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_star_wars_cardtrader_blueprints_expansion_id_idx"
  on "marketplace_star_wars"."cardtrader_blueprints" (expansion_id);

create index if not exists "marketplace_star_wars_cardtrader_blueprints_category_id_idx"
  on "marketplace_star_wars"."cardtrader_blueprints" (category_id);
\endif

select current_database() = 'pokoin_union_arena' as is_union_arena \gset
\if :is_union_arena
create schema if not exists "marketplace_union_arena";

create table if not exists "marketplace_union_arena"."cardtrader_blueprints" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_union_arena_cardtrader_blueprints_expansion_id_idx"
  on "marketplace_union_arena"."cardtrader_blueprints" (expansion_id);

create index if not exists "marketplace_union_arena_cardtrader_blueprints_category_id_idx"
  on "marketplace_union_arena"."cardtrader_blueprints" (category_id);
\endif

select current_database() = 'pokoin_riftbound' as is_riftbound \gset
\if :is_riftbound
create schema if not exists "marketplace_riftbound";

create table if not exists "marketplace_riftbound"."cardtrader_blueprints" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_riftbound_cardtrader_blueprints_expansion_id_idx"
  on "marketplace_riftbound"."cardtrader_blueprints" (expansion_id);

create index if not exists "marketplace_riftbound_cardtrader_blueprints_category_id_idx"
  on "marketplace_riftbound"."cardtrader_blueprints" (category_id);
\endif

select current_database() = 'pokoin_gundam' as is_gundam \gset
\if :is_gundam
create schema if not exists "marketplace_gundam";

create table if not exists "marketplace_gundam"."cardtrader_blueprints" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_gundam_cardtrader_blueprints_expansion_id_idx"
  on "marketplace_gundam"."cardtrader_blueprints" (expansion_id);

create index if not exists "marketplace_gundam_cardtrader_blueprints_category_id_idx"
  on "marketplace_gundam"."cardtrader_blueprints" (category_id);
\endif

select current_database() = 'pokoin_sorcery' as is_sorcery \gset
\if :is_sorcery
create schema if not exists "marketplace_sorcery";

create table if not exists "marketplace_sorcery"."cardtrader_blueprints" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_sorcery_cardtrader_blueprints_expansion_id_idx"
  on "marketplace_sorcery"."cardtrader_blueprints" (expansion_id);

create index if not exists "marketplace_sorcery_cardtrader_blueprints_category_id_idx"
  on "marketplace_sorcery"."cardtrader_blueprints" (category_id);
\endif

select current_database() = 'pokoin_palworld' as is_palworld \gset
\if :is_palworld
create schema if not exists "marketplace_palworld";

create table if not exists "marketplace_palworld"."cardtrader_blueprints" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_palworld_cardtrader_blueprints_expansion_id_idx"
  on "marketplace_palworld"."cardtrader_blueprints" (expansion_id);

create index if not exists "marketplace_palworld_cardtrader_blueprints_category_id_idx"
  on "marketplace_palworld"."cardtrader_blueprints" (category_id);
\endif

select current_database() = 'pokoin_cyberpunk' as is_cyberpunk \gset
\if :is_cyberpunk
create schema if not exists "marketplace_cyberpunk";

create table if not exists "marketplace_cyberpunk"."cardtrader_blueprints" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_cyberpunk_cardtrader_blueprints_expansion_id_idx"
  on "marketplace_cyberpunk"."cardtrader_blueprints" (expansion_id);

create index if not exists "marketplace_cyberpunk_cardtrader_blueprints_category_id_idx"
  on "marketplace_cyberpunk"."cardtrader_blueprints" (category_id);
\endif

select current_database() = 'pokoin_weiss_schwarz' as is_weiss_schwarz \gset
\if :is_weiss_schwarz
create schema if not exists "marketplace_weiss_schwarz";

create table if not exists "marketplace_weiss_schwarz"."cardmarket_products" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_weiss_schwarz_cardmarket_products_expansion_id_idx"
  on "marketplace_weiss_schwarz"."cardmarket_products" (expansion_id);

create index if not exists "marketplace_weiss_schwarz_cardmarket_products_category_id_idx"
  on "marketplace_weiss_schwarz"."cardmarket_products" (category_id);
\endif

select current_database() = 'pokoin_final_fantasy' as is_final_fantasy \gset
\if :is_final_fantasy
create schema if not exists "marketplace_final_fantasy";

create table if not exists "marketplace_final_fantasy"."cardmarket_products" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_final_fantasy_cardmarket_products_expansion_id_idx"
  on "marketplace_final_fantasy"."cardmarket_products" (expansion_id);

create index if not exists "marketplace_final_fantasy_cardmarket_products_category_id_idx"
  on "marketplace_final_fantasy"."cardmarket_products" (category_id);
\endif

select current_database() = 'pokoin_force_of_will' as is_force_of_will \gset
\if :is_force_of_will
create schema if not exists "marketplace_force_of_will";

create table if not exists "marketplace_force_of_will"."cardmarket_products" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_force_of_will_cardmarket_products_expansion_id_idx"
  on "marketplace_force_of_will"."cardmarket_products" (expansion_id);

create index if not exists "marketplace_force_of_will_cardmarket_products_category_id_idx"
  on "marketplace_force_of_will"."cardmarket_products" (category_id);
\endif

select current_database() = 'pokoin_world_of_warcraft' as is_world_of_warcraft \gset
\if :is_world_of_warcraft
create schema if not exists "marketplace_world_of_warcraft";

create table if not exists "marketplace_world_of_warcraft"."cardmarket_products" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_world_of_warcraft_cardmarket_products_expansion_id_idx"
  on "marketplace_world_of_warcraft"."cardmarket_products" (expansion_id);

create index if not exists "marketplace_world_of_warcraft_cardmarket_products_category_id_idx"
  on "marketplace_world_of_warcraft"."cardmarket_products" (category_id);
\endif

select current_database() = 'pokoin_battle_spirits_saga' as is_battle_spirits_saga \gset
\if :is_battle_spirits_saga
create schema if not exists "marketplace_battle_spirits_saga";

create table if not exists "marketplace_battle_spirits_saga"."cardmarket_products" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_battle_spirits_saga_cardmarket_products_expansion_id_idx"
  on "marketplace_battle_spirits_saga"."cardmarket_products" (expansion_id);

create index if not exists "marketplace_battle_spirits_saga_cardmarket_products_category_id_idx"
  on "marketplace_battle_spirits_saga"."cardmarket_products" (category_id);
\endif

select current_database() = 'pokoin_star_wars_destiny' as is_star_wars_destiny \gset
\if :is_star_wars_destiny
create schema if not exists "marketplace_star_wars_destiny";

create table if not exists "marketplace_star_wars_destiny"."cardmarket_products" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_star_wars_destiny_cardmarket_products_expansion_id_idx"
  on "marketplace_star_wars_destiny"."cardmarket_products" (expansion_id);

create index if not exists "marketplace_star_wars_destiny_cardmarket_products_category_id_idx"
  on "marketplace_star_wars_destiny"."cardmarket_products" (category_id);
\endif

select current_database() = 'pokoin_dragon_born' as is_dragon_born \gset
\if :is_dragon_born
create schema if not exists "marketplace_dragon_born";

create table if not exists "marketplace_dragon_born"."cardmarket_products" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_dragon_born_cardmarket_products_expansion_id_idx"
  on "marketplace_dragon_born"."cardmarket_products" (expansion_id);

create index if not exists "marketplace_dragon_born_cardmarket_products_category_id_idx"
  on "marketplace_dragon_born"."cardmarket_products" (category_id);
\endif

select current_database() = 'pokoin_my_little_pony' as is_my_little_pony \gset
\if :is_my_little_pony
create schema if not exists "marketplace_my_little_pony";

create table if not exists "marketplace_my_little_pony"."cardmarket_products" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_my_little_pony_cardmarket_products_expansion_id_idx"
  on "marketplace_my_little_pony"."cardmarket_products" (expansion_id);

create index if not exists "marketplace_my_little_pony_cardmarket_products_category_id_idx"
  on "marketplace_my_little_pony"."cardmarket_products" (category_id);
\endif

select current_database() = 'pokoin_the_spoils' as is_the_spoils \gset
\if :is_the_spoils
create schema if not exists "marketplace_the_spoils";

create table if not exists "marketplace_the_spoils"."cardmarket_products" (
  id bigint primary key,
  name text not null,
  version text,
  game_id integer not null,
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
  card_market_ids jsonb,
  tcg_player_ids jsonb,
  editable_properties jsonb not null default '[]'::jsonb,
  blueprint jsonb not null,
  expansion jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists "marketplace_the_spoils_cardmarket_products_expansion_id_idx"
  on "marketplace_the_spoils"."cardmarket_products" (expansion_id);

create index if not exists "marketplace_the_spoils_cardmarket_products_category_id_idx"
  on "marketplace_the_spoils"."cardmarket_products" (category_id);
\endif
