# Validation, 2026-10-22

Worktree: `/home/nez/Projects/pokoin-x-poko`, branch `feature/x-poko-rust`.
All Cargo build/test/check commands used `nice -n 10`, `CARGO_BUILD_JOBS=3`,
and isolated `CARGO_TARGET_DIR=/tmp/x-poko-target`. No GPU or production
credentials were supplied to tests. All HTTP writes used local wiremock servers.

`cargo test --manifest-path pokoin-rust/Cargo.toml -p poko-bot --locked`:

```text
unit library:     test result: ok. 60 passed; 0 failed
connect_parity:   test result: ok. 1 passed; 0 failed
cutover_guard:    test result: ok. 1 passed; 0 failed
gate_parity:      test result: ok. 1 passed; 0 failed
hospital:         test result: ok. 2 passed; 0 failed
token_refresh_model: test result: ok. 1 passed; 0 failed
x_poko_parity:    test result: ok. 6 passed; 0 failed
youtube_oauth:    test result: ok. 10 passed; 0 failed
```

Total 82 tests. Binary unit and doc suites also passed with 0 tests.
The social parity test replays 167 cases generated from the exact p2 sources.
The denied OAuth callback test replays one captured GET response, replacing only
the Node recovery command with its documented native CLI equivalent. Other GET
captures are evidence for future routes, not claims of implemented parity.

`cargo clippy ... -p poko-bot --locked --all-targets -- -D warnings`:
`Finished dev profile` with exit 0, no warnings.

`cargo fmt ... -p poko-bot --check`: exit 0.
`git diff --check`: exit 0.
`bash -n apps/poko-bot/deploy/x-poko-cutover.sh`: exit 0.
`shellcheck apps/poko-bot/deploy/x-poko-cutover.sh`: exit 0.

The guard test exercises both `--check` and `--apply`: both reject the incomplete
ledger before bundle checks or host mutations. No successful production cutover,
rollback failure injection, full end-to-end bot flow, betting proof, or public
OAuth deployment has been validated. Those remain retirement blockers.
