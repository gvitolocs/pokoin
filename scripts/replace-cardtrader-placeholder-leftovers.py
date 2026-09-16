#!/usr/bin/env python3
"""Stamp Pokoin missing-card onto leftover JPEGs that are CardTrader's 186×260 back.

CDN leftover keys stay `{ct_id}_{slug}.jpg`. Output is 63:88 so CardArt does
not treat them as card_uploader. Homepage webp is rewritten beside the JPEG.
Does not CLIP-encode these — the coin would glue every missing scan together.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MISSING = ROOT / "home" / "missing-card.webp"
REPLICA = Path(
    os.environ.get("POKOIN_NVME_LEFTOVERS", "/home/nez/data/pokoin-leftovers")
) / "objects"
HOST = "pi-home"
PI_OBJECTS = "/srv/pokoin/card-images/objects"
WIDTH, HEIGHT = 630, 880
CT_SIZE = (186, 260)
CT_BYTES = 7920
CACHE = "pkph1"
IDS_JS = ROOT / "market" / "src" / "data" / "pokoin-placeholder-leftovers.js"


def is_cardtrader_back(path: Path) -> bool:
    if path.stat().st_size != CT_BYTES:
        return False
    try:
        with Image.open(path) as image:
            return image.size == CT_SIZE
    except Exception:
        return False


def pokoin_card() -> Image.Image:
    src = Image.open(MISSING).convert("RGB")
    return src.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)


def write_leftover(dest: Path, card: Image.Image) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    card.save(dest, "JPEG", quality=92, optimize=True)
    webp = dest.with_name(dest.stem + "_homepage.webp")
    tile = card.copy()
    width, height = tile.size
    if width > 240:
        height = max(1, round(height * 240 / width))
        tile = tile.resize((240, height), Image.Resampling.LANCZOS)
    tile.save(webp, "WEBP", quality=82, method=6)


def find_backs(root: Path) -> list[Path]:
    found: list[Path] = []
    for path in root.iterdir():
        if not path.is_file():
            continue
        low = path.name.lower()
        if "_homepage" in low or not low.endswith((".jpg", ".jpeg")):
            continue
        if is_cardtrader_back(path):
            found.append(path)
    return sorted(found)


def leftover_ct_id(path: Path) -> int:
    stem = path.name.split("_", 1)[0]
    return int(stem) if stem.isdigit() else 0


def write_ids_module(ids: list[int]) -> None:
    body = ",".join(str(n) for n in ids)
    IDS_JS.write_text(f"export default [{body}];\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--push", action="store_true")
    args = parser.parse_args()
    if not MISSING.is_file():
        raise SystemExit(f"missing {MISSING}")
    hits = find_backs(REPLICA)
    ids = sorted({leftover_ct_id(p) for p in hits if leftover_ct_id(p)})
    print(f"cardtrader_backs={len(hits)} ct_ids={len(ids)}", flush=True)
    write_ids_module(ids)
    Path("/tmp/pokoin-placeholder-leftover-ids.json").write_text(json.dumps(ids) + "\n")
    if not args.apply:
        print(f"dry-run wrote {IDS_JS.name} (pass --apply)", flush=True)
        return 0
    card = pokoin_card()
    out = Path("/tmp/pokoin-placeholder-leftovers")
    if out.exists():
        for old in out.iterdir():
            if old.is_file():
                old.unlink()
    out.mkdir(parents=True, exist_ok=True)
    for path in hits:
        write_leftover(out / path.name, card)
        write_leftover(path, card)
    print(f"wrote {len(hits)} leftovers + {IDS_JS.name} v={CACHE}", flush=True)
    if args.push:
        subprocess.run(["rsync", "-a", "--info=stats1", f"{out}/", f"{HOST}:{PI_OBJECTS}/"], check=True)
        print("pushed pi", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
