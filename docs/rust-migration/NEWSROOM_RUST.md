# X-NEWS native newsroom: implementation and cutover gate

**Status: partial port; J17 is not ready to replace Node.** Do not deploy or
cut over this revision. The activation preflight deliberately fails before
any service is stopped. This is not a completed Rust migration.

## Reference and ownership

- Repository `/home/nez/Projects/pokoin-web`, branch `feat/newsroom-rust`.
- Lucina reference `d372ecffb3846115e403ea6befc08759789f013a` (`secretary-live`).
- Live publisher checkout `f2acfd3e4c8be9fcb58c7cf8419d9176e09c314b` under
  `/home/nez/services/pokoin-newsroom/app`. All 24 newsroom modules were
  byte-identical to the Lucina reference when inspected on 2026-10-22.
- Inventory IDs: **J17** publisher user service; **H42** `GET /api/poko/news`;
  **F16** legacy website article file.
- Sources and asset hashes: `pokoin-rust/apps/newsroom/assets/provenance.json`.
  Schemas, game registry, templates and the exact model system prompts are
  embedded data. No JavaScript engine or Node subprocess exists in Rust.
- Codevira tools were not exposed in this session. The locked decisions in
  AGENTS.md were read; `.codevira/*.jsonl` was not opened.

The live unit is `pokoin-newsroom.service`, a **user** unit. It uses Infisical,
`POKO_NEWSROOM_CLAUDE_PROVIDER=deepseek`, `deepseek-flash` at the Anthropic-
compatible `/anthropic/v1/messages` endpoint, high effort for reporter and
repair, max effort for editor, adaptive thinking, 96000 max tokens, streaming.
Anthropic configuration retains Opus 5.5 / Sonnet 5.5 repair, 32000 max tokens,
JSON Schema structured outputs and the server-side fallback beta. Both use
reqwest directly. There is no native `claude-cli` fallback.

Actual live data directory: `/home/nez/services/pokoin-newsroom/data`.
The standalone publisher has **no SQL tables or Redis keys**: it owns JSON
CMS/cadence files and Firestore `news_comments`. Pokoin enrichment uses public
HTTP reads. The legacy scout (`index.js`) has separate social adapters; it is
not called by `scripts/newsroom-publisher.mjs`. J17 publishes the website
projection, not Telegram or Discord posts. Do not silently start social sends.

## Implemented and tested

The crate lives at `pokoin-rust/apps/newsroom` and is a member of the
`pokoin-rust` workspace, so `cargo test --workspace` builds and tests it in CI.
It is still **not deployed** and registers no route in the shared API.

| Entry | Implemented pieces | Remaining integration |
| --- | --- | --- |
| J17 | Exact cadence/candidate/update plan; source hosts/tiers; deterministic hints, template eligibility and worthiness; model schemas/prompts; reporter/editor/repair primitives; moderation rules and Firestore/JWT primitives; record/revision storage and permanent slug guard | Native scout/evidence pipeline, full publication gates, CMS orchestration and publisher/moderator loops |
| H42 | axum route, GET list/slug/story/export, authorization, statuses, headers, missing-file behavior; live and nonempty synthetic tests | Register route in shared API/edge and verify upstream routing/auth |
| F16 | Legacy `newsroom-articles.json` projection read semantics, separate from v1 CMS exports | Shared API must receive the correct legacy data mount; do not substitute v1 records |

`store.rs` keeps the Node filenames and fields. `snapshot` validates all three
critical JSON files and hashes them before and after copying. Unknown fields,
lessons, revisions and media are preserved. Read-only API loads keep Node's
empty-on-failure behavior; cutover validation is strict so corruption cannot
reset cadence. `store::DataLock` is an exclusive lock **primitive**: no command
acquires it yet, so today it prevents nothing by itself. The unmodified Node
publisher does not take that lock either, so stopping Node completely
is a mandatory protocol precondition.

## Read-only acceptance evidence (2026-10-22)

No production unit was stopped, restarted, reconfigured or installed. No
production post, comment, moderation patch, bet or database write was made.
No bot token was used. All builds used `nice -n 10`, `CARGO_BUILD_JOBS=3`, no GPU.

Fixtures are under `pokoin-rust/apps/newsroom/fixtures/`:

- `schedule.json`: Node reference over **276 stories, 22 CMS records, 20 active
  games**, captured at **2026-10-22T19:39:50.083Z**. Rust matches every slot,
  reason, cadence parameter, remaining attempt count and ordered candidate id
  exactly. Its `updates` list is empty on both sides: the golden has no
  living-story update ids, so only the **no-update** direction of that rule is
  matched here (an update that is actually proposed is covered by the
  `cadence::plan` tests). This is the plan over existing scout state;
  it is not a new native scouting pass.
- `h42-live.json`: six public **GET** responses from the live Lucina HTTP
  listener `127.0.0.1:8788`: list, absent slug, absent story, invalid export,
  unauthorized all-export, published-export. Live article collections were
  empty. Nonempty contents and authorized exports are tested with local files.
- `editorial.json`: injected Node provider captures reporter, editor and update
  request JSON, with the clock fixed. Rust requests and trimmed evidence match.
  No real model call was used to capture these request goldens. They cover
  `strictSchema=true` requests only: the production DeepSeek provider is
  non-strict, and where its `output_schema`/`output_rules` sit in the request is
  matched by the non-strict key-order tests in `tests/parity.rs`, not by this
  fixture.
- `live-evidence.json`: the actual open Magic candidate
  `story_20261021_a1lxkm` (“Magic: The Gathering Confirms All Star Trek Set
  Products and Prices”). Node's evidence builder was invoked with **GET-only**
  fetch injection, resulting in five GET attempts, zero fetched documents and
  zero extracted claims. It produced worthiness **0.22**, decision **skip**.
  This matches the live publisher's recent `editorial_worthiness_skip` logs.
- `dry-run-report.json`: a Rust replay reading the real live state and that
  captured evidence at the same clock. Exact same plan, hints, templates and
  worthiness; `editorial_worthiness_skip`, **0 model calls**, **no draft**.
  The replay derives the worthiness flags the way the live publisher passes
  them instead of hardcoding them: `allowSingleSpecialist` is whether that
  slot's cadence kind is daily, and `covered` is an existing English CMS record
  for the story whose pack is not an update. So a story with no record can
  still skip on its score, and a covered story is never skipped for its score.

The dry-run command used (output was copied into the fixture directory only
for review; production files were read-only):

```sh
nice -n 10 "$HOME/.cache/pokoin-newsroom-target/debug/pokoin-newsroom" dry-run \
  --data-dir /home/nez/services/pokoin-newsroom/data \
  --input pokoin-rust/apps/newsroom/fixtures/live-evidence.json \
  --now 2026-10-22T19:39:50.083Z --max-model-calls 10 \
  --output "$HOME/scratch/newsroom/pokoin-newsroom-rust-dry-run.json"
```

This establishes **skip parity**, not generated-draft parity. It would be
incorrect to generate an article for this candidate merely to show a draft.
A successful real reporter/editor draft comparison is still required. The
capture uses the Node evidence builder as a development reference; the Rust
binary consumes only JSON, but has not yet replaced that builder.

## Formal handover model

`tests/handover_model.rs` uses Stateright BFS and the actual Rust `slot_open`:

- **395875 daily** and **2425 weekly** unique states are what the current model
  BFS *prints*. Those counts are reported, not asserted: the tests assert the
  invariants below, so a rule change that moves a count is not a test failure
  by itself.
- Two canonical stories, review/published records, generation attempts,
  midnight/rolling-week time steps, stop, start, crash before/after static
  projection, repeated projection and rollback.
- Invariants: cadence cap and publication gap survive handover; a canonical
  story is committed once across handover; every
  public projection has a durable published CMS record. Reachability checks
  cover Rust publication and rollback retaining publications.
- A reset-on-handover mutant yields a duplicate canonical story counterexample.

Assumptions: one active publisher at a time, atomic durable CMS commit, shared
state survives handover, and deployment projects permanent URLs. A repeated
static build of the same URL is not a new article. The model does **not** prove
filesystem/remote deployment behavior, unmodeled multi-host writers or social
exactly-once delivery. End-to-end crash injection against the completed native
publisher is still required; this is a protocol model, not a completion claim.

## Validation

- `cargo test --manifest-path pokoin-rust/apps/newsroom/Cargo.toml`: 18
  parity/integration tests and two Stateright tests pass, zero failures.
- `cargo fmt --manifest-path pokoin-rust/apps/newsroom/Cargo.toml --check`: clean.
- `cargo clippy --manifest-path pokoin-rust/apps/newsroom/Cargo.toml --all-targets -- -D warnings`: clean.
- `cargo test -p pokoin-newsroom --test cutover_script`: four local-fake
  orchestration tests pass (preflight refusal, success, failed health
  rollback, and refusal to start Node when Rust cannot be stopped).
- `bash -n scripts/cutover-newsroom-rust.sh`: clean.

## Required parity gaps before activation

1. Port `tcg-feeds.js`, `games.js` detection and `stories.js` clustering into
   native HTTP scouting/placement. Cadence currently consumes existing state.
2. Port `source-fetch.js`, `claims.js`, evidence construction, primary-source
   discovery, `enrich.js` and image planning/composition. These determine facts,
   exact printings, market metrics and whether a story deserves an article;
   substituting empty packs would silently change publishing behavior.
3. Port all `schema.js` article validation, `publication.js` checks, originality
   checks, gate/autopublish policy, revisions/corrections, pending revisions,
   lesson persistence and living updates. Reporter schema validation alone
   is insufficient to authorize publication.
4. Wire the native hourly publish cycle and independent 60-second moderation
   cycle (including their no-overlap guards), 45-minute token cache and all
   persistence into the above primitives. Add the static projection/deploy
   adapter with its 15-minute timeout. The current `run` refuses to start.
5. Exercise provider refusal, repair, outage and retry behavior more broadly.
   SDK automatic HTTP retries/error envelopes are not fully mirrored. Require
   real eligible-draft parity within a shared 10-call budget, no production
   publishing. Existing request equality and local SSE tests are insufficient.
6. Mount F16 correctly and integrate H42 into the production API router.
   `serve` now refuses to start without an explicit `--legacy-data-dir`:
   `--data-dir` holds the v2 CMS exports, and substituting it would serve the
   wrong v1 records. Nothing passes that mount yet, so
   `newsroom-articles.json` is still not read by the Rust binary; `status`
   lists this as a parity gap.
7. Run crash/rollback acceptance against local fakes and reconcile the
   implementation with the formal model. Only then replace the explicit
   `PARITY_COMPLETE=false` activation gate as part of a reviewed implementation.

## Operator preparation and exact future cutover

**Steps that change services below are future steps after all gaps close. Do
not execute them with this revision.** The script's current activation check
exits nonzero before its first `systemctl` call.

1. Merge and push the reviewed, parity-complete commit through the normal
   authorized process. Build/test that pinned commit. This task did not push.
   Build command (standalone crate):

   ```sh
   export CARGO_BUILD_JOBS=3 CARGO_INCREMENTAL=0
   export CARGO_TARGET_DIR="$HOME/.cache/pokoin-newsroom-target"
   nice -n 10 cargo build --release --locked --manifest-path pokoin-rust/apps/newsroom/Cargo.toml
   ```

2. Install the exact reviewed binary at
   `$HOME/services/pokoin-newsroom/rust/pokoin-newsroom`. Install the two unit
   files from `deploy/systemd/pokoin-newsroom-rust*.service` into
   `$HOME/.config/systemd/user/`. Create the `checks` directory beside `data`.
   Do not start/enable the Rust publisher yet. Preserve `POKOIN_WEB_DIR` and
   autopublish settings from the live unit. The units provided here are gated
   templates; real readiness must be implemented before using them.
3. Materialize the same model/Firebase/export secrets from the existing secret
   source into `$HOME/.config/pokoin/newsroom.env`, owned by `nez`, **0600**.
   Keep `DEEPSEEK_KEY`/`DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY` names unchanged.
   Never print the env, put secrets on argv, or commit it. Retain
   `NEWSROOM_DATA_DIR=$HOME/services/pokoin-newsroom/data`. No empty state seed.
4. Complete a new read-only acceptance run against current real data. Keep
   output under `checks/`, outside `data/`; use the dry-run unit only after its
   captured-evidence mode has been upgraded to the complete native cycle.
   Account for all model calls including repairs in the maximum of 10.
5. Reload installed unit definitions, then invoke the operator script:

   ```sh
   systemctl --user daemon-reload
   scripts/cutover-newsroom-rust.sh --execute
   ```

   It preflights before touching services, locks cutover, stops and confirms
   Node is inactive, snapshots **all current shared state**, starts Rust, then
   checks active state plus native readiness for up to 30 seconds. It never
   starts Node while Rust may still be active. Failed health stops Rust and
   restarts Node with the **current shared state**. It does not restore the
   pre-cutover snapshot, which could forget a successful Rust publication.
   Backup lives at `services/pokoin-newsroom/rollbacks/<UTC>-<pid>`.
6. Inspect the first complete publish and moderation cycles plus H42. Only
   after health and parity remain good, disable Node and enable Rust for boot:

   ```sh
   systemctl --user disable pokoin-newsroom.service
   systemctl --user enable pokoin-newsroom-rust.service
   ```

   To roll back later: stop Rust and confirm inactive, then start Node using
   the same current data files; switch boot enablement back as appropriate.
   Keep the original service installed during the observation period. Never
   restore cadence/CMS backups blindly or run both publishers concurrently.
