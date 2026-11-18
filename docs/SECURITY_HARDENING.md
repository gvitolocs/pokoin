# API security hardening (2026-10-07)

Live system: Cloudflare Load Balancer `api.pokoin.com` (pool `pokoin-api`, origins
`pi` 0.9 / `nez` 0.1, monitor `GET /readyz`). Pi tunnel → Rust edge `127.0.0.1:18079`
→ in-process Rust API (`pokoin-rust-api.service`; the Node API on `127.0.0.1:18080`
was retired on 2026-10-09). NEZ tunnel → cloudflared pods → ClusterIP Service
`pokoin-api:8080` → Rust API pods. Postgres: NEZ primary `:25433`, Pi streaming
replica `127.0.0.1:5432`. Topology and weights were not changed.

## Transport

| Path | Before | Now |
| --- | --- | --- |
| Outbound HTTPS (Stripe, Google/Firebase, R2, CDN, CardTrader, Supabase, …) | `NODE_TLS_REJECT_UNAUTHORIZED=0` on Pi and NEZ | flag removed everywhere; every endpoint verifies normally |
| Pi API → NEZ writer | `sslmode=disable` | `sslmode=verify-full`, Pokoin PG CA |
| k3s pods → NEZ primary | `sslmode=disable` | `sslmode=verify-full` (`secret/pokoin-pg-ca` mounted at `/etc/pokoin/pg-ca`) |
| Pi replica ← NEZ primary (WAL) | `sslmode=prefer` (TLS was off on the primary) | `sslmode=verify-full`, TLS 1.3 |
| Pi API → Pi replica | TLS, self-signed, unverified | TLS, CA-signed cert (loopback only) |

Why the flag existed: the oldest pg clients used `sslmode=require` against a
self-signed Postgres; node-postgres treated that as full verification, and the
global flag silenced it. Every pool now sets its own `ssl` (and `uselibpqcompat`),
so nothing needed it. The private CA lives on nezopt `~/secrets/pokoin-pg-ca`
(key never leaves nezopt); server certs: NEZ (SAN 192.168.178.55, 172.31.250.10,
127.0.0.1), Pi (SAN 127.0.0.1, 192.168.178.46).

## Postgres access (pg_hba, first match wins)

Audited from `log_connections` (7 h, both servers). Broad `host all all all` removed.

| Source | Role | DB | Rule |
| --- | --- | --- | --- |
| Pi 192.168.178.46 (API writer) | pokoin_marketplace | all | `hostssl` scram |
| Pi 192.168.178.46 (replica) | pokoin_replicator | replication | `hostssl` scram |
| k3s 172.31.250.20 (pods, SNAT) | pokoin_marketplace | all | `hostssl` scram |
| nezopt-local jobs, Oracle dump reverse tunnel (172.17.0.1 / 192.168.178.55) | pokoin_marketplace | all | `host` scram (never leaves the host) |
| container-internal (docker exec) | any | any | local trust |
| anything else (other LAN hosts, plaintext from Pi/k3s, other roles) | — | — | rejected |

Pi replica: only `hostssl all pokoin_marketplace 172.18.0.1/32` (the local API via
the loopback-published port) plus container-local. It now listens on `127.0.0.1:5432`.

Open: every client still logs in as the superuser `pokoin_marketplace`. The
least-privilege roles that replace it are prepared but not applied; see
[Least-privilege roles](#least-privilege-roles-prepared-2026-10-15-not-applied).

## Ingress

| Entry | Before | Now |
| --- | --- | --- |
| NEZ NodePort `:30880` (old overflow) | LAN-reachable | Service is ClusterIP; k3s no longer publishes the port |
| Pi Node `:18080` | `0.0.0.0` | `127.0.0.1` (`ORACLE_API_HOST`); retired 2026-10-09 — every Rust listener (`18079`, `18081`, `18082`, `18090`) binds `127.0.0.1` |
| Pi Postgres `:5432` | `0.0.0.0` | `127.0.0.1` |
| Pi LAN surface | 22, 5432, 18080 | 22 only |

The Pi Rust API reads `/srv/pokoin/rust/pokoin-api.env` (root:nes, 0640), seeded from the
retired container's environment, so its database URLs carry the TLS settings above; releases
go through `scripts/deploy-pokoin-rust.sh` ([RUST_RUNTIME.md](RUST_RUNTIME.md)).

## Kubernetes (namespace pokoin-overflow)

- NetworkPolicy is enforced by k3s's embedded kube-router controller (verified with a
  deny-all test namespace). `infra/k3s/pokoin-security.yaml`: default deny, DNS for all,
  API ingress only from cloudflared, API egress only to Redis, Meili, the primary and
  TCGCSV on the Docker network, the scan bridge and public 443; cloudflared egress only
  to the API and Cloudflare (7844/443); Redis/Meili ingress only from the API and index jobs.
- API and cloudflared: dedicated ServiceAccounts, no token, `runAsNonRoot`, no privilege
  escalation, all capabilities dropped, `RuntimeDefault` seccomp, read-only root (API `/tmp`
  is an emptyDir). cloudflared gained `/ready` probes.
- PDB `minAvailable: 1` for the API and cloudflared.
- Secrets encryption at rest: k3s started with `--secrets-encryption`, `rotate-keys` →
  `reencrypt_finished` (aescbc). k3s also uses `--resolv-conf` with a real upstream (Docker's
  embedded 127.0.0.11 made CoreDNS detect a loop).
- `nezopt-k3s.sh sync` writes verify-full DSNs and never copies `NODE_TLS_REJECT_UNAUTHORIZED`,
  `ORACLE_API_HOST` or `POKOIN_TRUSTED_PROXY_CIDRS` from the Pi; `apply` applies both manifests.

## Application

- One client-IP implementation (`pokoin-rust/crates/api-common/src/security.rs`): proxy headers are
  honoured only from trusted peers (`POKOIN_TRUSTED_PROXY_CIDRS`: Pi loopback; NEZ pod CIDR, reachable
  only by cloudflared because of NetworkPolicy). The security layer stamps the trusted value into
  `x-pokoin-client-ip` so every handler sees it.
- One CORS allowlist (same module) applied around every route on every status code; credentials only
  for exact Pokoin origins; never `*` with credentials.
- Invalid Firebase tokens → 401 `Invalid or expired sign-in token.`; verifier outages → 503.
- `/api/__routes` is off unless `POKOIN_EXPOSE_ROUTE_MANIFEST=1`.
- Rate limits: security/cost limiters are global in Postgres (`marketplace_rate_limits`), degrade to
  the origin Redis at half the limit when the primary is unreachable, fail closed if Redis is down too.
- Responses whose game came from a header (not `?game=`) are `private, no-store`, so Cloudflare cannot be
  poisoned across games.

## Least-privilege roles (prepared 2026-10-15, not applied)

Every client still logs in as the superuser `pokoin_marketplace`. These roles replace it. The
code is ready: no Rust handler or job runs DDL, and every write goes to a writer pool. The
database changes are migrations `scripts/sql/120`–`125`. Nothing on a host or in a database
has changed yet. Each step below needs Giuseppe's explicit OK.

| Role | Used by | Rights |
| --- | --- | --- |
| `pokoin_api_read` | Pi API read URLs (`MARKETPLACE_DATABASE_URL`, `MARKETPLACE_NAME_SEARCH_DATABASE_URL`, the 24 `<GAME>_MARKETPLACE_DATABASE_URL`) on the Pi standby | `SELECT`; sessions are read-only (`default_transaction_read_only`); `EXECUTE` on the 5 search/name SECURITY DEFINER functions |
| `pokoin_api_write` | Pi `MARKETPLACE_WRITER_DATABASE_URL`, the Pi job timers (same env file), and every URL of the k3s overflow pods | `SELECT` everywhere; `INSERT/UPDATE/DELETE` on the tables the API writes (`pokoin_marketplace` only, list in 124); `USAGE` on sequences; `EXECUTE` on the search functions plus `refresh_marketplace_blueprint_price_summary`, `refresh_marketplace_hot_blueprints` and the 3 daily-refresh functions |
| `pokoin_jobs` | k3s CronJobs (`build-lists-*`, `search-delta`, `search-reindex`; secret `pokoin-jobs-env`), the nezopt price cache, the Oracle CardTrader ingest | DML on every table in every catalog database, `TEMP`, `EXECUTE` on every function; no `TRUNCATE` |
| `pokoin_migrator` | migrations only (`docker exec … psql -U pokoin_migrator`, local socket; no network login) | owns the databases, schemas, tables, views, sequences and functions after 125 |

None has `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` or `BYPASSRLS`, and none except the
migrator can create or alter anything. `pokoin_replicator` and the separate `pokoin_scan_language`
database are untouched. In scope: `pokoin_marketplace` and the 24 `pokoin_<game>` databases.

Connection limits per role (writer `max_connections` is 200 today, 3 reserved for superusers;
budget in [RUST_RUNTIME.md](RUST_RUNTIME.md#postgres-connection-budget)): `pokoin_api_write` 120
(Pi writer ceiling 26, overflow HPA 4 × 18 plus satellites), `pokoin_jobs` 50, `pokoin_migrator` 3,
`pokoin_api_read` 100 (Pi standby only: catalog 16 + domain 12 + commerce 12 + accounts 4 +
satellites 2 each). That is 173 on the writer, leaving 24 for the superuser and host scripts. A role
at its limit only refuses its own clients ("too many connections for role"). The overflow keeps one
pool per database: every URL in `pokoin-api-env` carries the same role, so read and write URLs stay
equal.

### What the code does now

- No runtime DDL. Moved to migrations: the admin debug tables (120, previously created on every
  request), the list snapshot columns (121, previously six `alter table` per `build-lists` run in every
  game database, each an access-exclusive lock the Pi replayed), the price cache table and view
  (122), the satellite raw catalogs of the admin game ingest (123, generated from `ingest_schemas.json`;
  a test keeps them in sync), and the seller book schema (116/119, which `build-lists --kind=seller`
  applied). `game_ingest` reports a blocker when its target table is missing.
- Writes go to a writer pool. Before, these went through a read pool, so on the Pi they failed
  against the standby: the 10 admin debug writes (`state.api.write()`), the home hot-blueprint
  refresh, and in accounts the current page, chat listing photos, Poko connect codes and links, and
  the personal snapshot (`DomainState::marketplace_writer_db()`).
- `build-lists` writes through its database URLs, so it refuses to run against a standby
  (`pg_is_in_recovery()`).
- The price cache logs in with `POKOIN_PRICE_CACHE_PG_USER`/`_PASSWORD` when set (unit
  `EnvironmentFile=-%h/.config/pokoin/price-cache-pg.env`). Otherwise it uses the container
  superuser and says so on stderr.
- `nezopt-k3s.sh sync` writes two secrets. `pokoin-api-env` gets every writer URL as
  `pokoin_api_write`, and `pokoin-jobs-env` gets them as `pokoin_jobs`, each with its password from
  `~/secrets/pokoin-pg-roles/<role>.pw`. Without those files both secrets keep the Pi's login. It
  refuses to copy a `pokoin_api_read` URL to the writer. The CronJobs in
  `infra/k3s/pokoin-overflow.yaml` read `pokoin-jobs-env`.

Pre-existing, not changed: commerce calls `public.record_marketplace_query_chunks`, which does not
exist in production, so that call already fails.

### Rules after the rollout

- Migrations run as `pokoin_migrator`. Only `create extension` for an untrusted extension still needs
  the superuser.
- A new table is readable by every role and writable by `pokoin_api_write` and `pokoin_jobs` (default
  privileges). A migration adding a catalog table the API must never write ends with
  `revoke insert, update, delete on public.<t> from pokoin_api_write;`.
- A new SECURITY DEFINER function: rerun 124 on that database. It revokes `PUBLIC` and grants the
  jobs. If the API calls the function, add it to 124's allow-list first.
- No DDL in Rust code. The API roles cannot run it.

### Rollout

The writer is `docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace` on nezopt
(below `W`). Run a per-database file with:

```bash
W="docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -v ON_ERROR_STOP=1"
DBS=$($W -d postgres -XAt -c "select datname from pg_database where datname like 'pokoin\_%' and datname <> 'pokoin_scan_language' order by 1")
for db in $DBS; do $W -d "$db" < scripts/sql/<file>.sql || break; done
```

0. **Deploy the code** (merge, Pi release, `nezopt-k3s.sh install` so the sync timer gets the new
   script, `nezopt-k3s.sh sync`, then `nezopt-k3s.sh apply` once `pokoin-jobs-env` exists). Everything
   keeps logging in as `pokoin_marketplace`. Check that `build-lists-*` and `search-delta` pass once.
1. **DDL audit, 24 h.** Is any client other than a migration still running DDL? That matters most for
   the Oracle CardTrader ingest (Node, cardvault repo) and the nezopt catalogue refresh.
   `$W -d postgres -c "alter role pokoin_marketplace set log_statement = 'ddl'"`, then after 24 h
   `docker logs --since 24h pokoin-marketplace-postgres-15t 2>&1 | grep -E 'statement: (create|alter|drop) '`.
   Map each `[pid]` to its client with the `connection authorized` lines (`log_connections` is on).
   Finish with `alter role pokoin_marketplace reset log_statement`. A client that still runs DDL keeps
   the superuser until that DDL is a migration.
2. **Migrations 120–123** as the superuser. 120 runs on `pokoin_marketplace` only; 121 and 122 on
   every database in `$DBS` (after 112 and 114); 123 on the satellites. All of them are idempotent
   and match what production already has.
3. **Migration 124** (roles, grants) on every database in `$DBS`. It touches catalogs only, takes no
   table locks, and changes nothing for the superuser.
4. **Passwords** on nezopt (hex, no URL escaping):
   ```bash
   install -d -m 700 ~/secrets/pokoin-pg-roles
   for r in pokoin_api_read pokoin_api_write pokoin_jobs pokoin_migrator; do
     (umask 077; openssl rand -hex 32 > ~/secrets/pokoin-pg-roles/$r.pw)
     printf "set log_statement = 'none';\nalter role %s password '%s';\n" "$r" "$(cat ~/secrets/pokoin-pg-roles/$r.pw)" \
       | docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d postgres -qX -v ON_ERROR_STOP=1
   done
   ```
   The password travels on stdin, never in a process argument or the server log. Roles and
   passwords replicate to the Pi standby.
5. **pg_hba.** On the writer (`/var/lib/postgresql/data/pg_hba.conf`), next to the existing
   `pokoin_marketplace` lines:
   ```
   hostssl all  pokoin_api_write  192.168.178.46/32  scram-sha-256   # Pi API + Pi job timers
   hostssl all  pokoin_api_write  172.31.250.20/32   scram-sha-256   # k3s overflow pods (SNAT)
   hostssl all  pokoin_jobs       172.31.250.20/32   scram-sha-256   # k3s CronJobs
   host    all  pokoin_jobs       172.17.0.1/32      scram-sha-256   # nezopt price cache, Oracle tunnel :15543
   host    all  pokoin_jobs       192.168.178.55/32  scram-sha-256   # nezopt host jobs over the LAN IP
   ```
   On the Pi standby: `hostssl all pokoin_api_read 172.18.0.1/32 scram-sha-256`. `pokoin_api_read` gets
   no line on the writer, and `pokoin_migrator` gets no network line anywhere. Then
   `select pg_reload_conf()` on each server, and check
   `select line_number, error from pg_hba_file_rules where error is not null` (expect none).
6. **Overflow pods (stage 1).** `nezopt-k3s.sh secret`, then
   `kubectl -n pokoin-overflow rollout restart deploy/pokoin-api`. Run one job by hand:
   `kubectl -n pokoin-overflow create job bl-check --from=cronjob/build-lists-sets`, and the same for
   `search-delta`. Verify with the queries below and the overflow `/readyz`. Watch the writer log for
   30 min: `docker logs --since 30m pokoin-marketplace-postgres-15t 2>&1 | grep -E 'permission denied|must be owner|read-only transaction|too many connections for role'`.
7. **nezopt price cache.** `~/.config/pokoin/price-cache-pg.env` (mode 600):
   `POKOIN_PRICE_CACHE_PG_USER=pokoin_jobs`, plus `POKOIN_PRICE_CACHE_PG_PASSWORD=` followed by the jobs
   password. Install the updated `deploy/systemd/pokoin-all-cardtrader-daily.service`,
   `systemctl --user daemon-reload`, and check the next run's `price-cache-status.json`.
8. **Pi (stage 2).** Back up `/srv/pokoin/rust/pokoin-api.env`. Set the read URLs to
   `pokoin_api_read` and the writer URL to `pokoin_api_write`. Leave `TCGCSV_DATABASE_URL`
   alone (separate server). Copy the two password files to `/root` (mode 600) first, so no
   password is typed:
   ```bash
   cd /srv/pokoin/rust && cp -p pokoin-api.env pokoin-api.env.bak-$(date -u +%Y%m%dT%H%M%SZ)
   R=$(cat /root/pokoin_api_read.pw) WR=$(cat /root/pokoin_api_write.pw)
   sed -E -i \
     -e "s#^((MARKETPLACE_DATABASE_URL|MARKETPLACE_NAME_SEARCH_DATABASE_URL|[A-Z_]+_MARKETPLACE_DATABASE_URL)=\"?postgres(ql)?://)[^@]+@#\1pokoin_api_read:$R@#" \
     -e "s#^(MARKETPLACE_WRITER_DATABASE_URL=\"?postgres(ql)?://)[^@]+@#\1pokoin_api_write:$WR@#" pokoin-api.env
   systemctl restart pokoin-rust-api
   ```
   Check `/readyz`, the loopback contract smoke and the queries below. The job timers pick up the env
   on their next run. Next, run `nezopt-k3s.sh secret` on nezopt: it now reads `pokoin_api_read` from
   the Pi and must still write `pokoin_api_write` for the pods.
9. **Oracle CardTrader ingest (stage 3)**, only if step 1 showed no DDL from `172.17.0.1`. On Oracle
   `pokoin-marketplace`, set the user of `MARKETPLACE_DATABASE_URL` (and every other database URL) to
   `pokoin_jobs` in `/home/ubuntu/cardtrader-oracle-api/.env` and in the dump env `.env.cardtrader-nezopt`.
   Restart `cardtrader-oracle-api` and let the next `pokoin-cardtrader-daily-market-refresh` run.
10. **Migration 125** (ownership to `pokoin_migrator`) once every client above is moved. Pick a quiet
    hour, not during the daily refresh. Run it on every database in `$DBS`, and rerun until each
    database reports `left_with_from_role 0`. Each `ALTER … OWNER` is its own short transaction with a
    3 s lock timeout. Afterwards SECURITY DEFINER functions run as `pokoin_migrator`, and migrations run
    as `docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_migrator -d <db>`.
11. **Close the superuser.** Remove the `pokoin_marketplace` lines for `192.168.178.46` and
    `172.31.250.20` from the writer pg_hba, and the `pokoin_marketplace` line from the Pi standby;
    then `pg_reload_conf()`. The `172.17.0.1`/`192.168.178.55` lines stay for the host scripts still on
    the superuser: the Node catalogue refresh, `sync-refreshed-catalogue-search`, site map and listing
    dump, and the Oracle ingest if step 9 was skipped.

### Verification

```sql
-- Attributes and limits (expect no t in the flag columns).
select rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolconnlimit
  from pg_roles where rolname like 'pokoin\_%' order by 1;
-- Who is connected as what (writer: no pokoin_marketplace from .46 / 172.31.250.20 after stage 2).
select usename, client_addr, datname, count(*) from pg_stat_activity
 where backend_type = 'client backend' group by 1, 2, 3 order by 4 desc;
-- The API roles cannot create anything (expect f, f, f, f).
select has_database_privilege('pokoin_api_write', current_database(), 'create'),
       has_schema_privilege('pokoin_api_write', 'public', 'create'),
       has_database_privilege('pokoin_api_read', current_database(), 'temporary'),
       has_schema_privilege('pokoin_jobs', 'public', 'create');
-- SECURITY DEFINER functions the API roles may call (expect the allow-list in 124 only).
select r.rolname, p.oid::regprocedure from pg_proc p
 cross join (values ('pokoin_api_read'), ('pokoin_api_write')) r(rolname)
 where p.prosecdef and has_function_privilege(r.rolname, p.oid, 'execute')
   and p.pronamespace = 'public'::regnamespace order by 1, 2;
-- Tables the API may write (pokoin_marketplace).
select table_name, string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
 where grantee = 'pokoin_api_write' and privilege_type in ('INSERT', 'UPDATE', 'DELETE') group by 1 order by 1;
-- A table nobody may read (a migration ran without default privileges): expect none.
select c.oid::regclass from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where (n.nspname = 'public' or n.nspname like 'marketplace\_%') and c.relkind in ('r', 'p', 'v', 'm')
   and not has_table_privilege('pokoin_api_read', c.oid, 'select');
```

The whole sequence (120–125, the role probes, rollback, and re-apply) was run against a schema-only
copy of `pokoin_marketplace`, `pokoin_magic` and `pokoin_weiss_schwarz` in a scratch container on
2026-10-15. Every migration exited 0 twice, and 125 moved 259 objects with none left behind. The
read role was read-only. The write role could do DML only on its tables (`permission denied for table
cardtrader_sold_daily`) and nothing else (`permission denied for schema public`, `must be owner`). The
listing audit trigger and `refresh_marketplace_blueprint_price_summary` worked under write and jobs.

### Rollback

- **A client stage (6–9):** put its login back. Pi: restore the `pokoin-api.env.bak-…` and restart.
  Overflow: move `~/secrets/pokoin-pg-roles/*.pw` aside, run `nezopt-k3s.sh secret`, and restart the
  deployment (the Pi must be back on `pokoin_marketplace` first, or the sync refuses). Price cache:
  remove `price-cache-pg.env`. Oracle: restore its `.env`. The superuser keeps its pg_hba lines until
  step 11, so nothing else is needed.
- **Step 11:** add the removed pg_hba lines back and reload.
- **Migration 125:** the same file with the roles swapped,
  `… -v from_role=pokoin_migrator -v to_role=pokoin_marketplace < scripts/sql/125_migrator_ownership.sql`.
- **Everything (124 and 125)**, after every client is back on the superuser:
  `scripts/sql/rollback-124-125-least-privilege.sql` on every database in `$DBS`, then once with
  `-d postgres -v drop_roles=1`. It reassigns ownership to `pokoin_marketplace`, drops every grant of the
  four roles, restores `PUBLIC`'s connect/temp and SECURITY DEFINER `EXECUTE`, and drops the roles.
  Migrations 120–123 stay: they are the schema production already had.
