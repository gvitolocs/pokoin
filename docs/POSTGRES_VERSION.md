# Postgres version: policy and update runbook

## Where things stand (2026-10-12)

| | |
| --- | --- |
| Production major | **17** (writer and Pi replica must always be the same major) |
| Writer image pin | `postgres:17.11-alpine` (`scripts/install-pokoin-postgres-nvme.sh`). Before this pin it was the floating `postgres:17-alpine`, so the running minor depends on when that tag was last pulled: check it (step 0 below). |
| Latest 17.x | 17.11, released 2026-08-13. Next scheduled minor release: 2026-11-12. |
| Latest stable major | 18.6 |
| Next major | 19: beta4 on 2026-09-24 (Docker `postgres:19beta4-alpine`), GA planned for October 2026 |
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

## Major upgrade to 19 (plan, for when 19.1 or 19.2 is out)

`postgres-recreate.py` refuses this on purpose: a major upgrade has to
rewrite the system catalogs.

- **Before the window**
  - Run `cd pokoin-rust && cargo test --workspace` against a scratch 19
    (`POKOIN_TEST_DATABASE_URL`), and run the `scripts/sql/` migrations on
    it.
  - Check that `pg_trgm`, `unaccent` and `pgcrypto` load in the 19 image.
  - Rehearse `pg_upgrade` on a copy of the writer's PGDATA (the NVMe has
    room) and time it.
- **Data path:** since Postgres 18, the official Docker images keep data in
  `/var/lib/postgresql/<major>/docker` and expect the volume at
  `/var/lib/postgresql`. An old-style mount at `/var/lib/postgresql/data` is
  rejected. The new writer either mounts the parent directory at
  `/var/lib/postgresql` or sets `PGDATA` explicitly. Update
  `scripts/install-pokoin-postgres-nvme.sh` (or a successor script) in the
  same PR.
- **Writer:**
  1. Stop the writes: the Oracle dump tunnel, `pokoin-overflow-sync.timer`
     and the overflow pods.
  2. Keep a file-level copy of PGDATA.
  3. Run `pg_upgrade --link`, which needs the 17 and 19 binaries side by
     side, for example the docker-library `postgres-upgrade` images.
  4. Start 19 and refresh planner statistics (`vacuumdb --all --analyze-in-stages`,
     following the 19 release notes on what `pg_upgrade` carries over).
  5. Run `pokoin-rust` and the overflow against it before reopening writes.
- **Pi replica:** a standby cannot stream from another major. Rebuild it
  with `pg_basebackup` from the upgraded writer, with the watchdog timer
  stopped (`docs/GAMES.md`). The Pi API returns 503 until the replica is
  back; the overflow on nezopt reads the writer.
- **Rollback:** after `--link` has started the new cluster, the old one is no
  longer usable. Roll back from the file-level copy taken before the upgrade.
