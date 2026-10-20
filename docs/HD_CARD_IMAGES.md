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
`_homepage.webp` at 240 px wide (480 px since 2026-10-20), q82, the same as `scripts/ingest-missing-product-images.py`.

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

## Derived previews (`tools/preview-regen`)

The desk, zoom, promo fan, album crops (CSS), og:image and JSON-LD all use the
master JPEG. Every grid tile and the suggest thumb + illustration crop use the
`_homepage.webp` sibling (480 px, q82, since 2026-10-20; was 240 px). `objects/previews/{stem}.webp` (96 px) is
legacy and is not used by Pokémon tiles. `artcut/` crops are CLIP-only (nezopt).
A thumb must be its master, downscaled.

```bash
cd tools/preview-regen && CARGO_TARGET_DIR=~/tmp/hd-card-images/target cargo build --release
B=~/tmp/hd-card-images/target/release/preview-regen
$B audit --objects ~/data/pokoin-leftovers/objects --previews ~/data/pokoin-leftovers/objects/previews \
  --visual --out audit.tsv          # ~2 min for 88k masters, read-only
$B encode --objects ~/data/pokoin-leftovers/objects --keys keys.txt --out stage --width 240
```

`audit` flags `home_mismatch` when the thumb is not a picture of its master
(48×67 grey NCC < 0.90 whole or < 0.85 artwork), `home_older`, `no_home`,
`home_width`, `small_master` (< 240 px). `encode` writes to a staging directory only.
Landscape masters (55 XY BREAK `full-v4` at 1024×734) are skipped: their thumbs are
stored rotated for `.is-landscape`.

**Decoder.** `image` 0.25 (zune-jpeg 0.5.15) decodes the hd1 `jpeg-encoder` masters
as a washed-out ghost; libjpeg and browsers read them fine. Rust tools that read CDN
JPEGs must decode them with `jpeg-decoder` (as `preview-regen` does). The first
audit run with `image` reported 11,412 false mismatches.

### 480 px thumbs, token t480 (20 October 2026)

All Pokémon `_homepage.webp` were rebuilt from their masters at 480 px wide (q82,
mean ~47 KB; was 240 px, ~19 KB) because 240 px tiles were upscaled on 2× screens
(155 CSS px tiles = 310 device px). Each store got the thumb of **its own** master:
the stores had drifted (5,420 masters differ between the nezopt NVMe mirror and the
Pi; the 15T copy follows the Pi), so Pi and 15T thumbs for those keys come from the
Pi master. 931 old thumbs were another picture than their master (189 grey
CardTrader placeholders over real scans, ~430 other variants); all fixed by the
rebuild. The 55 landscape BREAK masters kept their rotated thumbs.

- Written: NVMe 88,713, 15T 85,754, Pi 88,705 thumbs, plus Wigglytuff 13/100
  (`114719`, token `wg1`: the stamped reverse-holo scan replaced by the Holo Rare from
  pokemontcg.io `ex14/13_hires.png`, 591×825) on every store.
- Old files: `backups/thumbs480-20261020/` beside `objects/` on each store.
- Cache: `thumbToken` `t480` in `catalog-image-cache.json`. `withThumbToken` /
  `withoutThumbToken` (`image-urls.js`, mirrored in `desk_art.rs`) give thumbs
  `v=<id token>.t480` and strip it again when a thumb URL becomes its JPEG, so the
  desk JPEG URL is unchanged. `index.html` landing thumbs carry the same tokens.
- New thumbs: `scripts/ingest-missing-product-images.py` and `tools/hd-scan-upgrade`
  now write 480 px.
- Rollback: copy `backups/thumbs480-20261020/` back over `objects/` on each store and
  change `thumbToken`.
- Open: the 5,420 drifted masters themselves (which store holds the right scan; some
  Pi copies of WOTC prints may be 1st Edition) — not changed here.
