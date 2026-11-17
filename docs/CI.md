# CI for the Rust API: check locally first, GitHub gates the merge

The fast check runs on nezopt in your worktree. GitHub repeats the gate that already guards a release, plus a "nothing new" check on the diff. Ported from LucinaOS `docs/ci/SHIFT-LEFT.md`, without the proof tiers.

| Tier | Runs | Where | Decides |
| --- | --- | --- | --- |
| Fast check | `scripts/check-fast` | Your worktree, before a commit | Nothing by itself; it tells you early |
| GitHub `rust-gate` | `.github/workflows/rust-ci.yml`: jobs `changes`, `test`, `changed`, `flow-db` | GitHub, on every pull request and every push to `main`; the Rust jobs run only when Rust files changed | Whether the PR may merge, once the owner makes it a required check |
| GitHub `repo-gate` | `.github/workflows/repo-ci.yml`: job `gate-tests` | GitHub, on every pull request and every push to `main` | Whether the deploy gate's own scripts still work; `scripts/require-ci-green.sh` also reads it before anything ships |
| Unsafe-code check | `scripts/rust-lints-check.sh` and its test, as steps of `gate-tests` | GitHub, on every pull request and every push to `main`; part of `repo-gate` | Whether a `pokoin-rust` crate is left out of `unsafe_code = "forbid"`, or an exception to that rule was added; see "Unsafe code" below |
| GitHub `secret-gate` | `.github/workflows/secrets-ci.yml`: `scripts/ci-secret-scan.sh` (gitleaks over the commit range and the tree, fails on any allowlist change) and its test | GitHub, on every pull request and every push to `main` | Whether the PR may merge, once the owner makes it a required check; it is also in scripts/ci-required-checks, so a commit ships only when it is green; docs/SECRETS.md |
| `flow-db` | Same workflow, `scripts/run-flow-tests.sh` against a Postgres 17 service | GitHub, only when Rust files changed | Part of `rust-gate`: every `*_flow` binary runs in a database of its own, and a binary that fails, prints `skipped:` or runs no test is a failure |
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

- `changes`: `git diff --name-only` against the PR's merge base (or the push's previous commit) with full history. Output `rust=true` when `pokoin-rust/**`, `.github/workflows/rust-ci.yml`, `scripts/check-fast*`, `scripts/run-flow-tests*`, `scripts/rust-lints-check*`, `scripts/rust-unsafe-exceptions.txt` or `scripts/flow-test-workers*` changed, else `rust=false`
- `test`: only when `rust=true`. The same coverage as the release gate's `cargo test --workspace --locked`, without a database, but as 6 shards of workspace packages (`cargo test -p … --locked --no-fail-fast`, packages taken from `cargo metadata` so new crates are included). A single `cargo test --workspace` froze the GitHub runner VM three times (the log is lost, "runner lost communication"), while every package and every shard passes alone; the cause is not found. The `test` result is the aggregate of the shards
- `changed`: only when `rust=true`. `scripts/check-fast --no-test` against the PR's base branch (or the push's previous commit). On the runner `diffgate`, `actionlint` and `gitleaks` are not installed, so they show as `SKIPPED`
- `flow-db`: only when `rust=true`, and `rust-gate` waits for it. `scripts/run-flow-tests.sh` discovers every tracked `pokoin-rust/crates/<crate>/tests/<name>_flow.rs` in the tree, creates a fresh database `flow_<name>` for each from `POKOIN_FLOW_ADMIN_URL`, and runs that one binary in it with both `POKOIN_TEST_DATABASE_URL` and `POKOIN_PRICE_EXPORT_TEST_DATABASE_URL` set to that database. One shared database used to let a binary read tables an earlier one had left behind with a different shape, and `price_export_flow` skipped itself because the job never set the variable it reads. A binary is a failure when cargo exits non-zero, when its output has a line starting with `skipped:` (a guard returned early, so nothing was asserted), or when it reports no passed test at all. The host of `POKOIN_FLOW_ADMIN_URL` must be `127.0.0.1`, `localhost` or `::1`: the script creates and drops databases, so it refuses any URL that is not a throwaway Postgres on the runner. Every binary runs even after one fails, and the job ends with one table (binary, package, result, passed, seconds). `pokoin_commerce::router()` is not a pure constructor but starts three background workers, so every flow test that builds one switches `POKOIN_SELLER_BOOK_WORKER`, `POKOIN_LISTING_SYNC_WORKER` and `POKOIN_SELLER_WEBHOOK_WORKER` off next to its database guard, or carries a line with its reason in `scripts/flow-test-workers-exceptions.txt`: the seller-book sweep racing the assertion it was supposed to feed is what made `seller_snapshot_flow` fail roughly one run in five (PKN-09). `scripts/flow-test-workers-check.sh --base <commit>` enforces that rule, and `repo-gate` runs it and `scripts/flow-test-workers-check.test.sh` so the gate cannot quietly stop checking (`bash scripts/flow-test-workers-check.sh` runs it locally, with no database and no cargo)
- `rust-gate`: always runs. Passes at once when `rust=false` (nothing to check). Otherwise passes only when `test`, `changed` and `flow-db` all succeeded. A failed or cancelled `changes` job fails it. It prints one line saying which case applied. This is the one required check

Locally: start a throwaway Postgres whose user may create databases and point `POKOIN_FLOW_ADMIN_URL` at it (`postgres://postgres:test@127.0.0.1:<port>/postgres`, the shape `scripts/check-fast --db` starts, though that one is removed when the check exits), then run `bash scripts/run-flow-tests.sh` from the repository root. `bash scripts/run-flow-tests.sh --list` prints the binaries, packages and database names it discovered and changes nothing, and `bash scripts/run-flow-tests.test.sh` covers the script itself against a fake `psql` and a fake `cargo`.

### Making `rust-gate` required (owner, in GitHub)

Because `rust-gate` always runs, requiring it cannot block front-end PRs. Do this only AFTER this workflow is on `main`: before that, no PR gets the check from a base that has it and GitHub waits for a status that may never come.

1. Merge the PR that adds `.github/workflows/rust-ci.yml` and confirm `rust-gate` is green on a later PR.
2. Settings, Branches, Add branch protection rule (or Rulesets, New branch ruleset) for `main`.
3. Tick "Require status checks to pass before merging".
4. Search for `rust-gate` and select it (it appears only after it has run once in the last week).
5. Save. Do not add `test`, `changed` or `flow-db`; each is skipped on non-Rust PRs and a skipped required check counts as passed only through `rust-gate`, which now waits for all three.

The same steps apply to `repo-gate` (from `.github/workflows/repo-ci.yml`): merge the workflow first, then require `repo-gate` as well.

## Unsafe code

Unsafe code is forbidden in every crate of `pokoin-rust/` by the compiler, not by review: each crate manifest carries

```toml
[lints.rust]
unsafe_code = "forbid"
```

so a new `unsafe` block, `unsafe fn`, `unsafe impl` or `unsafe extern` is a build error rather than a discussion.

`scripts/rust-lints-check.sh` covers the other half: that no crate is left out of the rule. It walks every tracked `pokoin-rust/**/Cargo.toml` with a `[package]` section and fails on a crate that neither has that table nor is listed in `scripts/rust-unsafe-exceptions.txt` (one `crate directory<TAB>reason` line per crate). It also fails on an exception whose directory is gone, whose crate has the table anyway, whose reason is shorter than 15 characters, or whose sources no longer contain `unsafe` — the list cannot quietly rot or protect nothing.

The exceptions today are `pokoin-rust/crates/shared-dictionary` (Brotli's C library through `brotlic_sys`, the raw shared dictionaries of RFC 9842) and `pokoin-rust/apps/cardtrader-bridge` (`libc::flock` on the gate file the Oracle pipeline processes share).

**CI fails on every added exception**: with `--base`, the check compares the list against the base commit and refuses any line that was not already there. An added exception ships only with the owner's logged override of `scripts/require-ci-green.sh` ("Deploy gate" below). Removing a line is always fine: give the crate the table and retire the exception. `scripts/rust-lints-check.test.sh` proves each rule on throwaway repositories. Both run as steps of `gate-tests` in `.github/workflows/repo-ci.yml`, so the check is part of `repo-gate`; `rust-ci.yml` also re-runs the Rust jobs when the checker or the list changes.

```bash
scripts/rust-lints-check.sh                  # what every crate does today
scripts/rust-lints-check.sh --base origin/main   # as CI runs it
```

## Deploy gate: main must be green to ship

A commit ships only when its required GitHub checks are green. `scripts/require-ci-green.sh <commit>` asks GitHub for the check runs of that exact commit (`gh api repos/gvitolocs/pokoin/commits/<sha>/check-runs`) and exits 0 only when every name in `scripts/ci-required-checks` has a completed run that ended in `success`. The list is read from the commit being shipped, so a commit without the list cannot ship. Only runs made by GitHub Actions count; a check with the right name from another app does not. When a check was run more than once, the newest run decides. `skipped`, `cancelled`, `neutral`, `timed_out` and a missing run are not green. Any error talking to GitHub is a refusal, never a pass.

These entry points call it before they do anything else that matters: `scripts/publish-web.sh` (upload mode), `scripts/deploy-web.sh`, `scripts/deploy-pokoin-rust.sh` and `scripts/build-pokoin-rust-release.sh`. `scripts/deploy-gate-callers.test.sh` fails if one of them stops calling it. `publish-web.sh --promote` asks no CI question at all — promoting an older version is the rollback path — but it does run the self-check below, and it ends the exception it used to have for unrecorded version ids. It records every upload and promotion, with the commit and the CI result, in `$HOME/pokoin-deploy/web-versions.tsv`.

The gate also checks the checkout it runs in: a gate that only exists in a checkout with main's scripts cannot bind an old checkout, which runs its own old scripts. Before any GitHub call, and before the override branch, `require-ci-green.sh` compares its own file, `scripts/ci-required-checks` next to it, and every `--caller-script` it is given (each entry point passes its own path) with `origin/main`'s copies, in the repository being shipped or in another work tree of it. A difference, a path `origin/main` does not have, a file from another repository, or a failing `git` call is a refusal logged as `refused`; without `--caller-script` only the first two files are compared. This check has no override: `POKOIN_CI_OVERRIDE` answers the CI question, never the question of which checkout is shipping. The gate does not fetch; `origin/main` is what the caller fetched a moment before. `--self-check-only` answers the comparison alone: no commit, no GitHub call, no log line.

`publish-web.sh --promote` ends its own exception. Every promote asks Cloudflare which versions it retains (`wrangler versions list --name pokoin-web --json`, the ids through `jq`) and prints `publish-web: N of M retained versions were uploaded through the gate`, or that they could not be listed, with the reason: the call failed, `jq` failed, no id came back. N counts the retained ids this host's versions file records as `green` or `override`. A recorded id is promoted without a warning; an unrecorded one still is while the list is unknown or `N < M` — the older versions are the rollback path and predate the gate — and once `N = M` the promote is refused and `versions deploy` is never called, since an id that is not a rollback target any more needs no exception. The promote path first runs the self-check above on itself and the gate (`--self-check-only`, after `git fetch -q origin main`, a failed fetch being a warning): a warning while the exception lives, a refusal once `N = M`. The `versions list --json` shape is from the Cloudflare documentation, not from a run of the real tool; the count line makes a wrong assumption visible.

Waiting: a check that is still running is waited for (poll every 30 seconds, give up after an hour). A check run that does not exist yet gets 5 minutes to appear, then it is a refusal. `--no-wait` refuses at once for anything not yet green. If GitHub cannot be read (`gh` fails or its answer does not parse), the gate does not wait out the hour: it refuses after `POKOIN_CI_API_RETRIES` unreadable answers in a row (default 5; a readable answer resets the count, and `--no-wait` refuses on the first). It finds `gh` on PATH, else at `$HOME/.local/bin/gh` (a non-login shell may not have `~/.local/bin` on PATH), and refuses at once when there is none (`GH=<path>` picks another binary). The settings are `POKOIN_CI_POLL_S`, `POKOIN_CI_WAIT_S`, `POKOIN_CI_API_RETRIES` and `POKOIN_CI_MISSING_GRACE_S`.

Why only the newest `main` commit is usually shippable: the workflows use `cancel-in-progress`, so when a newer commit lands on `main` the runs of the older one are cancelled, and a cancelled check is not green. Ship the newest `origin/main` commit, or re-run the failed workflow on GitHub for the older one.

The required names are in `scripts/ci-required-checks`: `rust-gate`, `repo-gate` and `secret-gate`. `js-gate` joins when the JavaScript workflow lands. Add a name there only after that check exists on `main`; a name nobody produces blocks every deploy.

Override (owner only): `POKOIN_CI_OVERRIDE=<full 40-hex commit id>:<reason>` skips the check for that one commit. The reason is at least 10 characters of letters, digits, space and `.,;_()/#-`. A use is valid only when both records are written: a line in `$HOME/pokoin-deploy/ci-gate.log` and an incident in the ops record (`lucina-rs ops record --source pokoin-ci-gate`, or `POKOIN_OPS_RECORD_CMD`). If either cannot be written, the override is refused. Lane workers never get it: it is refused whenever `LANE_WORKER` is set. An agent never sets it; if you are an agent and the gate refuses, stop and report.

Every run that ends is logged: one line in `$HOME/pokoin-deploy/ci-gate.log` with the UTC time, the full commit, the result (`green`, `refused` or `override`), the reason and the caller.

## Pushing to main

`.githooks/pre-push` is the local front door of that gate. A pull request is merged on GitHub and never passes through a local `git push`, so every local push that updates `refs/heads/main` is a direct push: 11 of the 161 first-parent commits on `main` in the 30 days before this hook existed were exactly that. For a remote url of this repository (`POKOIN_PUSH_GUARD_URL_RE` names it) the hook

- **secret-scans what it publishes**, every ref and not only `main`, a deletion excepted: `gitleaks detect --redact --log-opts=<remote sha>..<local sha>`, or `<local sha> --not --remotes=<remote>` for commits no remote branch has yet. A finding refuses the push (docs/SECRETS.md). Where this host has no gitleaks, it prints one warning that the push was not scanned and lets it pass; the CI `secret-gate` is unchanged by that.
- **refuses, for `refs/heads/main`,** deleting it, and any push that does not fast-forward the remote `main` (a rewrite of published history — refused even when the checks of that commit are green, and a remote sha this clone does not have counts as not an ancestor). Otherwise it runs `scripts/require-ci-green.sh --no-wait` on the commit, so a check that is still running is a refusal, never a wait.

The hook adds no switch of its own: the emergency path is the gate's `POKOIN_CI_OVERRIDE` above, logged and ops-recorded, and an agent never sets it. Every other remote passes silently.

Both are refusals only where the hook runs: it needs `core.hooksPath=.githooks` (`scripts/setup-git-hooks.sh`; active in every worktree on nezopt) and `git push --no-verify` skips it. That is why the deploy gate above is what makes an untested commit unshippable — the deploy entry points call `scripts/require-ci-green.sh` again, so a commit that reached `main` unchecked may sit there but will not ship.

`scripts/pre-push-hook.test.sh` covers it on throwaway repositories (the hook called directly with git's arguments and the ref lines on stdin, a fake `gh` through `GH=`, real gitleaks for the scan cases) and runs in the `gate-tests` job of `.github/workflows/repo-ci.yml`.
