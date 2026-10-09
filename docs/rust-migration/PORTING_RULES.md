# Porting Node API handlers to native Rust — rules for every task

Production rule (AGENTS.md, Codevira D00008C): the shared Pokoin API runs as native Rust.
No Node at request time, no proxy to Node, no JS engine, no placeholder success payloads.

## Reference = the live production Node code
- Snapshot of the running container: ``.reference-node/api/*.js` and `.reference-node/server/*.js` (inside this worktree, git-ignored).
  These are the exact files production runs. Port THOSE, not repo copies.
- Read the handler AND every helper it requires (`./_*.js`). Port only what the route uses.

## What "parity" means (all of it)
- Same path(s) and HTTP methods as `docs/rust-migration/live-routes-20261008.json`; OPTIONS answers exactly like Node
  (status, CORS headers). Unsupported method -> same status/body as Node (often 405 + `Allow`).
- Same query/body parameter names and aliases, same defaults, clamps and validation messages.
- Same status codes and JSON bodies: field names, nesting, types (string ids stay strings), null vs missing,
  array order, error message text.
- Same response headers the handler sets (`Content-Type`, `Cache-Control`, CORS, `Location`, `X-*`).
- Same SQL. Copy the SQL text verbatim and bind values with `$n` (sqlx `query`/`query_as`/`query_scalar`).
  Never interpolate request values into SQL. Use `to_jsonb(...)` / `row_to_json` + `serde_json::Value` when the
  Node code passes whole rows through, so column names stay identical.
- Same Redis keys, TTLs and value formats when the handler caches (Node and Rust share the Pi Redis during the
  cutover). Redis is fail-open: if it is down, compute the answer without the cache.
- Same game scoping: resolve the game with
  `pokoin_api_common::game::parse_game_from_request(&http::header_pairs(&headers), q.first("game"), q.first("marketplaceGame"))`
  (or whatever precedence the Node handler uses) and read that game's catalog with `state.api.game_pool(&game)`.
  `pokemon` reads `state.api.read()`.
- Timeouts/fallbacks the Node code has (`withTimeout`, `Promise.race`) keep the same budget and fallback value.

## Building blocks (crate `pokoin-api-common`, already in the workspace)
- `RouteState { api: ApiState, accounts: pokoin_accounts::DomainState }` is the axum state of every route crate.
  - `state.api.read()` replica PgPool (reads), `state.api.write()` writer PgPool (all SQL writes),
    `state.api.redis().await -> Option<ConnectionManager>`, `state.api.http()` reqwest client,
    `state.api.game_pool(game).await`.
  - `state.require_user(&headers).await -> Result<Claims, Response>` = Node `verifyBearerToken` (401 `Missing Pokoin bearer token.`).
  - `state.optional_user(&headers).await -> Option<Claims>`; `state.require_debug_admin(&headers)` = `_search_debug_auth.js`.
  - `state.accounts.firestore()`, `.auth()`, `.service_account()` for Firestore/Firebase Admin needs.
- `pokoin_api_common::http`: `Query::from_uri(&uri)` (`get`/`text`/`any`/`first`/`last`/`all`, Node `req.query` semantics),
  `parse_body(&headers, &bytes) -> Result<NodeBody, Response>` (`.json()` = `req.body`),
  `json(status, value)`, `json_with(status, value, &[(name, value)])`, `raw(...)`, `json_ok(body, cache_control)`,
  `READ_CORS`, `read_preflight()`, `js_number`, `parse_public_card_id`, `parse_id_list`, `parse_limit`, `parse_offset`, `bearer`.
- A global middleware already applies `_public_error.sanitizePublicJson` to error responses and a 10 MiB body limit.
- Handlers take `State(state): State<RouteState>`, `headers: HeaderMap`, `uri: Uri`, and `body: Bytes` when they read a body.

## Constraints
- Work only inside the directories your task names. Do not edit Cargo.toml / Cargo.lock / other crates. If you need a
  dependency that is not already in your crate's Cargo.toml, stop and say which one in your final message.
- No `git commit/push/rebase/stash/reset/checkout`. No edits outside the task's directories.
- `unsafe` is forbidden. No `unwrap()`/`expect()` on request data or I/O results in handlers.
- Schema questions: `pokoin-sql-ro "select ..."` (read-only session, 15 s timeout) runs SQL against the production
  writer database `pokoin_marketplace` (other games: `pokoin-sql-ro -d pokoin_one_piece "..."`). Use it to check that
  every SQL statement you port parses and returns the columns you expect (`EXPLAIN` or `... LIMIT 1`). Keep queries small.
- Rust: `source ~/.cargo/env`; use the target dir your task names (`CARGO_TARGET_DIR=...`).
- Something truly impossible to port natively (e.g. an external service that has no HTTP API) -> return the same error
  the Node handler returns when that dependency is unavailable, and list it in your final message. Never fake success.

## Tests (required)
- Unit tests for every pure function you port (parsers, mappers, ranking, SQL param building), with cases taken from
  the Node code paths (and from `*.test.js` next to the reference when it exists — port those assertions).
- A router test per module: every route answers its methods (not 404/405) using `tower::ServiceExt::oneshot`, with a
  state built from lazy pools pointing at `postgres://x@127.0.0.1:1/x` (DB-touching handlers will then return their
  DB-failure response, which is fine for this test). Build the state with
  `RouteState::new(ApiState::new(pool.clone(), pool, None, 1), pokoin_accounts::DomainState::default())`.
- `cargo test -p <your crate>` must pass with 0 failures; `cargo clippy` is not required.

## Final message
List: routes ported (method + path), files created, any behaviour you could not reproduce exactly (and why),
any dependency you need added, and the `test result:` lines.

## Production configuration (port the branches production actually runs)
Non-secret flags of the live Node container: `MARKETPLACE_SEARCH_ENGINE=redis` (Meilisearch and Valkey are RETIRED:
code paths that only run with the meili engine are dead in production; port the redis-engine path and treat Meili as
unavailable), `PIPELINE_HEALTH_SKIP=meili`, `USE_ORACLE_API=0`, `PUBLIC_SITE_URL=https://pokoin.com`,
`POKOIN_CARD_CDN_BASE_URL=https://cdn.pokoin.com`, `REDIS_HOST=127.0.0.1`, `REDIS_PORT=6380`, `POKOIN_REDIS_INDEX=pokoin:cards`,
`MARKETPLACE_NAME_SEARCH_TIMEOUT_MS=4000`, `MARKETPLACE_NAME_SEARCH_CIRCUIT_MS=60000`, `POKONTACT_SERVICE_TIMEOUT_MS=0`,
`POKOIN_REQUIRE_VERIFIED_PASSWORD` is set. Secrets (Stripe, Firebase, R2, Supabase, CardTrader, per-game database URLs,
`TCGCSV_DATABASE_URL`, `MARKETPLACE_NAME_SEARCH_DATABASE_URL`, `DEAL_SCAN_TOKEN`, `POKONTACT_SERVICE_*`, `POKO_CHAT_URL`)
are present in the Rust service environment under the same names — read them with `std::env::var` exactly like Node.
The Redis search index (RediSearch `FT.SEARCH` on `pokoin:cards`) is what the redis engine queries; see
`api/_redis_search.js` and the existing Rust port in `pokoin-rust/crates/search` (`redis_query.rs`) — reuse it where it fits.

## Security release (live since 2026-10-08 22:39 UTC, PR #266) — already handled globally
The Rust app applies, around every route, the ports of `_http_security.prepareRequest`, `_cors_policy`,
`_client_ip.applyTrustedClientIp` and `_route_limits`. Consequences for handler ports:
- Read the client IP ONLY via `pokoin_api_common::security::client_ip(&headers)` (the middleware stamps the trusted
  value into `x-pokoin-client-ip`); never parse `x-forwarded-for` yourself.
- Do not set CORS headers for correctness — the global policy replaces them — but keeping the Node calls is harmless.
- Rate limits: `limitGlobal` = `pokoin_api_common::limits::limit_global(&state.api, scope, identity, limit, window)`
  (Postgres `marketplace_rate_limits` via the writer, Redis fallback with halved limit, else fail closed);
  `limitBestEffort` = `pokoin_api_common::limits::limit_best_effort(...)`; `limitSecurityCritical` =
  `pokoin_api_common::limits::limit_security_critical(...)`. Use exactly the class the Node handler uses.
- Auth: invalid token -> 401 `{"error":"Invalid or expired sign-in token."}`, verifier unavailable -> 503
  `{"error":"Sign-in could not be checked right now."}` (handled by `state.require_user`).
