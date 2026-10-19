# Card scans in the visitor's card language

Pick Italian (or French, German, Spanish, Portuguese) in the search language
menu, and a western card's tile, desk hero and zoom show the Italian scan of
that same card. A small "Italian scan" label sits on the desk hero. English,
Japanese, Korean and every other language keep the leftover JPEG.

## Rule (Codevira decision)

A western CardTrader blueprint is **one printing for every western
language**: the language belongs to the listing, not to the card. The
leftover JPEG is that printing's English scan. TCGdex has the same card
scanned per language, so a language scan is another picture of the same
printing, never a separate printing. Japanese/Korean and Chinese print
families are their own printings (D000065, D000084) and never get a western
language scan. English names stay primary (D00001T); the scan follows the
language menu the way the second name line does.

## Data

| Piece | Where |
| --- | --- |
| Scans | `cdn.pokoin.com/tcgdex/{lang}/{serie}/{set}/{localId}.webp` (both CDN origins), 600×825, transparent rounded corners. Source and upload manifests on nezopt 15T: `~/mnt/mybook/datasets/tcg/pokoin-cdn/tcgdex/{lang}/…`, `…/manifest/{lang}.jsonl` |
| Mapping table | `public.marketplace_leftover_lang_scans (ct_id, language, scan_path)` — `scripts/sql/127_leftover_lang_scans.sql`. Key = leftover `ct_id` (public card id / 2). `scan_path` is `{serie}/{set}/{localId}` |
| Mapping tool | `tools/lang-scans` (Rust, own workspace) |
| API field | `langScans: "de,fr,it:swsh/swsh3/136"` on card records, only when the printing has one |
| SPA | `market/src/lang-scans.js`, `solid/src/components/CardArt.jsx` (`langScans` prop) |

### How the mapping is built

1. Export the western printings (read-only):
   `psql -A -F $'\t' -d pokoin_marketplace < tools/lang-scans/export-cards.sql > cards.tsv`
2. Run the tool on nezopt (decodes every candidate scan from the 15T tree, ~10–20 min cold):
   ```
   cargo build --release --manifest-path tools/lang-scans/Cargo.toml
   lang-scans --cards cards.tsv \
     --manifests ~/mnt/mybook/datasets/tcg/pokoin-cdn/tcgdex/manifest \
     --scan-root ~/mnt/mybook/datasets/tcg/pokoin-cdn \
     --out mapping.tsv --rejects rejects.tsv --sample 100 --sample-out sample.tsv
   ```
   - Join: expansion `official_id` (pokemontcg.io / TCGdex id) + printed
     collector number, both folded (`sv3pt5` = `sv03.5`, `095` = `95`,
     `TG05` = `TG5`). A few set aliases (`sma`→`sm115`, `base6`→`lc`,
     `rsv10pt5`→`sv10.5w`, …) and promo prefixes (`swshp` `045` = `SWSH045`)
     are in the tool.
   - A pair is kept only when the TCGdex **English** name of that slot folds
     to the leftover's name (accents, case, punctuation, `Lv.36`,
     `δ Delta Species`, `☆ Gold Star`, `◇ Prism Star`, ` - subtitle`,
     `[stamp]` ignored). TCGdex Pocket (`tcgp`) is never used.
   - Each language scan must decode, be ≥ 400 px wide and be opaque down
     its middle (some TCGdex files are cut off, e.g. FR xyp Champions
     Festival is only the top 44 %).
3. Look at a contact sheet before loading:
   `tools/lang-scans/contact-sheet.sh cards.tsv sample.tsv OUT_DIR` (leftover
   left, language scan right).
4. Load on the nezopt writer (one transaction; adds, updates and removes rows):
   `psql -v ON_ERROR_STOP=1 -d pokoin_marketplace -f tools/lang-scans/load.sql < mapping.tsv`

The table only needs a reload when TCGdex scans or western printings are
added.

## API

`catalog_api::cards` (`marketplace-card-page`, `marketplace-card-tiles`, `marketplace-search-page`)
reads `marketplace_leftover_lang_scans` by `ct_id` in the same `join!` as
art shades and visual themes: one indexed lookup per request batch, grouped
in Postgres. No per-row work on the Pi. A database without the table gives
no field (same `optional_rows` guard). Responses are language-independent,
so cached bodies stay shared across languages.

Not covered yet: the Pokémon typeahead and `marketplace-suggest` (Meili documents) and prebuilt list
snapshots (`marketplace-list` c1v2, set desks) do not carry `langScans`;
those keep the English scan.

## SPA

`CardArt` puts `langScanUrl(langScans, searchLang())` in front of the usual
sibling list, so a missing or failing language scan falls back to the
leftover JPEG (and is remembered like any failed sibling). Only full-card
renders opt in: grid tiles, the desk hero and its zoom. Album crops (`cut`),
LEGEND/BREAK landscape desks and the typeahead keep the leftover scan,
because their crop windows are measured on it. `img.is-lang-scan` uses
`object-fit: cover` (a ~1.5 % side crop of the 0.727 scan in the 63:88
frame) on a dark background, so the transparent corners read dark.
