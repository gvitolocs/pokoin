# Native newsroom work in progress

**X-NEWS is incomplete. Do not cut over this revision.** `run`, `ready`, and
`preflight --activate` fail closed. Node remains the production owner. This is
an isolated Cargo workspace so the partial port does not change API releases.

Inventory: J17 (publisher), H42 (`GET /api/poko/news`), F16 (legacy article file).
The full scope and operator procedure are in
[NEWSROOM_RUST.md](../../../docs/rust-migration/NEWSROOM_RUST.md).

Implemented modules:

- `cadence`: daily/weekly caps, attempt caps, review accounting, candidate rank,
  living-story update plan. Popular = pokemon, one_piece, magic, yugioh,
  lorcana, riftbound. Weekly is a rolling seven-day window, not ISO weeks.
- `sources`: outlet/host resolution, tier and story status.
- `templates`: deterministic hints, eligibility and editorial worthiness.
- `editorial`, `model`: embedded Node schemas/prompts, normalization, evidence
  references, reporter/editor/repair passes and reqwest streamed Messages API.
  Production configuration uses DeepSeek's Anthropic-compatible endpoint;
  Anthropic uses Opus 5.5 and Sonnet 5.5 repair by default. No CLI/JS fallback.
- `moderation`: prechecks, decision parsing, DeepSeek Flash request, 24-hour
  unavailable hold, Firestore values, key normalization, service-account JWT
  and REST query/patch primitives. No production poller is started.
- `store`: Node-compatible CMS records/revision snapshots, permanent slugs,
  exports, native exclusive lock, strict state validation, 0600 env loader.
- `website`: standalone axum H42 handler preserving legacy/v1 distinction,
  export authorization, headers, errors and supported method.
- `handover`: state digest/snapshot and explicit incomplete-parity gate.

Commands (from repository root):

```sh
export CARGO_BUILD_JOBS=3 CARGO_INCREMENTAL=0
export CARGO_TARGET_DIR="$HOME/.cache/pokoin-newsroom-target"
nice -n 10 cargo test --manifest-path pokoin-rust/apps/newsroom/Cargo.toml
nice -n 10 cargo clippy --manifest-path pokoin-rust/apps/newsroom/Cargo.toml --all-targets -- -D warnings
nice -n 10 cargo fmt --manifest-path pokoin-rust/apps/newsroom/Cargo.toml --check
```

`plan` reads state without changing it. `dry-run` is a **captured-evidence
replay**, not the full native publisher cycle: provide a read-only captured
pack and an output path outside live data. It computes editorial worthiness
first and does not call a model for skipped stories. Model calls share a hard
budget (default 4, maximum 10 including repairs); retries are not hidden.
`serve --bind 127.0.0.1:<workspace-port>` serves H42 only. It does not register
routes in the existing shared API or expose a production health endpoint.

`tools/*.mjs` and `capture-get.py` are development capture tools. They are not
used by the Rust binary, systemd units or cutover script. Their imports are
read-only references; the evidence capture injects a GET-only fetch function.
`capture-assets.mjs` embeds prompt text/schema data, never JavaScript source.

Secrets: pass `--env-file /absolute/path` after the command. The file must be
owned by the runtime user, mode 0600, and must not be a symlink. `KEY=value`,
`export KEY=value`, and outer single/double quotes are supported; no expansion
or shell evaluation occurs. The private key normalization handles escaped
newlines. Never place this env file in the repository. The live service obtains
keys through Infisical; this port does not export or migrate secrets itself.

See the runbook for all remaining parity gaps and the limits of the model.
