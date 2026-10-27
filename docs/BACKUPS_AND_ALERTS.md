# Postgres backups and failure alerts

Status 2026-10-15: **repo side done, nothing installed.** Every host change below waits
for Giuseppe's OK, one step at a time (section 5). Nothing here is deployed by merging.

## 1. Why

Audit of 2026-10-15:

- The writer (`pokoin-marketplace-postgres-15t` on nezopt, 26 databases, ~19 GB) has
  `archive_mode=off`, `data_checksums=off`, `max_slot_wal_keep_size=-1` and no
  automated backup. The newest copy is a manual base backup from 2026-10-07 on mybook,
  which is attached to the same machine.
- The Pi streaming replica is the only second copy. It is async, and it replays mistakes
  (a bad `DELETE`) within a second.
- No job alerts anyone when it fails. Only `pokoin-uptime-mail` probes `/healthz`.
  Two production units are failed right now and nobody was told:
  - `pokoin-all-cardtrader-daily` was stopped by SIGTERM at 06:44 UTC on 2026-10-15,
    with the listing books at 925/3396.
  - `pokoin-site-map-refresh` has been failing since 2026-10-12: deploy-web stops with
    "production runs , which this repo does not have".

## 2. Design

| Piece | Where | What |
| --- | --- | --- |
| PITR | Pi | `archive_mode=always` on the **standby**. `archive_command` copies each WAL segment into `/srv/pokoin/postgres/wal-spool`. It only copies because wal-g (glibc) cannot run in the Alpine (musl) container. `pokoin-wal-push.timer` runs every minute and pushes the spool with `wal-g wal-push` (zstd, libsodium-encrypted). `pokoin-basebackup.timer` runs Sundays at 02:30 UTC: `wal-g backup-push` from the standby, then `delete retain FULL 3`. Recovery is possible to any point in the last 14–21 days. |
| Nightly dumps | nezopt → Pi | `pokoin-pgdump.timer` runs at 03:30 UTC. For each of the 26 databases plus globals, `pg_dump -Fc -Z0` runs inside the replica container over SSH. nezopt then compresses with zstd and encrypts with age, writing `mybook/pokoin-backups/dumps/<stamp>/`, and rclone copies the set to the `daily/` or `weekly/` prefix off-site. Retention keeps the 14 newest sets plus the 8 newest Sunday sets. The dump **refuses any server that is not in recovery**, so it never touches the writer. |
| Local PITR copy | nezopt | `pokoin-backup-mirror.timer` runs at 06:00 UTC: `rclone sync` of the wal-g bucket to mybook, using a read-only key. |
| Restore tests | nezopt | `pokoin-restore-test.timer` runs on the first Sunday of each month. (1) `backup verify` checks the sha256 of each file in the newest dump set, decrypts it, restores it into a throwaway container (`--network none`, data on mybook), and compares row counts per table between the archive and the restored database. The archive counts come from its COPY blocks, so they are exact. (2) `backup pitr-test` fetches the newest wal-g base backup and every later WAL segment from the mirror, replays them, and requires a last replayed transaction less than 30 h old. It then reads every table with `count(*)`. Both send a pass or fail mail. |
| Slot cap | writer | `max_slot_wal_keep_size = 50GB` (reload only). A Pi outage can then no longer fill nezopt's NVMe. After roughly 4 days down (~12 GB WAL/day), the slot is invalidated and the Pi needs a fresh base backup; the sentinel alerts long before that, at 40 GB. |
| Failure mail | all hosts | A `pokoin-notify@.service` template runs `pokoin-ops notify-unit`. It mails the unit's state and journal tail through the same Resend key, sender and inbox as `scripts/pokoin-uptime-mail.sh`, and pings the unit's dead-man check `/fail` as an independent second path. A 3 h per-unit cooldown folds repeat failures into the next mail. It is attached with `OnFailure=` drop-ins to `pokoin-rust-job@.service` and `pokoin-pi-watchdog` (Pi), to **every nezopt user service** through the type-wide `~/.config/systemd/user/service.d/90-alert.conf` (opt out with a same-named `<unit>.service.d/90-alert.conf` holding `OnFailure=`, as `pokoin-notify@` and `pokoin-uptime-mail` do), and to `pokoin-cardtrader-daily-market-refresh` (Oracle host `pokoin-marketplace`). Each failure is also pushed to the Secretary app (`POST /v1/notify`, see below). |
| TERM summary | repo | `scripts/run-all-cardtrader-daily.sh` traps SIGTERM/SIGINT. It still sends its CardTrader summary, marked `interrupted`. Stages report only once they have finished. The drop-in sets `TimeoutStopSec=120` so the summary has time to go out. |
| Dead-man pings | all hosts | healthchecks.io: one project and one ping key per host, one slug per timer (`ExecStartPre … start`, `ExecStartPost …` on success). `pokoin-ops hc-provision` creates every check with its period and grace from `tools/pokoin-ops/src/hc.rs`. Without a key the pings do nothing, so the drop-ins can go in first. |
| Sentinel | Pi + nezopt | `pokoin-sentinel.timer` runs every 5 min (`pokoin-ops sentinel --role pi\|nezopt`). **nezopt** checks: writer client connections (warn at 100, crit at 120), a streaming standby present in `pg_stat_replication`, replay lag over 60 s, slot `wal_status` lost/unreserved or more than 40 GB retained, free space on `/` below 40 GB, the newest pg_dump older than 30 h or mybook unmounted, and failed system and user units. **Pi** checks: the replica is in recovery and its WAL receiver is streaming (if the receiver is down, nezopt is gone), replay lag, archiver failures plus the `.ready` backlog, the WAL spool backlog, API errors from `/metrics` (more than 25 new errors per run), disk on `/` and `/srv/pokoin` below 10 GB, failed units, and TCP to the writer. A problem mails after 2 consecutive bad runs (units and disk: 1), again on escalation, again every 6 h while it lasts, and once when it clears. Transient units (`systemd-run`) and desktop units are not reported. If a whole host dies, its sentinel's healthchecks ping stops. |
| Secretary push (nezopt) | nezopt | `sentinel --role nezopt` also watches what OnFailure cannot see: restart storms (NRestarts/RestartCount in the last hour, warn ≥ 3, crit ≥ 10), units and containers listed in `~/.config/pokoin/expected-active.txt` that are not running, `unless-stopped`/`always` containers that are stopped or unhealthy, failed k3s Jobs in `pokoin-overflow` new since the previous run (warn for 1 h), the local target of every active `ssh -R` unit plus Infisical `:8088`, silent degradation in logs (`no CARDTRADER_AUTH_TOKEN`, `invalid_grant`, `moderation_failed`), timers whose last run failed, disks below 10 %/5 % free and CPU Tctl ≥ 90/95 °C. Every run posts the full snapshot (healthy checks included) to `POST $POKOIN_SECRETARY_URL/v1/system/health`. A change into crit pushes `POST /v1/notify` once (`dedupKey` `<host>:<check id>`, route `/server-health`); the return to ok pushes one "recovered" with the same key. The first run only records a baseline. Token: `POKOIN_SECRETARY_TOKEN_FILE` (default `/home/nez/Projects/Lucina/private/lucina/secretary-service.token`); a missing token or an HTTP error is logged and never fails the run. |

Everything new is one Rust binary, `tools/pokoin-ops` (own Cargo workspace, so the API
lockfile is untouched). The only shell is the archive command, which runs inside the
replica's BusyBox. Zero API latency cost:

- No new code runs in the API.
- The Pi does no compression for dumps.
- Its background work runs with `Nice`, `IOSchedulingClass=idle` and `CPUQuota`, and the
  base backup is rate-limited (`WALG_DISK_RATE_LIMIT` 30 MB/s, network 12 MB/s).

### Trade-offs to know

- **A 20–40 min `pg_dump` of `pokoin_marketplace` on a hot standby.**
  - The replay of an `AccessExclusiveLock` can cancel it after
    `max_standby_streaming_delay=30s`, for example an autovacuum truncation during the
    CardTrader nightly. The dump retries each database 3 times, 2 min apart. If every try
    fails, the sentinel's 30 h freshness check mails.
  - With `hot_standby_feedback=on`, a long dump also delays vacuum on the writer.
  - If 03:30 UTC proves flaky, move the timer to the afternoon (more API traffic, fewer
    writes).
  - The clean fix is a third, backup-only standby on mybook whose replay is paused during
    dumps. That needs a pg_hba replication entry on the Pi and is not part of this round.
- **The replica restarts once** (step P3) for `archive_mode`, which is a
  postmaster-level setting. `/healthz` returns 503 for a few seconds.
- **data_checksums stays off.** Turning it on needs `pg_checksums --enable` on a stopped
  cluster, which means writer downtime proportional to 19 GB. Not in scope. The monthly
  full read and restore are the substitute.

## 3. Verified in this branch

- `cargo test` passes 31 unit tests: alert state machine, thresholds, retention,
  COPY row counter, WAL ordering, slug coverage, age + zstd round trip.
- `tools/pokoin-ops/tests/e2e-backup.sh` runs against a throwaway Postgres 17.11-alpine.
  It shows that the dump refuses a primary, that the files are encrypted, that the restore
  passes with exact row counts (including quoted identifiers, newlines in values and empty
  tables), that a tampered file fails the checksum, and that no container is left behind.
- `scripts/backup/walspool-archive.test.sh` passes under GNU and under the replica image's
  own BusyBox.
- A rehearsal on nezopt with a throwaway Postgres 17.11-alpine primary and standby:
  - `ALTER SYSTEM SET archive_mode='always'` works on a standby, followed by a restart.
  - The spool archiving gave 3 segments archived, 0 failures, 0 `.ready` left.
  - The rehearsal also found that an archive script without its exec bit exits 126. That
    kills the archiver **without** incrementing `pg_stat_archiver.failed_count`. Hence
    `archive_command = 'sh …'`, and the Pi sentinel also watches the `.ready` backlog.
- `scripts/run-all-cardtrader-daily.test.sh`:
  - A full run whose dump stage fails reports every stage and exits 1.
  - A process-group SIGTERM during the catalogue stage sends the summary with
    `--exit-code 143` and `interrupted=143`, and reports no unfinished stage.
- `systemd-analyze --user verify` passes on all new units and drop-ins (systemd 255),
  including `OnFailure=pokoin-notify@%n.service` on a template instance.
- `pokoin-ops sentinel --role nezopt --dry-run` against the live writer:
  - All database checks are OK (24 connections, standby streaming, 0 s lag, slot 0 GB).
  - It reports exactly the 3 real failed units: the 2 above plus
    `tailscale-nextcloud-setup.service`.
- Release builds come from `scripts/backup/build-pokoin-ops.sh`. The x86_64 binary
  needs glibc 2.34, so it loads on Oracle's Ubuntu 22.04 (checked in `ubuntu:22.04`). The
  aarch64 binary is for the Pi.

**Not verified end to end:** wal-g itself (`wal-push`, `backup-push` from the standby,
`pitr-test`), rclone, Resend delivery from the new binary, and healthchecks. These need
the storage account and the installs below. The first real run of each step is its test,
and section 5 says what to look at.

## 4. Decisions needed from Giuseppe

1. **Off-site storage.** Recommended: **Backblaze B2, EU Central**, two buckets:
   - `pokoin-pg-walg`, used by wal-g. Its key needs delete for wal-g's retention, and a
     second, read-only key serves the nezopt mirror.
   - `pokoin-pg-dumps`, with an **append-only** key (`listFiles,writeFiles`, no
     `deleteFiles`). Lifecycle rules delete `daily/` after 15 days and `weekly/` after
     57 days, so a stolen nezopt key cannot erase history.

   Estimated size is ~150 GB: about 45 GB of compressed WAL, 3 base backups at ~6 GB each,
   and 22 dump sets at ~4 GB each. That is about $1/month.

   Alternatives: Cloudflare R2 (no egress fees, but no append-only keys), or a Hetzner
   Storage Box (wal-g over SSH, rclone over SFTP).
2. **Dead-man service.** Recommended: hosted **healthchecks.io**. The free tier covers
   the 18 checks, and it keeps working when our hosts are down. A self-hosted instance
   would die with the host it watches.
3. **Dump time.** 03:30 UTC as designed, or the afternoon (see the trade-off above).
4. **Stale failed units.** Before the sentinels start, decide on the 3 failed units:
   - Fix `pokoin-site-map-refresh`, or run `systemctl --user reset-failed` on it.
   - Rerun or reset `pokoin-all-cardtrader-daily`.
   - Reset or fix `tailscale-nextcloud-setup` (system).

   Otherwise the first sentinel mail lists all three, which may be what you want.

## 5. Host changes awaiting OK (in order, each separately)

All commands run on nezopt from a checkout of this branch once it is merged (the canonical
checkout after merge, or this worktree before). Build first:

```bash
scripts/backup/build-pokoin-ops.sh
```

| # | Host | Change | Command | Restarts | Check after |
| --- | --- | --- | --- | --- | --- |
| N1 | nezopt (writer) | `max_slot_wal_keep_size = 50GB` via ALTER SYSTEM + reload | `scripts/backup/install-ops-nezopt.sh slot-cap` | none | prints `50GB`; slot `wal_status` stays `reserved` |
| N2 | nezopt (user) | `~/.local/bin/pokoin-ops`; `pokoin-notify@`; OnFailure and dead-man drop-ins on cardtrader-daily, site-map-refresh, overflow-sync, shipping-rates-sync, uptime-mail; `pokoin-sentinel.timer` | `scripts/backup/install-ops-nezopt.sh alerts` | none (drop-ins apply on the next run) | `systemctl --user start pokoin-notify@pokoin-site-map-refresh.service.service` sends one real failure mail |
| P1 | Pi | `/usr/local/bin/pokoin-ops`; `/etc/pokoin/alerts.env` (Resend key copied from nezopt); `pokoin-notify@`; drop-ins on `pokoin-rust-job@` and `pokoin-pi-watchdog`; `pokoin-sentinel.timer` | `scripts/backup/install-ops-pi.sh alerts` | none | dry-run output printed by the script; `journalctl -u pokoin-sentinel` |
| O1 | Oracle `pokoin-marketplace` | `/usr/local/bin/pokoin-ops`; `/etc/pokoin/alerts.env`; `pokoin-notify@`; drop-in on `pokoin-cardtrader-daily-market-refresh` | `scripts/backup/install-ops-oracle.sh` | none | `systemctl show … -p OnFailure` printed by the script |
| H1 | healthchecks.io | create the project; put the ping key in `POKOIN_HC_PING_KEY` on all three hosts (`~/.config/pokoin/alerts.env`, `/etc/pokoin/alerts.env`) | `POKOIN_HC_API_KEY=… ~/.local/bin/pokoin-ops hc-provision` | none | 18 checks listed; all green after one day |
| S1 | B2 (or the chosen store) | buckets, keys and lifecycle rules as in section 4.1 | provider console; rclone remotes `pokoin-dumps` and `pokoin-walg-ro` in `~/.config/rclone/rclone.conf` on nezopt; rclone binary in `~/.local/bin` | none | `rclone lsd pokoin-dumps:` |
| N3 | nezopt (user) | `~/.config/pokoin/backup.env`; age key pair (`backup keygen`, **copy `~/.config/pokoin/backup-age.key` offline**); `pokoin-pgdump.timer` | `scripts/backup/install-ops-nezopt.sh backups` then `systemctl --user start pokoin-pgdump.service` | none | `journalctl --user -u pokoin-pgdump`: 27 files; `rclone ls pokoin-dumps:pokoin-pg-dumps/daily` |
| P2 | Pi | wal-g binary (pinned sha256), `/etc/pokoin/walg.env` (libsodium key from `openssl rand -hex 32`, **copy it offline**; PGPASSWORD of `pokoin_marketplace`), spool dirs, archive script, `pokoin-wal-push.timer`, `pokoin-basebackup.timer` | `scripts/backup/install-ops-pi.sh walg ./wal-g-pg-<ver>-aarch64 <sha256>` | none | the script runs `wal-g backup-list` against the bucket |
| P3 | Pi replica | `ALTER SYSTEM SET archive_mode='always'`, `archive_command='sh …/walspool-archive.sh %p %f'`; one container restart (watchdog paused around it); then the first base backup | `scripts/backup/install-ops-pi.sh archiving --restart-replica` at a quiet hour | **replica container**, a few seconds of 503 | `pg_stat_archiver` counts up; spool drains within a minute; `wal-g backup-list` shows the first backup |
| N4 | nezopt (user) | wal-g x86_64 in `~/.local/bin`; `~/.config/pokoin/walg-mirror.env`; enable mirror + monthly restore tests | rerun `scripts/backup/install-ops-nezopt.sh backups` | none | `systemctl --user start pokoin-backup-mirror.service pokoin-restore-test.service`; both send a mail |

The installers never print secrets. Their only key copy is the Resend key, from nezopt's
`uptime-mail.env` into a root-only env file on the Pi and on Oracle.

## 6. Restoring

From a dump set (any machine with docker; the age identity is needed):

```bash
pokoin-ops backup decrypt /home/nez/mnt/mybook/pokoin-backups/dumps/<stamp>/pokoin_marketplace.dump.zst.age | zstd -d > pokoin_marketplace.dump
```

```bash
pg_restore -d postgres -C -j 4 pokoin_marketplace.dump
```

Globals (roles) come first: decrypt `globals.sql.zst.age` the same way, then run it with
`psql -f`.

Point in time (wal-g, from the bucket or from the mybook mirror with
`WALG_FILE_PREFIX`):

1. `wal-g backup-fetch <empty dir> LATEST` (or a backup name from `wal-g backup-list`).
2. Remove `standby.signal` and add to `postgresql.auto.conf`:
   - `restore_command = 'wal-g wal-fetch %f %p'`
   - `recovery_target_time = '<UTC time>'`
   - `recovery_target_action = 'promote'`
   - `primary_conninfo = ''`
   - `archive_mode = 'off'`
3. Touch `recovery.signal` and start Postgres 17.

`backup pitr-test` does exactly this every month. Read `tools/pokoin-ops/src/backup/pitr.rs`
for the container details: the same Alpine image as the replica, so collations match, and
WAL pre-fetched on the host.
