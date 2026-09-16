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
| Upload loop | `scripts/upload-figure-masks-loop.sh` (rsync pass-list while the builder runs) | `pi-home:/srv/pokoin/card-images/objects/figure-masks/` |

The SPA resolves the URL in `market/src/art-figure-mask.js`
(`FIGURE_MASK_REV` cache-busts, currently `sam21-1`) and consumes it in
`market/src/components/CardArt.jsx` as the album-cut hover layer. The review
page is `market/src/pages/ArtworkHover.jsx`.

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

## Planned cleanup (not yet applied)

1. Post-process in `build-artwork-figure-masks.py` before `write_mask`:
   `scipy.ndimage.binary_fill_holes` (with a small hole-area cap so
   genuinely open silhouettes keep their gaps), drop connected components
   under an area floor relative to the largest component, optional
   binary-closing to calm jaggies.
2. Extend `qa-figure-masks.py` with the same two checks so the gate fails
   holey / speckled masks instead of shipping them: `hole_ratio` max and a
   speck-component count max.
3. Rebuild (`--out` is resumable; delete touched masks or rebuild all), then
   bump `FIGURE_MASK_REV` in `market/src/art-figure-mask.js` (e.g.
   `sam21-2-clean`) so browsers drop the cached artifacts.
4. Delete the shipped-but-failing masks from the CDN pass-list flow — the
   upload loop only ever rsyncs the QA pass-list, so a stricter gate plus a
   rebuilt pass list self-corrects on the next loop tick.

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
