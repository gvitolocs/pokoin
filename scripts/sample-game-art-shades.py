#!/usr/bin/env python3
"""Sample artwork-delta shades for every non-Pokemon game on HIP 0.

Pokemon leftovers already live in pokoin_marketplace. Other games keep
their own database, because CardTrader ids collide across games. Decode
uses every CPU; the illustration mean runs on the 7900 XTX. This does
not load Qwen.

  /home/nez/Projects/ai-toolkit/venv/bin/python \\
    scripts/sample-game-art-shades.py --all
"""
from __future__ import annotations

import argparse
import csv
import importlib.util
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "pokemon_art_shade", HERE / "sample-leftover-art-shade.py"
)
POKEMON = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POKEMON)

# Upper painting of a typical trading card, then the same bottom band the
# Pokemon sampler uses. Taller than the Pokemon window because these games
# put more of the picture above the rules text.
GAME_CUT = (0.08, 0.10, 0.84, 0.46)
THUMB = (96, 36)
OBJECTS = Path(os.environ.get("POKOIN_NVME_LEFTOVERS", "/home/nez/data/pokoin-leftovers")) / "objects"
POSTGRES = "pokoin-marketplace-postgres-15t"
SKIP = {
    "artist-profiles",
    "competitive",
    "downloads",
    "expansions",
    "figure-masks",
    "manifests",
    "originals",
    "previews",
}
RANK = {".jpg": 0, ".jpeg": 0, ".png": 1, ".webp": 2}


def psql(database: str, sql: str) -> str:
    result = subprocess.run(
        [
            "docker", "exec", "-i", POSTGRES, "sh", "-c",
            f'PGPASSWORD="$POSTGRES_PASSWORD" psql -U pokoin_marketplace -d {database} -v ON_ERROR_STOP=1 -tA',
        ],
        input=sql,
        text=True,
        check=True,
        capture_output=True,
    )
    return result.stdout


def databases() -> set[str]:
    text = psql("postgres", "select datname from pg_database where datname like 'pokoin\\_%';")
    return {line.strip() for line in text.splitlines() if line.strip()}


def ensure_table(database: str) -> None:
    psql(database, """
create table if not exists public.marketplace_leftover_art_shades (
  ct_id bigint primary key,
  shade text not null,
  sampled_at timestamptz not null default now(),
  constraint marketplace_leftover_art_shades_hex
    check (shade ~ '^#[0-9a-f]{6}$')
);
""")


def existing_ids(database: str) -> set[int]:
    text = psql(database, "select ct_id from public.marketplace_leftover_art_shades;")
    return {int(line) for line in text.splitlines() if line.strip().isdigit()}


def game_sources(folder: Path) -> list[str]:
    found: dict[int, tuple[int, str]] = {}
    if not folder.is_dir():
        return []
    for path in folder.iterdir():
        if not path.is_file():
            continue
        name = path.name.lower()
        if "_homepage" in name:
            continue
        rank = RANK.get(path.suffix.lower())
        if rank is None:
            continue
        ct_id = POKEMON.leftover_ct_id(path)
        if not ct_id:
            continue
        current = found.get(ct_id)
        if current is None or rank < current[0]:
            found[ct_id] = (rank, str(path))
    return [item[1] for item in found.values()]


def thumb_one(src_s: str) -> tuple[int, bytes] | None:
    src = Path(src_s)
    ct_id = POKEMON.leftover_ct_id(src)
    if ct_id is None:
        return None
    try:
        with Image.open(src) as image:
            rgb = image.convert("RGB")
            width, height = rgb.size
            left, top, cut_w, cut_h = GAME_CUT
            rgb = rgb.crop((
                int(width * left),
                int(height * top),
                int(width * (left + cut_w)),
                int(height * (top + cut_h)),
            ))
            width, height = rgb.size
            if width < 2 or height < 2:
                return None
            band = rgb.crop((0, int(height * 0.62), width, height))
            thumb = band.resize(THUMB, Image.Resampling.BILINEAR)
            return ct_id, thumb.tobytes()
    except Exception:
        return None


_DEVICE = None


def gpu_device():
    global _DEVICE
    import torch
    if _DEVICE is None:
        if not torch.cuda.is_available():
            raise SystemExit("HIP device unavailable")
        _DEVICE = torch.device("cuda:0")
        torch.cuda.set_device(_DEVICE)
        print(f"gpu {torch.cuda.get_device_name(_DEVICE)}", flush=True)
    return _DEVICE


def shades_on_gpu(rows: list[tuple[int, bytes]]) -> list[tuple[int, str]]:
    import torch

    if not rows:
        return []
    device = gpu_device()
    width, height = THUMB
    stack = np.stack([
        np.frombuffer(blob, dtype=np.uint8).reshape(height, width, 3)
        for _ct, blob in rows
    ])
    tensor = torch.from_numpy(np.ascontiguousarray(stack)).to(device=device, dtype=torch.float32)
    # NHWC -> NCHW. Area mean, not bilinear: ROCm bilinear-to-1x1 washes the
    # hue out and every card lands on the same gray.
    reduced = tensor.permute(0, 3, 1, 2).mean(dim=(2, 3))
    pixels = reduced.clamp_(0, 255)
    cpu = pixels.detach().cpu().tolist()
    out = []
    for (ct_id, _blob), (red, green, blue) in zip(rows, cpu):
        out.append((ct_id, POKEMON.darken_for_caption(red, green, blue)))
    return out


def load_shades(database: str, rows: list[tuple[int, str]]) -> None:
    if not rows:
        return
    handle = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8")
    path = Path(handle.name)
    try:
        writer = csv.writer(handle)
        for ct_id, shade in rows:
            writer.writerow([ct_id, shade])
        handle.close()
        remote = f"/tmp/pokoin-art-shades-{database}.csv"
        subprocess.run(["docker", "cp", str(path), f"{POSTGRES}:{remote}"], check=True)
        subprocess.run(
            [
                "docker", "exec", POSTGRES, "sh", "-c",
                f"""
PGPASSWORD="$POSTGRES_PASSWORD" psql -U pokoin_marketplace -d {database} -v ON_ERROR_STOP=1 <<SQL
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


def sample_game(folder: Path, database: str, workers: int, limit: int, batch: int) -> int:
    ensure_table(database)
    done = existing_ids(database)
    sources = [src for src in game_sources(folder) if POKEMON.leftover_ct_id(Path(src)) not in done]
    if limit:
        sources = sources[:limit]
    if not sources:
        print(f"{folder.name}: nothing new", flush=True)
        return 0
    print(f"{folder.name}: {len(sources)} scans -> {database}", flush=True)
    written = 0
    pending: list[tuple[int, bytes]] = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(thumb_one, src) for src in sources]
        for future in as_completed(futures):
            hit = future.result()
            if not hit:
                continue
            pending.append(hit)
            if len(pending) >= batch:
                rows = shades_on_gpu(pending)
                load_shades(database, rows)
                written += len(rows)
                pending = []
                print(f"{folder.name}: {written}", flush=True)
    if pending:
        rows = shades_on_gpu(pending)
        load_shades(database, rows)
        written += len(rows)
    print(f"{folder.name}: sampled {written}", flush=True)
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--game", action="append", default=[])
    parser.add_argument("--objects", type=Path, default=OBJECTS)
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 8) - 2))
    parser.add_argument("--batch", type=int, default=2048)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    known = databases()
    names = args.game
    if args.all:
        names = sorted(
            path.name for path in args.objects.iterdir()
            if path.is_dir() and path.name not in SKIP
        )
    if not names:
        print("pass --all or --game", file=sys.stderr)
        return 1
    total = 0
    for name in names:
        database = "pokoin_" + name.replace("-", "_")
        if database not in known or database == "pokoin_marketplace":
            print(f"{name}: no isolated database ({database})", flush=True)
            continue
        total += sample_game(args.objects / name, database, args.workers, args.limit, args.batch)
    print(f"done {total}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
