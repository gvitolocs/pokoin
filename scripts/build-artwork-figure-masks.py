#!/usr/bin/env python3
"""Turn reviewed Qwen boxes into silhouette alpha masks with SAM2.

The output is one lossless WebP per CLIP artwork version.  It is transparent
outside the Pokemon silhouettes, so the SPA can scale a masked duplicate of
the card art while leaving the original painting still.  Qwen boxes are only
prompts and never appear in the UI.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from transformers import Sam2Model, Sam2Processor

REPLICA = Path(os.environ.get("POKOIN_NVME_LEFTOVERS", "/home/nez/data/pokoin-leftovers"))
OBJECTS = REPLICA / "objects"
OUT = REPLICA / "figure-masks"
MODEL = os.environ.get("POKOIN_SAM2_MODEL", "facebook/sam2.1-hiera-small")


def safe_version(value: str) -> str:
    version = str(value or "")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", version):
        raise ValueError(f"unsafe version {version!r}")
    return version


def pixel_boxes(figures: list[dict], width: int, height: int) -> list[list[float]]:
    boxes = []
    for figure in figures or []:
        x1, y1, x2, y2 = figure["box"]
        boxes.append([
            x1 * width / 1000, y1 * height / 1000,
            x2 * width / 1000, y2 * height / 1000,
        ])
    return boxes


def box_iou(left: list[int], right: list[int]) -> float:
    x1 = max(left[0], right[0])
    y1 = max(left[1], right[1])
    x2 = min(left[2], right[2])
    y2 = min(left[3], right[3])
    intersection = max(0, x2 - x1) * max(0, y2 - y1)
    left_area = (left[2] - left[0]) * (left[3] - left[1])
    right_area = (right[2] - right[0]) * (right[3] - right[1])
    union = left_area + right_area - intersection
    return intersection / union if union else 0.0


def sanitize_figures(figures: list[dict]) -> list[dict]:
    """Remove card-UI thumbnails and duplicate prompts before SAM.

    Evolution-stage thumbnails occupy a small, fixed area above the artwork in
    the upper-left name bar. Qwen occasionally labels those icons as cameos.
    """
    cleaned = []
    for figure in figures or []:
        box = figure.get("box")
        if not isinstance(box, list) or len(box) != 4:
            continue
        x1, y1, x2, y2 = box
        is_evolution_thumbnail = (
            x2 <= 250 and y2 <= 190 and (x2 - x1) <= 200 and (y2 - y1) <= 150
        )
        if is_evolution_thumbnail:
            continue
        if any(box_iou(box, prior["box"]) >= 0.85 for prior in cleaned):
            continue
        cleaned.append(figure)
    return cleaned


def load_rows(path: Path) -> list[dict]:
    rows = {}
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if not row.get("error"):
            row = dict(row)
            row["figures"] = sanitize_figures(row.get("figures") or [])
            rows[str(row["version"])] = row
    return list(rows.values())


def union_best_masks(masks: torch.Tensor, scores: torch.Tensor) -> np.ndarray:
    """Pick SAM's best candidate for each Qwen box and union the silhouettes."""
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
        candidate = int(torch.argmax(scores[min(index, scores.shape[0] - 1)]))
        union |= masks[index, candidate] > 0
    return union.numpy()


def write_mask(mask: np.ndarray, path: Path) -> None:
    alpha = Image.fromarray(mask.astype(np.uint8) * 255, mode="L")
    rgba = Image.new("RGBA", alpha.size, (255, 255, 255, 0))
    rgba.putalpha(alpha)
    tmp = path.with_suffix(path.suffix + ".tmp")
    rgba.save(tmp, format="WEBP", lossless=True, method=6)
    tmp.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jsonl", type=Path, default=Path("/tmp/qwen-artwork-figures.jsonl"))
    parser.add_argument("--objects", type=Path, default=OBJECTS)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    rows = load_rows(args.jsonl)
    if args.limit:
        rows = rows[: max(0, args.limit)]
    args.out.mkdir(parents=True, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    processor = Sam2Processor.from_pretrained(MODEL)
    model = Sam2Model.from_pretrained(MODEL).to(device).eval()
    print(f"rows {len(rows)} model={MODEL} device={device}", flush=True)

    with torch.inference_mode():
        for index, row in enumerate(rows, start=1):
            version = safe_version(row["version"])
            dest = args.out / f"{version}.webp"
            if dest.is_file() and dest.stat().st_size:
                continue
            source = args.objects / row["image_key"]
            with Image.open(source) as image:
                rgb = image.convert("RGB")
            boxes = pixel_boxes(row.get("figures") or [], *rgb.size)
            if not boxes:
                write_mask(np.zeros((rgb.height, rgb.width), dtype=bool), dest)
                continue
            inputs = processor(images=rgb, input_boxes=[boxes], return_tensors="pt")
            inputs = {key: value.to(device) if hasattr(value, "to") else value for key, value in inputs.items()}
            outputs = model(**inputs, multimask_output=True)
            masks = processor.post_process_masks(
                outputs.pred_masks.cpu(), inputs["original_sizes"].cpu()
            )[0]
            write_mask(union_best_masks(masks, outputs.iou_scores), dest)
            print(f"{index}/{len(rows)} {version} figures={len(boxes)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
