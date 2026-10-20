-- The CardTrader sold graph for every game: the Pokémon `cardtrader_sold_daily`
-- table in each CardTrader game database. `pokoin-cardtrader-sold`
-- (`pokoin-rust/apps/cardtrader-sold`, docs/CARDTRADER_DAILY_DUMP.md "Sold
-- graph") fills it nightly from the stored listing books; the API's
-- `/api/marketplace-card-sales` already reads it from the game's database.
--
-- Apply on the nezopt writer to every CardTrader game database except
-- pokoin_marketplace (Pokémon has the table; the Oracle job fills it), as
-- pokoin_migrator. Idempotent. The definition is the Pokémon one.
--
--   for db in pokoin_magic pokoin_yugioh pokoin_flesh_and_blood pokoin_digimon \
--     pokoin_dragon_ball_super pokoin_vanguard pokoin_one_piece pokoin_lorcana \
--     pokoin_star_wars pokoin_union_arena pokoin_riftbound pokoin_gundam \
--     pokoin_sorcery pokoin_palworld pokoin_cyberpunk; do
--     docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_migrator -d "$db" \
--       -v ON_ERROR_STOP=1 < scripts/sql/131_cardtrader_sold_daily_all_games.sql
--   done
create table if not exists public.cardtrader_sold_daily (
    blueprint_id bigint NOT NULL,
    observed_day date NOT NULL,
    condition text NOT NULL,
    language text NOT NULL,
    reverse boolean DEFAULT false NOT NULL,
    first_edition boolean DEFAULT false NOT NULL,
    graded boolean DEFAULT false NOT NULL,
    median_pkn numeric NOT NULL,
    min_pkn numeric NOT NULL,
    max_pkn numeric NOT NULL,
    sold_qty integer DEFAULT 0 NOT NULL,
    listings integer DEFAULT 0 NOT NULL,
    graded_comments text[] DEFAULT '{}'::text[] NOT NULL,
    refreshed_at timestamp with time zone DEFAULT now() NOT NULL,
    sample_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT cardtrader_sold_daily_pkey
      PRIMARY KEY (blueprint_id, observed_day, condition, language, reverse, first_edition, graded)
);
create index if not exists cardtrader_sold_daily_blueprint_day_idx
  ON public.cardtrader_sold_daily USING btree (blueprint_id, observed_day);

-- 124's default privileges cover a table pokoin_migrator creates; the grants
-- are explicit too for a database where the owner differs.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'pokoin_jobs') then
    grant select, insert, update, delete on public.cardtrader_sold_daily to pokoin_jobs;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pokoin_api_read') then
    grant select on public.cardtrader_sold_daily to pokoin_api_read;
  end if;
  if exists (select 1 from pg_roles where rolname = 'pokoin_api_write') then
    grant select on public.cardtrader_sold_daily to pokoin_api_write;
  end if;
end $$;
