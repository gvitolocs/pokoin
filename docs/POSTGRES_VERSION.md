# Postgres version: policy and update runbook

## Where things stand (2026-11-22)

| | |
| --- | --- |
| Production major | **17** (writer and Pi replica must always be the same major). Both run 17.11, measured 2026-11-22 (docker inspect). |
| Writer image, as measured | The live writer's container config records an image **id** (`sha256:18cfe3ef…`), not a tag, because it was created from the floating `postgres:17-alpine`; `postgres --version` in it says **17.11** and its `/etc/alpine-release` says **3.24.1**. Measured 2026-11-22 (docker inspect). |
| Writer image pin in the repo | `scripts/install-pokoin-postgres-nvme.sh:12` pins `postgres:17.11-alpine` for containers it creates, and `scripts/postgres-recreate.py` retags an existing one. Neither is what the live container was created from, so the pin is not evidence of the running minor — check the container (step 0 below). The pin's 17.11 is one minor behind the current 17 minor 17.12 (https://www.postgresql.org/support/versioning/, fetched 2026-11-22); that is a patch within 17, so the patch section covers it. |
| Current minors | 19.0, released 2026-11-19; 18.7; 17.12 — https://www.postgresql.org/support/versioning/ (fetched 2026-11-22). Minor fixes come "at least once every three months" and the project's advice is to "always run the current minor release associated with their major version" (https://www.postgresql.org/support/versioning/), which is what step 0 checks on the writer. |
| Support ends | 17: November 8, 2029. 18: November 14, 2030. 19: November 19, 2031. A major is supported "for 5 years after its initial release", and jumping one is allowed: "You can upgrade from one major version to another without upgrading to intervening versions, but we recommend reading the release notes of all intervening major versions prior to doing so." — all https://www.postgresql.org/support/versioning/ |
| 19 images | `postgres:19-alpine`, `postgres:19-alpine3.24` and `postgres:19.0-alpine` are one image — same manifest digest `sha256:8b0ff4cdf221f0c53d7fcda681d3b461be725c492cd881c5ec9c0ad25023f188` (measured 2026-11-22 on the pulled image, and the same value the tag listing reports) and amd64 digest `sha256:8e81a484…`, pushed 2026-11-20 — so `19-alpine` is Alpine 3.24, which is the release the writer runs; `19-alpine3.23` has a different digest (`sha256:8b9e23fd…`) — https://hub.docker.com/v2/repositories/library/postgres/tags?name=19-alpine and https://hub.docker.com/v2/repositories/library/postgres/tags?name=19.0. There is no 19.1 image yet: 19.0 is the only 19 minor. The upgrade script does not take this on faith: it reads the writer's own `/etc/alpine-release` and builds both tags on it (`scripts/postgres-major-upgrade.sh:48`), the way the 2026-10-12 rehearsal ran `17.11-alpine3.24` and `19beta4-alpine3.24`. |
| Upgrade tooling | Retargeted from 19beta4 to 19.0 on 2026-11-22: the default `NEW` in `infra/postgres-upgrade/Dockerfile`, `REL_19_0` in `bench/postgres/build-pg.sh` and the rehearsal examples. Nothing that runs today moved — every `17…` pin, including the CI and test images, stays as it is. Two changes to the rehearsal script the 19.0 cutover needs: it now takes the old minor from `docker exec <writer> postgres --version` when the container's config holds an image id instead of a `postgres:<major>.<minor>-alpine` tag — which is exactly the live writer above — and it refuses to start a copy-mode rehearsal with less than 2.2× the cluster size free in the work root, 1.2× for link mode (`POKOIN_PG_UPGRADE_SKIP_SPACE_CHECK=1` overrides). |

**Decision (Giuseppe, 2026-10-12):** stay on 17 and keep it on the latest
patch release. Skip 18. Make one major jump, 17 → 19, once 19.1 or 19.2 is
out, instead of migrating twice.

**Instruction (Giuseppe, 2026-11-22):** "prepare the migration to postgres 19
to leverage his new incredible features". Preparation only: the tooling now
targets the released 19.0, the section "From beta4 to GA" says which
rehearsal findings have to be re-run on it, and "Features to turn on after
the upgrade" lists what we would use once it runs. No cluster is migrated
here. **Which 19.x to cut over on is not decided.**

**Instruction (Giuseppe, 2026-11-22, later the same day):** "verify, then move
production to 19.0 today". That decides the target minor, so it supersedes
"which 19.x is not decided" above and the 2026-10-12 "once 19.1 or 19.2 is
out" for this cutover; the 2026-10-12 decision stays as the record of why 18
is skipped. No cluster has been migrated from a repository change: the state
below is what `docker inspect` and `psql` measured on the hosts today
(measured 2026-11-22), and the cutover steps further down are still to be run
as an explicit host operation.

## What runs Postgres

| Container | Host | Notes |
| --- | --- | --- |
| `pokoin-marketplace-postgres-15t` | nezopt, PGDATA `/home/nez/data/pokoin-marketplace-postgres-t2/data` | **Writer.** 17.11 on Alpine 3.24.1, from the floating `postgres:17-alpine` (its config holds image id `sha256:18cfe3ef…`, not a tag). Everything else about it — mounts, ports, flags, TLS, limits, networks — is in the measured table below. It was not created by `scripts/install-pokoin-postgres-nvme.sh` as that script now stands (it publishes port 25432 and asks for `--shm-size 5g`, `--memory 16g` and `shared_buffers=4GB`, and sets no `max_connections` at all — none of which matches the measured table below), and that script is a one-shot HDD → NVMe move: **never rerun it to change the image**, because it rsyncs the stale HDD copy over the live data. **No systemd unit owns it**: `pokoin-postgres-15t.service` does not exist on this host (measured 2026-11-22), and `restart=unless-stopped` is what brings it back. |
| `pokoin-marketplace-postgres-replica` | Pi | Streaming hot standby (slot `pokoin_pi_replica`), part of a Docker Compose project (network `pokoin-marketplace-replica_default`), not a hand-run `docker run`. The API reads it, so `GET /healthz` returns 503 while it is down. The Pi watchdog (`pokoin-pi-watchdog.timer`, every 5 min) starts and restarts it by name; stopping that timer needs root on the Pi. |
| `tcgprices-postgres-15t` | nezopt | TCGCSV prices: 17.11, one database of 34 GB (measured 2026-11-22). |
| scratch and test databases | anywhere | `docs/SCAN_CONNECT.md` and `pokoin-rust/crates/commerce/tests/*` use the floating `postgres:17-alpine`. That is fine for throwaway databases. |

### The writer as measured (2026-11-22, `docker inspect`, `psql`, `SHOW`)

| | |
| --- | --- |
| Ports | `127.0.0.1:25433` and `192.168.178.55:25433` → 5432. **Not 25432**, which is what `scripts/install-pokoin-postgres-nvme.sh:64-65` writes for containers it creates. |
| Mounts | `/home/nez/data/pokoin-marketplace-postgres-t2/data` → `/var/lib/postgresql/data`; `/home/nez/data/pokoin-marketplace-postgres-t2/run` → `/var/run/postgresql`. The old path without `-t2` is the pre-move layout. |
| Command | `-D /var/lib/postgresql/data -c max_connections=200 -c shared_buffers=256MB -c hot_standby=on -c hot_standby_feedback=on -c wal_level=replica -c max_wal_senders=8 -c max_replication_slots=8` |
| `postgresql.auto.conf` | `log_connections=on` — that is where the setting lives, not in the flags or `postgresql.conf`; `docs/RUST_RUNTIME.md:68` and `docs/SECURITY_HARDENING.md:29` are right about it being on, and the 2026-10-12 bench never read this file. |
| TLS | `ssl=on`, certificate and key under `data/tls/`, `ssl_min_protocol_version=TLSv1.2` |
| WAL retention | `max_slot_wal_keep_size=50GB` |
| Runtime | user `1000:1000`, `--shm-size` 64 MB, **no memory limit**, stop signal SIGINT, restart `unless-stopped`, networks `bridge` and `pokoin-overflow` (`172.31.250.10`) |
| Cluster | 27 databases, 29 GB total, data checksums **off**, `jit` on (measured 2026-11-22) |
| Work root | 112 GB free of 1.8 TB where the rehearsal root lives |

Two of these decide cutover mechanics. Checksums off means the new 19 cluster
must be initialised with `--no-data-checksums`, which
`infra/postgres-upgrade/upgrade-cluster.sh:39-53` already does from
`pg_controldata`. And 112 GB free against a 29 GB cluster is 3.9× — enough for
copy mode, which the rehearsal now insists on 2.2× of, and enough for the
1.8 TB figure this document used to assume nothing about.

### The Pi replica as measured (2026-11-22, `docker inspect`, compose files)

| | |
| --- | --- |
| Image | `postgres:17-alpine`, running 17.11 |
| Network | Docker Compose project, network `pokoin-marketplace-replica_default` |
| Ports | `127.0.0.1:5432` only |
| Mount | `/srv/pokoin/postgres` → `/var/lib/postgresql/data`, with `PGDATA` the `pgdata` subdirectory — beside `pgdata.oracle-20260912T135334Z` and `pgdata.timeline2`, two earlier states that are still on disk |
| TLS | certificates from `/etc/pokoinpos-postgres/certs` |
| Settings | `max_connections=200`, `shared_buffers=256MB`, `statement_timeout=30000`, `hot_standby_feedback=on` |

So the replica's upgrade is not an upgrade at all: it is a new `pg_basebackup`
off the new writer, and the sibling directories above are why any cleanup on
the Pi has to name `pgdata` exactly. The `pgdata` subdirectory layout is also
what `tools/pokoin-ops/src/backup/pitr.rs:118-123` mounts, which is the
pattern the 19 image's own `PGDATA` default does not use — see step 6 below.

Schema extensions in use: `citext`, `pg_trgm`, `unaccent`, `pgcrypto` — the
versions a fresh 19.0 restore of a 17 dump came up with are `citext` 1.8,
`pg_trgm` 1.6, `pgcrypto` 1.4 and `unaccent` 1.1 (measured 2026-11-22).
`citext` was missing from this list before today; the upgrade page's rule about
shared objects and never running `CREATE EXTENSION` by hand covers all four
(https://www.postgresql.org/docs/19/pgupgrade.html).

**No backup job is installed on either host** (measured 2026-11-22). That is a
second disagreement with `docs/BACKUPS_AND_ALERTS.md:10-11,28`, which describes
a nightly `pg_dump` timer at 03:30 over 26 databases; the tooling for it is in
`tools/pokoin-ops/src/backup/` and its systemd units are under `deploy/ops/`,
but nothing on these hosts runs them. For the cutover this matters in one way
only: the dump/restore path below was made by hand, and it is the only copy of
this data that has ever been proved to load into 19.

## Patch update within 17 (e.g. 17.x → 17.11)

A minor update only swaps binaries; the data directory stays as it is. Docker
cannot change a container's image in place, so
`scripts/postgres-recreate.py` rebuilds the container from `docker inspect`
with the new image. It keeps every setting, including ports, binds, user,
memory, `shm`, command, runtime env and static-IP networks. The old container
is kept, stopped and renamed `<name>-pre-<tag>`, and if the new one is not
ready within 180 s the script rolls back by itself. It refuses a change of
major and a moved PGDATA. Without `--apply` it only prints the plan.

0. **Check what runs**, on each host:

   ```bash
   docker exec <container> postgres --version
   docker inspect -f '{{.Config.Image}}' <container>
   ```

   If it already reports 17.11, there is nothing to update.

1. **Read the release notes.** For every minor between the running one and
   17.11, read the "Migration to Version 17.N" section of its release notes
   (https://www.postgresql.org/docs/release/). In 17.11, the only reindex
   advice concerns `btree_gist` indexes on float columns that may hold NaN,
   and `ltree`. Pokoin uses neither; confirm with
   `select extname from pg_extension`.

2. **Pi replica first.** Standbys are updated before the primary. If the Pi
   has no pokoin checkout, copy the script there first.

   ```bash
   sudo systemctl stop pokoin-pi-watchdog.timer
   docker pull postgres:17.11-alpine
   python3 postgres-recreate.py pokoin-marketplace-postgres-replica postgres:17.11-alpine   # read the plan
   python3 postgres-recreate.py pokoin-marketplace-postgres-replica postgres:17.11-alpine --apply
   docker exec pokoin-marketplace-postgres-replica psql -U pokoin_marketplace -d pokoin_marketplace \
     -Atc "select pg_is_in_recovery(), status from pg_stat_wal_receiver"                    # t|streaming
   curl -fsS https://api.pokoin.com/healthz
   sudo systemctl start pokoin-pi-watchdog.timer
   ```

   The Pi API returns 503 for the few seconds the replica restarts.

3. **nezopt writer**, at a quiet hour and not while the CardTrader dump is
   persisting:

   ```bash
   docker pull postgres:17.11-alpine
   scripts/postgres-recreate.py pokoin-marketplace-postgres-15t postgres:17.11-alpine
   scripts/postgres-recreate.py pokoin-marketplace-postgres-15t postgres:17.11-alpine --apply
   docker exec pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d pokoin_marketplace \
     -Atc "select application_name, state, replay_lag from pg_stat_replication"           # the Pi, streaming
   ```

   While the writer restarts (typically 10–30 s), writes fail: listing POSTs,
   the Oracle dump persist tunnel, and the overflow pods. The replica
   reconnects on its own through its slot. The script reattaches
   `pokoin-overflow` at `172.31.250.10`; if that step was skipped,
   `scripts/nezopt-k3s.sh up` reattaches it as well.

4. **After a day without problems**, remove the kept containers on both hosts:
   `docker rm <name>-pre-17.11-alpine`.

**Rollback**, if needed after the script has finished (it prints the exact
command): `docker rm -f <name> && docker rename <name>-pre-<tag> <name> && docker start <name>`,
then reconnect `pokoin-overflow` on the writer. Minor releases share the
on-disk format, so the old binaries read the data as it is.

## Major upgrade to 19 (prepared against 19.0; cut over on the 19.x the owner picks)

`postgres-recreate.py` refuses this on purpose: a major upgrade has to
rewrite the system catalogs. The tooling below was rehearsed against 19beta4
on 2026-10-12 and now points at 19.0, the release that came out on
2026-11-19. Everything in the two subsections that follow is still a beta4
measurement until it is re-run; what a GA re-run has to settle is
[below](#from-beta4-to-ga-what-must-be-checked-again).

| Piece | What it does |
| --- | --- |
| `infra/postgres-upgrade/Dockerfile` | The new official Alpine image plus the old release's binaries under `/opt/pg-old`, which `pg_upgrade` needs side by side. Both images on the writer's Alpine release; a passwd entry for the host uid that owns the data. |
| `infra/postgres-upgrade/upgrade-cluster.sh` | Runs inside that image: refuses an old cluster that is not cleanly shut down, `initdb`s the new one with the old checksum setting, encoding and locale, runs `pg_upgrade --check` and then `--copy` / `--clone` / `--link` / `--swap`, and carries over `pg_hba.conf`, `pg_ident.conf`, `postgresql.auto.conf` and any certificate files. `postgresql.conf` is only diffed. |
| `scripts/postgres-major-upgrade.sh rehearse <version>` | On nezopt, without touching the live writer: base backup of it, recovery and clean shutdown with its own 17 image, the upgrade in the image above, 19 started on the result with no network, extension updates, statistics, and a row-count check of the 12 largest tables against the 17 copy. Copy mode keeps the 17 copy, so `bench/postgres/run.py` can compare the two on the real catalogue. |
| `bench/postgres/` | Schema replay, synthetic data and the 17-vs-19 benchmark ([README](../bench/postgres/README.md)). |

### What the 19beta4 rehearsal found (2026-10-12)

Done twice: with source builds of 17.11 and 19beta4 on the replayed schema
and 2.5 GB of synthetic data (181 functions, 137 tables, 384 indexes), and
with the official `postgres:17.11-alpine3.24` and `19beta4-alpine3.24`
images (musl, `en_US.utf8`, as the writer was created) through
`upgrade-cluster.sh`.

- **Checksums.** `initdb` turns data checksums on by default since 18; the
  writer has them off, and `pg_upgrade --check` stops with "old cluster
  does not use data checksums but the new one does". The new cluster must be
  created with `--no-data-checksums` (`upgrade-cluster.sh` reads the old
  setting from `pg_controldata`).
- **Compatible.** With that, `pg_upgrade --check` reports *Clusters are
  compatible* and the upgrade completes: 3.4 s with `--link`, 5 s with
  `--copy` on the small official-image cluster. The time grows with the
  number of catalogue objects (every game database on the writer), not with
  data size in link mode; the rehearsal on production measures it.
- **Extensions.** `pgcrypto` goes 1.3 → 1.4 through the generated
  `update_extensions.sql`; `pg_trgm` 1.6, `unaccent` 1.1 and `plpgsql` are
  unchanged. Trigram search and `refresh_cardtrader_sold_daily` run on 19.
- **Statistics** come across: `vacuumdb --analyze-in-stages
  --missing-stats-only` finishes immediately.
- **Data.** Row counts and a hash over every removed-listing id match
  between 17 and the upgraded 19.
- **Configuration.** The only `postgresql.conf` difference is 19's new
  `autovacuum_worker_slots = 16` default. Replication slots are not carried
  over: recreate `pokoin_pi_replica` on the new writer before rebuilding the
  Pi replica.
- **Data path.** The 19 image keeps data in `/var/lib/postgresql/19/docker`
  with the volume at `/var/lib/postgresql`; an old-style mount at
  `/var/lib/postgresql/data` is rejected. The new writer mounts a new host
  directory at `/var/lib/postgresql` and the old data directory stays where
  it is, untouched in copy mode.

### Performance on Pokoin's workloads (19beta4, 2026-10-12)

The full results, with every round, are in
[bench/postgres/results/2026-10-12-summary.md](../bench/postgres/results/2026-10-12-summary.md).
They come from synthetic data, 3 rounds per workload, and a difference counts
only at ≥5% with no overlap between rounds.

- **Reads:** the card desk is 7–10% faster on 19, and search and the set
  page use about 8% less CPU per request. This is an engine gain: it holds
  with `io_method=sync`.
- **Nightly `sold_daily` rebuild:** no meaningful change, about 25 s on
  both. Its output is identical, row for row.
- **19's default `io_method = worker`:** vacuum is 17–23% slower and CardTrader
  book upserts 7% slower, and on stock memory settings the card desk loses
  23%. With `io_method=sync`, those costs go away and listing writes become
  28% faster than on 17.
- **Generic TPC-B** is 16–17% slower on 19beta4 with either I/O mode; Pokoin's
  own write paths don't show it. Check it again on GA.

So a performance gain alone doesn't justify a beta. At GA, set `io_method`
and `jit` explicitly (step 6 below) and repeat the comparison on production
data with `bench/postgres/run.py`, pointed at the rehearsal's 17 copy and its
19 upgrade.

### From beta4 to GA: what must be checked again

19.0 came out on 2026-11-19 (https://www.postgresql.org/docs/19/release-19.html), five weeks after the rehearsal above ran on beta4. A beta is not the released binary, and the release notes list changes made after it. Each line below names one thing the rehearsal measured or one thing the notes change, and the step that re-checks it. Two commands carry almost all of it: `scripts/postgres-major-upgrade.sh rehearse 19.0` (or a later 19.x) for the upgrade mechanics and the data, and `bench/postgres/` with the 19 side built from `REL_19_0` by `bench/postgres/build-pg.sh` for settings and performance.

- **Checksums at `initdb`.** Beta4: `initdb` has enabled data checksums by default since 18, the writer has them off, and `pg_upgrade --check` stopped with "old cluster does not use data checksums but the new one does" until the new cluster was created with `--no-data-checksums`; `infra/postgres-upgrade/upgrade-cluster.sh:39-45` reads the old setting from `pg_controldata` and passes the flag itself. GA: this is a *18* change and the 19 notes do not touch it (https://www.postgresql.org/docs/18/release-18.html). Re-check: `scripts/postgres-major-upgrade.sh rehearse 19.0` and the `initdb: new cluster created (--no-data-checksums, …)` line it prints.
- **`pg_upgrade --check`.** Beta4: *Clusters are compatible*, and the upgrade itself 3.4 s with `--link` and 5 s with `--copy` on 2.5 GB of synthetic data (181 functions, 137 tables, 384 indexes). The time grows with catalogue objects, and the writer holds 27 databases totalling 29 GB (measured 2026-11-22; `docs/BACKUPS_AND_ALERTS.md:10` records 26), so only a production rehearsal gives a window length. GA: three things in the release notes bear on the verdict. Two tighten it: "The btree_gist `inet`/`cidr` opclasses are broken because they can exclude rows that should be returned. pg_upgrade will disallow upgrading of clusters with btree_gist `inet`/`cidr` indexes", and carriage returns and line feeds in database, role and tablespace names are disallowed (https://www.postgresql.org/docs/19/release-19.html — the pg_upgrade page itself says nothing about either; https://www.postgresql.org/docs/19/pgupgrade.html was fetched 2026-11-22 and contains no `btree_gist` entry). One loosens it: 19's packaging changes "Allow pg_upgrade to process non-default tablespaces stored in the PGDATA directory", where "Previously such tablespaces generated an error" (https://www.postgresql.org/docs/19/release-19.html) — the writer's measured mounts are `data` and `run` only, so this buys us nothing today, but it means a beta4 refusal on that point is not a 19.0 refusal. Re-check: `infra/postgres-upgrade/upgrade-cluster.sh check` mode, which the rehearsal runs before it upgrades anything (`scripts/postgres-major-upgrade.sh:128-129`). Two gaps to close by hand: `check` mode runs `pg_upgrade --check` with no mode flag (`infra/postgres-upgrade/upgrade-cluster.sh:56`), while the pg_upgrade page says "If you are going to be using link, clone, copy-file-range, or swap mode, you should use the option `--link`, `--clone`, `--copy-file-range`, or `--swap` with `--check` to enable mode-specific checks" (https://www.postgresql.org/docs/19/pgupgrade.html); and neither rule can be checked from this repository alone: a search of it finds no `btree_gist` in any SQL, Rust or script (`PG19-INVENTORY.md:49`), no `inet` or `cidr` column declaration, and the only place this document names `btree_gist` at all is the 17.11 float/NaN reindex advice above (`docs/POSTGRES_VERSION.md:117-122`), which is a different opclass question; the database names we create are ASCII slugs (`scripts/create-multigame-ingest-databases.py:15-31`). Roles, tablespaces and any hand-made index on the writer are host state that only `--check` on the real cluster can see.
- **Extensions, and `pgcrypto` in particular.** Beta4: `pgcrypto` went 1.3 → 1.4 through the generated `update_extensions.sql`; `pg_trgm` 1.6, `unaccent` 1.1 and `plpgsql` did not move; trigram search and `refresh_cardtrader_sold_daily` ran on 19. GA: the release notes fix no extension versions, so the version comes from whatever the 19.0 image ships — and on the 19.0 image that is now measured, because the 17 dump restored cleanly into `postgres:19.0-alpine` with `citext` 1.8, `pg_trgm` 1.6, `pgcrypto` 1.4 and `unaccent` 1.1 (see "Onto 19 without pg_upgrade" below). The upgrade page is the rule: "Many extensions and custom modules … use shared object files (or DLLs) … If the old cluster used these, shared object files matching the new server binary must be installed in the new cluster", "Do not load the schema definitions, e.g., `CREATE EXTENSION pgcrypto`, because these will be duplicated from the old cluster", and "If extension updates are available, pg_upgrade will report this and create a script that can be run later to update them" (https://www.postgresql.org/docs/19/pgupgrade.html, quoted from the page fetched 2026-11-22). Re-check: the rehearsal applies `/work/update_extensions.sql` (`scripts/postgres-major-upgrade.sh:144-146`). Missing check: the rehearsal reads `select version()` (`:154`) but never compares extension versions, and with 27 databases on the writer that is per-database — `select extname, extversion from pg_extension` before on the writer, after on the upgraded copy.
- **Statistics carried over.** Beta4: they came across, and `vacuumdb --all --analyze-in-stages --missing-stats-only` finished immediately. GA: unchanged — the transfer came in with 18 and pg_upgrade still says it moves "most optimizer statistics", not custom or cumulative-system statistics (https://www.postgresql.org/docs/19/pgupgrade.html). Re-check: the same `vacuumdb` line in the rehearsal (`scripts/postgres-major-upgrade.sh:147`); how long it takes on the real catalogue is a window number, not a beta number.
- **Data.** Beta4: row counts and a hash over every removed-listing id matched between the 17 copy and the upgraded 19. GA: nothing in the notes changes stored values, with one exception — the trigram and full-text classification change below, which changes how *derived* values come out. Re-check: `scripts/postgres-major-upgrade.sh:109-110,148-153` (the 12 largest tables, counted on the 17 copy and on the 19 result and diffed) and the output-md5 pass of `bench/postgres/verify.py`. Independently, on the dump path: a `pg_dump -Fc` of all 27 databases restored into `postgres:19.0-alpine` with matching object counts and matching row counts on the ten largest tables (measured 2026-11-22) — which checks the same data through the other route onto 19, not through `pg_upgrade`.
- **The configuration diff.** Beta4: 53 settings differed (`bench/postgres/results/2026-10-12-summary.md:25`; the table runs `bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:80-132`) and the only `postgresql.conf` difference was 19's new `autovacuum_worker_slots = 16` default. GA: the 19 notes describe the autovacuum scoring weights and parallel workers by name (`autovacuum_freeze_score_weight`, `autovacuum_vacuum_score_weight`, `autovacuum_analyze_score_weight`, `autovacuum_max_parallel_workers`, per-table `autovacuum_parallel_workers`, view `pg_stat_autovacuum_scores`) but never mention `autovacuum_worker_slots`, and neither does `PG19-RESEARCH.md` (searching it for `autovacuum_worker_slots` and for `max_worker_processes` returns nothing), so that name is a beta4 observation that no page in this preparation confirms. Re-check: the settings pass of `bench/postgres/verify.py` against a 19.0 server — it prints every row that differs from 17 and is the only tool here that can catch a setting that appeared, vanished or was renamed between beta4 and GA.
- **Replication slots.** Beta4: slots are not carried over, and `pokoin_pi_replica` has to exist again on the new writer before the Pi is rebuilt. GA: still pg_upgrade's own step, plus two new timers that can end the Pi slot on their own — `idle_replication_slot_timeout` (18; on beta4 present and `0 s`, i.e. off, `bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:100`) and `wal_sender_shutdown_timeout` (19; beta4 recorded it absent on 17 and `-1 ms` on 19, `bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:132`, and GA adds it "to limit replica synchronization waits during shutdown" with "By default, senders still wait forever for synchronization" — https://www.postgresql.org/docs/19/release-19.html, read 2026-11-22 — so on GA it cannot end the Pi slot on its own unless someone sets it). Re-check: the same settings pass, read for the GA *default* of `idle_replication_slot_timeout`: if 19.0 shipped it non-zero, a replica stopped for the window stops protecting its slot, and the only thing keeping WAL on disk is `max_slot_wal_keep_size = 50GB` (`scripts/backup/install-ops-nezopt.sh:99`). Missing check: no file in this repository creates a replication slot (`pg_create_physical_replication_slot` appears nowhere), and the cutover text below only names the slot inside `pg_basebackup -R -S pokoin_pi_replica`; settle on the rehearsal which command creates it, because the two orders are not the same operation. The pg_upgrade page settles the rest of it: for any mode other than link the standby is not rsync-upgraded at all — "skip the instructions in this section and simply recreate the standby servers once pg_upgrade completes and the new primary is running" — and of the slots it says "If the old primary is version 17.0 or later, then only logical slots on the primary are copied to the new standby, but other slots on the old standby are not copied, so must be recreated manually" (https://www.postgresql.org/docs/19/pgupgrade.html, read 2026-11-22). The writer is 17.11 and `pokoin_pi_replica` is a physical slot, so that slot is created by hand on 19 whatever mode is chosen; and the shutdown order is a rule too, because "Streaming replication and log-shipping standby servers must be running during this shutdown so they receive all changes" (https://www.postgresql.org/docs/19/pgupgrade.html).
- **The PGDATA path and the mount.** Beta4: the 19 image keeps its data in `/var/lib/postgresql/19/docker` with the volume at `/var/lib/postgresql`, and an old-style mount at `/var/lib/postgresql/data` is rejected, so the new writer mounts a *new* host directory. GA: nothing in the notes fixes that path, so it is read from the image rather than assumed — `scripts/postgres-major-upgrade.sh:119` asks `docker image inspect` for `PGDATA` and hands it to `upgrade-cluster.sh`, which prints the directory it initialised (`infra/postgres-upgrade/upgrade-cluster.sh:47-53`). Measured 2026-11-22: the live writer mounts the old style — `/home/nez/data/pokoin-marketplace-postgres-t2/data` → `/var/lib/postgresql/data` — so the 19 writer does need a new host directory, and the rehearsal's `PGDATA` line is what names it. Re-check: those two lines on 19.0. Still untested: the restore tooling mounts the rejected layout — `tools/pokoin-ops/src/backup/verify.rs:246` uses `/var/lib/postgresql/data` and `pitr.rs:118-123` a `pgdata` subdirectory — and its image default is `postgres:17.11-alpine` (`tools/pokoin-ops/src/backup/mod.rs:74`), so the monthly restore test (`deploy/ops/nezopt-user/pokoin-restore-test.service:2`) has to be dry-run once with `POKOIN_RESTORE_IMAGE` pointing at a 19 tag. The one-shot installer's mount (`scripts/install-pokoin-postgres-nvme.sh:66`) is the same old layout and must not be reused for 19.
- **`io_method`.** Beta4: 19's default `worker` cost vacuum 17-23% and CardTrader book upserts 7%, and lost the card desk 23% on stock memory; with `io_method=sync` those costs went away and listing writes came out 28% faster than 17 (`bench/postgres/results/2026-10-12-summary.md:14`). GA: 19 keeps 18's async subsystem and lets `worker` start and stop its own processes through `io_min_workers`, `io_max_workers`, `io_worker_launch_interval` and `io_worker_idle_timeout`, while `io_workers` is removed outright (https://www.postgresql.org/docs/19/release-19.html). The removal cannot break our configuration: no file here sets `io_workers` — the only mention is a name list over `pg_settings` (`bench/postgres/sequence.sh:35`), which simply returns no row on either version. Re-check: the sync control again on 19.0, `bench/postgres/sequence.sh` steps 5 and 6 (`:87,95` write `io_method = sync` into the 19 cluster's conf and restart it), and the same on production data through the rehearsal. `io_uring` has never been measured here (`2026-10-12-summary.md:37`). Until that re-run exists the writer's `-c io_method` at step 6 below is undecided, not settled.
- **`jit`.** Beta4: both source builds were configured without LLVM, so JIT ran on neither side, and yet the settings table recorded 17 `jit=on` against 19beta4 `jit=off` (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:108`, with the build limit stated at `2026-10-12-summary.md:36`). GA: "Change JIT to be disabled by default" is now an intentional 19 change, and the notes tell a site doing many large analytical queries to enable it by hand (https://www.postgresql.org/docs/19/release-19.html). Our large analytical queries are `refresh_cardtrader_sold_daily(null)` and the price analytics over the observation table (`bench/postgres/verify.py:216,53`), and the official images do include LLVM. Re-check: the same control as steps 5-6 of `sequence.sh`, with `jit = on` instead of `io_method = sync`, on `run.py --only sold_daily_rebuild,observations_analytics`, 17 against 19.0.
- **`log_connections`.** Beta4: the diff recorded it `off` on 17.11 and *absent* on 19beta4 (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:110`), while `docs/RUST_RUNTIME.md:68` states it is on and `docs/SECURITY_HARDENING.md:29,174` audit who connected from those lines. Measured 2026-11-22, the writer's `postgresql.auto.conf` contains `log_connections=on`, and the bench compares `postgresql.conf` files — `bench/postgres/postgresql.bench.conf` and the `-c` flags — so it never read the file where the setting actually lives; that accounts for the `off` column but not for the *absent* one. Neither release-notes page mentions removing the setting, so why beta4 showed it absent is unexplained, and the GA settings pass is the arbiter: `verify.py` against a 19.0 server reads `pg_settings`, which sees `postgresql.auto.conf`. If the setting really is gone, both documents are wrong about how connections are audited and they must be fixed before the cutover, not after.
- **The performance numbers as a whole.** Every figure in the section above comes from `bench/postgres/results/2026-10-12-*` on beta4. The 19 notes list planner work that is easy to imagine arriving after beta4 ("Allow some aggregate processing to be performed before joins", `NOT IN` → `ANTI JOIN`, Memoize for `ANTI JOIN`s — https://www.postgresql.org/docs/19/release-19.html), and the beta4 report's defaults table has one row for the planner — 17.11 column blank, 19beta4 column "`enable_self_join_elimination`, `enable_eager_aggregate` on", action column "Nothing to set; part of the read gains" (`bench/postgres/results/2026-10-12-summary.md:104`). That is a note in a table of changed defaults, not a measured attribution of the read gains to those switches, its blank 17.11 cell understates 17: the two switches are ordinary planner GUCs that exist in 17 as well, off by default there — which is a reading of the settings' own history, not something this repository measured; `bench/postgres` records only what `pg_settings` answered on the two servers it compared. Re-check: rebuild both sides with `bench/postgres/build-pg.sh REL_17_11 17` and `REL_19_0 19`, run `bench/postgres/run.py` and `verify.py`, then repeat on the rehearsal's 17 copy and its 19 result. The generic TPC-B regression of 16-17% is explicitly flagged for a GA re-run (`2026-10-12-summary.md:15`).

The rest of the incompatibility lists in the release notes either does not reach us or reaches us in one narrow place, and the repository says which:

- **`standard_conforming_strings` is forced on in the server, and a dump that turns it off will not load into 19** (https://www.postgresql.org/docs/19/release-19.html; `escape_string_warning` is already gone on beta4, `bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:96`). Our dumps are `pg_dump -Fc -Z0` and `pg_dumpall --globals-only`, and both run *inside* the replica container, so client and server versions always match (`tools/pokoin-ops/src/backup/mod.rs:377,382`); the plain-SQL globals file is the one the note can bite, and no file here sets the parameter. Re-check: one restore test on 19.0 with a 17-era dump in place of the current one.
- **`COPY FROM` in CSV no longer treats `\.` as end-of-data unless it stands alone on its line, and older psql clients may hit `\copy` problems** (https://www.postgresql.org/docs/18/release-18.html). `scripts/satellite-scan-ingest.py:307-313` writes exactly that terminator, on its own line, so it already fits; the same script runs every night from `scripts/run-all-cardtrader-daily.sh:21`, and `scripts/refresh-all-cardtrader-pictures.py:97` reads `COPY … TO STDOUT WITH CSV HEADER`. Missing check: no test in this repository runs that ingest path; it has to be run once against the rehearsal's 19.
- **AFTER triggers now fire as the role that was active when the events were queued** (https://www.postgresql.org/docs/18/release-18.html: "Execute `AFTER` triggers as the role that was active when trigger events were queued… Previously such triggers were run as the role that was active at trigger execution time (e.g., at COMMIT)"). We have audit triggers on the listing paths (`scripts/sql/128_channel_synced_audit.sql:80`, `scripts/sql/144_listing_external_identity.sql:45`) and least-privilege roles running as them (`scripts/sql/124_least_privilege_roles.sql:53`). Re-check: the listing-write workload compares the end state row for row (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:138-154`), and `cargo test --workspace` against the rehearsal copy (step 1 below) covers the handlers.
- **Trigram indexes and stored `tsvector` values: reindex after the upgrade.** 18 moved full-text and `pg_trgm` character classification off "always libc" and 19 makes it follow the database's locale provider; both pages recommend reindexing every index that uses them and recomputing stored `tsvector` values (https://www.postgresql.org/docs/19/release-19.html). Our trigram use is production read paths — `word_similarity()` in `pokoin-rust/apps/api/src/search_page.rs:528` and `apps/api/src/game_search.rs:97,167`, `%%` and `similarity()` in `pokoin-rust/crates/search-api/src/autocomplete/engine.rs:3359,3439` — and `unaccent()` runs inside the expansion-slug expression `pokoin-rust/crates/catalog-api/src/shared/react_sql.rs:120`. No `to_tsvector` appears anywhere, so nothing is stored to recompute. Missing check: whether the writer holds a `gin_trgm_ops` or expression index at all — no definition in this repository creates one, and `pg_indexes` on the writer is the only answer; if one exists it must be reindexed and the search and autocomplete flow tests re-run on 19.
- **MD5 authentication is deprecated in 18 and warned about in 19, and the live writer is on MD5 today.** 18: "Deprecate MD5 password authentication… Support for MD5 passwords will be removed in a future major version release. CREATE ROLE and ALTER ROLE now emit deprecation warnings when setting MD5 passwords" (https://www.postgresql.org/docs/18/release-18.html, fetched 2026-11-22). 19: "Issue a warning after successful MD5 password authentication… The warning can be disabled via server variable `md5_password_warnings`. MD5 passwords were marked as deprecated in PostgreSQL 18." (https://www.postgresql.org/docs/19/release-19.html, quoted from the page saved today). `PG19-RESEARCH.md:125` carries a stronger sentence — "MD5 passwords are no longer supported for new connections. Existing MD5 passwords must be updated to use SCRAM-SHA-256 to continue using them." — which is from the 19 authentication documentation, not the release notes, and was not re-fetched today; treat it as unconfirmed and read `docs/19/auth-password.html` before relying on it. **Measured 2026-11-22: the writer's `pg_hba.conf` authenticates `md5`** — scram-sha-256 appears in `pg_hba.conf.sample` only — so this is not a future problem for us; every log line from 19 says "user \"pokoin_marketplace\" used an MD5 password", and the passwords themselves are stored as MD5 hashes. The fix cannot be done by the upgrade: an MD5-stored hash cannot be turned into a SCRAM verifier without the plaintext, so each role's password must be *set again* under `password_encryption = scram-sha-256`, `pg_hba.conf` changed to `scram-sha-256`, and every client checked that it speaks SCRAM. The Rust side does: sqlx 0.8 implements `auth_scram` in pure Rust (`pokoin-rust/Cargo.lock:1308-1316`), with no libpq on the hot path (`pokoin-rust/docs/RUST_MIGRATION.md:255`). The planned least-privilege writer roles are already `scram-sha-256` (`scripts/sql/124_least_privilege_roles.sql:15`, `docs/SECURITY_HARDENING.md:195-201`) — that sentence is about those roles, not about what runs. Re-check: `select rolname, case when rolpassword ~ '^\$2[ab]\$' then 'scram' when rolpassword ~ '^[0-9a-f]{32}\$' then 'md5' else 'other' end from pg_authid` on the writer before the cutover, and again after the passwords are re-set; `md5_password_warnings` was already present on beta4 (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:117`), so the GA settings pass will confirm the default is on.
- **Time zone abbreviation handling changed in 18** (https://www.postgresql.org/docs/18/release-18.html: "The system will now favor the current session's time zone abbreviations before checking the server variable `timezone_abbreviations`. Previously `timezone_abbreviations` was checked first"). Our SQL names `'utc'` in two places — `pokoin-rust/apps/ct-ask-unpad/src/sql.rs:397,399` and the `to_char(… at time zone 'utc', …)` stamps in `pokoin-rust/crates/external/src/pricing_store.rs:14-15` — and no committed setting names `timezone` or `timezone_abbreviations`. Re-check: those two crates' tests (`pokoin-rust/apps/ct-ask-unpad/tests/container.sh`, `pokoin-rust/crates/external/tests/pricing_store_flow.rs`) against the 19 copy.
- **`max_locks_per_transaction` doubles, 64 → 128, and shared memory follows** (https://www.postgresql.org/docs/19/release-19.html: "Lock size allocation has changed, so effectively settings must now be doubled to match their capacity in previous releases"). Beta4 already recorded the doubling, `shared_memory_size` 2136 → 2146 MB and a new `num_os_semaphores = 192` (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:115,119,122`). We never set the parameter; and the container shape the installer writes is not the container that runs — `scripts/install-pokoin-postgres-nvme.sh:58-59,75` asks for `--shm-size 5g`, `--memory 16g` and `shared_buffers=4GB`, while the live writer measures 64 MB of `shm`, **no memory limit** and `shared_buffers=256MB` (measured 2026-11-22). Re-check: read `shared_memory_size` and `shared_memory_size_in_huge_pages` on the rehearsal's 19 and start it with the measured 64 MB `shm` and no memory limit, since that is the shape production actually runs in.
- **Parallel vacuum now shares the cost-based delay budget, so a `VACUUM` with parallel workers and cost-based delay "might run slower"** (https://www.postgresql.org/docs/19/release-19.html). Beta4 measured vacuum 16.8-22.6% slower and credited `io_method = worker` for it (`bench/postgres/results/2026-10-12-summary.md:56`); with beta4 data alone the two causes cannot be told apart. We set no `vacuum_cost_delay` and run no parallel `VACUUM` anywhere — the maintenance here is `vacuumdb --all --analyze-in-stages --missing-stats-only` (`scripts/postgres-major-upgrade.sh:122`) and plain `vacuum analyze` in the bench and tests. Re-check: `run.py --only book_vacuum_analyze` under both `io_method` settings on 19.0.
- **Wait events are renamed in 19** (`BUFFERPIN` → `BUFFER`, `BufferPin` → `BufferCleanup`, `BufferContent` gone, `BufferShared`/`BufferShareExclusive`/`BufferExclusive` new). Exactly one place in this repository names a wait event — `pokoin-rust/crates/external/tests/scan_rows_flow.rs:312`, on `wait_event_type = 'Lock'`, which is not renamed — and no dashboard of ours reads buffer waits. Re-check: that test on 19.
- **Nothing else from either list reaches us**, and the check for each is a search of this repository: no logical replication, publication or subscription exists, so the subscription-view rename and the logical-replication pages do not apply; no partitioned or inherited table exists (every `partition by` hit is a window clause), so 18's VACUUM/ANALYZE inheritance change and its unlogged-partitioned-table ban do not apply; no `on delete restrict` appears and the only SQLSTATE our code matches is `23505` (`pokoin-rust/crates/commerce/src/channel_sync.rs:263`), so 18's `23001` change is not ours to absorb; there is no `CREATE RULE`, no `postgres_fdw`, no `json_array()`, no `fuzzystrmatch`, no RADIUS, no `pg_backend_memory_contexts` reader and no C extension; every database is UTF8 (`scripts/postgres-major-upgrade.sh:61` reads template0's encoding and the new cluster is initialised with it), so the `MULE_INTERNAL` removal is not ours either; `COPY … FROM` is used in two places and neither carries a `WHERE` clause, so the system-column ban is a rule for the future, not a re-check; and pg_upgrade's standing limit that no table column may use a `reg*` OID-referencing type (https://www.postgresql.org/docs/19/pgupgrade.html) holds today — the `regclass` and `regprocedure` hits in `scripts/sql` are casts inside migration queries, e.g. `scripts/sql/125_migrator_ownership.sql:49`, not columns.

### Features to turn on after the upgrade

None of these runs before the cutover, and none of them decides which 19.x to take. The only numbers this repository owns are the beta4 files under `bench/postgres/results/`, so a line that has no 19.0 measurement says *not measured*, and no line here promises a speed-up.

**Bulk writes and WAL volume — the nightly CardTrader refresh.**

- `wal_compression` uses the best method available instead of always `pglz` (19, https://www.postgresql.org/docs/19/release-19.html). It only matters if we turn it on: no committed setting names it, so it is off today — the writer's flags are `scripts/install-pokoin-postgres-nvme.sh:70-80` and the bench mirrors them at `bench/postgres/postgresql.bench.conf:3-13`. Not measured: beta4 recorded *equal* WAL bytes per transaction on both write paths, 7,327 against 7,329 for listing writes and 3,549 on both sides for book upserts (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:147,165`), which is what WAL looks like with compression off on both.
- TOAST compression now defaults to `lz4` instead of `pglz` (19, https://www.postgresql.org/docs/19/release-19.html), for columns and tables created after the upgrade; rows written earlier keep what they were written with. Nothing to set. It applies to the jsonb the nightly dump lands — read back with `->>` and `#>>` in `scripts/sql/063_collector_from_blueprint_image.sql:40` and `scripts/sql/064_pokemon_rarity_into_card_number.sql:43`. Not measured for size or WAL.
- The bytes written to WAL for full page images are now reported: "Add reporting of the bytes written to WAL for full page images… This is accessible via system view `pg_stat_wal` and function `pg_stat_get_backend_wal()`" (https://www.postgresql.org/docs/19/release-19.html, quoted from the page saved today). `PG19-RESEARCH.md:25` also records entries quoting "Add reporting of WAL full-page write bytes to `EXPLAIN (ANALYZE, WAL)`" and to "VACUUM and ANALYZE logging"; today's read of the page was truncated at the top, saw only the view-and-function sentence above, so treat those two surfaces as research's record rather than a re-read line. This is the measurement we do not have: WAL today comes from `pg_current_wal_lsn()` deltas (`bench/postgres/writes.py:92,132`), which cannot show the full-page-image share that `max_wal_size` and `checkpoint_timeout` decide — the installer asks 4GB and 15min for containers it creates (`scripts/install-pokoin-postgres-nvme.sh:79-80`), and `SHOW max_wal_size, checkpoint_timeout` on the live writer is what names the values it actually runs with, which were not read today. Where it goes: `bench/postgres/writes.py`, next to the WAL bytes per transaction it already reports. Not measured.
- `COPY FROM` text and CSV uses SIMD, table scans may mark pages all-visible in the visibility map, and hash-index bulk deletion and GIN vacuuming stream their reads (19, https://www.postgresql.org/docs/19/release-19.html). Automatic, nothing to set; our COPY sites are `bench/postgres/seed.sql:16-18`, `scripts/satellite-scan-ingest.py:307-313` and `scripts/refresh-all-cardtrader-pictures.py:97`. Not measured separately — the seeding COPY is inside every bench number.
- There is no "bulk write" or batched-WAL feature to enable: the two release-notes pages contain no such entry, and the four lines above are the whole of what 18 and 19 offer for WAL volume (checked 2026-11-22, https://www.postgresql.org/docs/18/release-18.html and https://www.postgresql.org/docs/19/release-19.html).

**Vacuum and bloat.**

- `REPACK` replaces `VACUUM FULL` and `CLUSTER`, rebuilds a table without the access-exclusive lock under `CONCURRENTLY`, and brings `max_repack_replication_slots` and `pg_stat_progress_repack` (19, https://www.postgresql.org/docs/19/release-19.html). No file here runs `VACUUM FULL` or `CLUSTER` today, so this is for the tables whose growth we do measure — 9.75 MB of table and 58.72 MB of index per 200,000 book upserts (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:167-168`). Using it is a SQL call at the desk; inside a migration it goes through `scripts/check-migrations.sh:21-55`. Not measured.
- Autovacuum can use parallel workers, through `autovacuum_max_parallel_workers` and the per-table `autovacuum_parallel_workers` storage parameter (19, https://www.postgresql.org/docs/19/release-19.html). Beta4 had the server variable at `0` (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:82`), so nothing happens until someone sets it per table. Not measured.
- A scoring system now orders the autovacuum queue (`autovacuum_freeze_score_weight`, `autovacuum_vacuum_score_weight`, `autovacuum_analyze_score_weight`, …, and `pg_stat_autovacuum_scores`; 19, https://www.postgresql.org/docs/19/release-19.html). Beta4 recorded every weight at `1` (`:80-86`), meaning the order is unchanged until we tune it for the nightly tables. Tuning, not a gain. Not measured.
- 18's vacuum changes are already in force and need nothing: normal vacuums freeze some all-visible pages early (`vacuum_max_eager_freeze_failure_rate`, `0.03` on beta4, `:130`) and `vacuum_truncate` is on (`:131`).

**Expression filters.**

- Generated columns can be virtual — computed when read — and that is now their default form (18, https://www.postgresql.org/docs/18/release-18.html). Today the expansion slug is rebuilt inside every query: `pokoin-rust/crates/catalog-api/src/shared/react_sql.rs:120` assembles `trim(both '-' from lower(regexp_replace(replace(public.unaccent(…), '&', ' and '), …)))`, and no generated column exists anywhere in `scripts/sql` or the Rust sources. Using it means a migration in `scripts/sql/` adding the column under `scripts/check-migrations.sh:21-55` and a change in `react_sql.rs` to filter on it. Not measured.
- Extended statistics now work on those virtual generated columns (19, https://www.postgresql.org/docs/19/release-19.html) — the follow-up to the line above, if that column becomes the filter. Not measured.
- Case handling got cheaper and more correct: repeated UTF-8 case folding is faster (19), `casefold()` was added (18) and so was the builtin `PG_UNICODE_FAST` collation provider (18). This is the same `lower(...)` path as the slug and the same text munging as `scripts/sql/070_platinum_arceus_sh_numbers.sql:9` and `scripts/sql/078_sm_gold_secret_rare.sql:26`. A collation is a schema decision per column, not a flag. Not measured.
- Planner rewrites that need nothing from us: btree skip scans, `IN (VALUES …)` treated as `x = ANY`, `OR`-clauses turned into arrays, aggregates before joins, `NOT IN` as `ANTI JOIN`, Memoize for `ANTI JOIN`s, and incremental sorts under Append/MergeAppend (18 and 19, both pages). 18 names no setting for skip scan. Part of what the beta4 read gains already measured — card desk +7.1% and search +6.1% tps, with 7.7% and 7.8% less server CPU per request on search and set page (`bench/postgres/results/2026-10-12-summary.md:40-47,74-84`), and the beta4 report credits the planner switches it saw for part of it (`:104`).

**Read-your-writes on the replica.** 19 adds a `WAIT` command: "Add `WAIT` command to allow standbys to wait for LSN values to be written, flushed, or replayed", and the headline list calls it "Support for "read-your-writes" consistency on standbys via the new `WAIT` command" (https://www.postgresql.org/docs/19/release-19.html, read 2026-11-22; `PG19-RESEARCH.md:54` records the same item). We already do this by polling, in exactly one place: the listing-sync consumer takes `pg_current_wal_lsn()` from the writer and then loops `select pg_last_wal_replay_lsn() >= $1::pg_lsn` on the read pool every 100 ms until `REPLICA_WAIT` (5 s) gives up and bumps the read generations anyway (`pokoin-rust/crates/commerce/src/listing_sync.rs:331-363`, the TLA+ rule it protects is named at `:336`). `WAIT` replaces that loop with one server-side wait: same semantics, no client-side timer, one round trip instead of up to fifty. That is the whole change, and it is a code change in `listing_sync.rs`, not a setting — nothing to turn on at the server. What it does **not** do is give read-your-writes anywhere else: every other replica read (desk, search, facets) is issued against whichever host the pool hands out with no LSN carried from the write, and no code in this repository threads an LSN into those paths, so making them consistent is an application design change that `WAIT` only makes *possible*. Not measured; the wait is bounded by replica lag either way.

**Asynchronous I/O.** The subsystem arrived in 18 (`io_method`, `io_combine_limit`, `pg_aios`) and 19 lets `worker` manage its own processes (`io_min_workers`, `io_max_workers`, `io_worker_idle_timeout`, `io_worker_launch_interval`); 19 also adds `EXPLAIN (ANALYZE, IO)` and `auto_explain.log_io` (https://www.postgresql.org/docs/18/release-18.html, https://www.postgresql.org/docs/19/release-19.html). The change we would make is one flag on the writer at step 6 below. Measured on beta4 only: `sync` beat `worker` on vacuum, on book upserts and on the card desk at stock memory, and turned listing writes 28% faster than 17 (`bench/postgres/results/2026-10-12-summary.md:14`). Nothing here has a 19.0 number, `io_uring` has never been measured, and `auto_explain` is loaded nowhere in this repository.

**Statistics that come across with `pg_upgrade`.** Since 18, `pg_upgrade` moves most optimiser statistics and `--no-statistics` turns that off; 19 improves the copying of large-object metadata (https://www.postgresql.org/docs/18/release-18.html, https://www.postgresql.org/docs/19/pgupgrade.html). Our path already takes the default: `infra/postgres-upgrade/upgrade-cluster.sh:60-61` passes no `--no-statistics`, and `scripts/postgres-major-upgrade.sh:122` then analyses only what is missing. Measured on beta4: statistics came across and that `vacuumdb` finished immediately (above). The follow-up that no number covers is what 18 and 19 add to *judging* them: `total_vacuum_time` and friends in `pg_stat_all_tables`, `stats_reset` in the table and index views, and `pg_stat_io` reporting bytes with WAL rows — none of which anything in this repository reads today.

**Monitoring.** 19 adds `pg_stat_lock`, `pg_stat_recovery`, `pg_stat_progress_repack`, `pg_stat_autovacuum_scores` and `pg_dsm_registry_allocations`, puts `started_by` and `mode` into `pg_stat_progress_vacuum` and `backup_type` into `pg_stat_progress_basebackup`, allows `log_min_messages` per process type, adds `log_autoanalyze_min_duration`, turns `log_lock_waits` on by default and moves the wraparound warning from 40 million to 100 million transactions away (https://www.postgresql.org/docs/19/release-19.html). Turning these on is new checks, not new settings: today the Postgres reads are `pg_stat_replication`, `pg_replication_slots`, `pg_stat_archiver`, `pg_stat_wal_receiver` and `pg_stat_activity` in `tools/pokoin-ops/src/sentinel.rs:563-609`, whose thresholds are written up at `docs/BACKUPS_AND_ALERTS.md:35`, and the retained-WAL cap they watch is `scripts/backup/install-ops-nezopt.sh:99`. Two of these are not optional reading: `log_lock_waits` was already `on` in the beta4 settings table (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:112`), so log volume rises with the upgrade unless the writer sets it back, and the wraparound warning changes when the writer starts complaining. Not measured.

## Onto 19 without pg_upgrade (tested today)

The rehearsal is not the only verified way onto 19. **Measured 2026-11-22:** a
full `pg_dump -Fc` of all 27 databases, taken off the live writer at 10:10 UTC
and 1.8 GB compressed, restored into a scratch `postgres:19.0-alpine`
container with 0 errors in 8 minutes; object counts matched and the ten
largest tables' row counts matched.

So dump/restore is a working second path onto 19.0 on this exact data, with
its own costs and its own guarantees:

| Dump/restore | `pg_upgrade` |
| --- | --- |
| Rebuilds every table from rows: index and table physical layout, fill factors and bloat are all reset. Statistics are not carried at all (`pg_upgrade` transfers "most optimizer statistics" — https://www.postgresql.org/docs/19/pgupgrade.html), so a `vacuumdb --all --analyze-in-stages --missing-stats-only` afterwards is mandatory, not a tidy-up. | Moves the existing files; the physical layout is inherited, statistics mostly come across, and `ANALYZE` only fills gaps. |
| Needs a new host directory and a fresh `initdb` anyway, so it does not care what the 19 image's default `PGDATA` is, and it never touches the writer's data directory. | The upgrade container needs the old PGDATA mounted read-only and initialises the new cluster inside `/var/lib/postgresql` (step 4). |
| Time: 8 minutes of restore measured for 1.8 GB of dump; the dump side was taken while the writer served, so this path can in principle run with no write pause at all if a consistent point is acceptable. | Beta4 wall clock on 2.5 GB synthetic data: 3.4 s link, 5 s copy. On the real 29 GB / 27-database cluster this is minutes and only a rehearsal measures it. |
| Survives whatever `pg_upgrade` refuses: if a GA check fails (a `btree_gist` `inet`/`cidr` index, a `reg*` column, a CR/LF name) the dump path still works, because it is SQL over the wire. | Refuses outright on those conditions. |
| The tooling in this repository is written for 17, not for this: `tools/pokoin-ops/src/backup/mod.rs:74` defaults its restore image to `postgres:17.11-alpine`, and `verify.rs:246` and `pitr.rs:118-123` mount the old-style layout that the 19 image rejects. So dump/restore onto 19 means overriding `POKOIN_RESTORE_IMAGE` (or running the commands by hand, as today's test was). | `infra/postgres-upgrade` is new in this preparation and is what the rehearsal exercises end to end. |

Decision for the ordered cutover: `pg_upgrade` stays the plan, because the
statistics transfer, the 12-largest-table row-count check and the
`update_extensions.sql` step are already scripted and measured, and the
rehearsal leaves both a 17 copy and a 19 result in the work dir for
`bench/postgres/run.py`. Today's dump is kept for what it is good at: it is a
17-era dump that has *proved it loads into 19*, which is the asset a rollback
or a refused upgrade would need.

## Cutover (on 19.0, ordered today)

1. Rehearse on production: `scripts/postgres-major-upgrade.sh rehearse 19.0`
   (copy mode; measured 2026-11-22 gives 112 GB free in the work root against
   a 29 GB cluster, so the script's 2.2× gate — 63.8 GB — passes, and link
   mode would need 34.8 GB). Then
   `cd pokoin-rust && cargo test --workspace` against the rehearsal copy.
   This rehearsal is also what re-answers the section above: its
   `--check`, `initdb`, timing and row-count lines are the named re-check
   for checksums, compatibility, the PGDATA path and the data itself, and
   the workspace tests are the re-check for the audit triggers, the `'utc'`
   queries and the wait-event test. Run the GA settings pass over the
   rehearsal's 19 too — `bench/postgres/verify.py` against a 19.0 server is
   what closes the `io_method`, `jit`, `log_connections`,
   `idle_replication_slot_timeout` and `shared_memory_size` questions above.
2. Application checks before the window, on a throwaway 19. The gate is the
   flow tests: `scripts/run-flow-tests.sh` runs every tracked
   `pokoin-rust/crates/*/tests/*_flow.rs` against a fresh database, and
   `cargo test -p <crate>` covers the touched crates
   (`docs/CI.md:32,75`, `docs/TESTING.md`) — that is where the listing,
   collection/inventory, cart, buy-order, price-export and seller-desk writes
   are proved against a real server. What that gate does **not** prove, and
   what this upgrade could therefore break unnoticed, is checkout and payment
   finalisation as one flow: the feature map records the Stripe Checkout
   session path as `status = "partial"` with unit-level proofs in
   `pokoin-rust/crates/commerce/src/handlers/stripe.rs`
   (`docs/FEATURES.toml:40-45`) and the fulfilment assertions in
   `pokoin-rust/crates/commerce/tests/firestore_flow.rs`
   (`docs/FEATURES.toml:47-53`, whose `entry` list is empty at `:51`), and the
   documented end-to-end proof of the money path is a **manual** Stripe
   test-mode walkthrough (`docs/CHECKOUT_EUR.md`, "Local checkout end to end
   (Stripe test mode)", from `:148`) run by hand against a throwaway Postgres.
   So on 19 that walkthrough has to be walked by hand before clients see the
   new writer, not afterwards — a webhook arriving at a 19 writer is exactly
   the untested path, and a price or discount regression there shows up as a
   wrong number on an order, not as a failed test.
3. Decide the mode, because it decides the rollback. Measured shape: the old
   data lives on the NVMe at `/home/nez/data/pokoin-marketplace-postgres-t2`
   and the rehearsal root is on the same filesystem, so link, clone and swap
   are all admissible there; `MODE` accepts all four in
   `infra/postgres-upgrade/upgrade-cluster.sh:15,30`. What each costs, in
   pg_upgrade's own words (https://www.postgresql.org/docs/19/pgupgrade.html,
   read 2026-11-22):

   | Mode | What it guarantees | What it costs |
   | --- | --- | --- |
   | `copy` (default) | The old cluster is left alone: "If neither `--link` nor `--swap` was used, the old cluster was unmodified; it can be restarted." | Disk, and the slowest transfer. 29 GB of it. |
   | `link` | Fast, little disk. | "you will not be able to access your old cluster once you start the new cluster after the upgrade" — rollback after that point is a restore from backup, not a restart. |
   | `clone` | "giving the speed advantages of `-k`/`--link` while leaving the old cluster untouched" | Only on Linux with Btrfs or XFS-with-reflink / macOS APFS: "If it is selected but not supported, the pg_upgrade run will error." Whether the NVMe filesystem supports reflink is not recorded here — check it with the rehearsal. |
   | `swap` | "This mode can outperform `--link`, `--clone`, `--copy`, and `--copy-file-range`, especially on clusters with many relations" — and 27 databases with hundreds of relations is that shape. | Destructive: "once the file transfer step begins, the old cluster will be destructively modified and therefore will no longer be safe to start", and "The old cluster will need to be restored from backup in this case." Requires old and new directories on the same filesystem. Use `--sync-method=fsync` with it, because the garbage files the mode leaves in the old cluster "can prolong the file synchronization step if `--sync-method=syncfs` is used". |

   `MODE=swap` is already wired through the rehearsal and the upgrade image
   (`scripts/postgres-major-upgrade.sh:28`,
   `infra/postgres-upgrade/upgrade-cluster.sh:60-61`), so the choice can be
   measured rather than argued — but note the gap recorded above: `check` mode
   passes no mode flag, so a mode's own checks only run in the second call,
   and a swap rehearsal should be run as `MODE=swap` from the start.
4. Stop the writes: the Oracle dump tunnel, `pokoin-overflow-sync.timer` and
   the overflow pods; the Pi API keeps reading its replica. Stop the writer
   cleanly. Streaming standbys must still be running during that shutdown so
   they receive all changes, and their "Latest checkpoint location" must match
   the primary's (https://www.postgresql.org/docs/19/pgupgrade.html).
5. Run the upgrade image on the writer's data directory
   (`upgrade-cluster.sh upgrade`) in the mode step 3 chose. With any mode
   other than `copy`, and with `swap` in particular, the file-level copy of the
   shut-down 17 directory is the precondition, not an option.
6. Start the new writer **local-only first**: on
   `postgres:19.0-alpine` — pin the minor, never the floating `19-alpine`, and
   mount the new host directory at `/var/lib/postgresql` because that is where
   the image's own `PGDATA` (`/var/lib/postgresql/19/docker`) lives, with the
   rehearsal printing which path it initialised — with the flags the writer
   actually runs with (the measured command above, plus whatever
   `postgresql.conf` and `postgresql.auto.conf` carry, which the rehearsal
   copies or diffs but does not enforce) plus the two that 19
   changes under us: an explicit `-c io_method` and an explicit `-c jit` (17
   runs with JIT on, 19 defaults to off). Bind only to loopback / publish only
   `127.0.0.1` at this stage: **the ports are the boundary**, and nothing
   outside this host can reach a writer that is still being checked. While it
   is local-only: run `update_extensions.sql`,
   `vacuumdb --all --analyze-in-stages --missing-stats-only`, recreate the
   slot `pokoin_pi_replica` (`pg_create_physical_replication_slot` — no file
   in this repository creates it, which is why it is named as a step and not
   assumed), read `jit`, `log_connections`, `idle_replication_slot_timeout`
   and `shared_memory_size` against what 17 runs with, reindex whatever
   `pg_trgm` or expression indexes the writer turns out to hold, and take the
   first `pg_dump` **on 19** — that dump is the rollback asset from here on.
   Then and only then reopen the LAN port `192.168.178.55:25433` and the
   `pokoin-overflow` attachment (`scripts/nezopt-k3s.sh up`). Two host-state
   items to carry over by hand, both measured today and neither checked by
   any tool here: the writer's TLS material lives in a `data/tls/`
   *subdirectory* while `infra/postgres-upgrade/upgrade-cluster.sh:70-72` only
   copies certificates and keys that sit at the top of the old PGDATA, so an
   `ssl=on` 19 cluster starts pointing at files that are not there; and the
   `log_connections=on` that `docs/RUST_RUNTIME.md:68` and
   `docs/SECURITY_HARDENING.md:29` rely on for connection auditing is set in
   `postgresql.auto.conf`, which the script does copy, but 19's defaults table
   in the bench recorded the setting as *absent* — which the settings pass in
   step 1 is the arbiter of.
7. Pi replica. A standby cannot stream from a different major, so the replica
   is rebuilt, not upgraded: stop the writes as in step 4, then build the 19
   replica in a **new directory beside the old one** with
   `pg_basebackup -R -S pokoin_pi_replica` from the new writer while the old
   replica keeps answering reads — those reads are stale from the moment the
   writer is cut over, and that is the honest description of the window: the
   API keeps serving from a replica that no longer matches the writer, rather
   than serving nothing. Then swap the two. The swap has a snag specific to
   this host: the Pi watchdog (`pokoin-pi-watchdog.timer`, every 5 min)
   starts and restarts the replica **by container name**, so a new replica in
   a new directory is not what it will find, and stopping that timer needs
   root on the Pi. Two ways out, both valid, and this document does not choose
   one: (a) stop the timer for the window and start it again after the swap,
   which needs the owner's root action on the Pi; or (b) rename the old
   container so the name `pokoin-marketplace-postgres-replica` is free, and
   give the new one that name — then the watchdog adopts the replacement with
   no root step, and the old container can be removed once `pg_stat_wal_receiver`
   says streaming. Check `pg_stat_wal_receiver` on the new replica and
   `pg_stat_replication` on the writer before the LAN port opens; the replica's
   own settings (`statement_timeout=30000`, `shared_buffers=256MB`) come from
   its compose file, so read that file rather than assuming the writer's flags.
8. Reopen writes. **The rollback boundary:** with `copy` mode the 17 data
   directory is untouched, so rolling back is free — stop 19, start the old
   container, everything before the window is there. The boundary is the 19
   writer's *first application write*: until then the two directories share no
   data and the old cluster is exactly as it was. After that first write, going
   back means losing everything written since, and the way back is forward
   (fix the 19 cluster and keep going) or a restore of a dump taken on 19 —
   never a restart of the 17 directory, which would reopen a cluster whose data
   19 has already moved on from. With `link` or `swap` mode that boundary is
   earlier still: the pg_upgrade page says the old cluster "will need to be
   restored from backup" once the new one has been started (link) or the file
   transfer has begun (swap), so in those modes there is no free rollback at
   any point after step 5. That is the argument for taking the first 19 dump in
   step 6, before any client is allowed in.
