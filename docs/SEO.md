# Marketplace SEO

Canonical card URLs stay `/marketplace/{lang}/cards/{id}/{slug}` from
`marketplace_card_urls`. Do not replace those with `/cards/{set}/{number}-{name}`.
Short aliases (`/pokemon/charizard`, `/sets/base-set`, `/artists/{slug}`,
`/rarities/illustration-rare`, `/languages/japanese`, `/guides/…`) **308** onto
the marketplace hubs.

Indexable landings:

- Card desk (one URL per printing; listings stay on that page)
- `/marketplace/en/pokemon/{species}`
- `/marketplace/sets/{slug}`
- `/marketplace/eras/{eraId}`
- `/marketplace/{lang}/artists/{slug}`
- `/marketplace/en/rarities/{slug}`
- `/marketplace/en/languages/{slug}`
- `/marketplace/en/guides/{slug}`

Do not index search or shop filters (`?seller=`, `?condition=`, `/marketplace/search`).
Googlebot on a card URL is served indexable HTML by `workers/marketplace-card-og.js`
(H1, the scan, crumbs, JSON-LD). `og:image`, the `<img>`, and JSON-LD `image` are
the `https://cdn.pokoin.com/...` file. `pokoin.com/card-images/...` is a 301,
and Google drops that hop, so the SPA `SeoHead` rewrites the same way and
keeps `max-image-preview:large` after render. A card with no scan omits the
image. The site logo and the missing-card coin are never the card photo.
A card with a Pokoin listing or a reference price gets
`Product` plus `offers` (price, priceCurrency, availability, url). A catalog
card with neither gets `ItemPage` — never a `Product` that lacks offers,
review, and aggregateRating. Reviews, ratings, and prices are never invented.
Non-Pokémon canonical, `og:url`, and JSON-LD `url` keep the game prefix
(`/one-piece/`, `/star-wars/`, …). Discord/Slack keep `noindex` and no leftover subtitle.
Sitemaps: submit **`https://sitemap.pokoin.com/sitemap.xml`** in Search Console
(index → hubs, Pokémon species, sets). That host is a grey-cloud Vercel
CNAME (`proxied=false`) so Bot Fight never sees Google’s fetch. Page
`<loc>` URLs stay on `pokoin.com`. Child sitemap `<loc>` URLs stay on
`sitemap.pokoin.com`. Apex `pokoin.com/sitemap.xml` and
`api.pokoin.com/sitemap.xml` are the same files for browsers; GSC’s
datacenter IPs get Cloudflare **403** on every orange-clouded name
(`Kunne ikke hentes`), including the API tunnel. `robots.txt` points at
`sitemap.pokoin.com`. Set URLs come from
`GET /api/marketplace-expansion-page?limit=2000`; if that fetch fails at
Vercel build, keep the last `sitemap-sets.xml` instead of collapsing to
`/marketplace/sets`.

## Cloudflare crawler-policy 403 (2026-09-16/17)

GSC "Blocked due to access forbidden (403)" was Cloudflare edge, not origin.
Managed rule `8fb4273cf339402ebc4a777810d32c18` (managed ruleset
`3e677e63d4e9479382576f3fa66279e7`, source `firewallManaged`, the
`content_bots_protection: block` crawler-policy rule — exact internal identity
unreadable via API, attribution STRONG) 403'd every non-exempt automated
request on pokoin.com/www page paths with `Your request was blocked.` before
the Workers ran. Genuine Googlebot was hit: 24 events/23h from
`66.249.66.72–76` (rDNS `crawl-66-249-66-*.googlebot.com`, Googlebot +
Googlebot Smartphone UAs) across set desks, era hubs, guides, `/`, `/privacy`.
Bot Fight Mode was exonerated (separate pipeline, challenges, unskippable);
`34.156.63.59` was a GCE "CMS-Checker" scanner, not Google. Origin (Vercel)
served 200 to Googlebot UA when bypassed via `--resolve`.

Fix: custom rule **`fd1dc4d1dfe44ba6a06206a9fb786f8d`** (first position,
"Pokoin custom firewall rules" v35): `(http.host in {"pokoin.com"
"www.pokoin.com"} and http.request.method in {"GET" "HEAD"} and
cf.verified_bot_category eq "Search Engine Crawler")` → **skip phase
`http_request_sbfm` ONLY**. Verified-bot category, not UA (spoofable), not
ASN/IP lists, not `cf.client.bot` (would also admit verified AI crawlers).
Free-plan cap is 5 custom rules, so the two identical TrainingAI skips
(`f4e639d2…` + `619563bc…`, same action_parameters) were merged into
`55161883ff23…` (union expression, behavior-neutral) to free the slot.
Rollback: `/tmp/pokoin-custom-ruleset-ROLLBACK-v33.json`, or delete the new
rule id. robots.txt is exempt from the crawler rule by Cloudflare itself;
`/api/*`, `/card-images/*`, downloads, embed bots keep the `897717b3…` skip.
**CONFIRMED fixed 2026-09-17**: GSC Live Test on
`/marketplace/sets/team-up` (≈05:55 UTC) reported "Google har adgang til
webadressen / Siden kan indekseres". Security Events show the verified
Search Engine Crawler document fetch skipping via `fd1dc4d1…` (edge 200,
66.249.66.72, Googlebot Smartphone, ray `a3c5df690bfdb227`, 05:57:18Z) plus
the robots.txt fetch (05:55:27Z, 66.249.66.74) and 54 subresource skips via
`897717b3…`; zero `8fb4273…` blocks in the window. Spoofed Googlebot UAs
from ordinary clients still 403 — the exception keys on Cloudflare's bot
verification, not the UA string. 6 h post-fix, organic Googlebot re-crawled
`/`, set/era desks, `/privacy`, robots, sitemap and SPA assets: 39 skips via
`fd1dc4d1…`, zero genuine-Googlebot blocks; the only 403s were spoofed UAs
(our probe box, one AWS client BFM-challenged via `bot_fight_mode` — Bot
Fight Mode itself stays enabled and only touches unverified clients).

Human UI stays a desk. Googlebot already gets worker HTML, so the SPA
must not paint a catalog-hub strip, an “X belongs to Set” lede, or text
prev/next under the header. Related **tiles** (at most **12**) and one
“All {Pokémon}” link stay. Extra crumbs and hub links live in **More in
the catalog** at the page end. Eras / rarities / languages / guides live
in Chrome **Catalog**. Visible H1 is the name; commercial “Card List &
Prices” copy stays on `<title>` / `SeoHead` only.

## /sitemap (link graph)

`pokoin.com/sitemap` is the human site map: a pan/zoom graph of every page
template, catalog hub and card desk, with the same hubs as plain links
underneath (`solid/src/pages/SiteMap.jsx`). Its data is
`market/public/data/site-map.json`, built on nezopt by
`node scripts/build-site-map.mjs`. Page links come from the Solid app
(`solid/src/router.js` and the route modules it imports, `<A>` / `<AppLink>`
`href` and `to`, `navigate()`, `APP.*`, `*Href` helpers); catalog links
come from a read-only SELECT against the 15T marketplace Postgres and the
public expansion list. It is not part of the Vercel build, so rerun it and
commit the JSON when routes or the catalog change. `?focus=set:base-set`
(`card:`, `pokemon:`, `artist:`, `era:`, `page:`) deep-links a node.

Weekly refresh: `pokoin-site-map-refresh.timer` (systemd user unit on nezopt,
Mondays 04:30 UTC) runs `scripts/refresh-site-map.sh` inside its own Paseo
worktree (`~/.paseo/worktrees/2n15xc8c/site-map-refresh`, used by nothing
else). It checks out `origin/main`, rebuilds `site-map.json` and
`site-map-images.json`, and only when either file changed commits both, pushes
to `main`, uploads with `scripts/publish-web.sh`, smoke-checks the version
preview (`/`, `/marketplace`, `/sitemap`, `/market/data/site-map.json`), then
promotes that version. A failed preview check leaves the version unpromoted and
the unit fails (OnFailure alert). The builder leaves the files alone when only
the date would change, so quiet weeks publish nothing. Log:
`journalctl --user -u pokoin-site-map-refresh`.

Site map v2: **Market** view colours card stars by the cheapest listed PKN
(`cheapest_homepage_cache_blueprint`, quintile ramp, snapshot date in the
footer); a card's panel fetches the live price from
`/api/marketplace-card-page`. Card thumbnails live in
`market/public/data/site-map-images.json`, loaded on the first card hover.
**Six degrees** (`?focus=…&to=…`) is a BFS over real two-way catalog links
(card ↔ set, card ↔ Pokémon, card ↔ artist, set ↔ era).

Review boards (`/tests`, `/sanitize`, `/espurr`, `/ocr`, `/ocr/artists`,
`/artwork`, `/jumbos`) are test.pokoin.com only: `vercel.json` 308-redirects
them off the `pokoin.com` host, and the site map leaves them (and the
extension auth bridge) off the graph. The map is the whole page: no footer,
no list underneath. Far out, sets paint as discs; card stars fade in with
zoom, and ring labels grow with it.

Compare (`?view=compare&q=lucario,scizor`, up to five keywords): card desks
whose name contains each keyword at a word start light up in that keyword's
colour. Each field suggests word-start phrases from card names as you type,
with the desks each would light up (Pokémon first). The panel opens with head
to head lines (reach, cheaper median, debut era, listed share, priciest ask) and
what the keywords share (sets, artists, desks naming all of them), then one
card per keyword: desks, median PKN, price mix on the site-wide ramp, listings,
sets, artists, era span, cheapest/priciest, biggest set and top artist.

Phones (≤720px): the header is one compact block (title and counts on one line,
modes full width, compare fields two per row); panels are a bottom sheet that
peeks at 42% and expands from its grip; legend and zoom hide under the sheet. Market prices take the cheaper of the
CardTrader cache and every active Pokoin listing, read live at build time.

## Card URLs for crawlers (2026-10-15)

- A card URL never serves the generic SPA shell to a search bot. API failure returns 503 + Retry-After (Google retries); an unknown id returns 404. Identical canonical-less shells were being clustered as duplicates ("Google chose different canonical") and carried no card image.
- `/marketplace/cards/:id/:slug` (no locale) 301s every client to `/marketplace/en/cards/:id/:slug`. Other `/marketplace/cards/*` shapes still fall through to the SPA shell.
- The crawler <img> no longer declares 630x880; CDN scans are ~500x703.

## Hub URLs for crawlers (2026-10-15)

- Set/era/artist/species/rarity hubs: API failure returns 503 + Retry-After + noindex (was a cached, indexable thin page). Unknown set/era/artist/species/rarity returns 404 + noindex (was 200, self-canonical soft 404).
- Crawlers get a 301 to the canonical form: non-en species/rarity/language/guide/artist hubs go to /marketplace/en/..., and locale-prefixed sets/eras go to /marketplace/sets|eras/.... Language-less hubs 301 for every client.
- Set, artist and species hubs publish the first card scan as og:image and JSON-LD image.

## Language-less marketplace URLs (2026-10-15)

Workers Static Assets served the SPA shell for `/marketplace/pokemon`, `/marketplace/rarities`, `/marketplace/languages`, `/marketplace/guides`, `/marketplace/artists`, and `/marketplace/cards/:id/:slug`, so the `_redirects` 301 never ran. Those paths are in `run_worker_first` now, and the worker 301s every client to the `/marketplace/en/...` form, keeping the query string and any game prefix. The `_redirects` rules stay.


## Public product, alternative, and workflow pages (2026-10-17)

The homepage links a public product-discovery layer alongside the catalog:

- `/features`: scanner, seller inventory, collection/portfolio, Poko assistant,
  Chrome extension, marketplace, and seller fees.
- `/alternatives`: workflow comparisons with Collectr, Dragon Shield,
  TCGplayer, and Cardmarket, with primary sources and review dates.
- `/learn`: scan-to-collection/listing and stock-spreadsheet walkthroughs.

These are complete static HTML pages, identical for visitors and crawlers.
They do not depend on SPA hydration or the bot-specific catalog Workers.
The private application URLs remain application actions, rather than the
indexable descriptions of the features. `robots.txt` gives Googlebot,
Bingbot, OAI-SearchBot, and other crawlers the same public/private rules.
The existing AI-training content policy is unchanged. A successful HTTP probe
with a crawler user-agent does not establish access from every real crawler
IP; verify production edge logs and URL Inspection after publication.

Author content in `content/product-pages.mjs`; render with
`node scripts/build-product-pages.mjs <output-directory>`.
`scripts/build-web.sh` invokes the renderer into `dist-web`, including
`sitemap-product-pages.xml`. The main sitemap generator includes that child
sitemap. Flat `.html` assets use the host's extensionless HTML handling;
these prefixes must stay out of SPA catch-all rewrites. The legacy Vercel
config has explicit static-page rewrites. Vite serves the same renderer for
local review, including proper unknown-page 404s for these prefixes.

Each page has its own title, description, canonical, social metadata,
visible breadcrumbs, WebPage/CollectionPage and BreadcrumbList JSON-LD,
visible text, related links, and ordinary HTML links to the application.
FAQs are visible content; no special FAQ search appearance is promised.
The WebApplication entity has no invented price, rating, or review data.
`llms.txt` is a supplemental product directory, not a prerequisite for AI
search discovery or a substitute for crawling and useful content.

Keep comparisons specific and fair. Use current primary sources, state
Pokoin's authorship, include material limitations, and change `reviewed`
only after an actual editorial review. Do not create city/keyword doorway
variants or claim recognition benchmarks without measured evidence.
The fee page describes the 3% buyer markup and actual seller payment costs, and compares
named published base rates, not universal lowest all-in selling cost.
Commission caps, minima, seller programs, VAT, payment/withdrawal/conversion,
and network costs can change an order's effective cost. The fee-copy test
fails when the checkout or native seller-settlement rate changes, prompting
an editorial review rather than silently relabelling stale content.

Checks: `node --test scripts/product-pages.test.mjs scripts/cloudflare-web-routing.test.mjs`
and `cd solid && npm run build`. Before release, inspect generated HTML and
the product sitemap in the deployment artifact, check mobile tables/menu,
and verify unknown public-page paths return 404. No push, crawl submission,
or deployment is implied by generating the pages.

After an authorised production publish, submit/check the sitemap in Search
Console and inspect representative feature and comparison URLs. Measure
impressions and clicks for actual task and alternative queries, and
referrals from services such as `chatgpt.com`; use the existing analytics
setup rather than adding an unrelated tracking script. Indexing, ranking,
and AI recommendations depend on the search systems and are not guaranteed.

### Minimal landing and offer scope (17 October 2026)

The landing keeps a short hero, three task cards, two send-in offers, compact
assistant/extension panels, and a reduced footer. Detailed articles remain on
public URLs. Search-demand evidence, raw autocomplete responses and estimated
keyword volumes are recorded in `docs/research/pokemon-search-2026-10-17/`.
Volumes are country-specific Semrush estimates; suggestions have no numeric
volume. Google Trends returned 429, so no trend claims were made.

New intent pages: `/features/pokemon-card-price-checker`,
`/features/trade-cards-for-pkn`, and `/features/managed-selling`. All are linked
from the homepage and feature hub and included in the generated product sitemap.

Keep the payout media distinct: 90% of market value (minimum 1 PKN per card)
is immediate **PKN credit**; managed selling pays **real money after sale** at
15.5% base commission, one percentage point below CardTrader’s published
1-Day Ready 16.5% base rate. These send-in offers use Contact for intake; the
CardTrader 1-DR account route is an external account viewer. The self-service
marketplace adds a 3% buyer markup. Seller item value is not reduced by that
markup; actual Stripe costs are allocated across seller proceeds. Contracted
Stripe rates and external payout/conversion charges are not established by
repository code. See the research folder’s `SELLING-OFFERS.md` audit.

Market-data copy leads the comparison hub and names **CardTrader + TCGplayer**
on the landing. Verified against `docs/POKO_MARKET.md` and
`pokoin-rust/crates/accounts/src/handlers/poko_market.rs`: CardTrader observed
asks/daily lowest asks; optional matched TCGplayer aggregate USD quotes in Poko
and inventory price-check. The price-checker page explains coverage, dates,
currencies and the distinction from inferred/completed sales. Do not describe
Cardmarket/eBay as integrated price feeds or claim every quote is a settled sale.

The authoritative economic contract is [CHECKOUT_FEES.md](CHECKOUT_FEES.md):
3% is added to the buyer’s card subtotal; sellers bear only actual allocated
payment costs, not a Pokoin seller commission. The single cart transaction’s
fixed fee is shared once with exact-cent allocation. Separately billed Connect
costs require verified reconciliation rather than guessed per-order deductions.
