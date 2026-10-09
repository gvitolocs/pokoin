# Handoff: compact c1 encoding

> **Done.** Implemented as an opt-in encoding; see
> [`docs/rust-migration/COMPACT_ENCODING.md`](../../rust-migration/COMPACT_ENCODING.md)
> for the design, the research and the measurements. The fixtures below are
> still live: `measure-sizes.py` measures against them, and `c1/` holds the
> Rust-encoded test vectors the `market/src/compact.test.js` cross-language
> round trip decodes. The task text is kept as written, for history.

Saved from the nezopt session "Compact c1 JSON dictionary encoding" (stopped 2026-10-09 to move the work to a cloud session).

## Progress
- Captured real public responses as size fixtures in `docs/handoff/compact-c1/fixtures/` (read-only GETs from api.pokoin.com). The Destined Rivals set page alone is **324 KB raw**.
- `docs/handoff/compact-c1/analyze.py` was the column-redundancy analysis it had started for the encoder design.
- No Rust code had been written yet.

## Task (continue from here)
Repository gvitolocs/pokoin. Rust workspace: pokoin-rust/ (the binary is pokoin-rust/apps/api; route crates are in pokoin-rust/crates). React SPA: market/.

Goal: make the API's big read responses much smaller and faster to load with an OPT-IN compact encoding called "c1". The default JSON must stay byte-for-byte unchanged, because it is a frozen contract shared with the SPA and the CardVault apps.

Idea to adapt (from the owner's CardRail app, backend/src/codes.rs): serve versioned, append-only numeric dictionaries at `GET /v1/dictionary`. Code = index + 1, and codes are never renumbered, only appended. The tables there are:
- games: pokemon, magic, yugioh, one_piece, …
- languages: EN, IT, FR, DE, JP, ES, PT, ZH, KO
- conditions: M, NM, SP, MP, PL, PO
- printings: Standard, Holo, Reverse Holo
- bit flags: firstEdition=1, signed=2, altered=4, …

Compact payloads then send small integers instead of repeated strings. Adapt this, then go further.

Target routes:
- /api/marketplace-expansion-page (set desk, hundreds of cards)
- /api/marketplace-card-versions
- /api/marketplace-search-page
- /api/marketplace-home-page and /api/marketplace-home/*
- /api/marketplace-artist-cards
- /api/marketplace-expansions (also slow: 1.69 s cold for limit=500, 16 KB)

Steps:
1. Research and cite sources in docs/rust-migration/COMPACT_ENCODING.md. Compare JSON+brotli/zstd, CBOR/MessagePack, and columnar struct-of-arrays JSON with per-response string interning plus global code dictionaries. Cover delta-encoded sorted ids, URL prefix tables (https://cdn.pokoin.com/...), and shared-dictionary compression (zstd dictionaries; Compression Dictionary Transport dcb/dcz), noting what Cloudflare and browsers support today. Pick the fastest design for hundreds of highly repetitive rows decoded in the browser.
2. Implement in Rust:
   - A versioned, append-only `GET /api/dictionary` with immutable caching and an ETag. Code tables: games, languages, conditions, rarities, print nationalities/flags, art layouts, product types. Take the values from the canonical lists in pokoin-rust and market/src.
   - A c1 encoder, selected by `Accept: application/vnd.pokoin.c1+json` or `?format=c1`. It uses columnar arrays, interned strings, dictionary codes, a URL prefix table and delta ids.
   - Serialize directly with serde_json writers.
   - Responses carry `Vary: Accept` and keep the same status and cache semantics.
3. Add market/src/compact.js, a tiny decoder that rebuilds exactly the default JSON objects. Export it, but do not wire it into pages; another session owns market/ performance.
   Tests:
   - a Rust round trip: encode, decode, equal to the default JSON, on fixtures built from the existing handler tests;
   - a JS test on the same fixtures.
4. Measure raw and brotli sizes, default vs c1, and encode time.

Verify: `cd pokoin-rust && cargo test --workspace` passes, and the market tests pass.

Work on branch `feature/compact-c1`. End commit messages with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>". Open a DRAFT PR against main; the body includes the size/time table and a rollout plan and ends with "🤖 Generated with [Claude Code](https://claude.com/claude-code)".

Do NOT merge or deploy, and do not touch deploy/ or scripts/.
