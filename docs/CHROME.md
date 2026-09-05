# Chrome icons → React (`pokoin.com`)

Public chrome is this SPA. Android/iOS CardVault is a separate app on
`app.pokoin.com`. App-only history and Flutter-web leftovers:
[APP.md](APP.md). Do not alias that host onto Vercel project `web`.

| Host | Vercel project | What |
| --- | --- | --- |
| `https://pokoin.com` | `web` (`prj_1x0bUwaSZPeMRU90jQL5Ak8WWnPX`) | Landing + React market (Pokemon) |
| `https://onepiece.pokoin.com` | same `web` | Same SPA; hostname → One Piece (`?game=one_piece`) |
| `https://riftbound.pokoin.com` | same `web` | Same SPA; hostname → Riftbound (`?game=riftbound`) |
| `https://app.pokoin.com` | `pokoin-flutter` (`prj_nrmYJjDGMPh4fZVO7dexZ77BTPls`) | Flutter CardVault |

Never alias `explorer.pokoin.com` to either Vercel project.

The search-language flag toggle sits to the **right of the search pill** on
desktop and phone (real circular SVGs from HatScripts/circle-flags, MIT,
vendored in `market/public/flags`). It is **not** visual-only: it sets
`pokoin.searchLanguage` and is sent as `search_language` / `lang` on suggest
and search. Card/artist URLs rewrite `/marketplace/{lang}/…`.

Home (house icon): on `pokoin.com` → `/` (landing). On One Piece / Riftbound hosts → `/marketplace`.

Competitive is Pokemon-only (hidden on satellite hosts).

Action inventory: [pokoin-react-action-map.canvas.tsx](/home/nez/.cursor/projects/home-nez-Projects-pokoin-web/canvases/pokoin-react-action-map.canvas.tsx).

---

## Icon map (market top bar)

Source: `market/src/components/Chrome.jsx`. Routes: `market/src/punchouts.js`.
Every control is a **same-origin** path on `pokoin.com`. Never
`https://app.pokoin.com/…` for these icons.

| Control | href on pokoin.com |
| --- | --- |
| Logo / Marketplace | `/marketplace` |
| Home | `/` (static landing, full page) |
| Forum | `/forum` |
| Signal | `/marketplace/signal` |
| Competitive | `/marketplace/competitive` |
| PKN chip | `/wallet` |
| Profile / Sign in | `/profile` or `/auth?from=` |
| Cart | `/cart` (`pokoin.cartItems`) |
| Language flag | Right of search. Sets catalog search language. |

Footer and burger also include Explore, Portfolio, Sets, Watchlist, Docs, Scan.

On viewports `≤720px` the icon row is a **full-height left side drawer**
(~86vw, dim scrim from the top of the viewport) with a **3-column grid** of
gold icons over labels (`Chrome.jsx` `mobile-tile`). The drawer and scrim sit
above the header. Tap the dim to close. Search submit is a gold magnifying-glass icon
at every width (`aria-label="Search"`). Phone layout: [MOBILE.md](MOBILE.md).
Suggest hides the Singles / versions column at `≤720px`.

Card page: Sign in → `/auth`. Artist and versions stay in this SPA. Add to cart
writes the local cart and opens `/cart`.

---

## Header search (CardTrader-style rows)

Source: `market/src/components/Chrome.jsx`, copy helpers in
`market/src/identity.js`. Dark gold theme — do **not** clone CardTrader’s
white/blue skin.

The pill submit control is a gold magnifying-glass SVG (never the word
“Search”). `aria-label="Search"` stays on the button.

`GET /api/marketplace-suggest?q=` (Meili groups) with `search_language` from the
flag toggle (`pokoin.searchLanguage`). Each printing is a row:

| Cell | What |
| --- | --- |
| Set square | 2–4 letter abbrev from the expansion name (`setAbbrev`). Skip filler words (the, set, mega, ex). Empty set → `●`. |
| Thumb | `imageSrc(card, 'suggest')`. Full leftover JPEG first; CardTrader `preview_` URLs are allowed **only** here so empty squares do not appear. Hero/grid still drop previews. |
| Title | **Bold**, `Name - 006/021` (`printingIdentity.suggestTitle`) |
| Expansion | Own line, `Phantasmal Flames #006` (`suggestExpansion`) |
| Right | Category (`suggestKind`, default **Singles**) and gold **View all N versions** when the group has more than one printing. Versions → `{canonicalPath}/versions`. |
| Footer | **View all {count} results** submits to `/marketplace/search` |

No uppercase group headers (`MIMIKYU`). Groups still exist in the payload so
version counts stay honest (δ / other names are separate groups).

Row pick goes to the card page. The versions control is a separate `<Link>`.

After marketplace **home** finishes loading, `warmupSearchBar()` runs on idle
(5 min TTL). It hits `GET /api/marketplace-suggest?q=m&limit=4` (the header
path) and, on Pokemon only, `GET /api/searchbar-token-predict?warmup=1`
(same first-char warmup as Flutter). Errors are swallowed. Do not wait on
this for LCP.

---

## Pipeline (edit → live)

```
Chrome hrefs          punchouts.js APP
     │
     ▼
pokoin-web  ──build-web.sh──►  dist-web/          Vercel `web`     pokoin.com
CardVault   ──deploy-pokoin-flutter-new-project.sh──►  Vercel `pokoin-flutter`
                                                          alias app.pokoin.com
```

1. Change a route in `market/src/punchouts.js` (and landing `index.html` if it
   is a marketing link).
2. Deploy the **web** (`scripts/build-web.sh` / Vercel project `web`).
3. Change Android/iOS UI in CardVault, then deploy **only** `pokoin-flutter`.
   Do **not** alias `pokoin.com`. See [APP.md](APP.md).

Do not copy Flutter `app.html` into `dist-web`.

---

## Live check

`https://pokoin.com` sits behind Cloudflare Bot Fight. Datacenter curls from
this host get **403** / JS challenge. Use a real browser.

Forum, Signal, Competitive, Wallet, Profile, and Cart on
`https://pokoin.com/marketplace` are same-origin React routes. They must not
open `app.pokoin.com`.
