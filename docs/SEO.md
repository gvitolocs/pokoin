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

Human UI stays a desk. Googlebot already gets worker HTML, so the SPA
must not paint a catalog-hub strip, an “X belongs to Set” lede, or text
prev/next under the header. Related **tiles** (at most **12**) and one
“All {Pokémon}” link stay. Extra crumbs and hub links live in **More in
the catalog** at the page end. Eras / rarities / languages / guides live
in Chrome **Catalog**. Visible H1 is the name; commercial “Card List &
Prices” copy stays on `<title>` / `SeoHead` only.
