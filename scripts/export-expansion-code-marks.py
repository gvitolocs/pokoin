#!/usr/bin/env python3
"""Save missing expansion marks as SVI-style PNGs (dark plate, light letters).

Desk / suggest circles currently 404 `/expansions/symbols/{slug}.png` and then
paint `setAbbrev` in HTML — yellow on a white disc. Official Scarlet & Violet
is already a 40×23 dark rounded plate. This writes that same plate for every
catalog expansion that has no symbol file yet.

Never overwrite an existing PNG (those are real set marks). Pi has no Pillow;
render on nezopt, rsync to replica + pi-home.

  /home/nez/Projects/ai-toolkit/venv/bin/python scripts/export-expansion-code-marks.py
  /home/nez/Projects/ai-toolkit/venv/bin/python scripts/export-expansion-code-marks.py --apply
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SET_LOGOS = ROOT / "market" / "src" / "set-logos.js"
HOST = os.environ.get("POKOIN_PI_HOST", "pi-home")
PI_OBJECTS = os.environ.get("POKOIN_PI_OBJECTS", "/srv/pokoin/card-images/objects")
REPLICA_OBJECTS = Path(
    os.environ.get(
        "POKOIN_REPLICA_OBJECTS",
        "/home/nez/mnt/mybook/pokoin-pi-card-images/objects",
    )
)
STAGING = Path(os.environ.get("POKOIN_CODE_MARK_DIR", "/tmp/pokoin-code-marks"))
PG_CONTAINER = os.environ.get("POKOIN_MARKETPLACE_POSTGRES", "pokoin-marketplace-postgres-15t")
CDN_BASE = os.environ.get("POKOIN_CARD_CDN_BASE_URL", "https://cdn.pokoin.com").rstrip("/")
FONT = Path(
    os.environ.get(
        "POKOIN_CODE_MARK_FONT",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    )
)

SET_ABBREV_SKIP = {"the", "of", "and", "a", "set", "starter", "mega", "ex", "collection", "series"}
PLATE = (35, 31, 32, 255)
LETTER = (190, 192, 194, 255)
SIZE = (160, 92)


def set_slug(name: str) -> str:
    text = unicodedata.normalize("NFKD", str(name or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.lower().replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:140]


def set_abbrev(set_name: str) -> str:
    words = []
    for raw in re.split(r"[\s/]+", str(set_name or "")):
        word = re.sub(r"[^A-Za-z0-9]", "", raw)
        if word and word.lower() not in SET_ABBREV_SKIP:
            words.append(word)
    if not words:
        return ""
    if len(words) == 1:
        return words[0][:3].upper()
    return "".join(word[0] for word in words)[:4].upper()


def load_set_codes(path: Path = SET_LOGOS) -> dict[str, str]:
    text = path.read_text()
    match = re.search(r"export const SET_CODES = \{([\s\S]*?)\n\};", text)
    if not match:
        raise SystemExit("SET_CODES missing from set-logos.js")
    codes = {}
    for slug, code in re.findall(r"'([^']+)': '([^']+)'", match.group(1)):
        codes[slug] = code
    return codes


def expansion_code(name: str, codes: dict[str, str] | None = None) -> str:
    slug = set_slug(name)
    table = codes if codes is not None else load_set_codes()
    return table.get(slug) or set_abbrev(name) or "●"


def render_mark(code: str, font_path: Path = FONT) -> bytes:
    text = str(code or "●").strip() or "●"
    img = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((2, 2, SIZE[0] - 3, SIZE[1] - 3), radius=16, fill=PLATE)
    n = len(text)
    size = 58 if n <= 2 else 48 if n == 3 else 38 if n == 4 else 32
    font = ImageFont.truetype(str(font_path), size)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (SIZE[0] - tw) / 2 - bbox[0]
    y = (SIZE[1] - th) / 2 - bbox[1] - 1
    draw.text((x, y), text, font=font, fill=LETTER)
    from io import BytesIO

    out = BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()


def load_expansions() -> list[tuple[str, str]]:
    proc = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            PG_CONTAINER,
            "psql",
            "-U",
            "pokoin_marketplace",
            "-d",
            "pokoin_marketplace",
            "-At",
            "-F",
            "\t",
            "-c",
            "select name, coalesce(code, '') from public.pokoin_pokemon_expansions order by name",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    rows = []
    for line in proc.stdout.splitlines():
        if "\t" not in line:
            continue
        name, code = line.split("\t", 1)
        rows.append((name, code))
    return rows


def sql_escape(value: str) -> str:
    return value.replace("'", "''")


def write_files(jobs: list[dict]) -> None:
    dest_dir = REPLICA_OBJECTS / "expansions" / "symbols"
    dest_dir.mkdir(parents=True, exist_ok=True)
    staging = STAGING / "expansions" / "symbols"
    staging.mkdir(parents=True, exist_ok=True)
    for job in jobs:
        name = f"{job['slug']}.png"
        (dest_dir / name).write_bytes(job["body"])
        (staging / name).write_bytes(job["body"])
        print(f"wrote {dest_dir / name} {job['code']} {len(job['body'])}B", flush=True)


def push_pi() -> None:
    src = f"{STAGING}/expansions/symbols/"
    dest = f"{HOST}:{PI_OBJECTS}/expansions/symbols/"
    subprocess.run(["rsync", "-a", "--info=stats1", src, dest], check=True)


def update_postgres(jobs: list[dict]) -> None:
    if not jobs:
        return
    lines = ["BEGIN;"]
    for job in jobs:
        slug = sql_escape(job["slug"])
        url = sql_escape(f"{CDN_BASE}/expansions/symbols/{job['slug']}.png")
        key = sql_escape(f"expansions/symbols/{job['slug']}.png")
        lines.append(
            f"""
UPDATE public.pokoin_pokemon_expansions
SET
  symbol_image_url = '{url}',
  symbol_object_key = '{key}',
  symbol_imported_at = now(),
  updated_at = now()
WHERE trim(both '-' from lower(regexp_replace(replace(public.unaccent(name), '&', ' and '), '[^a-zA-Z0-9]+', '-', 'g'))) = '{slug}'
  AND coalesce(symbol_image_url, '') = '';
"""
        )
    lines.append("COMMIT;")
    subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            PG_CONTAINER,
            "psql",
            "-U",
            "pokoin_marketplace",
            "-d",
            "pokoin_marketplace",
            "-v",
            "ON_ERROR_STOP=1",
        ],
        input="\n".join(lines),
        text=True,
        check=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    codes = load_set_codes()
    dest_dir = REPLICA_OBJECTS / "expansions" / "symbols"
    jobs = []
    for name, _db_code in load_expansions():
        slug = set_slug(name)
        if not slug:
            continue
        path = dest_dir / f"{slug}.png"
        if path.exists():
            continue
        code = expansion_code(name, codes)
        jobs.append({"name": name, "slug": slug, "code": code, "body": render_mark(code)})
        if args.limit and len(jobs) >= args.limit:
            break
    print(f"missing_symbols {len(jobs)}", flush=True)
    if not args.apply:
        for job in jobs[:12]:
            print(f"  {job['slug']} {job['code']}", flush=True)
        print("dry-run; pass --apply to write replica + Pi", flush=True)
        return 0
    write_files(jobs)
    push_pi()
    update_postgres(jobs)
    print("done", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
