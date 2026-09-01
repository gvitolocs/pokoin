# Chrome icons → React (`pokoin.com`)

Public chrome is this SPA. Android/iOS CardVault is a separate app on
`app.pokoin.com`. App-only history and Flutter-web leftovers:
[APP.md](APP.md). Do not alias that host onto Vercel project `web`.

| Host | Vercel project | What |
| --- | --- | --- |
| `https://pokoin.com` | `web` (`prj_1x0bUwaSZPeMRU90jQL5Ak8WWnPX`) | Landing + React market |
| `https://app.pokoin.com` | `pokoin-flutter` (`prj_nrmYJjDGMPh4fZVO7dexZ77BTPls`) | Flutter CardVault |

Never alias `explorer.pokoin.com` to either Vercel project.

The EN flag is visual only (English).

Home (house icon) stays on the web: `https://pokoin.com/`.

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
| EN | not a link |

Footer and burger also include Explore, Portfolio, Sets, Watchlist, Docs, Scan.

On viewports `≤720px` the icon row is the burger panel. Search submit becomes
an icon at `≤480px`. Phone layout: [MOBILE.md](MOBILE.md).

Card page: Sign in → `/auth`. Artist and versions stay in this SPA. Add to cart
writes the local cart and opens `/cart`.

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
