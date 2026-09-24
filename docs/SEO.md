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
(H1, crumbs, `Product` JSON-LD). Discord/Slack keep `noindex` and no leftover subtitle.
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
underneath (`market/src/pages/SiteMap.jsx`). Its data is
`market/public/data/site-map.json`, built on nezopt by
`node scripts/build-site-map.mjs`. Page links come from the SPA source
(routes, `to=`/`href=`, `navigate()`, `APP.*`, `*Href` helpers); catalog links
come from a read-only SELECT against the 15T marketplace Postgres and the
public expansion list. It is not part of the Vercel build, so rerun it and
commit the JSON when routes or the catalog change. `?focus=set:base-set`
(`card:`, `pokemon:`, `artist:`, `era:`, `page:`) deep-links a node.

Weekly refresh: `pokoin-site-map-refresh.timer` (systemd user unit on nezopt,
Mondays 04:30 UTC) runs `scripts/refresh-site-map.sh` inside its own Paseo
worktree (`~/.paseo/worktrees/2n15xc8c/site-map-refresh`, used by nothing
else). It checks out `origin/main`, rebuilds the JSON, and only when the map
changed commits, pushes to `main` and runs `scripts/deploy-web.sh`. The builder
leaves the file alone when only the date would change, so quiet weeks deploy
nothing. Log: `journalctl --user -u pokoin-site-map-refresh`.

Site map v2: **Market** view colours card stars by the cheapest listed PKN
(`cheapest_homepage_cache_blueprint`, quintile ramp, snapshot date in the
footer); a card's panel fetches the live price from
`/api/marketplace-card-page`. Card thumbnails live in
`market/public/data/site-map-images.json`, loaded on the first card hover.
**Six degrees** (`?focus=…&to=…`) is a BFS over real two-way catalog links
(card ↔ set, card ↔ Pokémon, card ↔ artist, set ↔ era).

Review boards (`/tests`, `/sanitize`, `/espurr`, `/ocr`, `/ocr/artists`,
`/artwork`, `/jumbos`) are test.pokoin.com only: `vercel.json` 308-redirects
them off the `pokoin.com` host, and the site map links them to
test.pokoin.com and leaves them out of the pokoin.com page count.
