-- Rollback of migrations 124 and 125 (docs/SECURITY_HARDENING.md, "Least-privilege
-- roles", Rollback). Only after every client is back on pokoin_marketplace: it
-- removes every grant the new roles hold, so a client still using one fails.
--
-- psql only: run as pokoin_marketplace once per database in scope, like 124:
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d <db> -v ON_ERROR_STOP=1 \
--     < scripts/sql/rollback-124-125-least-privilege.sql
-- then, once, to remove the roles themselves (cluster-wide):
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d postgres -v ON_ERROR_STOP=1 \
--     -v drop_roles=1 < scripts/sql/rollback-124-125-least-privilege.sql
\set ON_ERROR_STOP on
select current_database() like 'pokoin\_%' and current_database() <> 'pokoin_scan_language' as in_scope \gset
\if :in_scope
-- 125: every object (and the database) back to the superuser. REASSIGN OWNED
-- keeps the objects; DROP OWNED then removes every privilege and default
-- privilege granted to the four roles in this database.
reassign owned by pokoin_migrator to pokoin_marketplace;
drop owned by pokoin_api_read, pokoin_api_write, pokoin_jobs, pokoin_migrator;
-- 124: PUBLIC's defaults (connect, temp, EXECUTE on SECURITY DEFINER functions).
do $$
declare
  f record;
begin
  execute format('grant connect, temporary on database %I to public', current_database());
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prosecdef and (n.nspname = 'public' or n.nspname like 'marketplace\_%')
  loop
    execute format('grant execute on function %s to public', f.sig);
  end loop;
end $$;
\endif
\if :{?drop_roles}
drop role if exists pokoin_api_read;
drop role if exists pokoin_api_write;
drop role if exists pokoin_jobs;
drop role if exists pokoin_migrator;
\endif
