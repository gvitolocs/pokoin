#!/usr/bin/env python3
"""Sample a darkened illustration shade from leftover / artcut JPEGs.

Writes marketplace_leftover_art_shades on nezopt 15T. Same POKEMON_ART_CUT
window as market/src/art-cut.js. Prefer sibling artcut/ crops when present.

  /home/nez/Projects/BattleScan/.venv/bin/python \\
    scripts/sample-leftover-art-shade.py
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

ART_CUT = (0.08, 0.125, 0.84, 0.36)
REPLICA = Path(
    os.environ.get("POKOIN_NVME_LEFTOVERS", "/home/nez/data/pokoin-leftovers")
)
OBJECTS = REPLICA / "objects"
ARTCUT = REPLICA / "artcut"
CT_NAME = re.compile(r"^(\d+)_")
HEX = re.compile(r"^#[0-9a-f]{6}$")
POSTGRES = "pokoin-marketplace-postgres-15t"


def leftover_ct_id(path: Path) -> int | None:
    match = CT_NAME.match(path.name)
    if not match:
        return None
    value = int(match.group(1))
    return value if value > 0 else None


def darken_for_caption(red: float, green: float, blue: float) -> str:
    """Delta shade of the illustration: keep hue, drop it to a caption bar."""
    red = max(0.0, min(255.0, red * 0.52))
    green = max(0.0, min(255.0, green * 0.52))
    blue = max(0.0, min(255.0, blue * 0.52))
    lum = 0.2126 * red + 0.7152 * green + 0.0722 * blue
    if lum > 78:
        scale = 78 / lum
        red *= scale
        green *= scale
        blue *= scale
    if lum < 22:
        lift = (22 - lum) / 22
        red = min(255.0, red + (40 * lift))
        green = min(255.0, green + (40 * lift))
        blue = min(255.0, blue + (40 * lift))
    return f"#{int(round(red)):02x}{int(round(green)):02x}{int(round(blue)):02x}"


def shade_from_image(image: Image.Image, *, already_cut: bool) -> str:
    rgb = image.convert("RGB")
    if not already_cut:
        width, height = rgb.size
        left, top, cut_w, cut_h = ART_CUT
        rgb = rgb.crop(
            (
                int(width * left),
                int(height * top),
                int(width * (left + cut_w)),
                int(height * (top + cut_h)),
            )
        )
    width, height = rgb.size
    if width < 2 or height < 2:
        return darken_for_caption(48, 52, 64)
    band = rgb.crop((0, int(height * 0.62), width, height))
    sample = band.resize((1, 1), Image.Resampling.BILINEAR)
    red, green, blue = sample.getpixel((0, 0))[:3]
    return darken_for_caption(red, green, blue)


def shade_one(src_s: str, already_cut: bool) -> tuple[int, str] | None:
    src = Path(src_s)
    ct_id = leftover_ct_id(src)
    if ct_id is None:
        return None
    try:
        with Image.open(src) as image:
            shade = shade_from_image(image, already_cut=already_cut)
    except Exception:
        return None
    if not HEX.match(shade):
        return None
    return ct_id, shade


def leftover_sources(objects: Path, artcut: Path) -> list[tuple[str, bool]]:
    found: dict[int, tuple[str, bool]] = {}
    if artcut.is_dir():
        for path in artcut.iterdir():
            if not path.is_file():
                continue
            name = path.name.lower()
            if "_homepage" in name or not name.endswith((".jpg", ".jpeg")):
                continue
            ct_id = leftover_ct_id(path)
            if ct_id:
                found[ct_id] = (str(path), True)
    if objects.is_dir():
        for path in objects.iterdir():
            if not path.is_file():
                continue
            name = path.name.lower()
            if "_homepage" in name or not name.endswith((".jpg", ".jpeg")):
                continue
            ct_id = leftover_ct_id(path)
            if ct_id and ct_id not in found:
                found[ct_id] = (str(path), False)
    return list(found.values())


def load_shades(rows: list[tuple[int, str]]) -> None:
    if not rows:
        return
    handle = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8")
    path = Path(handle.name)
    try:
        writer = csv.writer(handle)
        for ct_id, shade in rows:
            writer.writerow([ct_id, shade])
        handle.close()
        remote = "/tmp/pokoin-art-shades.csv"
        subprocess.run(
            ["docker", "cp", str(path), f"{POSTGRES}:{remote}"],
            check=True,
        )
        subprocess.run(
            [
                "docker",
                "exec",
                POSTGRES,
                "sh",
                "-c",
                f"""
PGPASSWORD="$POSTGRES_PASSWORD" psql -U pokoin_marketplace -d pokoin_marketplace -v ON_ERROR_STOP=1 <<SQL
create temp table art_shade_load (ct_id bigint, shade text);
\\copy art_shade_load from '{remote}' csv
insert into public.marketplace_leftover_art_shades (ct_id, shade, sampled_at)
select ct_id, shade, now()
from art_shade_load
where shade ~ '^#[0-9a-f]{{6}}$'
on conflict (ct_id) do update
  set shade = excluded.shade,
      sampled_at = now();
SQL
""",
            ],
            check=True,
        )
    finally:
        path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--objects", type=Path, default=OBJECTS)
    parser.add_argument("--artcut", type=Path, default=ARTCUT)
    parser.add_argument("--workers", type=int, default=os.cpu_count() or 8)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    sources = leftover_sources(args.objects, args.artcut)
    if args.limit:
        sources = sources[: args.limit]
    if not sources:
        print("no leftover JPEGs", file=sys.stderr)
        return 1
    rows: list[tuple[int, str]] = []
    workers = max(1, args.workers)
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(shade_one, src, cut) for src, cut in sources]
        for future in as_completed(futures):
            hit = future.result()
            if hit:
                rows.append(hit)
    load_shades(rows)
    print(f"sampled {len(rows)} leftover shades")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
