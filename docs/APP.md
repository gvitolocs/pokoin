# CardVault (Android / iOS) — not pokoin.com

This file is **app-only**. Public `https://pokoin.com` is the React SPA in
this repo. Do not use the notes below as the production web pipeline.

| Host | What |
| --- | --- |
| `https://pokoin.com` | Landing + React market. Docs: [LANDING.md](LANDING.md), [MARKET.md](MARKET.md), [CHROME.md](CHROME.md). |
| `https://app.pokoin.com` | Flutter CardVault (Vercel project `pokoin-flutter`). Android, iOS, and leftover Flutter web. |

Repo: [`gvitolocs/cardvault`](https://github.com/gvitolocs/cardvault)
(`pokemon_card_vault/`). Firebase project `pokoin` is shared with the public
web (`market/src/auth.jsx` uses the same `DefaultFirebaseOptions.web` keys).

Identity that both clients must keep: public `card_id` = leftover CardTrader
blueprint (`ct_id`) × 2. Never put `ct_id` in a URL. **Old Milo** gallery
`id` was that leftover `ct_id`. Live `/scan` catalogs
(`pokemon_generic` / `one_piece_singles`) use `"identity": "public_id"` —
`hit.id` **is** the desk id. Omitting `catalog` still searches TCGPlayer;
that `id` is **not** a desk URL. [SCAN.md](SCAN.md). CollectorVision Fast was a
different catalog; do not copy that into Pokoin scan docs. Web map:
[MARKET.md](MARKET.md) identity. Art files: [CARD_ART.md](CARD_ART.md).

---

## What still belongs in the app

Store binaries, camera/OCR hardware bridges, extension in-app WebViews, and
any Flutter-only admin/debug screens that have not been copied to React.
The **public** chrome (marketplace, wallet, cart, forum, scan, buy, admin
expansion logos) is React on pokoin.com. Chrome-extension Cardmarket auth is
`https://pokoin.com/extension/auth-bridge` in this SPA (`extension-auth-bridge.js`),
not `app.pokoin.com`.

Do **not** alias `app.pokoin.com` onto Vercel project `web`. Do **not** alias
`pokoin.com` onto `pokoin-flutter`. Do not copy Flutter `app.html` into
`dist-web/`.

---

## Historical Flutter-web landing (do not deploy)

These paths live in CardVault. They were how pokoin.com was served before this
repo owned `/`. They are leftover. `deploy-pokoin-web.sh` must not run for
production `web`.

### Generated / copied (do not hand-edit in CardVault; not production)

| Path | Role |
| --- | --- |
| `web/home.html` | Old production landing HTML with `/home/` asset URLs. |
| `web/home/landing.css` | Copy of pokoin-web CSS. |
| `web/home/landing.js` | Copy of pokoin-web JS. |
| `build/web/index.html` | After the old deploy swap: landing. After `flutter build`, before swap: Flutter shell. |
| `build/web/app.html` | Flutter shell created by the old deploy script. |

### Routing and deploy (edit only if changing the **app** host)

| Path | Role |
| --- | --- |
| `web/index.html` | Flutter web shell. Never overwrite with the landing. |
| CardVault `vercel.json` | `/` → `/home.html`, catchall `/(.*)` → `/app.html` on **app.pokoin.com**. |
| `deploy-pokoin-web.sh` | Old Flutter build + index/app swap onto project `web`. **Do not run.** |
| `docs/landing-root.md` | Pointer that used to live in CardVault. |

### In-app “Home” leaving the Flutter SPA

Production `/` on pokoin.com is static HTML. Inside Flutter web, Home did a
full navigation to `/`:

| Path | Role |
| --- | --- |
| `lib/utils/public_home.dart` | `goPublicHome()` |
| `lib/utils/browser_location_web.dart` | `window.location.assign('/')` |

`lib/screens/landing_screen.dart` is the old marketing UI still routed at `/`
**inside** Flutter (`lib/main.dart`). Production Vercel `/` never loads it.

### Static files the landing still links to

These URLs 404 on pokoin.com until they are copied into this repo:

| URL | Origin (CardVault `web/`) |
| --- | --- |
| `/audit/PokoinPOS_Official_Security_Audit_2026-05-28.pdf` | `web/audit/…` |
| `/favicon.ico`, `/pokoin-512.png` | `web/` |
| OG image `/pokoin-project-banner-1360x430.png` | `web/` |
| `/bootstrap-peers.json` | Join-only host:port for nodes. Not linked from the landing. |

---

## App APIs that the web already calls

Same Oracle origin `https://api.pokoin.com`. React uses GET page BFFs; do not
POST for page data. Flutter `POST /api/marketplace-autocomplete` is the old searchbar (prefix-only,
needs a remake) — the web uses `GET /api/marketplace-suggest` plus SPA
`suggest-rank.js` (set-code tokens like `hgss energy` peel to HeartGold
elemental energies on the search page; `palkai sl` peels Call of Legends;
set-title phrases like `flareon call of legendsd` peel Call of Legends and
rank Flareon, not sealed product titles; a bare `expedition` browses
Expedition Base Set (20 singles), not Expedition Uniform;
collector n/m like
`061 shieldon` peels to the name, not every 061;
`Sh1` is SH collector hits first, then real Shinx/Shuppet printings from the
ranked pool — never `live:` stubs to pad 20;
jumbo / oversized leftovers sit on the Product tab;
expansion aliases stay off typeahead search-on).

Canonical ranking notes for Meili: CardVault
`pokemon_card_vault/docs/marketplace-search-ranking.md`.

JP/CN print flags (React live, Flutter next): [PRINT_FLAGS.md](PRINT_FLAGS.md).
Flutter set analog is `CollectionExpansionScreen` /
`_SelectedExpansionHeader` in `lib/screens/collection_screen.dart`. Use
`expansion.nationality` from the BFF; do not keep `_regionForExpansion()`
name regex for World Champions Pack.
