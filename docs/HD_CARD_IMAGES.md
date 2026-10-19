# HD card images (leftover upgrades)

On 2026-10-19, 10,470 Pokémon leftover scans on the CDN (10,626 JPEG keys plus
their `_homepage.webp`) were replaced by a larger scan of the **same printing**:

| Source | Cards | Typical size |
| --- | --- | --- |
| artofpkm (pokemon-card.com official JP images) | 9,159 Japanese | 255×361 / 500×698 → 868×1212 |
| tcgdex `en` | 1,255 western | 400×550 / 255×361 → 600×825 (591×825 at 63:88) |
| tcgdex `ja` | 56 Japanese | → 600×825 |

The bytes replaced the existing keys (the CDN resolves a card to its shortest
slug-compatible JPEG, so a new key would not be served). The browser and
Cloudflare caches are bypassed by cache token `hd1` in
`market/src/data/catalog-image-cache.json` (304 ranges, shared with the Rust
`deskArtUrl`). A range never spans an id that already has another token unless
that id itself was upgraded; a non-upgraded id inside a range only refetches its
unchanged bytes.

## Tool

`tools/hd-scan-upgrade` (Rust, own workspace; review sheets with `sheets.sh`):

```bash
cd tools/hd-scan-upgrade && CARGO_TARGET_DIR=~/tmp/hd-card-images/target cargo build --release
B=~/tmp/hd-card-images/target/release/hd-scan-upgrade
$B ap-index --catalog <artofpkm>/catalog.jsonl --out ap-printings.tsv --sets ap-sets.tsv
$B match --catalog catalog.tsv --objects ~/data/pokoin-leftovers/objects --data market/src/data \
  --tcgdex-root ~/mnt/mybook/datasets/tcg/pokoin-cdn --ap-printings ap-printings.tsv \
  --ap-sets ap-sets.tsv --ap-root <artofpkm> --out run
$B remeasure --objects ~/data/pokoin-leftovers/objects --pairs run/pairs.tsv --out run/pairs-ed.tsv
$B decide --pairs run/pairs-ed.tsv --out run/final.tsv
$B encode --pairs run/final.tsv --ids accepted.ids --out stage
```

`catalog.tsv` is `marketplace_search_candidates` singles joined to
`pokoin_pokemon_expansions` on `normalized_name` (ct_id, card_id, name,
card_number, expansion, expansion_id, code, nationality, official_id,
official_source, kind, art_layout, product_type, version, image_url).

## Acceptance rules

- **Join.** Western: tcgdex `en` by official set id + collector number; the
  names must agree. TCG Pocket (`tcgp`) is excluded. Japanese: tcgdex `ja` by set id
  + number, and artofpkm by expansion name + number (the English names must share
  a word).
- **Size.** The candidate is at least 1.3× taller and wider than the served JPEG.
- **Visual.** Both scans normalised to 63:88 and aligned (scale ±6 %, shift
  ±4 px at 126×176). Whole card NCC ≥ 0.98, artwork window ≥ 0.97, worst 6×8 tile
  z-diff ≤ 0.30. Colour difference ≥ 16 goes to review (holo / foil variants).
- **1st Edition.** A template match of the Japanese "1 EDITION" mark (DP and BW
  styles, `templates/`) runs on both scans. A mark on one side only rejects the pair
  (529) or holds it for review (273). Beat of the Frontier Medicham Lv.48 43/100
  is the case that showed it: the CDN had the unlimited print, artofpkm the 1st
  Edition.
- **WOTC.** tcgdex `en` pairs from the WOTC era are rejected (tcgdex mixes 1st
  Edition prints there). Listed Base Set (expansion 1472) stays the unlimited
  TCGPlayer photo (D00000W, D000013).
- **Skipped.** Ids pinned by an `ids` rule in the cache-token file, placeholder
  leftovers (`pokoin-placeholder-leftovers.json`), and LEGEND/BREAK (the sources
  store them landscape).
- **Several keys.** When a card has two slug families
  (`togetic-39-147-aquapolis` and `togetic-full-v4`), every JPEG of that ct_id
  that passes the core check on its own is replaced.
- **Sharpness** is logged but not used: the small scans' JPEG noise scored as
  "sharper" than real detail.

Encoding: the source is made exactly 63:88 at its own height (transparent tcgdex
corners are flattened onto the card's border colour). Output is JPEG q92 and
`_homepage.webp` at 240 px wide, q82, the same as `scripts/ingest-missing-product-images.py`.

## Lists

- `tools/hd-scan-upgrade/runs/hd1-upgraded.tsv`: the 10,470 cards (ct_id, card_id,
  source, source ref, old size, new height). Use these ct_ids to re-embed the
  CLIP / `cdn_milo` galleries; that has not been run (GPU mutex, see
  `pokoin-cardapp/notes/NEZOPT_GPU.md`).
- `tools/hd-scan-upgrade/runs/hd1-review.tsv`: 1,543 pairs held for review (near
  the thresholds, colour, edition-unsure, stamped). They were **not** written.

## Rollback

The replaced objects are in `backups/hd1-20261019/` beside `objects/` on every
store: nezopt NVMe `~/data/pokoin-leftovers/`, the 15T copy
`~/mnt/mybook/pokoin-pi-card-images/`, and the Pi `/srv/pokoin/card-images/`.
Copy them back (`rsync -a backups/hd1-20261019/ objects/`) and change the `hd1`
token to a new one, so caches refetch.
