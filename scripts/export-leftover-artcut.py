#!/usr/bin/env python3
"""Export searchbar illustration crops from leftover JPEGs on nezopt.

Source: nezopt NVMe leftover JPEGs (full card, not _homepage.webp).
Output: sibling artcut/ JPEGs for CLIP / version matching.

Never writes into objects/. Never _art.webp. SPA tiles stay full-card.
Rectangle: market/src/art-cut.js POKEMON_ART_CUT.

  /home/nez/Projects/BattleScan/.venv/bin/python \\
    scripts/export-leftover-artcut.py
"""
from __future__ import annotations

import argparse
import os
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

# Same fractions as market/src/art-cut.js
ART_CUT = (0.08, 0.125, 0.84, 0.36)
REPLICA = Path(
    os.environ.get("POKOIN_NVME_LEFTOVERS", "/home/nez/data/pokoin-leftovers")
)
OBJECTS = REPLICA / "objects"
ARTCUT = REPLICA / "artcut"
JPEG_QUALITY = 92


def leftover_jpegs(root: Path) -> list[Path]:
    out = []
    if not root.is_dir():
        return out
    for path in root.iterdir():
        if not path.is_file():
            continue
        name = path.name.lower()
        if "_homepage" in name:
            continue
        if name.endswith(".jpg") or name.endswith(".jpeg"):
            out.append(path)
    return out


def crop_one(src_s: str, dst_s: str) -> str:
    src = Path(src_s)
    dst = Path(dst_s)
    try:
        if dst.is_file() and dst.stat().st_size > 0:
            if dst.stat().st_mtime >= src.stat().st_mtime:
                return "skip"
        image = Image.open(src).convert("RGB")
        width, height = image.size
        left, top, width_f, height_f = ART_CUT
        crop = image.crop(
            (
                int(width * left),
                int(height * top),
                int(width * (left + width_f)),
                int(height * (top + height_f)),
            )
        )
        tmp = dst.with_name(dst.name + ".tmp")
        crop.save(tmp, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        tmp.replace(dst)
        return "ok"
    except Exception as exc:
        return f"err:{exc}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--objects", type=Path, default=OBJECTS)
    parser.add_argument("--out", type=Path, default=ARTCUT)
    parser.add_argument(
        "--workers",
        type=int,
        default=os.cpu_count() or 8,
        help="process pool size (default: all CPUs)",
    )
    args = parser.parse_args()
    sources = leftover_jpegs(args.objects)
    if not sources:
        print(f"no leftover JPEGs in {args.objects}", file=sys.stderr)
        return 1
    args.out.mkdir(parents=True, exist_ok=True)
    jobs = [(str(src), str(args.out / src.name)) for src in sources]
    workers = max(1, args.workers)
    print(
        f"leftover {len(jobs)} · workers {workers} · out {args.out}",
        flush=True,
    )
    ok = skip = err = 0
    done = 0
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(crop_one, src, dst) for src, dst in jobs]
        for future in as_completed(futures):
            result = future.result()
            done += 1
            if result == "ok":
                ok += 1
            elif result == "skip":
                skip += 1
            else:
                err += 1
                if err <= 20:
                    print(result, file=sys.stderr, flush=True)
            if done % 2000 == 0 or done == len(jobs):
                print(
                    f"  {done}/{len(jobs)} ok={ok} skip={skip} err={err}",
                    flush=True,
                )
    print(f"done ok={ok} skip={skip} err={err}", flush=True)
    return 1 if err and not ok else 0


if __name__ == "__main__":
    raise SystemExit(main())
