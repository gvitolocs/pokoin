# Chrome icons → Flutter (`app.pokoin.com`)

The React market on `pokoin.com` does not implement wallet, forum, signal,
competitive, cart, auth, inventory, scan, or profile. Those controls are
**full-page links** into the Flutter app.

| Host | Vercel project | What |
| --- | --- | --- |
| `https://pokoin.com` | `web` (`prj_1x0bUwaSZPeMRU90jQL5Ak8WWnPX`) | Landing + React market |
| `https://app.pokoin.com` | `pokoin-flutter` (`prj_nrmYJjDGMPh4fZVO7dexZ77BTPls`) | Flutter CardVault |

Never alias `app.pokoin.com` onto project `web`. Never alias
`explorer.pokoin.com` to either Vercel project.

The EN flag is visual only (English). Language switching stays in Flutter.

Home (house icon) stays on the web: `https://pokoin.com/`.

---

## Why the icons looked broken

They already used `<a href="/forum">` (and friends), not React Router. After
pokoin.com stopped serving Flutter:

1. Same-origin paths **404** on `pokoin.com`.
2. `/marketplace/signal` and `/marketplace/competitive` were swallowed by the
   Vite SPA fallback and bounced back to marketplace home.

They are not supposed to become React pages yet. They leave the origin.

---

## Icon map (market top bar)

Source: `market/src/punchouts.js`. Chrome: `market/src/components/Chrome.jsx`.

| Control | href |
| --- | --- |
| Logo / Marketplace | `/marketplace` (React) |
| Home | `/` (landing) |
| Forum | `https://app.pokoin.com/forum` |
| Signal | `https://app.pokoin.com/marketplace/signal` |
| Competitive | `https://app.pokoin.com/marketplace/competitive` |
| 0 PKN | `https://app.pokoin.com/wallet` |
| Profile / Sign in | `https://app.pokoin.com/profile` or `…/auth?from=` |
| Cart | `https://app.pokoin.com/cart` |
| EN | not a link |

Same origin table for landing nav/footer (wallet, scan, forum, inventory,
signal, cardscan, docs, health, buy, profile, earn, about, contact, privacy,
whitepaper). Explore cards / marketplace stay on `pokoin.com`.

On viewports `≤720px` the icon row is replaced by the burger panel (same hrefs).
Search submit becomes an icon at `≤480px`. Phone layout: [MOBILE.md](MOBILE.md).

Card page: Sign in, artist, View all versions, listing rows → `app.pokoin.com`.

---

## Pipeline (edit → live)

```
Chrome hrefs          punchouts.js APP_ORIGIN
     │
     ▼
pokoin-web  ──build-web.sh──►  dist-web/          Vercel `web`     pokoin.com
CardVault   ──deploy-pokoin-flutter-new-project.sh──►  Vercel `pokoin-flutter`
                                                          │
                                                          alias app.pokoin.com
                                                          DNS CNAME app →
                                                          b0495ddbae9afb9b.vercel-dns-017.com
                                                          (Cloudflare, DNS only, not proxied)
```

1. Change a punch-out URL in `market/src/punchouts.js` (and landing
   `index.html` if it is a marketing link).
2. Deploy the **web**:

```bash
cd /home/nez/Projects/pokoin-web
env -u VERCEL_TOKEN vercel pull --yes --environment=production
env -u VERCEL_TOKEN vercel build --prod --yes
env -u VERCEL_TOKEN vercel deploy --prebuilt --prod --yes --archive=tgz
```

3. Change Flutter UI in CardVault, then deploy **only** `pokoin-flutter`
   (`deploy-pokoin-flutter-new-project.sh`). Do **not** alias `pokoin.com`.
4. First-time host (already done 30 Aug 2026):

```bash
env -u VERCEL_TOKEN vercel domains add app.pokoin.com pokoin-flutter --scope giuseppevitolo17s-projects
# Cloudflare CNAME app → b0495ddbae9afb9b.vercel-dns-017.com, proxied=false
env -u VERCEL_TOKEN vercel alias set <pokoin-flutter-deployment>.vercel.app app.pokoin.com
```

Do not copy Flutter `app.html` into `dist-web`. The web repo stays React.

---

## Verify

```bash
dig +short app.pokoin.com CNAME
curl -sS -o /dev/null -w '%{http_code}\n' -A 'Mozilla/5.0' https://app.pokoin.com/wallet
curl -sS -o /dev/null -w '%{http_code}\n' -A 'Mozilla/5.0' https://app.pokoin.com/forum
curl -sS https://pokoin.com/marketplace | grep -F 'app.pokoin.com'
curl -sS https://pokoin.com/ | grep -F 'https://app.pokoin.com/wallet'
```

Click Forum / Signal / wallet chip on `https://pokoin.com/marketplace` — the
browser origin must become `app.pokoin.com`.
