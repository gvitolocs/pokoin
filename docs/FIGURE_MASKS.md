# Figure masks (Qwen boxes → SAM2 silhouettes)

The artist-album hover lifts the painted Pokémon out of the card: the SPA
scales a masked duplicate of the artwork while the original painting stays
still. One lossless WebP alpha mask per CLIP `version` lives on the Pi CDN at
`/card-images/figure-masks/{version}.webp`. The mask is a **silhouette**, never
a rectangle; Qwen boxes are only SAM prompts and never reach the UI.

## Pipeline

| Stage | Script | Output |
| --- | --- | --- |
| Ground visible figures once per CLIP artwork | `scripts/qwen-artwork-figures.py` (Qwen3-VL via Ollama `:11434` on nezopt) | `scripts/out/qwen-artwork-figures.jsonl` (resumable; rows keyed by `version`) |
| Boxes → alpha masks | `scripts/build-artwork-figure-masks.py` (transformers `Sam2Model`, `facebook/sam2.1-hiera-small`, ROCm CUDA) | `/home/nez/data/pokoin-leftovers/figure-masks/{version}.webp` |
| Quality gate | `scripts/qa-figure-masks.py` | `scripts/out/figure-masks-qa.jsonl` + `figure-masks-pass.txt` |
| Retro-clean pre-cleanup masks | `scripts/clean-figure-masks.py` | `/home/nez/data/pokoin-leftovers/figure-masks-clean/` |
| Upload loop | `scripts/upload-figure-masks-loop.sh` (rsync pass-list while the builder runs) | `pi-home:/srv/pokoin/card-images/objects/figure-masks/` |

The SPA resolves the URL in `market/src/art-figure-mask.js`
(`FIGURE_MASK_REV` cache-busts, currently `sam21-1`) and consumes it in
`solid/src/components/CardArt.jsx` as the album-cut hover layer. The review
page is `solid/src/pages/ArtworkHover.jsx`.

## The artifact problem (2026-09-16)

Two visible defects on certain cards, both reported on the album hover:

1. **Silhouettes empty inside in spots** — interior holes. SAM follows the
   painted background through translucent bodies (Lampent / Chandelure glass,
   Ghost-type wisps) and through holofoil windows, so the mask has lakes of
   transparency inside the creature.
2. **Granular glitch specks** — tiny disconnected island components and ragged
   jaggies along the silhouette edge, mostly on holo / textured scans where
   the foil pattern out-contrasts the creature outline.

Measured on every 10th painted mask (933 of the 10,276 built so far):

| Statistic | Value |
| --- | --- |
| Masks with ≥1% of silhouette area as interior holes | **333 (35.7%)** |
| Masks with any speck component (<50 px) | **670 (71.8%)** |
| Hole area of mask: median / p90 / max | 0.44% / 3.87% / 58.2% |
| Speck count: median / p90 / max | 4 / 76 / 627 |

Worked examples from the report (both currently **pass** QA and are live on
the CDN):

- `v249112` Lampent 42/119 Phantom Forces — holes are 3.1% of the mask
  (translucent glass body), 7 components with 6 tiny specks.
- `v249116` Chandelure 43/119 Phantom Forces holo — holes 4.3%, **56
  components, 50 of them <50 px** (foil speckle).

## Root cause

**The transformers port never fills holes or removes islands.** Upstream
`facebookresearch/sam2` runs `fill_holes_in_mask_scores` inside the image
predictor — background connected components with area ≤ `fill_hole_area`
(default 8, set by the `++model.fill_hole_area=8` hydra override in
`build_sam.py`) get flooded foreground. `transformers.Sam2Model` — what
`build-artwork-figure-masks.py` imports — ships **no such post-processing**
(in transformers only `sam3_video` has `fill_hole_area`). Our builder takes
SAM's best-IoU candidate per box (`multimask_output=True`), unions across
boxes, and writes the WebP directly: no morphology, no component filter, no
hole fill.

**The QA gate cannot see either defect.** `qa-figure-masks.py` checks
coverage, bleed, and box fill only. A mask full of holes and specks passes as
long as the aggregate numbers sit in range — so the artifacts upload.

**Translucent / foil subjects are the trigger.** This is the documented SAM
failure mode on transparent and mirror surfaces (see references below):
background visible through the body breaks SAM's grouping, and specular foil
texture spawns false-positive fragments.

## Cleanup (applied 2026-09-16, on test only)

`build-artwork-figure-masks.py` now runs `clean_mask` on every union before
`write_mask` (opt out with `--no-clean`):

- one 3×3 binary closing to settle jaggies (padded first — scipy erodes with
  `border_value=0`, which would eat silhouettes touching the image edge),
- drop connected components under `max(32 px, 0.2% of the largest component)`
  so specks die and real second figures / cameos survive,
- fill interior background components up to 5% of the mask area, so Lampent
  glass lakes close while genuinely open silhouettes keep their gaps.

`scripts/qa-figure-masks.py` grew the matching gate checks: `holes`
(`--max-hole-ratio`, default 0.02) and `specks` (`--max-specks`, default 0).

`scripts/clean-figure-masks.py` retro-cleaned the already-built 10,276 masks
into `figure-masks-clean/` without re-running SAM (about 45 s, 8 workers).
Gate results over the same rows:

| Check | Before (raw SAM) | After (cleaned) |
| --- | --- | --- |
| fail specks | 6597 | 94 |
| fail holes | 1948 | 415 |
| fail coverage / fill (real SAM misses, untouched) | 1335 / 1103 | 1351 / 1102 |

Showcase versions after cleaning: Lampent `v249112` holes 3.1% → 0,
Chandelure `v249116` specks 50 → 0, Noivern GX `v224472` specks 579 → 0.
Gyarados GX `v226758` keeps one large open gap (over the 5% cap — art gaps
must survive) and stays a QA `holes` fail on purpose.

### Where to see before / after

- **Test board**: `/artwork` on the Solid dev server (`npm run dev` in
  `solid/`) — "Hole and speck cleanup" section
  renders each card twice, wearing the raw production mask vs the cleaned
  one, with alpha previews under each pair. `CardArt` takes a `figureMask`
  override prop for this; production cards still resolve
  `artworkFigureMaskSrc` unchanged.
- **CDN**: the cleaned set is rsynced to
  `pi-home:/srv/pokoin/card-images/objects/figure-masks-clean/`, i.e.
  `https://cdn.pokoin.com/figure-masks-clean/{version}.webp`. Production
  `figure-masks/` is untouched.

### Production flip (applied 2026-09-17)

`market/src/art-figure-mask.js` points at `figure-masks-clean/` with
`FIGURE_MASK_REV = 'clean-1'` — fresh URLs, so the one-year immutable CDN
caches never serve the old dirty bytes. The CDN path holds only the QA pass
list (fails are pruned; QA-failing versions simply have no hover layer, same
as before). Production deploys build from GitHub pushes; the flip shipped in
`c84385c`. The remaining versions still grounding through the Qwen job get
clean masks automatically: `scripts/ship-figure-masks-after-qwen.sh` waits
for the job, runs the builder (cleanup baked in) into `figure-masks-clean/`,
re-QAs, and rsyncs the new pass list.

## Same problem, discussed online

- [sam2 #452 — hydra overrides fill_hole_area for post processing](https://github.com/facebookresearch/sam2/issues/452)
  — asks why upstream defaults `fill_hole_area=8`; open, unanswered, but
  confirms the knob exists and only upstream applies it.
- [sam2 `misc.py` — `fill_holes_in_mask_scores`](https://github.com/facebookresearch/sam2/blob/main/sam2/utils/misc.py)
  — the upstream hole fill (background components ≤ max area flooded with
  score 0.1). Skipped entirely when the compiled connected-components kernel
  is missing, which is also what
  [#311](https://github.com/facebookresearch/sam2/issues/311) and
  [#661](https://github.com/facebookresearch/sam2/issues/661) report —
  relevant on non-CUDA builds like ROCm.
- [sam2 #243 — Python version of connected_components](https://github.com/facebookresearch/sam2/issues/243)
  — the kernel is CUDA-only upstream; pure-torch/numpy re-implementations are
  a common request, same gap we hit through transformers.
- [segment-anything `amg.py` — `remove_small_regions`](https://github.com/facebookresearch/segment-anything/blob/main/segment_anything/utils/amg.py)
  — the canonical SAM1 cleanup with `"holes"` and `"islands"` modes, applied
  by `SamAutomaticMaskGenerator.postprocess_small_regions`. The exact
  islands+holes cleanup our builder lacks.
- [transformers — `fill_hole_area` only in `sam3_video`](https://github.com/huggingface/transformers)
  (`src/transformers/models/sam3_video/`); the `sam2` text/web image model
  carries no hole fill, which is how artifacts reach our masks.
- [SAM Meets Glass: Mirror and Transparent Objects Cannot Be Easily Detected (arXiv 2305.00278)](https://arxiv.org/abs/2305.00278)
  — the academic confirmation of the Lampent failure: SAM carves holes on
  transparent bodies and fires on shiny regions (holofoil).
- [RobustSAM (CVPR 2024)](https://cvpr.thecvf.com/virtual/2024/poster/29230)
  — robustness fixes for SAM on degraded images; background option for if
  post-processing is not enough on foil scans.

## Clean-art silhouettes (artofpkm TCG Gallery, 2026-10-20)

Full-art cards print their attack text, HP and rule bars on top of the
painting, so SAM on the leftover scan cut bites and holes where text crossed
the Pokémon. artofpkm's catalog 668 ("TCG Gallery", the 2022 Pokémon TCG
Online Illustration Exhibition) has the same paintings without card text. For
100 full-art versions the album hover now uses a silhouette cut from that
clean painting, registered onto the same scan.

### Data

| Step | Tool | Output (nezopt, 15T) |
| --- | --- | --- |
| Dump catalog 668 | `tools/artofpkm-catalog` (Rust; 2 s between requests, resumable, robots-clean URLs, reuses the 2026-10-16 archive by SHA-256) | `/home/nez/mnt/mybook/datasets/tcg/artofpkm/catalog668-20261020/` (`artworks.jsonl`, `catalog.jsonl`, `assets/`, `html/`, `metadata/`, `progress.json`) |
| CLIP art-box vectors of the clean art | `scripts/embed-clean-artworks.py` (open_clip ViT-B-32 laion2b, same space as `artbox-clip.npz`) | `…/match/clean-clip.npy` |
| Match to versions | `tools/clean-art-match match` (Rust) | `…/match/match.jsonl`, `match-summary.json`, `review/` |

The dump holds 521 artworks and 599 full-resolution images (918×1280 card-sized
paintings, or the ~1106×696 window painting), plus each artwork's linked card
pages (set, collector number, illustrator). Only 22 requests went to the site;
the rest were copied from `full-20261016` after a hash check.

### Matching

CLIP art-box kNN (top 40 printings) and name + collector-number candidates
propose versions. Each is verified by registering the clean painting onto the
scan its mask is drawn on (the Qwen `image_key`) with the scanner's pure-Rust
ORB + RANSAC homography (`pokoin-scanner/native/artwork_matcher`). Verified =
a near-rectangular homography (upright, ≤15% keystone, no shear), at least 25
inliers inside the painting interior, and NCC ≥ 0.35 after warping (or ≥ 0.2
with ≥ 100 interior inliers on foil recolours). Interior-only evidence matters:
the portrait clean art of V/GX cards keeps the card frame, which otherwise
matches any card with that frame. A verified version with a different name
needs ≥ 60 interior inliers and NCC ≥ 0.6 (art reused under another name).

Result: 491 artworks matched (568 artwork–version pairs, 563 versions),
9 ambiguous, 21 unmatched (V-UNION pieces, cards missing from the catalogue,
tiny scans). A hand-checked sample of 81 pairs (40 random, all 35 with < 60
interior inliers, all 6 name mismatches) was 81/81 correct.

### Masks

SAM on the bare clean painting fails: the Qwen boxes span the whole picture
and SAM returns a part (one Unown, Electrode's white half). So:

1. `clean-art-match composite` paints the clean art over the scan, upscaled to
   ~1024 px tall: same framing and boxes as the scan builder, no card text.
2. `scripts/build-clean-art-figure-masks.py --select guided` runs the same SAM
   2.1 + `clean_mask`, but per box picks the candidate that best matches the
   production mask inside the box (granularity from production, edges from the
   clean painting).
3. `clean-art-match warp --ui-clip-objects …` downsamples to the scan, cuts
   solid card UI the body runs under (GX / attack bars, ability boxes: large
   regions where scan ≠ clean painting after an opening + closing; enclosed
   icons such as energy costs stay), and drops specks.
4. `scripts/qa-figure-masks.py`, and `clean-art-match compare` for IoU vs
   production plus before/after images.

Window-art cards keep their scan masks: their text never overlaps the
painting, and the new masks were no better there. Full-art versions ship when
they pass QA (or fail only `holes` and pass visual review, as in the 2026-09-17
salvage) and keep IoU ≥ 0.5 with production. That gives 100 versions: 94
replace a production mask, and 6 had no hover before (their scan masks failed
QA: Charizard VMAX, Zoroark GX, Rayquaza GX, …). Per-version decisions are in
`…/match/mask-decisions.jsonl`.

### Serving

The 100 masks live in `figure-masks-artofpkm/{version}.webp` on both CDN
origins (Pi `/srv/pokoin/card-images/objects/` and the nezopt mirror
`~/data/pokoin-leftovers/objects/`), in the same scan frame as
`figure-masks-clean/`. `market/src/figure-masks-artofpkm.js` lists the
versions; `artworkFigureMaskSrc` sends those to the new directory with rev
`artofpkm-1`. Nothing in `figure-masks-clean/` is overwritten, so removing a
version from the list reverts it. Upload the directory to both origins before
deploying the SPA change, or those 100 tiles lose their hover. The `/artwork`
board has a "Clean-art silhouettes" section; in dev,
`VITE_ARTOFPKM_MASK_BASE=/_review/figure-masks-artofpkm` (with the files in
`market/public/_review/`) shows unpublished masks.

### Known limits

- The hover duplicate is still the scan, so text printed over the body lifts
  with it. Lifting the clean painting itself would remove that.
- A mask is per CLIP version, drawn on one representative scan. Other
  printings of the version sit a median 1.2% of the card off that frame (p90
  3.8%, 46 of 1,297 over 5%, measured by registering the clean art on each
  printing). Per-printing masks would fix it.
