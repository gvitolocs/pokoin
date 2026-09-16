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
| `(max-width: 1100px)` | Card desk drops the three-column wide layout (Best Deal under art+center). Promo fan shrinks. Not the compact chrome. |
| `(max-width: 720px)` | **One compact breakpoint** for chrome, search suggest, and card desk. Burger + **40px** Pokoin logo + search + **32px** title-language flag. Print-language picker is the **magnifying glass** inside the pill. Search is **Enter**. Icon nav moves into the burger panel. **Top bar columns:** `auto auto minmax(0, 1fr) auto`. Suggest: **two-column** row (`main \| art`), set square hidden, print flag overlays the art crop; expansion `<em>` stays in the DOM (clipped); collector number moves into the title. Card desk stacks Best Deal → art → shop → list form. Home promo copy stacks. Wallet/forum/scan grids go one column. Test: `node --test market/src/suggest-layout.test.js`. |
| `(max-width: 480px)` | **Phone aesthetics** (iPhone 16). See below. Desktop is not in this query. |

## Phone-only (`≤480px`) — market

Source: `market/src/styles.css` (block at the bottom). Chrome markup:
`market/src/components/Chrome.jsx`.

| Surface | What changes | Why |
| --- | --- | --- |
| Top bar | Safe-area padding; 40px logo; 32px title-language flag after search; mag glass in the pill opens print-language; search is Enter | Flag is the smaller circle; Poko is the larger mark in the 52px bar |
| Search suggest | Full viewport width minus the 0.75rem chrome gutters. **Two-column** row: title block \| art crop. Set square hidden. Print flag overlays the crop (top-left). No Singles cell. Expansion `<em>` is still in the DOM (clipped). Collector number moves into the title (`suggest-num-phone`). Missing leftover (Mimikyu `#suggest-691678`) keeps the JP flag on that last column. | The panel is a child of the search pill |
| Main | Tighter padding `0.75rem 0.85rem` | Recover horizontal room for two tile columns |
| Expansion promo | Fan above copy, still overflowing the box; 1.65rem title; **full-width** yellow **Explore** CTA (44px); 44px arrows | Thumb reach; overlay chase cards |
| Rails | Tile width `9.6rem`, tighter gap, touch momentum scroll | ~2 cards plus a peek instead of one oversized tile |
| Grid | Forced **two columns** `minmax(0, 1fr)` | `auto-fill` / `10.5rem` was borderline at 393px |
| Sell callout | Stacks label above “Get started” | Horizontal flex overflowed |
| **Card desk** | Areas: **art → Best Deal → shop → list form** | Compact `≤720px` puts Best Deal first (same breakpoint as search suggest); on a 852px-tall phone that hid the scan. Phone (`≤480px`) shows the printing first |
| Asset header | **Fixed 5.75rem.** Two lines: name + watch/share; set line + last-day PKN / 24h. Name and set ellipsis. No type/rarity pills | Swiping printings must not jump the scan. Stop the name wrapping into a wall of navy |
| Art ‹ › | 44×44 tap targets (SVG chevrons). Gold pill between them is the rarity label (dropdown chevron only if this set has another rarity). ‹ › walk the expansion, not rarity finishes. Set-symbol circles under the scan (drop when more than five expansions; gold **More versions...** halo stays) | Apple HIG; centering is in the SVG, not `‹`/`›` glyphs |
| Shop filters | One line with Shop / Condition / Language / Sort / trash; wrap if the phone is too narrow | Full-width stacked selects made the desk taller than it needed |
| Footer | Extra `safe-area-inset-bottom` | Home indicator |
| Burger panel | Left drawer **below** the top bar; full-page dim scrim underneath the drawer; 3-column gold icon tiles | Header dims with the rest of the page; tap the dim to close |

What phone CSS does **not** change: gold `#FFD33D`, `card_id` identity, listing
`nativeOnly`, honest `24h —`, JPEG heroes, Satoshi.
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
| `market/src/components/Chrome.jsx` | Mag glass opens print-language; search is Enter; CardTrader-style suggest rows |
| `home/landing.css` | `≤480px` safe-area nav / hero / CTA |
| `docs/MARKET.md` | Card stack exception on phone |

## Check after a CSS change

1. **393×852** marketplace home: burger, logo, search icon in one row; promo
   CTA full width; 3-card fan overflows the banner; arrows change expansion;
   two New cards tiles with a peek of a third.
2. Open a card: **scan is in the first viewport** (name + art, then Best Deal).
   Left ‹ goes to the previous collector number.
3. Rotate or 430×932 (Plus): still two columns, no horizontal page scroll.
4. Desktop ≥721px: icon nav still in the top bar; search submit is **Enter**
   (the visible word “Search” is `sr-only`); card desk is three columns
   **above 1100px**.
