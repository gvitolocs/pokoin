# Phone browsing (iPhone 16 as the design target)

Phone layout is **CSS-only** (`max-width: 480px` and the existing `720px`
chrome). Desktop and tablet widths are unchanged except the `≤720px` top bar
grid, which already hid the icon nav.

Canonical handset: **iPhone 16** at default Display Zoom.

| | Value |
| --- | --- |
| CSS viewport | **393 × 852** |
| Physical panel | 1179 × 2556 |
| Device pixel ratio | 3 |
| Safe areas | Dynamic Island top, home indicator bottom |
| Same width as | iPhone 15 / 15 Pro / 14 Pro (393) |

Plus / Pro Max (430–440) still match `max-width: 480px`. iPhone 16 with
**Larger Text / Display Zoom** can report **320** CSS px; two-column grids
still fit.

## How to simulate

Chrome DevTools → device toolbar, or Playwright:

```bash
playwright-cli close
playwright-cli open http://127.0.0.1:5174/marketplace
playwright-cli resize 393 852
```

Vite market: `cd market && npm run dev` → `/marketplace`.

Landing is not on the Vite port. Serve the repo root or use `https://pokoin.com/`
at the same 393×852 viewport.

`viewport-fit=cover` is set on both `index.html` (landing) and
`market/index.html` so `env(safe-area-inset-*)` is non-zero in Safari.

## Breakpoints

| Query | What it is for |
| --- | --- |
| `(max-width: 1100px)` | Card desk drops the three-column wide layout |
| `(max-width: 960px)` | Tablet card stack: Best Deal → art → shop → list form (Flutter narrow) |
| `(max-width: 720px)` | Burger + logo + search. Icon nav moves into the burger panel. **Top bar columns:** `auto auto minmax(0, 1fr)` so search fills the leftover row (the old `auto 1fr auto` parked the logo in the flexible column and squeezed it). |
| `(max-width: 480px)` | **Phone aesthetics** (iPhone 16). See below. Desktop is not in this query. |

## Phone-only (`≤480px`) — market

Source: `market/src/styles.css` (block at the bottom). Chrome markup:
`market/src/components/Chrome.jsx`.

| Surface | What changes | Why |
| --- | --- | --- |
| Top bar | Safe-area padding; 32px logo; 44px burger; search submit is a magnifying-glass icon (the word “Search” stays on desktop) | 393px cannot fit burger + logo + long placeholder + “Search” without crowding |
| Search input | `font-size: 16px` | iOS Safari zooms the page if the field is smaller than 16px |
| Main | Tighter padding `0.75rem 0.85rem` | Recover horizontal room for two tile columns |
| Mega Era promo | Less padding, 1.65rem title, **full-width** yellow CTA (min-height 44px) | Thumb reach; less empty navy |
| Rails | Tile width `9.6rem`, tighter gap, touch momentum scroll | ~2 cards plus a peek instead of one oversized tile |
| Grid | Forced **two columns** `minmax(0, 1fr)` | `auto-fill` / `10.5rem` was borderline at 393px |
| Sell callout | Stacks label above “Get started” | Horizontal flex overflowed |
| **Card desk** | Areas: **art → Best Deal → shop → list form** | Flutter tablet order puts Best Deal first; on a 852px-tall phone that hid the scan. Phone shows the printing first |
| Asset header | Smaller title, tighter padding | Stop the name wrapping into a wall of navy |
| Art ‹ › | 44×44 tap targets (SVG chevrons, collector-number order) | Apple HIG; centering is in the SVG, not `‹`/`›` glyphs |
| Shop filters | Full-width stacked selects | Two dropdowns side by side were unreadable |
| Footer | Extra `safe-area-inset-bottom` | Home indicator |
| Burger panel | 44px-tall rows + bottom safe area | Same menu as `≤720px`, easier to hit |

What phone CSS does **not** change: gold `#FFD33D`, punch-outs to
`app.pokoin.com`, `card_id` identity, listing `nativeOnly`, honest `24h —`,
no Sell in the header.

## Phone-only — landing

`home/landing.css` `@media (max-width: 480px)`:

- Fixed nav gets `padding-top: env(safe-area-inset-top)` so the logo/hamburger
  sit below the Dynamic Island.
- Hero padding matches that nav height.
- Yellow CTA bar adds `safe-area-inset-bottom`.

`≤640px` / `≤991px` landing rules (single-column features, full-screen nav
drawer) were already there and still apply.

## Files

| File | Role |
| --- | --- |
| `market/index.html`, `index.html` | `viewport-fit=cover` |
| `market/src/styles.css` | `≤720px` top-bar grid; `≤480px` phone sheet |
| `market/src/components/Chrome.jsx` | Search button: `.search-go-text` + `.search-go-icon` |
| `home/landing.css` | `≤480px` safe-area nav / hero / CTA |
| `docs/MARKET.md` | Card stack exception on phone |

## Check after a CSS change

1. **393×852** marketplace home: burger, logo, search icon in one row; promo
   CTA full width; two New cards tiles with a peek of a third.
2. Open a card: **scan is in the first viewport** (name + art, then Best Deal).
   Left ‹ goes to the previous collector number.
3. Rotate or 430×932 (Plus): still two columns, no horizontal page scroll.
4. Desktop ≥721px: icon nav still in the top bar, “Search” still a word, card
   desk still three columns above 1100px.
