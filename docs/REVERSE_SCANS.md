# Reverse-holo scans on the card desk

The card desk shows a gold three-sparkle button next to the expansion marks when
we hold a **verified** reverse-holo (or Japanese mirror) scan of that printing.
Clicking it swaps the desk scan (and the zoom) to the reverse scan, with the note
"Reverse holo scan"; clicking again goes back. The toggle is per card and not
stored in the URL. SEO images, drags and tiles keep the regular scan.

## Why it is not a separate card

CardTrader has one blueprint per printing. Plain reverse holo is a listing option
on it (`pokemon_reverse` in `editable_properties`: 34,208 of 70,248 Pokémon
singles offer it, and 15,569 have had reverse listings). Pattern reverses (Poké
Ball, Master Ball, Energy, Ball & Rocket) are separate CardTrader expansions with
their own desks. So are stamped printings (League, Staff, Prerelease…). Neither
gets the sparkles.

## Data path

- Files: `cdn.pokoin.com/reverse/{ct_id}_{slug}.jpg`, the same basename as the
  printing's master, 63:88 at the source height, JPEG q92. They are stored on both
  CDN origins: Pi `/srv/pokoin/card-images/objects/reverse/` and the nezopt mirror
  `~/data/pokoin-leftovers/objects/reverse/`.
- Table: `market/src/data/reverse-scans.json` (`token`, `scans: {ct_id: file}`).
  `pokoin-rust/crates/catalog/src/reverse_scan.rs` embeds it, and the card page
  (`catalog_api.rs`) sends `card.reverseScan` with `?v=<token>`.
- SPA: `market/src/reverse-scans.js` accepts only CDN `reverse/` JPEG URLs.
  `solid/src/pages/Card.jsx` renders `ReverseSparkles` and swaps the hero.

Changing a file means bumping `token`, which needs a web + API release.

## Batch rv1 (2026-10-20): 195 printings

- **Wigglytuff 13/100 EX Crystal Guardians (114719):** the set-stamped reverse
  (322×450) that the CDN served before token `wg1`. Kept from
  `backups/thumbs480-20261020/`.
- **194 Japanese mirrors** (Shiny Treasure ex, VSTAR Universe) from the artofpkm
  archive (pokemon-card.com scans, 868×1212). A mirror was kept only when all of
  these hold:
  - the blueprint offers `pokemon_reverse`;
  - the desk scan is artofpkm's normal scan (ncc ≥ 0.995, text diff < 4);
  - the mirror differs from that normal scan.

  13 desks already show the mirror as their master. They were left out, and fixing
  them is a separate task. Start Deck 100 / Battle Collection / The Best of XY
  "Mirror" pages show the plain render, so they were not used.
- **Not used:** artofpkm English "Reverse Holo" pages (TCG Live renders that only
  darken the frame) and our older CDN scans. Of 4,316 alternate scans of 17,781
  western printings, almost none are reverses.

`tools/reverse-scan-audit` (Rust) does the work: `scan` (our scans vs tcgdex),
`compare` (given pairs), `sheet` (contact sheets), and `encode`.
`tools/reverse-scan-audit/picks-rv1.tsv` lists every source.
