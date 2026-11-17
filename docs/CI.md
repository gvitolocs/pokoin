# CI for the Rust API: check locally first, GitHub gates the merge

The fast check runs on nezopt in your worktree. GitHub repeats the gate that already guards a release, plus a "nothing new" check on the diff. Ported from LucinaOS `docs/ci/SHIFT-LEFT.md`, without the proof tiers.

| Tier | Runs | Where | Decides |
| --- | --- | --- | --- |
| Fast check | `scripts/check-fast` | Your worktree, before a commit | Nothing by itself; it tells you early |
| GitHub `rust-gate` | `.github/workflows/rust-ci.yml`: jobs `changes`, `test`, `changed` | GitHub, on every pull request and every push to `main`; the Rust jobs run only when Rust files changed | Whether the PR may merge, once the owner makes it a required check |
| GitHub `repo-gate` | `.github/workflows/repo-ci.yml`: job `gate-tests` | GitHub, on every pull request and every push to `main` | Whether the deploy gate's own scripts still work; `scripts/require-ci-green.sh` also reads it before anything ships |
| GitHub `secret-gate` | `.github/workflows/secrets-ci.yml`: `scripts/ci-secret-scan.sh` (gitleaks over the commit range and the tree, fails on any allowlist change) and its test | GitHub, on every pull request and every push to `main` | Whether the PR may merge, once the owner makes it a required check; it is also in scripts/ci-required-checks, so a commit ships only when it is green; docs/SECRETS.md |
| `flow-db` | Same workflow, Postgres 17 service, `*_flow` test binaries | GitHub | Nothing: informational, `continue-on-error`. `seller_api_flow` is the known red on `main` |
| Release gate | `cargo test --workspace --locked` in `scripts/build-pokoin-rust-release.sh` | nezopt, at deploy | Whether a release is built and deployed |

## `scripts/check-fast`

```bash
scripts/check-fast              # against the merge base with origin/main
scripts/check-fast --base REF   # against the merge base of REF and HEAD
scripts/check-fast --db         # also start a throwaway Postgres for the flow tests
scripts/check-fast --no-build   # no cargo steps; --no-test skips only cargo test
```

Run it before you commit a `pokoin-rust/` change. The change is everything from the merge base to the working tree: commits, staged and unstaged edits, untracked files. Steps:

- `diffgate --repo . --base <base>` (placeholders, stubs, removed tests or assertions), when `~/.local/bin/diffgate` exists
- rustfmt on the touched `.rs` files
- clippy (`cargo clippy -p <crate> --all-targets`) on each touched crate
- `cargo test -p <crate>` on each touched crate. The `*_flow` tests skip themselves without `POKOIN_TEST_DATABASE_URL`; `--db` starts `postgres:17-alpine` as `pokoin-check-pg-<pid>` on a free port, as in the header of `crates/commerce/tests/zero_picks_flow.rs`, and removes that container on exit
- `shellcheck` on changed shell scripts, `actionlint` on changed workflows, `gitleaks` on the changed files

A step whose tool is missing, or that has nothing to look at, is printed as `SKIPPED` with its reason. It is never counted as passed. The run ends with one table (step, result, seconds) and exits 1 if any step failed, 2 if it refused to start.

A change to `pokoin-rust/Cargo.toml`, `Cargo.lock`, the toolchain file or `.cargo/` has a workspace-wide effect. The check says so and leaves it to the GitHub `test` job.

### What "nothing new" means

`main` has old debt: `cargo fmt --all -- --check` fails in many untouched files, and `pokoin-commerce` alone has about 400 clippy warnings. So the gate is never "the workspace is clean":

- **rustfmt:** each touched file is formatted (workspace edition) and diffed against the file as it is. A hunk fails only if it overlaps a line the change added or modified. An unformatted old line in the same file passes; edit that line and it fails. A new untracked file is all new lines.
- **clippy:** a warning fails only if its primary span, after macro expansion, overlaps a line the change added or modified. Any compiler or clippy *error* fails.
- **shellcheck:** the same line rule as rustfmt.
- **actionlint, gitleaks, diffgate:** the whole changed file (or, for diffgate, the whole diff).

`scripts/check-fast.test.sh` proves these rules on a throwaway repo and needs no network.

### Disk

nezopt's disk also holds production (`docs/RUST_RUNTIME.md`, "Build disk on nezopt"). The check:

- builds in one shared target, `$POKOIN_CHECK_TARGET` (default `~/.cache/pokoin-check-target`), never `pokoin-rust/target` in the worktree
- refuses to start (exit 2) with less than `POKOIN_CHECK_MIN_FREE_GB` (default 50) free where that target lives
- runs each cargo step in `systemd-run --user --scope -p MemoryMax=8G -p CPUQuota=400%` when systemd is available

Delete the shared target when it grows past about 40 GB. Do not run `cargo test --workspace` on nezopt by hand; check single crates.

## GitHub: `rust-ci.yml`

Triggers: every `pull_request` and every `push` to `main`, with no `paths` filter. Permissions are `contents: read`, there are no secrets and no deploy step, and actions are pinned by commit SHA.

Cost: `gvitolocs/pokoin` is a public repository, so standard GitHub-hosted runners (`ubuntu-24.04`) use no billed minutes. If the repository is made private, every run counts against the plan's included minutes (then per-minute billing), so the `test` and `flow-db` jobs (up to 90 minutes each) would cost real money; revisit the timeouts, the cache and whether `flow-db` should run at all.

- `changes`: `git diff --name-only` against the PR's merge base (or the push's previous commit) with full history. Output `rust=true` when `pokoin-rust/**`, `.github/workflows/rust-ci.yml` or `scripts/check-fast*` changed, else `rust=false`
- `test`: only when `rust=true`. The same coverage as the release gate's `cargo test --workspace --locked`, without a database, but as 6 shards of workspace packages (`cargo test -p … --locked --no-fail-fast`, packages taken from `cargo metadata` so new crates are included). A single `cargo test --workspace` froze the GitHub runner VM three times (the log is lost, "runner lost communication"), while every package and every shard passes alone; the cause is not found. The `test` result is the aggregate of the shards
- `changed`: only when `rust=true`. `scripts/check-fast --no-test` against the PR's base branch (or the push's previous commit). On the runner `diffgate`, `actionlint` and `gitleaks` are not installed, so they show as `SKIPPED`
- `flow-db`: only when `rust=true`. The `*_flow` binaries against Postgres 17, informational (`continue-on-error`)
- `rust-gate`: always runs. Passes at once when `rust=false` (nothing to check). Otherwise passes only when `test` and `changed` both succeeded. A failed or cancelled `changes` job fails it. It prints one line saying which case applied. This is the one required check

### Making `rust-gate` required (owner, in GitHub)

Because `rust-gate` always runs, requiring it cannot block front-end PRs. Do this only AFTER this workflow is on `main`: before that, no PR gets the check from a base that has it and GitHub waits for a status that may never come.

1. Merge the PR that adds `.github/workflows/rust-ci.yml` and confirm `rust-gate` is green on a later PR.
2. Settings, Branches, Add branch protection rule (or Rulesets, New branch ruleset) for `main`.
3. Tick "Require status checks to pass before merging".
4. Search for `rust-gate` and select it (it appears only after it has run once in the last week).
5. Save. Do not add `test`, `changed` or `flow-db`; they are skipped on non-Rust PRs and a skipped required check counts as passed only through `rust-gate`.

The same steps apply to `repo-gate` (from `.github/workflows/repo-ci.yml`): merge the workflow first, then require `repo-gate` as well.

## Deploy gate: main must be green to ship

A commit ships only when its required GitHub checks are green. `scripts/require-ci-green.sh <commit>` asks GitHub for the check runs of that exact commit (`gh api repos/gvitolocs/pokoin/commits/<sha>/check-runs`) and exits 0 only when every name in `scripts/ci-required-checks` has a completed run that ended in `success`. The list is read from the commit being shipped, so a commit without the list cannot ship. Only runs made by GitHub Actions count; a check with the right name from another app does not. When a check was run more than once, the newest run decides. `skipped`, `cancelled`, `neutral`, `timed_out` and a missing run are not green. Any error talking to GitHub is a refusal, never a pass.

These entry points call it before they do anything else that matters: `scripts/publish-web.sh` (upload mode), `scripts/deploy-web.sh`, `scripts/deploy-pokoin-rust.sh` and `scripts/build-pokoin-rust-release.sh`. `scripts/deploy-gate-callers.test.sh` fails if one of them stops calling it. `publish-web.sh --promote` does not call it: promoting an older version is the rollback path and is never blocked. It records every upload and promotion, with the commit and the CI result, in `$HOME/pokoin-deploy/web-versions.tsv`, and warns when you promote a version it did not record.

Waiting: a check that is still running is waited for (poll every 30 seconds, give up after an hour). A check run that does not exist yet gets 5 minutes to appear, then it is a refusal. `--no-wait` refuses at once for anything not yet green. If GitHub cannot be read (`gh` fails or its answer does not parse), the gate does not wait out the hour: it refuses after `POKOIN_CI_API_RETRIES` unreadable answers in a row (default 5; a readable answer resets the count, and `--no-wait` refuses on the first). It finds `gh` on PATH, else at `$HOME/.local/bin/gh` (a non-login shell may not have `~/.local/bin` on PATH), and refuses at once when there is none (`GH=<path>` picks another binary). The settings are `POKOIN_CI_POLL_S`, `POKOIN_CI_WAIT_S`, `POKOIN_CI_API_RETRIES` and `POKOIN_CI_MISSING_GRACE_S`.

Why only the newest `main` commit is usually shippable: the workflows use `cancel-in-progress`, so when a newer commit lands on `main` the runs of the older one are cancelled, and a cancelled check is not green. Ship the newest `origin/main` commit, or re-run the failed workflow on GitHub for the older one.

The required names are in `scripts/ci-required-checks`: `rust-gate`, `repo-gate` and `secret-gate`. `js-gate` joins when the JavaScript workflow lands. Add a name there only after that check exists on `main`; a name nobody produces blocks every deploy.

Override (owner only): `POKOIN_CI_OVERRIDE=<full 40-hex commit id>:<reason>` skips the check for that one commit. The reason is at least 10 characters of letters, digits, space and `.,;_()/#-`. A use is valid only when both records are written: a line in `$HOME/pokoin-deploy/ci-gate.log` and an incident in the ops record (`lucina-rs ops record --source pokoin-ci-gate`, or `POKOIN_OPS_RECORD_CMD`). If either cannot be written, the override is refused. Lane workers never get it: it is refused whenever `LANE_WORKER` is set. An agent never sets it; if you are an agent and the gate refuses, stop and report.

Every run that ends is logged: one line in `$HOME/pokoin-deploy/ci-gate.log` with the UTC time, the full commit, the result (`green`, `refused` or `override`), the reason and the caller.
