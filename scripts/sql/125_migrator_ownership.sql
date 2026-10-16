-- Move ownership of every application object from the superuser
-- (pokoin_marketplace) to pokoin_migrator (migration 124), so migrations run
-- without superuser rights and SECURITY DEFINER functions stop running as a
-- superuser. Runbook: docs/SECURITY_HARDENING.md "Least-privilege roles", step 6.
--
-- psql only (\gexec): run as pokoin_marketplace, once per database in scope
-- (pokoin_marketplace and every pokoin_<game>; never pokoin_scan_language or
-- postgres), after 124:
--
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d <db> \
--     -v ON_ERROR_STOP=1 < scripts/sql/125_migrator_ownership.sql
--
-- Rollback (same file, roles swapped):
--   ... -v from_role=pokoin_migrator -v to_role=pokoin_marketplace < scripts/sql/125_migrator_ownership.sql
--
-- `ALTER … OWNER` takes an ACCESS EXCLUSIVE lock, and the Pi standby replays it.
-- \gexec runs each statement in its own transaction, so each lock lasts only
-- that statement; lock_timeout makes a statement that would queue behind a
-- long query fail instead of stalling readers. Rerun the file until it reports
-- nothing left to change: it is idempotent. Extension members (pg_trgm,
-- unaccent, pgcrypto, citext) stay with the superuser, and sequences owned by
-- a column move with their table.
\if :{?from_role}
\else
\set from_role pokoin_marketplace
\endif
\if :{?to_role}
\else
\set to_role pokoin_migrator
\endif
set lock_timeout = '3s';
select set_config('pokoin.from_role', :'from_role', false), set_config('pokoin.to_role', :'to_role', false) \gset

-- The database itself (its owner is pg_database_owner, which owns schema public).
select format('alter database %I owner to %I', current_database(), current_setting('pokoin.to_role'))
 where pg_get_userbyid((select datdba from pg_database where datname = current_database())) = current_setting('pokoin.from_role')
\gexec

-- Schemas marketplace_<game> (satellite raw catalogs).
select format('alter schema %I owner to %I', nspname, current_setting('pokoin.to_role'))
  from pg_namespace
 where nspname like 'marketplace\_%' and pg_get_userbyid(nspowner) = current_setting('pokoin.from_role')
\gexec

-- Tables, views, materialized views, foreign tables and standalone sequences.
select format('alter %s %s owner to %I',
              case c.relkind when 'v' then 'view' when 'm' then 'materialized view'
                             when 'S' then 'sequence' when 'f' then 'foreign table' else 'table' end,
              c.oid::regclass, current_setting('pokoin.to_role'))
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where (n.nspname = 'public' or n.nspname like 'marketplace\_%')
   and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
   and pg_get_userbyid(c.relowner) = current_setting('pokoin.from_role')
   and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
   and not (c.relkind = 'S' and exists (select 1 from pg_depend d
                    where d.classid = 'pg_class'::regclass and d.objid = c.oid
                      and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')))
 order by c.relkind in ('v', 'm'), c.oid
\gexec

-- Functions, procedures and aggregates (SECURITY DEFINER ones then run as the new owner).
select format('alter %s %s owner to %I',
              case p.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end,
              p.oid::regprocedure, current_setting('pokoin.to_role'))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname = 'public' or n.nspname like 'marketplace\_%')
   and pg_get_userbyid(p.proowner) = current_setting('pokoin.from_role')
   and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
\gexec

-- Standalone types and domains (a table's row type moves with the table).
select format('alter %s %s owner to %I', case t.typtype when 'd' then 'domain' else 'type' end,
              t.oid::regtype, current_setting('pokoin.to_role'))
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
 where (n.nspname = 'public' or n.nspname like 'marketplace\_%')
   and pg_get_userbyid(t.typowner) = current_setting('pokoin.from_role')
   and t.typtype in ('e', 'd', 'r', 'c')
   and (t.typrelid = 0 or (select relkind from pg_class where oid = t.typrelid) = 'c')
   and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e')
\gexec

-- What is left (should be extension members only).
select 'left' as left_with_from_role, count(*)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where (n.nspname = 'public' or n.nspname like 'marketplace\_%')
   and pg_get_userbyid(c.relowner) = current_setting('pokoin.from_role')
   and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
   and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e');
