-- Least-privilege roles for the Rust API and jobs (docs/SECURITY_HARDENING.md,
-- "Least-privilege roles"). Until now every client logged in as the superuser
-- pokoin_marketplace.
--
--   pokoin_api_read   Pi API read pools on the Pi standby: SELECT only, read-only sessions
--   pokoin_api_write  Pi API writer pools and the k3s overflow pods (all their URLs):
--                     SELECT everywhere, DML only on the tables the API writes
--   pokoin_jobs       k3s CronJobs (build-lists, search-*), the nezopt price cache, the
--                     Oracle CardTrader ingest: DML on every table, TEMP, all functions
--   pokoin_migrator   owns the schema (migration 125) and runs migrations; no superuser
--
-- None of them is superuser, createdb, createrole, replication or bypassrls, and
-- none has DDL rights on objects it does not own. pokoin_replicator is untouched.
-- Passwords are not set here (runbook step 2); a role without one cannot log in
-- over the network (pg_hba is scram-sha-256).
--
-- psql only (\if): run as pokoin_marketplace, once per database in scope
-- (pokoin_marketplace and every pokoin_<game>), after 120–123. Other databases
-- (postgres, pokoin_scan_language) are skipped. Idempotent; rerun it after a
-- new SECURITY DEFINER function or a new table the API must write.
--
--   for db in $(docker exec pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d postgres -XAt \
--       -c "select datname from pg_database where datname like 'pokoin\_%' and datname <> 'pokoin_scan_language'"); do
--     docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d "$db" -v ON_ERROR_STOP=1 \
--       < scripts/sql/124_least_privilege_roles.sql
--   done
--
-- Grants only take catalog locks; no table is rewritten or locked exclusively.

\set ON_ERROR_STOP on
select current_database() like 'pokoin\_%' and current_database() <> 'pokoin_scan_language' as in_scope \gset
\if :in_scope

-- Roles are cluster-wide: the first database creates them, the rest re-assert
-- the attributes. Connection limits (writer max_connections 200, 3 reserved
-- for superusers; docs/RUST_RUNTIME.md "Postgres connection budget"):
--   pokoin_api_write 120  Pi writer ceiling 26 + overflow HPA 4 x 18 + satellites
--   pokoin_jobs       50  build-lists CronJobs (13 + 1 each, a few overlap), search-* 2,
--                         price cache 4, Oracle ingest up to 20
--   pokoin_api_read  100  Pi standby only (catalog 16 + domain 12 + commerce 12 +
--                         accounts 4 + satellites 2 each); pg_hba keeps it off the writer
--   pokoin_migrator    3
-- 120 + 50 + 3 leaves 24 of the writer's 197 for the superuser and host scripts.
do $$
declare
  r record;
begin
  for r in select * from (values
      ('pokoin_api_read', 100), ('pokoin_api_write', 120), ('pokoin_jobs', 50), ('pokoin_migrator', 3)
    ) as v(name, conn)
  loop
    if not exists (select 1 from pg_roles where rolname = r.name) then
      execute format('create role %I login', r.name);
    end if;
    execute format('alter role %I with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit connection limit %s',
                   r.name, r.conn);
  end loop;
end $$;
-- Defence in depth: a read session cannot write even where the server would let it.
alter role pokoin_api_read set default_transaction_read_only = on;

-- Database: only these roles (and the replicator, which keeps its grant) connect.
do $$
declare
  db text := current_database();
begin
  execute format('revoke connect, temporary on database %I from public', db);
  execute format('grant connect on database %I to pokoin_api_read, pokoin_api_write, pokoin_jobs, pokoin_migrator', db);
  -- The price cache's temp table; SECURITY DEFINER refreshes use temp tables as their owner.
  execute format('grant temporary on database %I to pokoin_jobs, pokoin_migrator', db);
  -- Migrations create schemas (123) and own the database after 125.
  execute format('grant create on database %I to pokoin_migrator', db);
end $$;

-- Schemas: public and the satellite raw catalogs marketplace_<game>.
do $$
declare
  s text;
  owner text;
begin
  for s in select nspname from pg_namespace where nspname = 'public' or nspname like 'marketplace\_%' loop
    execute format('grant usage on schema %I to pokoin_api_read, pokoin_api_write, pokoin_jobs', s);
    execute format('grant usage, create on schema %I to pokoin_migrator', s);
    -- Reads: everyone. Sequences: read sees values, writers draw them.
    execute format('grant select on all tables in schema %I to pokoin_api_read, pokoin_api_write, pokoin_jobs', s);
    execute format('grant select on all sequences in schema %I to pokoin_api_read', s);
    execute format('grant usage, select on all sequences in schema %I to pokoin_api_write', s);
    execute format('grant usage, select, update on all sequences in schema %I to pokoin_jobs', s);
    -- Jobs write every table (ingest, projections, snapshots); never TRUNCATE or DDL.
    execute format('grant insert, update, delete on all tables in schema %I to pokoin_jobs', s);
    -- Tables created later (by the migrator, or by the superuser until 125):
    -- readable by all, writable by the API and the jobs. A migration that adds a
    -- table the API must never write revokes it (see the runbook).
    foreach owner in array array['pokoin_migrator', 'pokoin_marketplace'] loop
      execute format('alter default privileges for role %I in schema %I grant select on tables to pokoin_api_read, pokoin_api_write, pokoin_jobs', owner, s);
      execute format('alter default privileges for role %I in schema %I grant insert, update, delete on tables to pokoin_api_write, pokoin_jobs', owner, s);
      execute format('alter default privileges for role %I in schema %I grant select on sequences to pokoin_api_read', owner, s);
      execute format('alter default privileges for role %I in schema %I grant usage, select on sequences to pokoin_api_write', owner, s);
      execute format('alter default privileges for role %I in schema %I grant usage, select, update on sequences to pokoin_jobs', owner, s);
    end loop;
  end loop;
end $$;

-- The API's own writes (pokoin_marketplace only; in the satellites the API only
-- reads). From the Rust sources (inventory in the runbook) plus the tables the
-- invoker triggers on those tables write. A table missing here is skipped, so the
-- file also runs before the migration that creates it.
do $$
declare
  t text;
begin
  if current_database() <> 'pokoin_marketplace' then
    return;
  end if;
  foreach t in array array[
    -- accounts
    'assistant_user_current_pages', 'cardrails_auth_codes', 'marketplace_user_listings',
    'poko_telegram_link_codes', 'poko_telegram_links', 'poko_discord_links', 'poko_user_personal_snapshot',
    -- commerce: carts, checkout, listings, outbox, seller API and books, scan connect
    'marketplace_user_carts', 'marketplace_checkout_holds', 'marketplace_user_recents', 'marketplace_outbox',
    'marketplace_card_events', 'marketplace_card_cart_analytics', 'marketplace_card_cart_users',
    'marketplace_card_watchlist_analytics', 'marketplace_card_watchlist_users', 'marketplace_seller_books',
    'seller_api_grants', 'seller_api_events', 'seller_api_listing_keys', 'seller_webhook_deliveries',
    'scan_batches', 'scan_items', 'scan_sessions', 'scan_pairings', 'scan_rate_limits',
    -- external: CardTrader seller sync, webhooks, 1-Day Ready assets
    'marketplace_cardtrader_seller_sync', 'marketplace_cardtrader_product_links',
    'marketplace_cardtrader_import_jobs', 'marketplace_cardtrader_1dr_assets',
    -- api-common rate limits; admin news
    'marketplace_rate_limits', 'news_events',
    -- admin debug routes (operator-only, authenticated)
    'flutter_debug_logs', 'pokoin_pokemon_expansions', 'marketplace_blueprint_artists',
    'marketplace_blueprint_classification_overrides', 'marketplace_artist_debug_skips',
    'marketplace_cm_refinement_log', 'marketplace_cm_verified_links', 'marketplace_cm_scrape_observations',
    'marketplace_cards', 'marketplace_search_candidates', 'marketplace_card_versions', 'marketplace_card_urls',
    'cardtrader_pokemon_blueprints',
    -- written by invoker triggers on the tables above
    'marketplace_user_listing_events', 'marketplace_listing_stats_daily', 'pokoin_version_sets'
  ] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('grant insert, update, delete on public.%I to pokoin_api_write', t);
    else
      raise notice 'pokoin_api_write: public.% does not exist here, skipped', t;
    end if;
  end loop;
end $$;

-- SECURITY DEFINER functions run as their owner (the superuser until 125), so
-- EXECUTE on them is the real privilege: PUBLIC loses it, the jobs and the
-- migrator keep all of them, and the API gets only the ones it calls.
-- Invoker functions keep PUBLIC EXECUTE: they run with the caller's rights.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prosecdef and (n.nspname = 'public' or n.nspname like 'marketplace\_%')
       and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public', f.sig);
    execute format('grant execute on function %s to pokoin_jobs, pokoin_migrator', f.sig);
    -- Read paths: search and localized names (read-only bodies).
    if f.proname in ('marketplace_card_names_for_language', 'search_marketplace_candidates',
                     'search_marketplace_blueprint_candidates_v2', 'search_marketplace_blueprint_name_candidates',
                     'search_marketplace_blueprint_non_name_candidates') then
      execute format('grant execute on function %s to pokoin_api_read, pokoin_api_write', f.sig);
    -- API writes: listing price summary (commerce, CardTrader sync/webhooks), the home
    -- hot-blueprint refresh, and the secret-guarded CardTrader daily-refresh route.
    elsif f.proname in ('refresh_marketplace_blueprint_price_summary', 'refresh_marketplace_hot_blueprints',
                        'refresh_cardtrader_market_listing_snapshots', 'finalize_cardtrader_daily_market_refresh',
                        'upsert_cardtrader_blueprint_population') then
      execute format('grant execute on function %s to pokoin_api_write', f.sig);
    end if;
  end loop;
end $$;

\else
\echo skipped: :DBNAME is not a Pokoin catalog database
\endif
