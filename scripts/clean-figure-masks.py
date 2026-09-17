#!/usr/bin/env python3
"""Retro-clean already-built SAM figure masks into a parallel directory.

Reads every WebP in ``figure-masks`` and writes the ``clean_mask`` result to
``figure-masks-clean``, so the before/after sets can be reviewed and uploaded
without re-running SAM inference.  The builder now cleans on write; this job
only exists for masks produced before that change.
"""
from __future__ import annotations

import argparse
import importlib.util
import multiprocessing as mp
from pathlib import Path

import numpy as np
from PIL import Image

BUILDER = Path(__file__).with_name("build-artwork-figure-masks.py")

SRC: Path | None = None
OUT: Path | None = None
BUILDER_MOD = None


def load_builder():
    spec = importlib.util.spec_from_file_location("build_artwork_figure_masks", BUILDER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def clean_one(name: str) -> tuple[str, bool]:
    try:
        with Image.open(SRC / name) as image:
            alpha = np.asarray(image.getchannel("A")) > 0
        BUILDER_MOD.write_mask(BUILDER_MOD.clean_mask(alpha), OUT / name)
        return name, True
    except Exception:  # noqa: BLE001 - leave the source untouched on any failure
        return name, False


def main() -> int:
    global SRC, OUT, BUILDER_MOD
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", type=Path, default=None, help="default: leftovers/figure-masks")
    parser.add_argument("--out", type=Path, default=None, help="default: leftovers/figure-masks-clean")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    BUILDER_MOD = load_builder()
    SRC = args.src or (BUILDER_MOD.REPLICA / "figure-masks")
    OUT = args.out or (BUILDER_MOD.REPLICA / "figure-masks-clean")
    OUT.mkdir(parents=True, exist_ok=True)

    jobs = [
        path.name
        for path in sorted(SRC.glob("*.webp"))
        if not (OUT / path.name).is_file() or not (OUT / path.name).stat().st_size
    ]
    print(f"{len(jobs)} masks to clean -> {OUT}", flush=True)

    done = failed = 0
    with mp.Pool(args.workers) as pool:
        for _, ok in pool.imap_unordered(clean_one, jobs, chunksize=16):
            done += 1
            failed += 0 if ok else 1
            if done % 1000 == 0 or done == len(jobs):
                print(f"{done}/{len(jobs)} failed={failed}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
