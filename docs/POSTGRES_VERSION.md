# Postgres version: policy and update runbook

## Where things stand (2026-10-12)

| | |
| --- | --- |
| Production major | **17** (writer and Pi replica must always be the same major) |
| Writer image pin | `postgres:17.11-alpine` (`scripts/install-pokoin-postgres-nvme.sh`). Before this pin it was the floating `postgres:17-alpine`, so the running minor depends on when that tag was last pulled: check it (step 0 below). |
| Latest 17.x | 17.11, released 2026-08-13. Next scheduled minor release: 2026-11-12. |
| Latest stable major | 18.6 |
| Next major | 19: beta4 on 2026-09-24 (Docker `postgres:19beta4-alpine`), GA planned for October 2026. Upgrade tooling ready and rehearsed against beta4 (below). |
| 17 end of life | November 2029 |

**Decision (Giuseppe, 2026-10-12):** stay on 17 and keep it on the latest
patch release. Skip 18. Make one major jump, 17 → 19, once 19.1 or 19.2 is
out, instead of migrating twice.

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

## Major upgrade to 19 (prepared; cut over once 19.1 or 19.2 is out)

`postgres-recreate.py` refuses this on purpose: a major upgrade has to
rewrite the system catalogs. The tooling below is ready and was rehearsed
against 19beta4; only the production cutover waits for a stable 19.

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

### Cutover (when 19 is stable)

1. Rehearse on production first: `scripts/postgres-major-upgrade.sh
   rehearse 19.N` (copy mode; the NVMe has room), then
   `cd pokoin-rust && cargo test --workspace` against the rehearsal copy.
2. Stop the writes: the Oracle dump tunnel, `pokoin-overflow-sync.timer`
   and the overflow pods; the Pi API keeps reading its replica.
3. Stop the writer cleanly and run the upgrade image on its data directory
   (`upgrade-cluster.sh upgrade`, `MODE=copy` unless the rehearsal shows the
   copy is too slow; with `--link` the old cluster is unusable once 19
   starts, so keep a file-level copy first).
4. Start the writer on `postgres:19.N-alpine` with its usual flags, the new
   host directory mounted at `/var/lib/postgresql`, the old ports and the
   `pokoin-overflow` attachment (`scripts/nezopt-k3s.sh up`). Run
   `update_extensions.sql`, `vacuumdb --all --analyze-in-stages
   --missing-stats-only`, and recreate the slot `pokoin_pi_replica`.
5. Pi replica: a standby cannot stream from another major. Stop the
   watchdog timer, rebuild the replica with `pg_basebackup -R -S
   pokoin_pi_replica` from the writer into a new directory, start it on the
   19 image, check `pg_stat_wal_receiver` is streaming, start the timer
   (`docs/GAMES.md`). The Pi API returns 503 until the replica is back; the
   overflow on nezopt reads the writer.
6. Reopen writes. Rollback until then: stop 19 and start the old container
   on the untouched 17 data directory.
