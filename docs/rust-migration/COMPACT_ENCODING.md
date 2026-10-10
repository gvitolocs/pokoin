# Compact read encoding (`c1`)

> Status: implemented behind an opt-in; **nothing in `market/` requests it yet**.
> Encoder `pokoin-rust/crates/api-common/src/compact/`, browser decoder
> `market/src/compact.js`, dictionary route `GET /api/dictionary`.

Pokoin's big catalogue reads are hundreds of near-identical rows. The Destined
Rivals set page is **324 KB** of JSON for 244 cards, and
`/api/marketplace-artist-cards?artist=mitsuhiro-arita` is **822 KB** for 400.
Every row carries 42 keys, 13 of which are exact duplicates of another key in
the same row, and 6 of which are URLs sharing a long prefix.

`c1` is an **opt-in second representation** of those responses: the same bodies,
columnar, interned, and coded against a shared dictionary. The default
`application/json` body is untouched — it is a frozen contract shared with the
SPA and the CardVault apps.

---

## 1. What the payloads actually look like

`docs/handoff/compact-c1/analyze.py` over the captured fixtures, on the 244-row
`cards` table of the Destined Rivals set page:

```
== $.cards rows=244 cols=42 shapes=1
  id                   distinct= 244  ex="668126"
  card_id              distinct= 244  SAME=id
  set                  distinct=   1  ex="Destined Rivals"
  set_name             distinct=   1  SAME=set
  number               distinct= 244  ex="Gold Secret Rare | 244/182"
  card_number          distinct= 244  SAME=number
  rarity               distinct=   1  ex="Card"
  itemKind             distinct=   1  ex="single"
  canonicalPath        distinct= 244  ex="/marketplace/en/cards/668126/card-levincia-…"
  canonical_path       distinct= 244  SAME=canonicalPath
  artist               distinct= 143  ex="MARINA Chikazawa"
  illustrator          distinct= 143  SAME=artist
  imageUrl             distinct= 244  ex="/card-images/668126_levincia.jpg"
  previewImageUrl      distinct= 244  ex="/card-images/previews/668126_levincia.jpg"
  homepageImageUrl     distinct= 244  ex="/card-images/668126_levincia_homepage.webp"
  gridImageUrl         distinct= 244  SAME=imageUrl
  heroImageUrl         distinct= 244  SAME=imageUrl
  tileImageUrl         distinct= 244  SAME=homepageImageUrl
  …
```

Four kinds of waste, in order of how much they cost:

1. **Repeated keys.** 42 key names × 244 rows. ~700 bytes of key text per row.
2. **Alias columns.** `id`/`card_id`, `set`/`set_name`, `number`/`card_number`,
   `canonicalPath`/`canonical_path`, `artist`/`illustrator`,
   `artLayout`/`art_layout`, plus the camelCase/snake_case emoji pairs, plus
   `gridImageUrl`/`heroImageUrl`/`tileImageUrl` — stored twice or three times.
3. **Derived columns.** `previewImageUrl` and `homepageImageUrl` are
   `imageUrl` with a different directory and extension.
4. **Low-cardinality strings.** 1 distinct `set`, 1 `rarity`, 1 `itemKind`,
   2 `artLayout`, 143 `artist` over 244 rows.

The key observation for the design: **after prefix/suffix stripping, the whole
`*ImageUrl` family has the same residual array** (`668126_levincia`), which is
also the `id` column with a slug appended. So the win is not "columnar" by
itself — it is columnar *plus* cross-column deduplication.

---

## 2. Options considered

### 2.1 JSON + brotli/zstd alone (the baseline — already on)

Cloudflare compresses responses to visitors with gzip, Brotli or Zstandard
depending on `Accept-Encoding`, plan and compression rules
([Content compression](https://developers.cloudflare.com/speed/optimization/content/compression/)).
Brotli is the default preferred algorithm; Zstandard is a separate, Beta
setting ([Compression Rules settings](https://developers.cloudflare.com/rules/compression-rules/settings/)).
Origin-side, Cloudflare requests `br` or `gzip`, not zstd.

Measured on our fixtures (§4): brotli q11 already takes the 11 captured
responses from 1.95 MB to 98.8 KB, **−95.1%**. zstd 19 is slightly worse
(108.9 KB) on these bodies.

This is the floor, and it is a high floor. Any structural work has to justify
itself *on top of brotli*, not against raw JSON. The honest framing of §4 is
that `c1` buys another −33% after brotli — real, but an order of magnitude less
dramatic than the raw-size number suggests.

What brotli does **not** fix is the client side: `JSON.parse` still has to
materialise 244 objects with 42 keys each, and the SPA then walks them.
Structural optimization reduces both payload size and parsing overhead, which
is why it still matters on mobile
([columnar JSON trade-offs](https://dev.to/99tools/stop-sending-bloated-json-a-simple-optimization-every-developer-should-know-3eob)).

### 2.2 CBOR / MessagePack

Rejected. Two reasons.

**The size win is mostly the same win, and it evaporates under compression.**
MessagePack's advantage over JSON is mainly tighter scalars and length-prefixed
strings; the repeated keys are still there. Once gzip is on, the wire-size
benefit of switching to MessagePack drops from about 35% to roughly 10–15%
([JSON vs MessagePack](https://jsonic.io/guides/json-msgpack)). None of that
touches the alias/derived-column redundancy, which is where our bytes are.

**The decode win in a browser is unproven and library-dependent.** Native
`JSON.parse` is a tuned C++ fast path; a CBOR/MessagePack decoder in a browser
is JavaScript going through the JIT. The published benchmarks disagree with
each other and are nearly all author-run and Node-only:
[`cbor-x`'s own benchmark](https://github.com/kriszyp/cbor-x/blob/master/benchmark.md)
reports decode at 75,340 op/s vs `JSON.parse` at 17,720 op/s on clinical data
*with shared structures*, while
[`json-pack`'s own benchmark](https://github.com/jsonjoy-com/json-pack/blob/HEAD/src/msgpack/README.md)
has `JSON.parse` at ~224,616 ops/sec **beating** `@msgpack/msgpack` at
~196,799. An
[older measurement](https://news.ycombinator.com/item?id=4090831) on a 386 KB
payload had `msgpack.unpack` at 13 ms against `JSON.parse` at 4 ms.

Note what makes `cbor-x` fast in its own benchmark: *shared structures* — i.e.
hoisting the repeated record shape out of the rows. That is the actual
optimisation, and it does not require leaving JSON.

Also against: a binary body cannot be inspected in devtools, cannot be diffed
in a test fixture, and would need a decoder in the Flutter app too.

### 2.3 Columnar struct-of-arrays JSON + interning + dictionary codes (chosen)

Keep JSON as the container; change the *shape*. Pay `JSON.parse` once for a
small document, then rebuild rows in a tight JS loop.

A worked example of the floor on this technique: a DEV test found the
compressed columnar version about 7.7% smaller than the compressed row-based
one, because gzip's window does not always catch every repeated key across a
large array ([same source as above](https://dev.to/99tools/stop-sending-bloated-json-a-simple-optimization-every-developer-should-know-3eob)).
We measure −33.2% after brotli rather than −7.7%, because plain columnarisation
is only one of the five transforms (§3) and is not the biggest one.

### 2.4 Delta-encoded sorted ids

Included. `id` on a set page is `"668126"`, `"668127"`, … — canonical decimal
integer strings in near-sorted order. Stored as one integer plus deltas, with a
flag that turns them back into strings. The 244-row `id` column goes from ~2.4 KB
to ~500 B, and `card_id` is then a reference to it rather than a second copy.

The codec is strict about canonicality (no `"007"`, no `"+1"`, no whitespace,
nothing above 2^53−1) so `value.to_string()` is byte-identical to the original.

### 2.5 URL prefix tables

Included, and deliberately framed as a small win. Pokoin image and canonical
URLs share long heads (`https://cdn.pokoin.com/card-images/previews/`,
`/marketplace/en/cards/`). `c1` already hoists each column's common prefix and
suffix out of the column — that alone removes the per-row cost. The shared
table removes the remaining *per-column* cost (~20 bytes × ~8 URL columns ×
per response). It is worth having because the table is already being shipped
for the code tables, but it is not where the bytes come from, and §4 does not
claim otherwise.

### 2.6 Shared-dictionary compression (zstd dictionaries, `dcb`/`dcz`)

**Measured, then rejected for now.** This is the most attractive-sounding
option and the measurement is what settles it.

Compression Dictionary Transport is a real standard —
[RFC 9842](https://www.rfc-editor.org/rfc/rfc9842.html), September 2025,
Meenan (Google) and Weiss (Shopify) — which lets a designated response act as
an external dictionary for later ones, registering `dcb` (Brotli-based) and
`dcz` (Zstandard-based) content encodings negotiated with
[`Available-Dictionary`](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Available-Dictionary)
and `Use-As-Dictionary`. Cloudflare ships it as
[shared dictionaries](https://developers.cloudflare.com/speed/optimization/content/shared-dictionaries/),
over HTTPS only, requiring Chrome/Edge 130+ or another Chromium browser at that
version. The [Chromium docs](https://chromium.googlesource.com/chromium/src.git/+/main/docs/experiments/compression-dictionary-transport.md)
note the feature has been available experimentally since 117 and that the link
relation was spelled `dictionary` before M126; support is detectable with
`document.createElement('link').relList.supports('compression-dictionary')`.
Google reports it ready across Chromium browsers for
[Search](https://developer.chrome.com/blog/search-compression-dictionaries).
MDN marks it [not Baseline](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Available-Dictionary),
because it does not work in some of the most widely used browsers: Safari does
not support it, and the Firefox position is at best Technology Preview.

So: Chromium-only today, and a progressive enhancement everywhere else.

That would still be worth doing if the compression win were large. zstd's own
early benchmark on ~300-byte JSON records reports ratios going from ~1.33× to
~5.9–6.8× with a trained dictionary
([dictionary compression guide](https://www.mintlify.com/facebook/zstd/guides/dictionary-compression)).
But that is the *small record* case — gains are mostly in the first few KB, and
dictionaries only work within a family of similar documents.

Our payloads are 14 KB–822 KB, not 300 B. Measured, with one 110 KB dictionary
trained over all 11 fixtures and used to recompress them (§4):

| | all 11 fixtures | vs default+brotli |
| --- | --- | --- |
| default JSON + brotli q11 | 98.8 KB | — |
| default JSON + zstd 19 + shared dictionary (110 KB) | 94.6 KB | −4.3% |
| **c1 + brotli q11** | **66.0 KB** | **−33.2%** |

A **−4.3%** win, Chromium-only, for a 110 KB dictionary fetch, an extra
`Vary`/negotiation axis at the CDN, a dictionary-training step in the build, and
origin-side zstd that Cloudflare does not accept today. `c1` is 7× the benefit
with none of that. Not worth it at this size; revisit if Pokoin ever serves a
lot of genuinely small, highly similar documents (per-card offer rows, say) and
Safari ships support.

### 2.7 Just send fewer fields

Worth saying out loud: the cheapest fix for 13 duplicate columns is to stop
sending them. We cannot — the default JSON is a frozen contract with the
CardVault apps, which is exactly why `c1` is a second *representation* rather
than a change to the first. `c1` is the mechanism that makes the duplicates
free without renegotiating the contract.

---

## 3. The chosen design

Five transforms, applied generically to any response body — not per route. One
code path serves every target route, which is what makes "decodes back to the
default JSON exactly" testable.

```
{ "c1": 1, "dict": "1", "b": <skeleton>, "t": [<table>, …] }
```

`b` is the original JSON with every array worth columnarising replaced by a
`{"$c1": <index>}` placeholder. An object in the source that happens to carry a
`$c1`-prefixed key is wrapped as `{"$c1x": {…}}`, so the placeholder can never
be confused with real data.

```
{ "n": <rows>, "k": ["id", …], "c": [<column>, …] }   // array of objects
{ "n": <len>,  "c": [<column>] }                      // array of scalars
```

Row `i` is rebuilt by inserting `k[j] -> column[j][i]` in column order, which is
each row's own key order — the encoder only builds a table when every row's key
sequence is a subsequence of `k`, and leaves the array alone otherwise. **Key
order is part of the frozen contract**, so the tests compare serialised strings,
not deep equality.

A column is an object with codec `c` plus modifiers:

| field | meaning |
| --- | --- |
| `m` | presence mask (`0`/`1` per row); omitted when every row has the key |
| `ns` | the decoded integers are decimal strings (`668126` → `"668126"`) |
| `prei`/`pre` | prefix to prepend: URL-prefix-table code, then literal |
| `sufi`/`suf` | suffix to append: URL-prefix-table code, then literal |

| codec | payload | transform |
| --- | --- | --- |
| `0` | `v` | **constant** — one value for every row |
| `1` | `v: []` | plain array, one value per present row |
| `2` | `p: []`, `x: []`, `t?` | **palette** (per-response interning); with `t`, an integer entry is a dictionary code |
| `3` | `z`, `d: []` | **integer delta** — `v[0] = z`, `v[i] = v[i-1] + d[i-1]` |
| `4` | `r` | **reference** — same residuals and mask as column `r` |

Codec `4` on top of affix stripping is where the bulk of the win is: the alias
pairs, and the whole `imageUrl`/`previewImageUrl`/`homepageImageUrl`/
`gridImageUrl`/`heroImageUrl`/`tileImageUrl` family, collapse onto one stored
array of `668126_levincia`-shaped stems.

**Codec choice is made by serialising every applicable candidate and keeping the
shortest.** A codec therefore can never make a column larger than the plain
array — there is no heuristic to tune and no payload shape where delta or a
palette backfires. `compact::tests::a_column_is_never_larger_than_the_plain_array`
pins that on unsorted integers, high-cardinality strings and floats.

### 3.1 The dictionary

`GET /api/dictionary` serves the append-only code tables, adapted from
CardRail's `backend/src/codes.rs`: `games`, `languages`, `conditions`,
`printings`, `nationalities`, `artLayouts`, `rarityKinds`, `itemKinds`,
`productTypes`, `rarities`, plus the listing bit flags and the URL prefixes.

- A code is `index + 1`; `0` is never a code.
- Entries are **only appended**, never renumbered, reordered or removed, because
  a payload a client decoded with an older snapshot must keep decoding to the
  same strings forever. Retiring a value means leaving it in place.
- `VERSION` is bumped when a table gains entries, and every `c1` payload
  declares the version it was encoded against.
- Unknown values are **not** an error. `rarity` in particular is free text in
  the catalog (set-specific stamps, WCD years, bare collector numbers — 57
  distinct values across 11 fixtures), so the `rarities` table is deliberately
  partial and anything missing stays a literal string in the palette. A
  dictionary-coded palette entry is an integer; a literal is a string; the
  encoder only codes a palette whose entries are all strings, so the two can
  never be confused.

Caching has two modes, because "append-only" and "immutable" are different
promises:

- `GET /api/dictionary` — the current tables. Can gain entries, so it is
  revalidated: `max-age=3600, s-maxage=86400, stale-while-revalidate=604800`
  plus `ETag: "c1-dict-<version>"` and `304` on `If-None-Match`.
- `GET /api/dictionary?v=<version>` — a pinned version, which can never change
  its bytes, so `max-age=31536000, immutable`. A client that pins the version a
  payload declared makes one request, ever. A `?v=` that is not the current
  version is a `409` rather than a wrong body.

The dictionary's *size* contribution to a response is small and §4 does not
pretend otherwise: a 244-row set page has ~20 distinct rarities, so coding them
saves a few hundred bytes out of 324 KB. Its real value is being a stable,
immutably cacheable contract — the same codes mean the same thing in every
response, in the SPA, and in the Flutter app.

`market/src/compact.js` bundles a snapshot of the tables so a page can decode
without a second request. Drift is impossible to ship silently:
`compact::dict::tests::the_committed_snapshot_matches_the_tables` asserts
`market/src/compact-dictionary.json` equals the Rust tables, and
`market/src/compact.test.js` asserts the inline `C1_DICTIONARY` equals that
file. Regenerate with:

```sh
cd pokoin-rust
cargo run --quiet --example c1_dictionary > ../market/src/compact-dictionary.json
```

### 3.2 Negotiation and HTTP semantics

- **Opt in** with `Accept: application/vnd.pokoin.c1+json` or `?format=c1`.
  `*/*` is deliberately **not** a match — every browser sends it.
- Content type `application/vnd.pokoin.c1+json; charset=utf-8`.
- Same status code and same `Cache-Control` as the default response.
- **`Vary: Accept` on both representations**, so a shared cache can never hand a
  `c1` body to a client that asked for plain JSON.
- `apps/api`'s Redis read cache keys `/api/marketplace-search-page` per
  representation (`:c1` suffix), for the same reason.
- `sanitize_public_json` runs before encoding, so an infrastructure error is the
  same public 503 in both representations.
- **Error and 405 bodies stay `application/json`.** They are tiny, there is
  nothing to columnarise, and the encoder envelope would make them bigger. A
  client should branch on `isC1(payload)` (or the content type) rather than
  assume.
- A payload with no columnarisable array pays a flat 31-byte envelope. That is
  why `card-versions-pikachu` (a 56-byte `{"error":…}`) is 87 bytes as `c1`.

### 3.3 Wired routes

| route | crate |
| --- | --- |
| `GET /api/dictionary` | `catalog-api` `reads::dictionary` (new) |
| `GET /api/marketplace-expansion-page` | `catalog-api` `pages::expansion_page` |
| `GET /api/marketplace-card-versions` | `catalog-api` `reads::card_versions` |
| `GET /api/marketplace-expansions` | `catalog-api` `reads::expansions` |
| `GET /api/marketplace-artist-cards` | `catalog-api` `reads::artist_cards` |
| `GET /api/marketplace-home-page` | `catalog-api` `pages::home_page` |
| `GET /api/marketplace-home` | `catalog-api` `reads::home` |
| `GET /api/marketplace-rails` | `catalog-api` `pages::rails` |
| `GET /api/marketplace-search-page` | `apps/api` `search_page` |
| `GET /api/marketplace-home/{new-cards,best-sellers,spotlight}` | `apps/api` `rails` |

### 3.4 What is not done

- **Serialisation.** The encoder builds a `serde_json::Value` for the compact
  document and streams it with `serde_json::to_writer` (`encode_to_vec`), so the
  document is never materialised as an intermediate `String`. It is not a
  hand-rolled streaming encoder: the handlers already hold their response as a
  `Value`, so streaming the *input* would be a much larger change to every
  handler for no size benefit. §4 reports the added cost.
- **Nested tables inside a row.** A column holding objects (`card_palette`) is
  interned by the palette codec but not itself columnarised. The palette already
  collapses it; recursing would add format surface for little gain.
- **`market/` is not wired up.** `decodeC1` is exported and tested, and no page
  calls it. Wiring belongs to whoever owns `market/` performance.

---

### 3.5 Format 2: template columns (`c1v2`)

> Added 2026-10-10 after the compression benchmark
> (`bench/c1-compression/` on branch `bench/c1-compression`).

The benchmark showed where C1 still leaves bytes on the table: URL and slug
columns are a deterministic function of other columns of the same row, but C1
stores their residuals literally, and every LZ match back to the `name` column
still costs brotli bytes per row. `canonicalPath`, for example, is
`"/marketplace/en/cards/" + {id} + "/card-" + slug{name} + "-" + slug{card_number} + "-" + slug{set}`.

Codec `5` stores such a column as a recipe (`compact/template.rs`):

```text
{ "c": 5, "s": [[col, form], …], "h": [[slot, …], …], "x": [shape, …], "l": [[<column>, …], …], "m"? }
```

- `s` — slots: another column of the row, form `0` its text (a string or a safe
  integer in decimal), form `1` its ASCII slug (lowercase ASCII alphanumerics;
  every other run between two of them becomes one `-`).
- `h` — shapes: the slots a value is made of, in order; `x` picks a shape per
  present row (omitted when there is one shape).
- `l` — per shape, the literal before each slot and after the last one, each an
  ordinary codec-0–3 column over that shape's rows.

A slot is never a template, nor a reference to one, so a decoder resolves plain
columns, then templates, then references to templates (`canonical_path` refs
the `canonicalPath` template). The encoder keeps a template only when it
serialises smaller than that column's own codec-0–4 encoding, refs included.

A document that uses codec `5` declares `"c1": 2`; one that does not stays
`"c1": 1`. Format 2 is opt-in on top of `c1`: `?format=c1v2`, or `v=2` on the
`c1` media type in `Accept`. Clients that ask for `c1` keep getting format 1, so
a cached bundle never meets a codec it cannot read. The Redis read cache keys
`:c1v2` separately.

List snapshots (`/api/marketplace-list`) also store brotli-11 copies of every
representation and serve them with `Content-Encoding: br` when the client
accepts it (`Vary: Accept, Accept-Encoding`). Cloudflare passes origin brotli
through; its own on-the-fly level is far lower (the 5ban artist snapshot: 288,557
B from Cloudflare vs 221,562 B at quality 11, −23%).

Measured on the 4,505-payload test split of the benchmark (real list snapshots of
22 TCGs plus live search and card responses), all round-trip verified byte for
byte in Rust, and 639 of them through `market/src/compact.js` in Node:

| | wire | vs `c1+br11` |
| --- | ---: | ---: |
| `c1` + brotli 11 | 13.10 MB | — |
| `c1v2` + brotli 11 | 10.76 MB | −17.9% |
| `c1v2` + brotli 5 | 12.34 MB | −5.8% |
| `c1v2` raw | 42.62 MB | (raw `c1` 58.85 MB, −27.6%) |

Encode p50 rises from 0.33 ms to 1.2 ms per payload (template planning), decode
p50 from 0.37 ms to 0.44 ms; snapshots pay the encode once per build.

Not in format 2 yet (measured, follow-ups): numeric split, front coding and a
trained value dictionary (about 7 more points), and RFC 9842 shared brotli
dictionaries (`dcb`, −14.6% on `c1`, Chromium only).

## 4. Measurements

Reproduce with:

```sh
pip install brotli zstandard
python3 docs/handoff/compact-c1/measure-sizes.py
```

That runs `pokoin-rust/crates/api-common/examples/c1_measure.rs` over the 11
captured production responses in `docs/handoff/compact-c1/fixtures/` — which
also asserts the byte-for-byte round trip for each — then compresses both
bodies. Timings are the best of 7 passes on the cloud session's container, so
treat them as orders of magnitude, not benchmarks.

`serialize` is what the handler already spends turning its `Value` into the
default body, so `encode − serialize` is what `c1` adds. `decode` is the **Rust**
decoder, included because it is the round-trip check; the browser decoder is
`market/src/compact.js` and has not been profiled in a browser yet.

brotli q11, zstd level 19.

| fixture | rows | default | c1 | c1 vs default | default+br | c1+br | c1+br vs default+br | serialize | encode | decode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `artist-arita` | 400 | 822.2 KB | 164.4 KB | −80.0% | 33.0 KB | 25.6 KB | −22.4% | 0.97 ms | 9.19 ms | 8.21 ms |
| `card-versions-card` | 0 | 1.5 KB | 1.5 KB | +2.0% | 614 B | 614 B | ±0% | 0.00 ms | 0.01 ms | 0.01 ms |
| `card-versions-expansion` | 268 | 397.7 KB | 83.4 KB | −79.0% | 19.1 KB | 13.2 KB | −31.2% | 0.46 ms | 4.19 ms | 2.87 ms |
| `card-versions-pikachu` | 0 | 56 B | 87 B | +55.4% | 56 B | 69 B | +23.2% | 0.00 ms | 0.00 ms | 0.00 ms |
| `expansion-base-set` | 102 | 135.1 KB | 14.5 KB | −89.3% | 6.8 KB | 3.6 KB | −47.6% | 0.10 ms | 0.93 ms | 1.08 ms |
| `expansion-destined-rivals` | 244 | 316.8 KB | 33.4 KB | −89.5% | 17.2 KB | 8.3 KB | −51.8% | 0.28 ms | 2.34 ms | 2.36 ms |
| `home-page` | 201 | 111.4 KB | 13.6 KB | −87.8% | 7.1 KB | 4.2 KB | −40.8% | 0.09 ms | 1.00 ms | 0.94 ms |
| `rails-best-sellers` | 24 | 14.0 KB | 3.3 KB | −76.5% | 1.6 KB | 1.3 KB | −22.0% | 0.01 ms | 0.14 ms | 0.12 ms |
| `rails-new-cards` | 40 | 22.5 KB | 3.6 KB | −84.0% | 1.6 KB | 1.2 KB | −27.8% | 0.02 ms | 0.20 ms | 0.21 ms |
| `rails-spotlight` | 60 | 32.6 KB | 4.2 KB | −87.0% | 2.3 KB | 1.5 KB | −35.4% | 0.03 ms | 0.31 ms | 0.31 ms |
| `search-charizard` | 106 | 145.7 KB | 39.7 KB | −72.8% | 9.4 KB | 6.5 KB | −30.1% | 0.12 ms | 1.33 ms | 1.06 ms |
| **all 11** | | 1.95 MB | 361.7 KB | **−81.9%** | 98.8 KB | 66.0 KB | **−33.2%** | | | |

### Other encodings, same bodies

| encoding | all 11 fixtures | vs default raw | vs default+brotli |
| --- | --- | --- | --- |
| default JSON | 1.95 MB | ±0% | +1923.4% |
| default JSON + brotli q11 | 98.8 KB | −95.1% | ±0% |
| default JSON + zstd 19 | 108.9 KB | −94.6% | +10.2% |
| default JSON + zstd 19 + shared dictionary (110.0 KB) | 94.6 KB | −95.3% | −4.3% |
| c1 | 361.7 KB | −81.9% | +266.0% |
| c1 + brotli q11 | 66.0 KB | −96.7% | −33.2% |
| c1 + zstd 19 | 74.3 KB | −96.3% | −24.8% |

### Reading the numbers honestly

- **Raw −81.9%** is the headline, and it is the wrong number to plan with: the
  CDN compresses. It matters for anything that stores or forwards the body
  uncompressed, and for the `JSON.parse` + object-materialisation cost in the
  browser, which compression does not help at all.
- **After brotli, −33.2%** is the number that lands on real users. On the set
  page specifically it is −51.8% (17.2 KB → 8.3 KB).
- **`search-charizard` benefits least** (−30.1% brotli'd) because its rows are
  genuinely heterogeneous: 100 different cards from different sets, with
  `card_palette` objects and few constant columns.
- **Tiny payloads get slightly bigger.** The envelope is 31 bytes. An error body
  is 56 B → 87 B. Irrelevant in absolute terms, and §3.2 explains why error
  bodies stay plain JSON anyway.
- **Encode cost is real but small**, and roughly 8–10× the serialise it replaces
  (2.3 ms vs 0.28 ms on the 244-row set page; 9.2 ms vs 0.97 ms on the 400-row
  artist page). That is CPU at the origin traded for bytes on the wire and
  objects in the browser. It is also the cost of the serialise-every-candidate
  codec choice, which is deliberate: it is what guarantees no column ever gets
  bigger. If this ever matters, the obvious optimisation is to skip the
  candidate measurement for columns above some width.
- The 400-row artist page is the one case where encode time is worth watching;
  it is also the one route where the raw saving is 658 KB.

---

## 5. Tests

| test | what it pins |
| --- | --- |
| `compact::tests::*` (api-common) | round trip on synthetic set/search/home shapes, absent keys, mixed-type columns, unicode, floats, nulls, 2^53 bounds, bodies that already use the `$c1` marker, `Vary`/content type/cache in both representations, sanitised errors, and "no column is bigger than the plain array" |
| `compact::encode::tests::*` | subsequence check, canonical-integer guard, UTF-8-safe affixes, URL-prefix splitting, ref formation |
| `compact::decode::tests::*` | rejects foreign documents, forward references, length mismatches, unknown dictionary codes |
| `compact::dict::tests::*` | codes are 1-based and round trip, no duplicates, every ingest game present, flag bits are distinct powers of two, **the committed JS snapshot matches the Rust tables** |
| `pages::tests::live_response_fixtures_round_trip_through_c1` | the six captured live responses the parity tests use |
| `pages::tests::handler_bodies_round_trip_through_c1` | bodies the page BFFs actually build, from production rows |
| `pages::tests::target_routes_negotiate_the_compact_representation` | a route answers `c1` only when asked, with `Vary: Accept` either way, and never for a browser's `*/*` |
| `reads::dictionary::tests::*` | tables, `ETag`, `304`, pinned-immutable, `409` on an unknown version, `405` |
| `market/src/compact.test.js` | **cross-language**: the browser decoder rebuilds all 11 real payloads, encoded by the real Rust encoder, byte for byte; plus codecs, masks, vectors, marker escaping, every error path, and a stale-dictionary diagnostic |

The JS test decodes committed Rust output in `docs/handoff/compact-c1/c1/`.
Regenerate it when the encoder changes:

```sh
cd pokoin-rust
cargo run --release --example c1_measure -- \
  ../docs/handoff/compact-c1/c1 ../docs/handoff/compact-c1/fixtures/*.json
rm -f ../docs/handoff/compact-c1/c1/*.default.json
```

---

## 6. Rollout

1. **Now (this change).** Encoder, dictionary route, decoder, tests. Opt-in
   only; no client requests `c1`, so production behaviour is unchanged except
   for `Vary: Accept` on the target routes' success responses and the new
   `/api/dictionary` route.
2. **Confirm `Vary: Accept` at the edge.** Before any client opts in, check that
   Cloudflare honours `Vary: Accept` for these routes (`curl -I` with and
   without the `Accept`, compare `cf-cache-status` and the content type). If it
   does not, clients must use `?format=c1` instead, which varies the URL and so
   varies the cache key unconditionally. This is a release gate, not a nice to
   have: getting it wrong serves `c1` bytes to the Flutter apps.
3. **One route, behind a flag.** `/api/marketplace-expansion-page` first: it has
   the best ratio (−51.8% brotli'd), one consumer (the set desk), and the
   simplest shape. Have the SPA fetch `?format=c1` for that route only, decode
   with `decodeC1`, and keep the default path as the fallback on any `C1Error`.
4. **Measure in a browser.** `JSON.parse` + `decodeC1` against `JSON.parse`
   alone, on a mid-range Android, over a throttled connection. The size win is
   measured; the *decode* win is the thing this document does not yet have a
   number for, and it is the main reason to prefer this design over brotli
   alone. If `decodeC1` turns out slower end to end than parsing the default
   body, stop here — that result would invalidate §2.3's premise.
5. **Then the rest**, in descending order of benefit: `home-page` and the rails
   (−40.8%/−35.4%), `artist-cards` (658 KB raw), `card-versions`,
   `search-page`.
6. **Pin the dictionary.** Once a client depends on codes, fetch
   `/api/dictionary?v=<version from the payload>` so it is immutably cached, and
   treat a `C1Error` mentioning a missing code as "refetch the current
   dictionary", not as a failure.
7. **Flutter.** Only after the SPA is proven. The format is deliberately plain
   JSON so a Dart decoder is the same ~200 lines.

### Backing out

Opt-in means backing out is client-side: stop sending the header. Nothing is
removed from the default representation, so a rollback never needs a server
deploy. The two server-side changes that *are* observable without a client —
`Vary: Accept` on the target routes and the `/api/dictionary` route — are both
additive.

### When this needs revisiting

- If Safari and Firefox ship Compression Dictionary Transport, re-measure §2.6:
  `c1 + dcz` with a dictionary trained on `c1` documents could beat both.
- If the catalogue contract is ever renegotiated and the 13 duplicate columns go
  away, most of `c1`'s advantage goes with them (§2.7). Re-measure before
  keeping it.
