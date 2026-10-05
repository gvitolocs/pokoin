# Pokoin News — article record contract (schemaVersion 1)

One JSON **article record** per canonical story and language. The Poko
Newsroom (Hermes, `src/newsroom/`) writes records; the website builder
(`news/` + `scripts/build-news-site.mjs` in this repo) renders them into static,
crawlable HTML at `https://pokoin.com/news/<slug>`. The builder **validates
every record** and refuses to render invalid ones; Hermes validates before it
stores. Both sides implement the same rules below.

Truth boundaries:

- **Evidence pack** = story-specific truth (Hermes, never rendered raw).
- **Article record** = what the reader sees + the provenance needed to render it.
- Every number in `market`, `related` and chart series is a **verbatim
  snapshot** of a Pokoin API response (with `retrievedAt`). The LLM never
  writes these values; it can only reference modules by id.

## Top level

| Field | Type | Rules |
| --- | --- | --- |
| `schemaVersion` | `1` | required |
| `id` | string | `art_<canonicalStoryId>_<language>`; internal |
| `slug` | string | `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 8–90 chars. Assigned **once** when the record is created and **never changes**, even if the headline changes. Collisions get `-2`, `-3`… |
| `canonicalStoryId` | string | the newsroom story id; one article per story per language |
| `language` | `"en"` | canonical newsroom language; future editions set `editionOf` |
| `editionOf` | string \| null | id of the canonical-language article this edition translates; `null` for originals |
| `status` | `draft` \| `review` \| `published` \| `blocked` \| `withdrawn` | only `published` is rendered publicly |
| `gate` | object | `{ verdict: READY\|REVIEW\|BLOCKED, checks: [{ id, pass, detail }], evaluatedAt }` |
| `template` | enum | `breaking`, `reveal`, `fact_check`, `market_pulse`, `explainer`, `developing`, `comparison`, `data_deep_dive`, `trend`, `analysis` |
| `articleType` | enum | `NEWS`, `BREAKING`, `FACT CHECK`, `ANALYSIS`, `EXPLAINER`, `MARKET`, `DATA` (visible label) |
| `section` | enum | `sets`, `cards`, `market`, `competitive`, `collectors`, `fact-check`, `analysis`, `industry` |
| `headline` | string | 20–110 chars, no trailing period, no emoji. Visible `<h1>`, `<title>` and JSON-LD `headline` all use this exact string |
| `dek` | string | 40–220 chars |
| `author` | object | always `{ id: "poko", name: "Poko", role: "Pokoin News Desk", url: "/news/authors/poko" }` |
| `datePublished` | ISO-8601 with offset | set on first publish; never changes |
| `dateModified` | ISO-8601 with offset | changes **only** on a material update or correction (see revisions) |
| `hero` | ImageRef \| null | null → branded fallback artwork is rendered |
| `images` | ImageRef[] | gallery / evidence / contextual images; ≤ 12 |
| `blocks` | Block[] | ordered body; 1–60 blocks |
| `sources` | Source[] | ≥ 1 for every template; primary sources first |
| `entities` | Entity[] | resolved Pokoin entities drive related cards/sets/news |
| `related` | `{ cards: RelatedCard[], sets: RelatedSet[] }` | Pokoin snapshots, may be empty |
| `market` | MarketModule \| null | null or `sufficient:false` → module is not rendered |
| `updates` | Update[] | public "Update — HH:MM" notes, oldest first |
| `corrections` | Correction[] | public correction notes, oldest first |
| `revisions` | Revision[] | internal history; ≥ 1 |
| `scores` | `{ editorialWorthiness: 0..1, originalReporting: 0..1, components: {…} }` | internal |
| `tags` | string[] | lowercase |
| `seo` | `{ title, description }` | `title` = headline (may append " — Pokoin News" in `<title>` only); description = dek |
| `generation` | object | `{ provider, reporterModel, editorModel, skillVersion, styleVersion, editorVerdict }` |
| `wordCount` / `readingMinutes` | integer | computed from rendered text |

## ImageRef

```json
{ "id": "img1", "url": "https://…", "width": 1600, "height": 900,
  "alt": "…", "caption": "…", "credit": "The Pokémon Company",
  "origin": "pokoin_generated | pokoin_catalog | official_press | editorial_source | branded_fallback",
  "sourceUrl": "https://…", "rights": "owned | press_kit | editorial_permitted | unknown",
  "isIllustration": false,
  "variants": [{ "url": "…", "width": 1200, "height": 675, "ratio": "16x9" }] }
```

- `alt` required (non-empty) for every image; `credit` required unless `origin` is `pokoin_generated`/`branded_fallback`.
- Hero for Discover: `width >= 1200` preferred; a hero narrower than 696 px is rejected (fallback artwork used instead). Never upscaled.
- `rights: unknown` images are never used as hero and never in a gallery.
- `isIllustration: true` images are labelled "Illustration" and never presented as evidence or product photos.

## Source

```json
{ "id": "s1", "outlet": "Pokémon", "url": "https://www.pokemon.com/…", "title": "…",
  "tier": "A|B|C|D", "role": "primary|secondary", "firstReported": false,
  "publishedAt": "…", "accessedAt": "…" }
```

## Blocks

Every block has `type` and optionally `id`. `sourceIds` must reference `sources[].id`.

| type | fields | rendering |
| --- | --- | --- |
| `paragraph` | `text`, `sourceIds?` | `<p>` |
| `heading` | `text` | `<h2>` |
| `key_facts` | `title?` (default "What we know"), `items: [{ text, sourceIds }]` | FACT box |
| `unknowns` | `title?` (default "What remains unclear"), `items: [{ text }]` | UNCLEAR box |
| `fact_check` | `claim`, `verdict`, `explanation`, `supportedBy[]`, `contradictedBy[]`, `primarySourceId?` | FACT CHECK box; verdict shown as text + icon, never colour alone |
| `source_comparison` | `rows: [{ claim, says: [{ sourceId, text }] }]` | table |
| `why_it_matters` | `text` | CONTEXT callout |
| `context` | `text` | CONTEXT callout |
| `analysis` | `text` | POKO ANALYSIS callout (labelled) |
| `market` | — | renders `article.market` (POKOIN MARKET DATA) |
| `chart` | `chartId` | one chart from `article.market.charts` |
| `gallery` | `imageIds[]` | `<figure>` grid from `article.images` |
| `timeline` | `items: [{ at, text, sourceIds? }]` | `<ol>` with `<time>` |
| `comparison` | `columns[]`, `rows: [{ label, values[] }]` | table |
| `faq` | `items: [{ q, a }]` | `<dl>` |
| `related_card` | `cardId` | inline card from `article.related.cards` |
| `related_set` | `slug` | inline set from `article.related.sets` |
| `methodology` | `text` | data window / definitions note |
| `quote` | `text` (≤ 30 words), `sourceId` | `<blockquote>` with attribution |
| `list` | `items: [text]` | `<ul>` |
| `update_note` | `at`, `text` | "Update — HH:MM" inline note |

Fact-check verdicts: `CONFIRMED`, `SUPPORTED`, `UNVERIFIED`, `DISPUTED`,
`MISLEADING`, `FALSE`. `CONFIRMED` requires a tier-A source in `supportedBy`;
`FALSE`/`MISLEADING` require a tier-A or tier-B source in `contradictedBy`;
`DISPUTED` requires both `supportedBy` and `contradictedBy` to be non-empty.

## Entities / related

```json
{ "type": "card|set|pokemon|artist|product", "name": "Charizard ex", "pokoinId": "522754",
  "path": "/marketplace/en/cards/522754/…", "resolved": true }
```

`RelatedCard` = `{ cardId, name, setName, number, imageUrl, path, listings: { count, sellerCount, lowestAskPkn, day } | null, retrievedAt }`
`RelatedSet` = `{ slug, name, path, cardCount, nationality, logoUrl, symbolUrl, retrievedAt }`

Values are copied from `api.pokoin.com` responses. Missing values stay `null`
and are not rendered.

## MarketModule

```json
{ "subject": { "type": "card", "name": "Charizard ex — 151 199/165", "pokoinId": "522754", "path": "/marketplace/…" },
  "window": { "from": "2026-09-04", "to": "2026-10-04", "days": 30 },
  "retrievedAt": "…", "currency": "PKN",
  "metrics": [ { "id": "lowest_ask_latest", "label": "Lowest ask (latest day)", "value": 50126, "unit": "PKN",
                 "measurement": "asking", "definition": "…" } ],
  "charts": [ { "id": "c1", "kind": "line|bar", "title": "…", "measurement": "asking|inferred_sold|count",
                "unit": "PKN|listings|sellers|copies", "series": [ { "label": "…", "points": [ { "x": "2026-09-11", "y": 44328 } ] } ],
                "summary": "text alternative" } ],
  "observations": 27, "sufficient": true,
  "sourceNote": "Pokoin marketplace data. Pokoin News is published by Pokoin, which operates this marketplace." }
```

- `measurement` is one of `asking` (listing asks), `inferred_sold`
  (CardTrader stack disappearances — not receipts), `count`. Asking and sold
  values are **never** mixed in one metric or one chart series.
- `sufficient` is false when fewer than 5 observations exist; the module is
  then suppressed.

## Update / Correction / Revision

```json
{ "at": "…", "text": "Pokémon has now officially confirmed …", "statusChange": "single_source→confirmed" }
{ "at": "…", "previous": "An earlier version of this article stated …", "corrected": "The correct information is …" }
{ "rev": 3, "at": "…", "reason": "initial|update|correction|copyedit", "material": true, "hash": "sha256…", "changed": ["blocks", "headline"] }
```

`dateModified` = the `at` of the latest revision with `material: true`.
Copy edits (`material: false`) never touch `dateModified` and never add a
public note.
