#!/usr/bin/env python3
"""SAM2 silhouettes on artofpkm clean artworks (no card text), in clean pixels.

Input is the prompts JSONL from ``tools/clean-art-match prompts``: per CLIP
version, the clean painting, the clean→scan homography and the version's Qwen
boxes mapped into clean-art pixels.  The SAM call, the per-box best-candidate
union and ``clean_mask`` are the ones ``build-artwork-figure-masks.py`` uses on
the leftover scan; only the picture changes, so card text no longer cuts into
the silhouette.  Output is ``OUT/{version}.png`` (8-bit alpha, clean-art size);
``clean-art-match warp`` carries it into the scan frame the SPA overlays.

  gpu-lease run --name clean-art-sam --mb 4096 -- \
    /home/nez/Projects/ai-toolkit/venv/bin/python scripts/build-clean-art-figure-masks.py \
    --prompts prompts.jsonl --dump DUMP --out OUT
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from transformers import Sam2Model, Sam2Processor

_spec = importlib.util.spec_from_file_location(
    "build_artwork_figure_masks", Path(__file__).with_name("build-artwork-figure-masks.py")
)
_builder = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_builder)
clean_mask = _builder.clean_mask
sanitize_figures = _builder.sanitize_figures
safe_version = _builder.safe_version
union_best_masks = _builder.union_best_masks
MODEL = _builder.MODEL


def union_largest_masks(masks: torch.Tensor, scores: torch.Tensor, slack: float) -> np.ndarray:
    """Per box, the largest SAM candidate scoring within ``slack`` of the best.

    SAM's three multimask outputs are roughly sub-part / part / whole. On the
    clean painting the best-scored one is often a part (Honchkrow's wing, half
    of Electrode), so prefer the widest candidate SAM is still confident about.
    """
    masks = masks.detach().cpu()
    scores = scores.detach().cpu()
    while masks.ndim > 4:
        masks = masks[0]
    while scores.ndim > 2:
        scores = scores[0]
    if masks.ndim == 3:
        masks = masks.unsqueeze(0)
    if scores.ndim == 1:
        scores = scores.unsqueeze(0)
    union = torch.zeros(masks.shape[-2:], dtype=torch.bool)
    for index in range(masks.shape[0]):
        s = scores[min(index, scores.shape[0] - 1)]
        ok = [k for k in range(masks.shape[1]) if float(s[k]) >= float(s.max()) - slack]
        pick = max(ok, key=lambda k: int((masks[index, k] > 0).sum()))
        union |= masks[index, pick] > 0
    return union.numpy()


def union_guided_masks(masks: torch.Tensor, boxes: list, guide: np.ndarray) -> np.ndarray:
    """Per box, the SAM candidate that best agrees with the production mask.

    The production silhouette (cut on the scan) knows the right granularity --
    whole Crobat, both Unown -- but its edges follow card text. Comparing inside
    each box picks that granularity; the chosen candidate's edges come from the
    clean painting.
    """
    masks = masks.detach().cpu()
    while masks.ndim > 4:
        masks = masks[0]
    if masks.ndim == 3:
        masks = masks.unsqueeze(0)
    union = np.zeros(masks.shape[-2:], dtype=bool)
    for index in range(masks.shape[0]):
        x1, y1, x2, y2 = [int(round(v)) for v in boxes[min(index, len(boxes) - 1)]]
        g = guide[y1:y2, x1:x2]
        best, pick = -1.0, 0
        for k in range(masks.shape[1]):
            c = (masks[index, k] > 0).numpy()[y1:y2, x1:x2]
            u = float((c | g).sum())
            iou = float((c & g).sum()) / u if u else 0.0
            if iou > best:
                best, pick = iou, k
        union |= (masks[index, pick] > 0).numpy()
    return union


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--prompts", type=Path, required=True)
    ap.add_argument("--dump", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--select", choices=["guided", "best", "largest", "single"], default="guided",
                    help="guided: candidate closest to the production mask (falls back to best); best: SAM's top-scored "
                         "candidate (scan builder); largest: widest within --slack; single: multimask off")
    ap.add_argument("--guide", type=Path, default=Path("/home/nez/data/pokoin-leftovers/objects/figure-masks-clean"),
                    help="production masks ({version}.webp, scan frame) for --select guided")
    ap.add_argument("--slack", type=float, default=0.15)
    ap.add_argument("--only", type=Path, help="file of versions to build (review subsets)")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    rows = [json.loads(line) for line in args.prompts.read_text().splitlines() if line.strip()]
    if args.only:
        wanted = set(args.only.read_text().split())
        rows = [r for r in rows if r["version"] in wanted]
    if args.limit:
        rows = rows[: args.limit]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    processor = Sam2Processor.from_pretrained(MODEL)
    model = Sam2Model.from_pretrained(MODEL).to(device).eval()
    print(f"rows {len(rows)} model={MODEL} device={device}", flush=True)
    with torch.inference_mode():
        for index, row in enumerate(rows, start=1):
            version = safe_version(row["version"])
            dest = args.out / f"{version}.png"
            if dest.is_file() and dest.stat().st_size:
                continue
            # Same prompt hygiene as the scan builder, judged on the card-frame boxes.
            kept = {json.dumps(f["box"]) for f in sanitize_figures([{"box": f["box"]} for f in row["figures"]])}
            boxes = [f["box_clean_px"] for f in row["figures"] if json.dumps(f["box"]) in kept]
            if not boxes:
                continue
            with Image.open(args.dump / row["clean_asset"]) as image:
                rgb = image.convert("RGB")
            inputs = processor(images=rgb, input_boxes=[boxes], return_tensors="pt")
            inputs = {k: v.to(device) if hasattr(v, "to") else v for k, v in inputs.items()}
            outputs = model(**inputs, multimask_output=args.select != "single")
            masks = processor.post_process_masks(outputs.pred_masks.cpu(), inputs["original_sizes"].cpu())[0]
            guide_path = args.guide / f"{version}.webp"
            if args.select == "guided" and guide_path.is_file():
                with Image.open(guide_path) as g:
                    alpha = g.getchannel("A").resize(rgb.size, Image.BILINEAR)
                union = union_guided_masks(masks, boxes, np.asarray(alpha) > 127)
            elif args.select == "largest":
                union = union_largest_masks(masks, outputs.iou_scores, args.slack)
            else:
                union = union_best_masks(masks, outputs.iou_scores)
            on = clean_mask(union)
            tmp = dest.with_suffix(".png.tmp")
            Image.fromarray(on.astype(np.uint8) * 255, mode="L").save(tmp, format="PNG")
            tmp.replace(dest)
            print(f"{index}/{len(rows)} {version} figures={len(boxes)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
