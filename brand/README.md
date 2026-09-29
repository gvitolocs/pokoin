# Pokoin brand assets

One folder with every logo, mascot, icon, font and illustration the site uses.
These are **copies** — the site serves the originals from `home/` and
`market/public/`. Refresh this folder with:

```bash
python3 scripts/build-brand-logo.py    # rebuild the SVG wordmark + mascot (fontTools, Pillow)
bash scripts/sync-brand-assets.sh      # copy everything else in
```

## Logo — the official wordmark

The topbar logo: heavy Fredoka "P·koin", the pixel coin mascot as the first **o**,
a yellow coin dot on the **i**, navy drop shadow. In React use
`market/src/components/PokoinWordmark.jsx`; everywhere else use the SVGs.

| File | Use |
| --- | --- |
| `logo/pokoin-logo.svg` | Default — white letters, navy shadow. Dark backgrounds. |
| `logo/pokoin-logo-flat.svg` | White, no shadow (small sizes, busy backgrounds). |
| `logo/pokoin-logo-navy.svg` | Navy letters for light backgrounds (docs, print, email). |
| `logo/logo.png` | Round coin badge — phone topbar, app icons. |
| `logo/pokoin-192.png` | Web app manifest icon. |
| `logo/bimi.svg` | Email BIMI mark. |

The SVGs are also served at `https://pokoin.com/brand/pokoin-logo.svg` (and
`-flat`, `-navy`, `pokoin-mascot.svg`). They contain paths and pixel squares
only, no font or bitmap, so they render the same in any browser, email client
or design tool. Colours: white `#ffffff`, navy `#23376e`, coin `#ffd23f`, UI
yellow `#ffd33d`.

## Mascot

| File | Use |
| --- | --- |
| `mascot/pokoin-mascot.svg` | Vector pixel mascot (26×24 grid) — scale freely. |
| `mascot/pokoin-mascot@8x.png` | The bitmap the site uses (208×192). |
| `mascot/pokoin-mascot.png` | Original mascot PNG. |

## Favicons, fonts, misc

- `favicon/` — `favicon.ico`, 32/48/96 px PNGs, `apple-touch-icon.png`.
- `fonts/satoshi.woff2` — site UI font. `fonts/fredoka-wordmark.ttf` — Fredoka 700
  subset used only for the wordmark letters (OFL).
- `misc/missing-card.webp` (card placeholder), `misc/working.gif` (maintenance page).

## Icon sets

- `conditions/` — NM / SP / MP / PL / PO condition chips (40×28).
- `flags/` — language and print flags (see `flags/LICENSE.md`).
- `games/` — TCG game icons for the multigame switcher.

## Pokoin Flex illustrations

`flex/` — hero (packs → 20 kg bag → sorting center → partner shop), the four
how-it-works steps and the padded Flex box. Served from `/brand/flex/` on the
site. Same palette as the logo.
