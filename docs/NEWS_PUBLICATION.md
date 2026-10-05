# Pokoin News at `pokoin.com/news` — publication architecture

Pokoin News is a trading card game publication written by **Poko — Pokoin
News Desk** (AI-assisted, disclosed as such) and published as static,
crawlable HTML on pokoin.com, one section per game, laid out like the
marketplace: Pokémon at `https://pokoin.com/news`, every other game at
`https://pokoin.com/<game-slug>/news` (`/one-piece/news`, `/magic/news`, …).

The Hypemeter app at `news.pokoin.com` ([NEWS.md](NEWS.md)) stays online as a
separate hype dashboard. The newsroom scouts every game itself
(`src/newsroom/tcg-feeds.js`), so the publication does not depend on it.

```
Multi-TCG feed (Hermes) ─► Poko Newsroom (Hermes, nezopt)                       ──► Telegram / Discord flash (Pokémon;
  Google News per game                                                                other games only when configured)
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
| `/news` | `news.html` | Pokémon front page: lead + secondary + rails + "Across the TCGs" |
| `/news/<slug>` | `news/<slug>.html` | Pokémon article; permanent, the slug never changes after creation |
| `/news/{sets,cards,market,competitive,collectors,fact-check,analysis}` | `news/<section>.html` | Pokémon section listings |
| `/<game>/news` | `<game>/news.html` | game hub (only for games with published stories) |
| `/<game>/news/<slug>` | `<game>/news/<slug>.html` | article of that game; the game never changes |
| `/<game>/news/<section>` | `<game>/news/<section>.html` | only sections that have stories |
| `/<game>/news/rss.xml` | | that game's RSS |
| `/news/authors/poko` | `news/authors/poko.html` | AI reporter disclosure |
| `/news/{about,editorial-policy,corrections,methodology,contact}` | `news/<page>.html` | transparency |
| `/news-sitemap.xml` | root | Google News sitemap, articles published in the last 48 h |
| `/news/sitemap.xml` | | every news URL; referenced from the main sitemap index |
| `/news/rss.xml` | | Pokémon RSS 2.0, latest 30 |
| `/news/all.xml` | | every game, latest 30 |
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

## Games

Game ids and URL slugs come from the article contract (`GAME_SLUGS`, mirroring
`market/src/game.js`). The Worker `pokoin-news` has one route per game
(`pokoin.com/<slug>/news*`, see `wrangler.pokoin-news.jsonc`); each is more
specific than `pokoin.com/*`, so `/<slug>/marketplace` stays with the SPA.
Stories never cluster, relate or cross-post across games. Only Pokémon posts
to the Pokémon Telegram/Discord channels; another game posts socially only
when `POKO_NEWS_TARGETS_<GAME_ID>` is set in Hermes.

## news.pokoin.com stays

Decision 2026-10-05 (Giuseppe): **news.pokoin.com is not deleted.** Hypemeter
keeps running there as the hype dashboard and as the news context that Poko on
peer1 reads. Pokoin News articles live only on pokoin.com (`/news`,
`/<game>/news`); the newsroom scouts with its own multi-TCG feed and does not
depend on Hypemeter.

## Running in production (since 2026-10-05)

**Service:** `pokoin-newsroom.service` (systemd user unit on nezopt,
`~/.config/systemd/user/pokoin-newsroom.service`).

- Code: `~/services/pokoin-newsroom/app` (detached checkout of gvitolocs/hermes
  `origin/main`); site renderer: `~/services/pokoin-newsroom/web` (detached
  checkout of this repo's `origin/main`, refreshed on every service start).
- Data: `~/services/pokoin-newsroom/data` (article records, revisions, media,
  site stories, publisher state, reporter memory).
- Secrets come from Infisical (project Pokoin, env dev): `DEEPSEEK_KEY`,
  `FIREBASE_*`. Cloudflare deploys use the login-shell wrangler credentials.
- Every 60 min: scout all games → cadence slots → generate → gate → publish
  READY articles → `scripts/publish-news.sh --deploy`. Every 60 s: comment
  moderation.

**Cadence:** Pokémon, One Piece, Magic, Yu-Gi-Oh!, Lorcana and Riftbound get up
to 2 articles per UTC day (6 h apart, fresh stories; drafts waiting in review
count). For these games a story carried by a single specialist outlet
(PokeBeach, Star City Games, YGOrganization, MTGGoldfish, …) or a single
official source is enough; specialist-only drafts wait for the desk, official
ones may auto-publish. Every other game gets 1
article per week, picked from stories at least 2 days old so evidence can build
up. Generation attempts are capped per period.

**Auto-publish:** only gate-READY articles from confirmed or multi-source
stories (`POKO_NEWSROOM_AUTOPUBLISH=*:confirmed,*:multi_source`); fact checks
always wait for the desk (`POKO_NEWSROOM_AUTOPUBLISH_EXCLUDE=fact_check`).
Everything else lands in review:

```bash
cd ~/services/pokoin-newsroom/app
NEWSROOM_DATA_DIR=~/services/pokoin-newsroom/data node scripts/newsroom-desk.mjs list
NEWSROOM_DATA_DIR=~/services/pokoin-newsroom/data node scripts/newsroom-desk.mjs approve <slug>
```

then redeploy the site with `systemctl --user restart pokoin-newsroom` (or run
the next cycle).

**Writer model:** DeepSeek V4.1 Flash (`deepseek-flash`, thinking on; editor
at max effort) through DeepSeek's Anthropic-compatible endpoint
(`POKO_NEWSROOM_CLAUDE_PROVIDER=deepseek`). Claude Opus 5.5 (reporter/editor)
with Sonnet 5.5 (repairs) is the default for `anthropic`/`claude-cli` providers
when a key or CLI quota is available.

**Comments:** `GET/POST https://api.pokoin.com/api/news-comments`
(`server/pokoin-api/news-comments.js`, Firestore `news_comments`). New comments
are `pending` until the service's DeepSeek V4.1 Flash moderator sets them
`visible`, `held` or `rejected` (criticism of Pokoin is allowed). Held
comments stay visible to their author only; remove or approve by editing the
Firestore document's `status`.
