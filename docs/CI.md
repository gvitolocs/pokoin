# CI for the Rust API: check locally first, GitHub gates the merge

The fast check runs on nezopt in your worktree. GitHub repeats the gate that already guards a release, plus a "nothing new" check on the diff. Ported from LucinaOS `docs/ci/SHIFT-LEFT.md`, without the proof tiers.

| Tier | Runs | Where | Decides |
| --- | --- | --- | --- |
| Fast check | `scripts/check-fast` | Your worktree, before a commit | Nothing by itself; it tells you early |
| GitHub `rust-gate` | `.github/workflows/rust-ci.yml`: jobs `test` and `changed` | GitHub, on pull requests and pushes to `main` that touch `pokoin-rust/` | Whether the PR may merge, once the owner makes it a required check |
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

Triggers: `pull_request` and `push` to `main`, only when `pokoin-rust/**`, the workflow or `scripts/check-fast` change. Permissions are `contents: read`, there are no secrets and no deploy step, and actions are pinned by commit SHA.

- `test`: `cargo test --workspace --locked` without a database, as in the release gate
- `changed`: `scripts/check-fast --no-test` against the PR's base branch (or the push's previous commit). On the runner `diffgate`, `actionlint` and `gitleaks` are not installed, so they show as `SKIPPED`
- `flow-db`: the `*_flow` binaries against Postgres 17, informational
- `rust-gate`: runs always; fails unless `test` and `changed` both succeeded. This is the one required check

### Making `rust-gate` required (owner, in GitHub)

Settings, Branches (or Rulesets), `main`: require status checks to pass and add `rust-gate`. Do this only after one green run of the workflow on a PR.

Catch: because of the `paths` filter, a PR that touches nothing under `pokoin-rust/` never starts the workflow, and GitHub then waits for the required `rust-gate` forever. Either drop the `paths` filter from `rust-ci.yml` (the jobs then run on every PR, and `changed` is quick when nothing under `pokoin-rust/` moved) before requiring the check, or keep merging non-Rust PRs by an admin override.
