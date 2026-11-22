# Postgres version: policy and update runbook

## Where things stand (2026-11-22)

| | |
| --- | --- |
| Production major | **17** (writer and Pi replica must always be the same major) |
| Writer image pin | `postgres:17.11-alpine` (`scripts/install-pokoin-postgres-nvme.sh`). Before this pin it was the floating `postgres:17-alpine`, so the running minor depends on when that tag was last pulled: check it (step 0 below). |
| Current minors | 19.0, released 2026-11-19; 18.7; 17.12 — https://www.postgresql.org/support/versioning/. Minor fixes come "at least once every three months" and the project's advice is to "always run the current minor release associated with their major version" (same URL), which is what step 0 checks on the writer. |
| Support ends | 17: November 8, 2029. 18: November 14, 2030. 19: November 19, 2031. A major is supported "for 5 years after its initial release", and jumping one is allowed: "You can upgrade from one major version to another without upgrading to intervening versions, but we recommend reading the release notes of all intervening major versions prior to doing so." — all https://www.postgresql.org/support/versioning/ |
| 19 images | `postgres:19-alpine`, `postgres:19-alpine3.24` and `postgres:19.0-alpine` are one image — same manifest digest `sha256:8b0ff4cd…` and amd64 digest `sha256:8e81a484…`, pushed 2026-11-20 — so `19-alpine` is Alpine 3.24; `19-alpine3.23` has a different digest (`sha256:8b9e23fd…`) — https://hub.docker.com/v2/repositories/library/postgres/tags?name=19-alpine and https://hub.docker.com/v2/repositories/library/postgres/tags?name=19.0. There is no 19.1 image yet: 19.0 is the only 19 minor. The upgrade script does not take this on faith: it reads the writer's own `/etc/alpine-release` and builds both tags on it (`scripts/postgres-major-upgrade.sh:46`), the way the 2026-10-12 rehearsal ran `17.11-alpine3.24` and `19beta4-alpine3.24`. |
| Upgrade tooling | Retargeted from 19beta4 to 19.0 on 2026-11-22: the default `NEW` in `infra/postgres-upgrade/Dockerfile`, `REL_19_0` in `bench/postgres/build-pg.sh` and the rehearsal examples. Nothing that runs today moved — every `17…` pin, including the CI and test images, stays as it is. |

**Decision (Giuseppe, 2026-10-12):** stay on 17 and keep it on the latest
patch release. Skip 18. Make one major jump, 17 → 19, once 19.1 or 19.2 is
out, instead of migrating twice.

**Instruction (Giuseppe, 2026-11-22):** "prepare the migration to postgres 19
to leverage his new incredible features". Preparation only: the tooling now
targets the released 19.0, the section "From beta4 to GA" says which
rehearsal findings have to be re-run on it, and "Features to turn on after
the upgrade" lists what we would use once it runs. No cluster is migrated
here. **Which 19.x to cut over on is not decided.**

## What runs Postgres

| Container | Host | Notes |
| --- | --- | --- |
| `pokoin-marketplace-postgres-15t` | nezopt, PGDATA `/home/nez/data/pokoin-marketplace-postgres/data` | **Writer.** Created by `scripts/install-pokoin-postgres-nvme.sh`, which is a one-shot HDD → NVMe move: **never rerun it to change the image**, because it rsyncs the stale HDD copy over the live data. Also attached to the Docker network `pokoin-overflow` at `172.31.250.10` for the k3s overflow (`scripts/nezopt-k3s.sh`). Started and stopped by name by `pokoin-postgres-15t.service`. |
| `pokoin-marketplace-postgres-replica` | Pi | Streaming hot standby (slot `pokoin_pi_replica`). Created by hand: there is no script for it in this repo. The API reads it, so `GET /healthz` returns 503 while it is down. The Pi watchdog (`pokoin-pi-watchdog.timer`, every 5 min) starts and restarts it by name. |
| `tcgprices-postgres-15t` | nezopt | TCGCSV prices. Its version is not recorded in this repo; check it with step 0. |
| scratch and test databases | anywhere | `docs/SCAN_CONNECT.md` and `pokoin-rust/crates/commerce/tests/*` use the floating `postgres:17-alpine`. That is fine for throwaway databases. |

Schema extensions in use: `pg_trgm`, `unaccent`, `pgcrypto`.

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
and `jit` explicitly (step 4 below) and repeat the comparison on production
data with `bench/postgres/run.py`, pointed at the rehearsal's 17 copy and its
19 upgrade.

### From beta4 to GA: what must be checked again

19.0 came out on 2026-11-19 (https://www.postgresql.org/docs/19/release-19.html), five weeks after the rehearsal above ran on beta4. A beta is not the released binary, and the release notes list changes made after it. Each line below names one thing the rehearsal measured or one thing the notes change, and the step that re-checks it. Two commands carry almost all of it: `scripts/postgres-major-upgrade.sh rehearse 19.0` for the upgrade mechanics and the data, and `bench/postgres/` with the 19 side built from `REL_19_0` by `bench/postgres/build-pg.sh` for settings and performance.

- **Checksums at `initdb`.** Beta4: `initdb` has enabled data checksums by default since 18, the writer has them off, and `pg_upgrade --check` stopped with "old cluster does not use data checksums but the new one does" until the new cluster was created with `--no-data-checksums`; `infra/postgres-upgrade/upgrade-cluster.sh:39-45` reads the old setting from `pg_controldata` and passes the flag itself. GA: this is a *18* change and the 19 notes do not touch it (https://www.postgresql.org/docs/18/release-18.html). Re-check: `scripts/postgres-major-upgrade.sh rehearse 19.0` and the `initdb: new cluster created (--no-data-checksums, …)` line it prints.
- **`pg_upgrade --check`.** Beta4: *Clusters are compatible*, and the upgrade itself 3.4 s with `--link` and 5 s with `--copy` on 2.5 GB of synthetic data (181 functions, 137 tables, 384 indexes). The time grows with catalogue objects, and the writer holds 26-27 databases (`docs/BACKUPS_AND_ALERTS.md:11`), so only a production rehearsal gives a window length. GA: three things can change the verdict — non-default tablespaces inside `PGDATA` now upgrade instead of erroring, a cluster with `btree_gist` indexes on `inet`/`cidr` is refused, and a cluster whose database, role or tablespace names contain a carriage return or line feed is refused (https://www.postgresql.org/docs/19/release-19.html). Re-check: `infra/postgres-upgrade/upgrade-cluster.sh check` mode, which the rehearsal runs before it upgrades anything (`scripts/postgres-major-upgrade.sh:103-104`). Two gaps to close by hand: `check` mode runs `pg_upgrade --check` without the mode flag (`infra/postgres-upgrade/upgrade-cluster.sh:56`), while the pg_upgrade page says the mode should be passed with `--check` "to enable mode-specific checks" for link, clone, copy-file-range and swap (https://www.postgresql.org/docs/19/pgupgrade.html); and neither rule can be checked from this repository alone — no SQL or Rust file declares an `inet`/`cidr` column or creates `btree_gist` (the one mention rules it out, `docs/POSTGRES_VERSION.md:52-53`) and the database names we create are ASCII slugs (`scripts/create-multigame-ingest-databases.py:15-31`), but roles, tablespaces and any hand-made index on the writer are host state that only `--check` on the real cluster can see.
- **Extensions, and `pgcrypto` in particular.** Beta4: `pgcrypto` went 1.3 → 1.4 through the generated `update_extensions.sql`; `pg_trgm` 1.6, `unaccent` 1.1 and `plpgsql` did not move; trigram search and `refresh_cardtrader_sold_daily` ran on 19. GA: the release notes fix no extension versions, so the version comes from whatever the 19.0 image ships. The upgrade page is the rule: the extension *shared objects* must be installed for the new server, you must not run `CREATE EXTENSION` yourself because the definitions are carried over, and available updates are reported in a script pg_upgrade writes (https://www.postgresql.org/docs/19/pgupgrade.html). Re-check: the rehearsal applies `/work/update_extensions.sql` (`scripts/postgres-major-upgrade.sh:119-121`). Missing check: the rehearsal reads `select version()` (`:129`) but never compares extension versions, and with 26-27 databases on the writer that is per-database — `select extname, extversion from pg_extension` before on the writer, after on the upgraded copy.
- **Statistics carried over.** Beta4: they came across, and `vacuumdb --all --analyze-in-stages --missing-stats-only` finished immediately. GA: unchanged — the transfer came in with 18 and pg_upgrade still says it moves "most optimizer statistics", not custom or cumulative-system statistics (https://www.postgresql.org/docs/19/pgupgrade.html). Re-check: the same `vacuumdb` line in the rehearsal (`scripts/postgres-major-upgrade.sh:122`); how long it takes on the real catalogue is a window number, not a beta number.
- **Data.** Beta4: row counts and a hash over every removed-listing id matched between the 17 copy and the upgraded 19. GA: nothing in the notes changes stored values, with one exception — the trigram and full-text classification change below, which changes how *derived* values come out. Re-check: `scripts/postgres-major-upgrade.sh:123-128` (the 12 largest tables) and the output-md5 pass of `bench/postgres/verify.py`.
- **The configuration diff.** Beta4: 53 settings differed (`bench/postgres/results/2026-10-12-summary.md:25`; the table runs `bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:80-132`) and the only `postgresql.conf` difference was 19's new `autovacuum_worker_slots = 16` default. GA: the 19 notes describe the autovacuum scoring weights and parallel workers by name (`autovacuum_freeze_score_weight`, `autovacuum_vacuum_score_weight`, `autovacuum_analyze_score_weight`, `autovacuum_max_parallel_workers`, per-table `autovacuum_parallel_workers`, view `pg_stat_autovacuum_scores`) but never mention `autovacuum_worker_slots`, so that name is a beta4 observation the notes do not confirm. Re-check: the settings pass of `bench/postgres/verify.py` against a 19.0 server — it prints every row that differs from 17 and is the only tool here that can catch a setting that appeared, vanished or was renamed between beta4 and GA.
- **Replication slots.** Beta4: slots are not carried over, and `pokoin_pi_replica` has to exist again on the new writer before the Pi is rebuilt. GA: still pg_upgrade's own step, plus two new timers that can end the Pi slot on their own — `idle_replication_slot_timeout` (18; on beta4 present and `0 s`, i.e. off, `bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:100`) and `wal_sender_shutdown_timeout` (19, `:132`). Re-check: the same settings pass, read for the GA *default* of `idle_replication_slot_timeout`: if 19.0 shipped it non-zero, a replica stopped for the window stops protecting its slot, and the only thing keeping WAL on disk is `max_slot_wal_keep_size = 50GB` (`scripts/backup/install-ops-nezopt.sh:99`). Missing check: no file in this repository creates a replication slot (`pg_create_physical_replication_slot` appears nowhere), and the cutover text below only names the slot inside `pg_basebackup -R -S pokoin_pi_replica`; settle on the rehearsal which command creates it, because the two orders are not the same operation.
- **The PGDATA path and the mount.** Beta4: the 19 image keeps its data in `/var/lib/postgresql/19/docker` with the volume at `/var/lib/postgresql`, and an old-style mount at `/var/lib/postgresql/data` is rejected, so the new writer mounts a *new* host directory. GA: nothing in the notes fixes that path, so it is read from the image rather than assumed — `scripts/postgres-major-upgrade.sh:94` asks `docker image inspect` for `PGDATA` and hands it to `upgrade-cluster.sh`, which prints the directory it initialised (`infra/postgres-upgrade/upgrade-cluster.sh:50-52`). Re-check: those two lines on 19.0. Still untested: the restore tooling mounts the rejected layout — `tools/pokoin-ops/src/backup/verify.rs:246` uses `/var/lib/postgresql/data` and `pitr.rs:118-123` a `pgdata` subdirectory — and its image default is `postgres:17.11-alpine` (`tools/pokoin-ops/src/backup/mod.rs:74`), so the monthly restore test (`deploy/ops/nezopt-user/pokoin-restore-test.service:2`) has to be dry-run once with `POKOIN_RESTORE_IMAGE` pointing at a 19 tag. The one-shot installer's mount (`scripts/install-pokoin-postgres-nvme.sh:66`) is the same old layout and must not be reused for 19.
- **`io_method`.** Beta4: 19's default `worker` cost vacuum 17-23% and CardTrader book upserts 7%, and lost the card desk 23% on stock memory; with `io_method=sync` those costs went away and listing writes came out 28% faster than 17 (`bench/postgres/results/2026-10-12-summary.md:14`). GA: 19 keeps 18's async subsystem and lets `worker` start and stop its own processes through `io_min_workers`, `io_max_workers`, `io_worker_launch_interval` and `io_worker_idle_timeout`, while `io_workers` is removed outright (https://www.postgresql.org/docs/19/release-19.html). The removal cannot break our configuration: no file here sets `io_workers` — the only mention is a name list over `pg_settings` (`bench/postgres/sequence.sh:35`), which simply returns no row on either version. Re-check: the sync control again on 19.0, `bench/postgres/sequence.sh` steps 5 and 6 (`:87,95` write `io_method = sync` into the 19 cluster's conf and restart it), and the same on production data through the rehearsal. `io_uring` has never been measured here (`2026-10-12-summary.md:37`). Until that re-run exists the writer's `-c io_method` at step 4 below is undecided, not settled.
- **`jit`.** Beta4: both source builds were configured without LLVM, so JIT ran on neither side, and yet the settings table recorded 17 `jit=on` against 19beta4 `jit=off` (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:108`, with the build limit stated at `2026-10-12-summary.md:36`). GA: "Change JIT to be disabled by default" is now an intentional 19 change, and the notes tell a site doing many large analytical queries to enable it by hand (https://www.postgresql.org/docs/19/release-19.html). Our large analytical queries are `refresh_cardtrader_sold_daily(null)` and the price analytics over the observation table (`bench/postgres/verify.py:216,53`), and the official images do include LLVM. Re-check: the same control as steps 5-6 of `sequence.sh`, with `jit = on` instead of `io_method = sync`, on `run.py --only sold_daily_rebuild,observations_analytics`, 17 against 19.0.
- **`log_connections`.** Beta4: the diff recorded it `off` on 17.11 and *absent* on 19beta4 (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:110`), while `docs/RUST_RUNTIME.md:68` states it is on and `docs/SECURITY_HARDENING.md:29,174` audit who connected from those lines. Neither release-notes page mentions removing it, so the most likely reading is a beta-only artefact — but "most likely" is not a runbook. Re-check: the `verify.py` settings pass on 19.0; if the setting really is gone, both documents are wrong about how connections are audited and they must be fixed before the cutover, not after.
- **The performance numbers as a whole.** Every figure in the section above comes from `bench/postgres/results/2026-10-12-*` on beta4. The 19 notes list planner work that is easy to imagine arriving after beta4 ("Allow some aggregate processing to be performed before joins", `NOT IN` → `ANTI JOIN`, Memoize for `ANTI JOIN`s — https://www.postgresql.org/docs/19/release-19.html), and the beta4 report already credits the read gains in part to planner settings that were new then (`2026-10-12-summary.md:104`). Re-check: rebuild both sides with `bench/postgres/build-pg.sh REL_17_11 17` and `REL_19_0 19`, run `bench/postgres/run.py` and `verify.py`, then repeat on the rehearsal's 17 copy and its 19 result. The generic TPC-B regression of 16-17% is explicitly flagged for a GA re-run (`2026-10-12-summary.md:15`).

The rest of the incompatibility lists in the release notes either does not reach us or reaches us in one narrow place, and the repository says which:

- **`standard_conforming_strings` is forced on in the server, and a dump that turns it off will not load into 19** (https://www.postgresql.org/docs/19/release-19.html; `escape_string_warning` is already gone on beta4, `bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:96`). Our dumps are `pg_dump -Fc -Z0` and `pg_dumpall --globals-only`, and both run *inside* the replica container, so client and server versions always match (`tools/pokoin-ops/src/backup/mod.rs:377,382`); the plain-SQL globals file is the one the note can bite, and no file here sets the parameter. Re-check: one restore test on 19.0 with a 17-era dump in place of the current one.
- **`COPY FROM` in CSV no longer treats `\.` as end-of-data unless it stands alone on its line, and older psql clients may hit `\copy` problems** (https://www.postgresql.org/docs/18/release-18.html). `scripts/satellite-scan-ingest.py:307-313` writes exactly that terminator, on its own line, so it already fits; the same script runs every night from `scripts/run-all-cardtrader-daily.sh:21`, and `scripts/refresh-all-cardtrader-pictures.py:97` reads `COPY … TO STDOUT WITH CSV HEADER`. Missing check: no test in this repository runs that ingest path; it has to be run once against the rehearsal's 19.
- **AFTER triggers now fire as the role that was active when the events were queued** (same 18 page). We have audit triggers on the listing paths (`scripts/sql/128_channel_synced_audit.sql:80`, `scripts/sql/144_listing_external_identity.sql:45`) and least-privilege roles running as them (`scripts/sql/124_least_privilege_roles.sql:53`). Re-check: the listing-write workload compares the end state row for row (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:138-154`), and `cargo test --workspace` against the rehearsal copy (step 1 below) covers the handlers.
- **Trigram indexes and stored `tsvector` values: reindex after the upgrade.** 18 moved full-text and `pg_trgm` character classification off "always libc" and 19 makes it follow the database's locale provider; both pages recommend reindexing every index that uses them and recomputing stored `tsvector` values (https://www.postgresql.org/docs/19/release-19.html). Our trigram use is production read paths — `word_similarity()` in `pokoin-rust/apps/api/src/search_page.rs:528` and `apps/api/src/game_search.rs:97,167`, `%%` and `similarity()` in `pokoin-rust/crates/search-api/src/autocomplete/engine.rs:3359,3439` — and `unaccent()` runs inside the expansion-slug expression `pokoin-rust/crates/catalog-api/src/shared/react_sql.rs:120`. No `to_tsvector` appears anywhere, so nothing is stored to recompute. Missing check: whether the writer holds a `gin_trgm_ops` or expression index at all — no definition in this repository creates one, and `pg_indexes` on the writer is the only answer; if one exists it must be reindexed and the search and autocomplete flow tests re-run on 19.
- **MD5 authentication is deprecated in 18 and warned about in 19** (both pages). No md5 password exists in this repository — every `md5` hit is `md5sum` on a file or the bench's `md5()` over query output — and the planned writer roles use `scram-sha-256` (`scripts/sql/124_least_privilege_roles.sql:15`, `docs/SECURITY_HARDENING.md:195-201`). `md5_password_warnings` was already present on beta4 (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:117`). Re-check: the settings pass, plus a read of the roles the writer actually has, which is host state.
- **Time zone abbreviation handling changed in 18** (18 page: abbreviations now favour the session's time zone before consulting `timezone_abbreviations`). Our SQL names `'utc'` in two places — `pokoin-rust/apps/ct-ask-unpad/src/sql.rs:397,399` and the `to_char(… at time zone 'utc', …)` stamps in `pokoin-rust/crates/external/src/pricing_store.rs:14-15` — and no committed setting names `timezone` or `timezone_abbreviations`. Re-check: those two crates' tests (`pokoin-rust/apps/ct-ask-unpad/tests/container.sh`, `pokoin-rust/crates/external/tests/pricing_store_flow.rs`) against the 19 copy.
- **`max_locks_per_transaction` doubles, 64 → 128, and shared memory follows** (19 page: "settings must now be doubled to match their capacity in previous releases"). Beta4 already recorded the doubling, `shared_memory_size` 2136 → 2146 MB and a new `num_os_semaphores = 192` (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:115,119,122`). We never set the parameter; the writer's memory shape is `--shm-size 5g --memory 16g` with `shared_buffers=4GB` (`scripts/install-pokoin-postgres-nvme.sh:58-59,75`). Re-check: read `shared_memory_size` on the rehearsal's 19 and start it inside those same limits.
- **Parallel vacuum now shares the cost-based delay budget, so a `VACUUM` with parallel workers and cost-based delay "might run slower"** (19 page). Beta4 measured vacuum 16.8-22.6% slower and credited `io_method = worker` for it (`bench/postgres/results/2026-10-12-summary.md:56`); with beta4 data alone the two causes cannot be told apart. We set no `vacuum_cost_delay` and run no parallel `VACUUM` anywhere — the maintenance here is `vacuumdb --all --analyze-in-stages --missing-stats-only` (`scripts/postgres-major-upgrade.sh:122`) and plain `vacuum analyze` in the bench and tests. Re-check: `run.py --only book_vacuum_analyze` under both `io_method` settings on 19.0.
- **Wait events are renamed in 19** (`BUFFERPIN` → `BUFFER`, `BufferPin` → `BufferCleanup`, `BufferContent` gone, `BufferShared`/`BufferShareExclusive`/`BufferExclusive` new). Exactly one place in this repository names a wait event — `pokoin-rust/crates/external/tests/scan_rows_flow.rs:312`, on `wait_event_type = 'Lock'`, which is not renamed — and no dashboard of ours reads buffer waits. Re-check: that test on 19.
- **Nothing else from either list reaches us**, and the check for each is a search of this repository: no logical replication, publication or subscription exists, so the subscription-view rename and the logical-replication pages do not apply; no partitioned or inherited table exists (every `partition by` hit is a window clause), so 18's VACUUM/ANALYZE inheritance change and its unlogged-partitioned-table ban do not apply; no `on delete restrict` appears and the only SQLSTATE our code matches is `23505` (`pokoin-rust/crates/commerce/src/channel_sync.rs:263`), so 18's `23001` change is not ours to absorb; there is no `CREATE RULE`, no `postgres_fdw`, no `json_array()`, no `fuzzystrmatch`, no RADIUS, no `pg_backend_memory_contexts` reader and no C extension; every database is UTF8 (`scripts/postgres-major-upgrade.sh:61` reads template0's encoding and the new cluster is initialised with it), so the `MULE_INTERNAL` removal is not ours either; `COPY … FROM` is used in two places and neither carries a `WHERE` clause, so the system-column ban is a rule for the future, not a re-check; and pg_upgrade's standing limit that no table column may use a `reg*` OID-referencing type (https://www.postgresql.org/docs/19/pgupgrade.html) holds today — the `regclass` and `regprocedure` hits in `scripts/sql` are casts inside migration queries, e.g. `scripts/sql/125_migrator_ownership.sql:49`, not columns.

### Features to turn on after the upgrade

None of these runs before the cutover, and none of them decides which 19.x to take. The only numbers this repository owns are the beta4 files under `bench/postgres/results/`, so a line that has no 19.0 measurement says *not measured*, and no line here promises a speed-up.

**Bulk writes and WAL volume — the nightly CardTrader refresh.**

- `wal_compression` uses the best method available instead of always `pglz` (19, https://www.postgresql.org/docs/19/release-19.html). It only matters if we turn it on: no committed setting names it, so it is off today — the writer's flags are `scripts/install-pokoin-postgres-nvme.sh:70-80` and the bench mirrors them at `bench/postgres/postgresql.bench.conf:3-13`. Not measured: beta4 recorded *equal* WAL bytes per transaction on both write paths, 7,327 against 7,329 for listing writes and 3,549 on both sides for book upserts (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:147,165`), which is what WAL looks like with compression off on both.
- TOAST compression now defaults to `lz4` instead of `pglz` (19, same page), for columns and tables created after the upgrade; rows written earlier keep what they were written with. Nothing to set. It applies to the jsonb the nightly dump lands — read back with `->>` and `#>>` in `scripts/sql/063_collector_from_blueprint_image.sql:40` and `scripts/sql/064_pokemon_rarity_into_card_number.sql:43`. Not measured for size or WAL.
- The bytes written to WAL for full page images are now reported, in `pg_stat_wal`, in `pg_stat_get_backend_wal()`, in `EXPLAIN (ANALYZE, WAL)` and in VACUUM and ANALYZE logging (19, same page). This is the measurement we do not have: WAL today comes from `pg_current_wal_lsn()` deltas (`bench/postgres/writes.py:92,132`), which cannot show the full-page-image share that `max_wal_size=4GB` and `checkpoint_timeout=15min` decide (`scripts/install-pokoin-postgres-nvme.sh:79-80`). Where it goes: `bench/postgres/writes.py`, next to the WAL bytes per transaction it already reports. Not measured.
- `COPY FROM` text and CSV uses SIMD, table scans may mark pages all-visible in the visibility map, and hash-index bulk deletion and GIN vacuuming stream their reads (19, same page). Automatic, nothing to set; our COPY sites are `bench/postgres/seed.sql:16-18`, `scripts/satellite-scan-ingest.py:307-313` and `scripts/refresh-all-cardtrader-pictures.py:97`. Not measured separately — the seeding COPY is inside every bench number.
- There is no "bulk write" or batched-WAL feature to enable: the two release-notes pages contain no such entry, and the four lines above are the whole of what 18 and 19 offer for WAL volume (checked 2026-11-22, https://www.postgresql.org/docs/18/release-18.html and https://www.postgresql.org/docs/19/release-19.html).

**Vacuum and bloat.**

- `REPACK` replaces `VACUUM FULL` and `CLUSTER`, rebuilds a table without the access-exclusive lock under `CONCURRENTLY`, and brings `max_repack_replication_slots` and `pg_stat_progress_repack` (19, https://www.postgresql.org/docs/19/release-19.html). No file here runs `VACUUM FULL` or `CLUSTER` today, so this is for the tables whose growth we do measure — 9.75 MB of table and 58.72 MB of index per 200,000 book upserts (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:167-168`). Using it is a SQL call at the desk; inside a migration it goes through `scripts/check-migrations.sh:21-55`. Not measured.
- Autovacuum can use parallel workers, through `autovacuum_max_parallel_workers` and the per-table `autovacuum_parallel_workers` storage parameter (19, same page). Beta4 had the server variable at `0` (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:82`), so nothing happens until someone sets it per table. Not measured.
- A scoring system now orders the autovacuum queue (`autovacuum_freeze_score_weight`, `autovacuum_vacuum_score_weight`, `autovacuum_analyze_score_weight`, …, and `pg_stat_autovacuum_scores`; 19, same page). Beta4 recorded every weight at `1` (`:80-86`), meaning the order is unchanged until we tune it for the nightly tables. Tuning, not a gain. Not measured.
- 18's vacuum changes are already in force and need nothing: normal vacuums freeze some all-visible pages early (`vacuum_max_eager_freeze_failure_rate`, `0.03` on beta4, `:130`) and `vacuum_truncate` is on (`:131`).

**Expression filters.**

- Generated columns can be virtual — computed when read — and that is now their default form (18, https://www.postgresql.org/docs/18/release-18.html). Today the expansion slug is rebuilt inside every query: `pokoin-rust/crates/catalog-api/src/shared/react_sql.rs:120` assembles `trim(both '-' from lower(regexp_replace(replace(public.unaccent(…), '&', ' and '), …)))`, and no generated column exists anywhere in `scripts/sql` or the Rust sources. Using it means a migration in `scripts/sql/` adding the column under `scripts/check-migrations.sh:21-55` and a change in `react_sql.rs` to filter on it. Not measured.
- Extended statistics now work on those virtual generated columns (19, https://www.postgresql.org/docs/19/release-19.html) — the follow-up to the line above, if that column becomes the filter. Not measured.
- Case handling got cheaper and more correct: repeated UTF-8 case folding is faster (19), `casefold()` was added (18) and so was the builtin `PG_UNICODE_FAST` collation provider (18). This is the same `lower(...)` path as the slug and the same text munging as `scripts/sql/070_platinum_arceus_sh_numbers.sql:9` and `scripts/sql/078_sm_gold_secret_rare.sql:26`. A collation is a schema decision per column, not a flag. Not measured.
- Planner rewrites that need nothing from us: btree skip scans, `IN (VALUES …)` treated as `x = ANY`, `OR`-clauses turned into arrays, aggregates before joins, `NOT IN` as `ANTI JOIN`, Memoize for `ANTI JOIN`s, and incremental sorts under Append/MergeAppend (18 and 19, both pages). 18 names no setting for skip scan. Part of what the beta4 read gains already measured — card desk +7.1% and search +6.1% tps, with 7.7% and 7.8% less server CPU per request on search and set page (`bench/postgres/results/2026-10-12-summary.md:40-47,74-84`), and the beta4 report credits the planner switches it saw for part of it (`:104`).

**Asynchronous I/O.** The subsystem arrived in 18 (`io_method`, `io_combine_limit`, `pg_aios`) and 19 lets `worker` manage its own processes (`io_min_workers`, `io_max_workers`, `io_worker_idle_timeout`, `io_worker_launch_interval`); 19 also adds `EXPLAIN (ANALYZE, IO)` and `auto_explain.log_io` (https://www.postgresql.org/docs/18/release-18.html, https://www.postgresql.org/docs/19/release-19.html). The change we would make is one flag on the writer at step 4 below. Measured on beta4 only: `sync` beat `worker` on vacuum, on book upserts and on the card desk at stock memory, and turned listing writes 28% faster than 17 (`bench/postgres/results/2026-10-12-summary.md:14`). Nothing here has a 19.0 number, `io_uring` has never been measured, and `auto_explain` is loaded nowhere in this repository.

**Statistics that come across with `pg_upgrade`.** Since 18, `pg_upgrade` moves most optimiser statistics and `--no-statistics` turns that off; 19 improves the copying of large-object metadata (https://www.postgresql.org/docs/18/release-18.html, https://www.postgresql.org/docs/19/pgupgrade.html). Our path already takes the default: `infra/postgres-upgrade/upgrade-cluster.sh:60-61` passes no `--no-statistics`, and `scripts/postgres-major-upgrade.sh:122` then analyses only what is missing. Measured on beta4: statistics came across and that `vacuumdb` finished immediately (above). The follow-up that no number covers is what 18 and 19 add to *judging* them: `total_vacuum_time` and friends in `pg_stat_all_tables`, `stats_reset` in the table and index views, and `pg_stat_io` reporting bytes with WAL rows — none of which anything in this repository reads today.

**Monitoring.** 19 adds `pg_stat_lock`, `pg_stat_recovery`, `pg_stat_progress_repack`, `pg_stat_autovacuum_scores` and `pg_dsm_registry_allocations`, puts `started_by` and `mode` into `pg_stat_progress_vacuum` and `backup_type` into `pg_stat_progress_basebackup`, allows `log_min_messages` per process type, adds `log_autoanalyze_min_duration`, turns `log_lock_waits` on by default and moves the wraparound warning from 40 million to 100 million transactions away (https://www.postgresql.org/docs/19/release-19.html). Turning these on is new checks, not new settings: today the Postgres reads are `pg_stat_replication`, `pg_replication_slots`, `pg_stat_archiver`, `pg_stat_wal_receiver` and `pg_stat_activity` in `tools/pokoin-ops/src/sentinel.rs:563-609`, whose thresholds are written up at `docs/BACKUPS_AND_ALERTS.md:35`, and the retained-WAL cap they watch is `scripts/backup/install-ops-nezopt.sh:99`. Two of these are not optional reading: `log_lock_waits` was already `on` in the beta4 settings table (`bench/postgres/results/2026-10-12-17.11-vs-19beta4.md:112`), so log volume rises with the upgrade unless the writer sets it back, and the wraparound warning changes when the writer starts complaining. Not measured.

### Cutover (on the 19.x the owner chooses)

1. Rehearse on production first: `scripts/postgres-major-upgrade.sh
   rehearse 19.N` (copy mode; the NVMe has room), then
   `cd pokoin-rust && cargo test --workspace` against the rehearsal copy.
   This rehearsal is also what re-answers the section above: its
   `--check`, `initdb`, timing and row-count lines are the named re-check
   for checksums, compatibility, the PGDATA path and the data itself, and
   the workspace tests are the re-check for the audit triggers, the `'utc'`
   queries and the wait-event test.
2. Stop the writes: the Oracle dump tunnel, `pokoin-overflow-sync.timer`
   and the overflow pods; the Pi API keeps reading its replica.
3. Stop the writer cleanly and run the upgrade image on its data directory
   (`upgrade-cluster.sh upgrade`, `MODE=copy` unless the rehearsal shows the
   copy is too slow; with `--link` the old cluster is unusable once 19
   starts, so keep a file-level copy first). 18 added `--swap`, which the
   pg_upgrade page calls potentially the fastest of the modes and also
   destructive to the old cluster, recommending `--sync-method=fsync` with
   it (https://www.postgresql.org/docs/19/pgupgrade.html): the same
   file-level copy rule as `--link`, and it is not in the rehearsal modes
   yet. Pass the mode to `--check` as well when a mode is chosen (see the
   gap above).
4. Start the writer on `postgres:19.N-alpine` with its usual flags plus
   `-c io_method=sync` (unless a GA re-run shows `worker` or `io_uring` doing
   better) and an explicit `-c jit=on|off` (17 runs with JIT on, 19 defaults
   to off). Mount the new host directory at `/var/lib/postgresql`, and keep
   the old ports and the `pokoin-overflow` attachment
   (`scripts/nezopt-k3s.sh up`). Run
   `update_extensions.sql`, `vacuumdb --all --analyze-in-stages
   --missing-stats-only`, and recreate the slot `pokoin_pi_replica`. At the
   same start, on the writer and not on the rehearsal: re-read `jit`,
   `log_connections`, `idle_replication_slot_timeout` and
   `shared_memory_size` against what 17 runs with, and reindex whatever
   `pg_trgm` or expression indexes the writer turns out to hold.
5. Pi replica: a standby cannot stream from another major. Stop the
   watchdog timer, rebuild the replica with `pg_basebackup -R -S
   pokoin_pi_replica` from the writer into a new directory, start it on the
   19 image, check `pg_stat_wal_receiver` is streaming, start the timer
   (`docs/GAMES.md`). The Pi API returns 503 until the replica is back; the
   overflow on nezopt reads the writer.
6. Reopen writes. Rollback until then: stop 19 and start the old container
   on the untouched 17 data directory.
