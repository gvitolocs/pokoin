# Automatic deploy of the Rust API

**Built switched off. Nothing deploys automatically until the owner enables the units.**

`scripts/auto-deploy-rust.sh` deploys `origin/main` to the Pi and the nezopt overflow when the Rust API changed. It runs the
steps of [RUST_RUNTIME.md](RUST_RUNTIME.md#deploy) in order and checks the result. It is the same shape as LucinaOS's
`auto-public-sync`: it watches `main`, coalesces to the newest tip, holds a lock, records one state per sha, never retries a
failed sha by itself, and can be paused with a file.

## Flow

1. Look at `~/scratch/pokoin-auto-deploy/pause` (the state dir is `$POKOIN_AUTODEPLOY_DIR`). If it exists, print why and exit 0.
2. Take the lock (`flock -n`). A second run says "another run is going" and exits 0.
3. `git fetch origin`; the tip is `origin/main`.
4. Baseline: the newer of the last `done` sha and the release the Pi serves (`x-pokoin-release` on
   `https://api.pokoin.com/healthz`). A deploy by hand therefore moves the baseline.
5. Skip when the tip is already `done` or `failed`, or when nothing under `pokoin-rust/` or
   `deploy/systemd/pokoin-rust-api.service` changed since the baseline.
6. Migration guard (below).
7. State `started`, then `scripts/build-pokoin-rust-release.sh <sha>` (tests plus aarch64 build), then
   `scripts/deploy-pokoin-rust.sh` from `~/pokoin-deploy/rust-release` (the installer checks health and restores the previous
   binary itself), then `scripts/nezopt-k3s.sh sync`.
8. Verify: `x-pokoin-release` equals the sha within 2 minutes, and `nezopt-k3s.sh status` shows that sha for the overflow.
9. All good: `done`. A failing step: `failed <step>`. If a commit landed meanwhile, look at `main` once more (one extra round).

`--dry-run` prints the range, the changed paths, the decision and the reason, and runs nothing (it does not fetch).
`--status` prints the last 10 state lines and whether `pause` exists.

## States

State file: `<state dir>/state`, lines `<sha> <state> [reason]`; the last line per sha counts. Logs: `<state dir>/log/<sha>.log`,
one summary line per result in `log/results.log`.

| State | Meaning | Next |
| --- | --- | --- |
| `started` | A run is going, or one died mid-way | the next trigger deploys it again |
| `done` | Live on the Pi and the overflow, verified | nothing |
| `failed <step>` | `build`, `deploy`, `sync`, `verify`, `migration-pending` or `no-baseline` | never retried; the next `main` commit starts afresh |
| `skipped` | Nothing under `pokoin-rust/` changed | the next commit is looked at |
| `stalled` | The build refused to start (under 60 GB free), or the owner acked migrations | retried on the next trigger |

Exit codes: 0 done, skipped, paused, stalled or busy; 1 a step failed; 2 cannot plan (fetch failed, no baseline); 3
migration-pending. A non-zero exit fails the unit, and the user-wide `service.d/90-alert.conf` (`OnFailure=pokoin-notify@%n`,
`pokoin-ops notify-unit`) mails the owner and pushes to Secretary, once per failed sha. `pokoin-ops` has no call that records a
success, so `done` goes to the log only.

## Migration guard

If any file under `scripts/sql/` was added or changed between the baseline and the tip, nothing is deployed: state
`failed migration-pending`, the files are listed in the log, exit 3. Migrations are applied by hand on the writer and must precede
the API that needs them. Then either deploy by hand (the Pi moves, so the baseline moves), or
`scripts/auto-deploy-rust.sh --ack-migrations <sha>` after applying them. The ack allows only that exact sha; the next commit
with a migration is blocked again.

## Pause

```bash
echo "why" > ~/scratch/pokoin-auto-deploy/pause     # stops every trigger
rm ~/scratch/pokoin-auto-deploy/pause               # resumes
```

Pause before a manual deploy or a risky merge. A run already in progress finishes.

## Install and enable (the owner runs these)

The units are in `deploy/systemd/` and point at the canonical checkout `/home/nez/Projects/pokoin-web`; edit the paths if it
lives elsewhere. Nothing is installed by the repo.

```bash
mkdir -p ~/.config/systemd/user ~/scratch/pokoin-auto-deploy
cp deploy/systemd/pokoin-rust-auto-deploy.{service,path,timer} ~/.config/systemd/user/
systemd-analyze --user verify ~/.config/systemd/user/pokoin-rust-auto-deploy.service
systemctl --user daemon-reload
scripts/auto-deploy-rust.sh --dry-run                    # read the plan first
systemctl --user enable --now pokoin-rust-auto-deploy.timer pokoin-rust-auto-deploy.path
```

The `.path` unit fires when `refs/remotes/origin/main` or `packed-refs` change in the canonical checkout, which only happens
when something fetches there. The `.timer` (every 15 minutes) is the trigger that fetches, through the script. Switch off:
`systemctl --user disable --now pokoin-rust-auto-deploy.timer pokoin-rust-auto-deploy.path`.

## Roll back

A failed install restores itself. For anything else follow [RUST_RUNTIME.md](RUST_RUNTIME.md#rollback): point
`/srv/pokoin/rust/current` at `previous` and restart `pokoin-rust-api`. Then `touch` the pause file so the automation does not
redeploy the bad sha's successor before you have looked.

## Test

`bash scripts/auto-deploy-rust.test.sh` runs the script against a throwaway repo with fake build, deploy and sync commands. No
network.
