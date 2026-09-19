#!/usr/bin/env python3
"""Quality gate for SAM figure masks before they upload to the Pi CDN.

Every successful Qwen row gets its mask inspected. Fully transparent masks
are the expected output for figure-less rows (trainer and Energy art) and
pass as "empty". Painted masks must stay a plausible Pokemon silhouette
relative to the Qwen prompt boxes:

- coverage: alpha pixels over the whole card within [min, max] coverage
  (silhouette, not whole-card blobs, not specks),
- bleed: at most `--max-bleed` of the alpha may fall outside the Qwen
  union box (SAM wandered off the creature),
- fill: at least `--min-fill` of the union box area must be alpha (SAM
  actually found the creature),
- holes: at most `--max-hole-ratio` of the silhouette may be interior
  background lakes (SAM followed the paint through translucent bodies),
- specks: at most `--max-specks` detached islands smaller than 50 px
  (holofoil texture fragments the silhouette).

The gate never edits masks; it only classifies them and writes a JSONL
report plus a file list of passes for `rsync --files-from`.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

BUILDER = Path(__file__).with_name("build-artwork-figure-masks.py")


def load_builder():
    spec = importlib.util.spec_from_file_location("build_artwork_figure_masks", BUILDER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def union_box(row: dict) -> list[int]:
    # Recompute from the sanitized figures. The stored union_box predates the
    # evolution-thumbnail filter, so it can be wider than what SAM was given.
    boxes = [figure["box"] for figure in row.get("figures") or []]
    return [
        min(b[0] for b in boxes), min(b[1] for b in boxes),
        max(b[2] for b in boxes), max(b[3] for b in boxes),
    ]


def mask_metrics(alpha: np.ndarray, row: dict, builder) -> tuple[dict, list[str]]:
    total = float(alpha.size)
    on = alpha > 0
    coverage = float(on.sum()) / total
    reasons: list[str] = []
    metrics = {"coverage": round(coverage, 4)}

    boxes = row.get("figures") or []
    if not boxes:
        if coverage > 0.001:
            reasons.append("empty-row-has-alpha")
        return metrics, reasons

    width, height = alpha.shape[1], alpha.shape[0]
    x1, y1, x2, y2 = union_box(row)
    px = [
        x1 * width / 1000, y1 * height / 1000,
        x2 * width / 1000, y2 * height / 1000,
    ]
    ix1, iy1, ix2, iy2 = [int(round(v)) for v in px]
    ix2, iy2 = max(ix2, ix1 + 1), max(iy2, iy1 + 1)

    inside = on[iy1:iy2, ix1:ix2]
    box_area = float((iy2 - iy1) * (ix2 - ix1))
    fill = float(inside.sum()) / box_area
    bleed = float(on.sum() - inside.sum()) / max(float(on.sum()), 1.0)
    metrics["fill"] = round(fill, 4)
    metrics["bleed"] = round(bleed, 4)

    on_area = max(float(on.sum()), 1.0)
    filled = ndimage.binary_fill_holes(on)
    metrics["holes"] = round(float((filled & ~on).sum()) / on_area, 4)
    structure = np.ones((3, 3), dtype=int)
    labels, count = ndimage.label(on, structure=structure)
    if count:
        sizes = np.bincount(labels.ravel())[1:]
        metrics["specks"] = int((sizes < 50).sum())
    return metrics, reasons


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jsonl", type=Path, required=True)
    parser.add_argument("--masks", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--pass-list", type=Path, required=True)
    parser.add_argument("--min-coverage", type=float, default=0.005)
    parser.add_argument("--max-coverage", type=float, default=0.55)
    parser.add_argument("--max-bleed", type=float, default=0.35)
    parser.add_argument("--min-fill", type=float, default=0.08)
    parser.add_argument("--max-hole-ratio", type=float, default=0.02)
    parser.add_argument("--max-specks", type=int, default=0)
    parser.add_argument(
        "--placeholders",
        type=Path,
        default=Path(__file__).with_name("out") / "placeholder-artwork-versions.txt",
        help="versions whose leftover scan is a CardTrader placeholder, never a painting",
    )
    args = parser.parse_args()

    # CardTrader ships one generic placeholder image for cards it has no scan of.
    # SAM happily segments its logo, so those masks must never reach the CDN.
    placeholders = set()
    if args.placeholders and args.placeholders.is_file():
        placeholders = {
            line.strip()
            for line in args.placeholders.read_text(encoding="utf-8").splitlines()
            if line.strip()
        }
        print(f"placeholder artworks excluded: {len(placeholders)}", flush=True)

    builder = load_builder()
    rows = builder.load_rows(args.jsonl)
    print(f"rows {len(rows)} masks-dir {args.masks}", flush=True)

    args.report.parent.mkdir(parents=True, exist_ok=True)
    passed: list[str] = []
    fails: dict[str, int] = {}
    with args.report.open("w", encoding="utf-8") as report:
        for row in rows:
            version = builder.safe_version(row["version"])
            path = args.masks / f"{version}.webp"
            verdict = {"version": version, "pass": False}
            if version in placeholders:
                verdict["reasons"] = ["placeholder-scan"]
                verdict["pass"] = False
                fails["placeholder-scan"] = fails.get("placeholder-scan", 0) + 1
                report.write(json.dumps(verdict) + "\n")
                continue
            if not path.is_file() or not path.stat().st_size:
                verdict["reasons"] = ["missing"]
            else:
                try:
                    with Image.open(path) as image:
                        alpha = np.asarray(image.getchannel("A"))
                    metrics, reasons = mask_metrics(alpha, row, builder)
                    coverage = metrics.get("coverage", 0.0)
                    if "empty-row-has-alpha" not in reasons:
                        if not (args.min_coverage <= coverage <= args.max_coverage):
                            reasons.append("coverage")
                        if metrics.get("bleed", 0.0) > args.max_bleed:
                            reasons.append("bleed")
                        if metrics.get("fill", 0.0) < args.min_fill:
                            reasons.append("fill")
                        if metrics.get("holes", 0.0) > args.max_hole_ratio:
                            reasons.append("holes")
                        if metrics.get("specks", 0) > args.max_specks:
                            reasons.append("specks")
                    verdict.update(metrics)
                    verdict["reasons"] = reasons
                except Exception as exc:  # noqa: BLE001 - any decode failure fails the mask
                    verdict["reasons"] = [f"decode:{type(exc).__name__}"]
            verdict["pass"] = not verdict.get("reasons")
            if verdict["pass"]:
                passed.append(f"{version}.webp")
            else:
                for reason in verdict["reasons"]:
                    fails[reason] = fails.get(reason, 0) + 1
            report.write(json.dumps(verdict) + "\n")

    args.pass_list.parent.mkdir(parents=True, exist_ok=True)
    args.pass_list.write_text("\n".join(passed) + ("\n" if passed else ""))
    print(f"pass {len(passed)} / {len(rows)}")
    for reason, count in sorted(fails.items(), key=lambda kv: -kv[1]):
        print(f"  fail {reason}: {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
