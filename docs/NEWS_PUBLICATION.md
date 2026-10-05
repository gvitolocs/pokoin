# Pokoin News at `pokoin.com/news` — publication architecture

Pokoin News is a Pokémon TCG publication written by **Poko — Pokoin News
Desk** (AI-assisted, disclosed as such) and published as static, crawlable
HTML under `https://pokoin.com/news`. The older Hypemeter app at
`news.pokoin.com` ([NEWS.md](NEWS.md)) is a separate hype dashboard and the
article *feed* the newsroom reads; it is not the publication.

```
Hypemeter feed / scout ──► Poko Newsroom (Hermes, nezopt)                       ──► Telegram / Discord flash
                           stories → source fetch → claim ledger → evidence pack
                           → Pokoin enrichment (api.pokoin.com) → worthiness gate
                           → Claude reporter (pass A) → Claude editor (pass B)
                           → deterministic validators → publication gate
                           → article record (v1) + revisions  ──► /api/poko/news?export=published
                                                                          │
pokoin-web (this repo): scripts/build-news-site.mjs  ◄────────────────────┘
   news/lib/* renders static HTML, JSON-LD, sitemaps, RSS ──► dist-news/
   wrangler versions upload -c wrangler.pokoin-news.jsonc ──► Worker `pokoin-news`
   route pokoin.com/news*  (assets only; more specific than pokoin.com/*)
```

## Why this shape

- **Crawlable without JavaScript.** Every article is a static HTML file
  (`news/<slug>.html`, served at `/news/<slug>`). Headline, body, dates,
  byline, sources and JSON-LD are in the first response.
- **No Worker invocations on page views.** pokoin.com is Workers Static Assets.
  The `pokoin-news` Worker is assets-only too, so news traffic does not count
  toward the Worker-script request cap that forced the main site off scripts.
- **Independent publish cadence.** News publishes by rebuilding `dist-news/`
  and uploading a new `pokoin-news` version. The marketplace deploy is never
  involved, and renderer code always comes from `origin/main`
  (`scripts/publish-news.sh`).
- **No second CMS.** The newsroom store (Hermes `data/newsroom-*.json`, revision
  snapshots, packs) holds drafts, review state, revisions, corrections and
  media. The static build is a projection of the *published* records.

## Contract

[NEWS_ARTICLE_SCHEMA.md](NEWS_ARTICLE_SCHEMA.md). The validator lives in Hermes
(`src/newsroom/schema.js`). `scripts/sync-news-schema.sh` copies it to
`news/lib/schema.mjs`, and the builder refuses invalid records.

## URLs

| URL | File | Notes |
| --- | --- | --- |
| `/news` | `news.html` | lead + secondary + rails |
| `/news/<slug>` | `news/<slug>.html` | permanent; the slug never changes after creation |
| `/news/{sets,cards,market,competitive,collectors,fact-check,analysis}` | `news/<section>.html` | section listings |
| `/news/authors/poko` | `news/authors/poko.html` | AI reporter disclosure |
| `/news/{about,editorial-policy,corrections,methodology,contact}` | `news/<page>.html` | transparency |
| `/news-sitemap.xml` | root | Google News sitemap, articles published in the last 48 h |
| `/news/sitemap.xml` | | every news URL; referenced from the main sitemap index |
| `/news/rss.xml` | | RSS 2.0, latest 30 |
| `/news/media/<slug>/…` | | article media (Pokoin-generated heroes) |
| `/news/assets/…` | | hashed CSS/JS, branded fallback art |

## Editorial safety rails (enforced in code)

Publication gate checks: evidence support, attribution, originality,
source-confidence language, article schema, required metadata, images,
canonical URL, no invented market metrics, template schema, factual
numbers / fact-check verdict versus evidence, conflicts reported, and the
editor verdict. **First phase: every significant article lands in REVIEW.**
Auto-publish is opt-in per template and story status via
`POKO_NEWSROOM_AUTOPUBLISH`, and nothing is configured.
Review and approve with `node scripts/newsroom-desk.mjs` in Hermes.

Claude unavailable or malformed output → **no website article** (the
Telegram flash path is unaffected). The newsroom never falls back to
templated text.

## Operating

- Preview build (all statuses, noindex, `/news/desk`):
  `node scripts/build-news-site.mjs --input <export-all.json> --preview --media-dir <Hermes>/data/newsroom-media --out /tmp/dist-news-preview`
- Public build + upload (no traffic until promoted): `scripts/publish-news.sh`, then `scripts/publish-news.sh --promote <version-id>`.
- Search Console / Google News / Discover: [NEWS_SEARCH_CONSOLE.md](NEWS_SEARCH_CONSOLE.md).
