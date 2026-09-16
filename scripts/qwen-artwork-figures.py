#!/usr/bin/env python3
"""Ground visible Pokemon figures once per CLIP artwork with Qwen3-VL.

The artist-album hover cannot infer its focal region from the card title or
National Dex number: trainer art, cameos, and multi-character paintings need
the Pokemon that are actually visible.  This job picks one local leftover
for every CLIP ``version`` and writes resumable JSONL for review.  Boxes are
only SAM prompts; they are never the visible hover effect.

Qwen3-VL is served by Ollama on nezopt ``:11434``.  The text-only llama.cpp
gateway on ``:11436`` has no mmproj and must not be used for this job.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

REPLICA = Path(os.environ.get("POKOIN_NVME_LEFTOVERS", "/home/nez/data/pokoin-leftovers"))
OBJECTS = REPLICA / "objects"
SERVER = os.environ.get("QWEN_VL_SERVER", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get("QWEN_VL_MODEL", "qwen3-vl:32b-instruct")
PSQL = [
    "docker", "exec", "-i", "pokoin-marketplace-postgres-15t", "psql",
    "-U", "pokoin_marketplace", "-d", "pokoin_marketplace", "-At",
]
PROMPT = """Inspect this Pokemon trading card. The catalog title is {name!r}.
Locate every visible Pokemon creature in the painted illustration, including small background cameos.
The small evolution-stage thumbnail near the upper-left name bar is card UI, not
part of the painted illustration. Never return a box for that thumbnail.
Return ONLY compact JSON in this exact shape:
{{"figures":[{{"label":"Pikachu","box":[x1,y1,x2,y2]}}]}}
Coordinates are integers 0..1000 relative to the full supplied card image. A box must tightly contain one whole visible Pokemon. Exclude people, text, borders, type/energy icons, symbols, objects, attacks/effects, and scenery. Do not invent the title Pokemon if it is not visible. Trainer and Energy cards can legitimately return {{"figures":[]}}.
Return each visible creature once; never repeat the same box.
"""
FIGURE_FALLBACK_RE = re.compile(
    r'"label"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*'
    r'"box"\s*:\s*\[([^\]]+)\]'
)


def query_rows() -> list[dict]:
    sql = """
      select json_build_object(
        'version', c.version,
        'card_id', c.card_id,
        'ct_id', c.ct_id,
        'name', c.name,
        'art_layout', c.art_layout,
        'image', coalesce(c.cdn_image_url, c.image_url)
      )
      from public.marketplace_search_candidates c
      where c.item_kind = 'single'
        and c.product_type = 'card'
        and coalesce(c.version, '') <> ''
      order by c.version, c.card_id
    """
    result = subprocess.run([*PSQL, "-c", sql], check=True, capture_output=True, text=True)
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def image_key(url: str) -> str:
    return str(url or "").split("?", 1)[0].rsplit("/", 1)[-1]


def object_index(root: Path) -> dict[int, list[Path]]:
    out: dict[int, list[Path]] = defaultdict(list)
    if not root.is_dir():
        return out
    for path in root.iterdir():
        if not path.is_file() or "_homepage" in path.name.lower():
            continue
        match = re.match(r"(\d+)[_-].*\.(?:jpg|jpeg)$", path.name, re.I)
        if match:
            out[int(match.group(1))].append(path)
    return out


def local_path(row: dict, root: Path, indexed: dict[int, list[Path]]) -> Path | None:
    key = image_key(row.get("image") or "")
    direct = root / key if key else None
    if direct and direct.is_file() and "_homepage" not in direct.name.lower():
        return direct
    hits = indexed.get(int(row.get("ct_id") or 0), [])
    return sorted(hits, key=lambda p: (len(p.name), p.name))[0] if hits else None


def representatives(rows: list[dict], root: Path) -> list[tuple[dict, Path]]:
    indexed = object_index(root)
    chosen: dict[str, tuple[dict, Path]] = {}
    for row in rows:
        version = str(row.get("version") or "")
        if not version or version in chosen:
            continue
        path = local_path(row, root, indexed)
        if path:
            chosen[version] = (row, path)
    return [chosen[key] for key in sorted(chosen)]


def parse_figures(text: str) -> list[dict]:
    raw_text = str(text or "")
    start = raw_text.find("{")
    if start < 0:
        raise ValueError("response has no JSON object")
    # Decode the first complete object only. Some vision-model replies append
    # a second object or commentary despite being asked for JSON-only.
    try:
        data, _ = json.JSONDecoder().raw_decode(raw_text[start:])
    except json.JSONDecodeError:
        recovered = []
        for encoded_label, encoded_box in FIGURE_FALLBACK_RE.findall(raw_text[start:]):
            values = [value.strip() for value in encoded_box.split(",")]
            if len(values) != 4:
                continue
            try:
                label = json.loads(f'"{encoded_label}"')
                box = [float(value) for value in values]
            except (ValueError, json.JSONDecodeError):
                continue
            recovered.append({"label": label, "box": box})
        if not recovered:
            if re.search(r'"figures"\s*:\s*\[\s*\]', raw_text[start:]):
                return []
            raise
        data = {"figures": recovered}
    if not isinstance(data, dict) or not isinstance(data.get("figures"), list):
        raise ValueError("response must contain a figures list")
    figures = []
    seen_boxes = set()
    for raw in data.get("figures") or []:
        label = str(raw.get("label") or "character").strip()[:80] or "character"
        box = raw.get("box")
        if not isinstance(box, list) or len(box) != 4:
            raise ValueError(f"invalid box for {label!r}")
        coords = [max(0, min(1000, int(round(float(value))))) for value in box]
        x1, y1, x2, y2 = coords
        if x2 <= x1 or y2 <= y1:
            raise ValueError(f"empty box for {label!r}")
        key = tuple(coords)
        if key in seen_boxes:
            continue
        seen_boxes.add(key)
        figures.append({"label": label, "box": coords})
    return figures


def union_box(figures: list[dict]) -> list[int] | None:
    if not figures:
        return None
    boxes = [figure["box"] for figure in figures]
    return [
        min(box[0] for box in boxes), min(box[1] for box in boxes),
        max(box[2] for box in boxes), max(box[3] for box in boxes),
    ]


def classify(name: str, image: bytes) -> tuple[list[dict], str, float]:
    payload = {
        "model": MODEL,
        "stream": False,
        "keep_alive": "10m",
        "messages": [{
            "role": "user",
            "content": PROMPT.format(name=name),
            "images": [base64.b64encode(image).decode()],
        }],
        "options": {"temperature": 0, "num_ctx": 4096, "num_predict": 256},
    }
    request = urllib.request.Request(
        f"{SERVER}/api/chat",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.time()
    with urllib.request.urlopen(request, timeout=300) as response:
        body = json.loads(response.read())
    if body.get("error"):
        raise RuntimeError(f"Ollama error: {body['error']}")
    raw = str((body.get("message") or {}).get("content") or "")
    return parse_figures(raw), raw, round(time.time() - started, 2)


def load_done(path: Path) -> dict[str, dict]:
    done = {}
    if not path.is_file():
        return done
    for line in path.read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            # Failed rows must remain retryable. This also makes an existing
            # error-heavy JSONL safe to resume after the model is recovered.
            if not row.get("error"):
                done[str(row["version"])] = row
    return done


def load_failure_counts(path: Path) -> dict[str, int]:
    failures: dict[str, int] = defaultdict(int)
    if not path.is_file():
        return failures
    for line in path.read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            if row.get("error"):
                failures[str(row["version"])] += 1
    return failures


def is_infrastructure_error(message: str) -> bool:
    return str(message).startswith((
        "RuntimeError: Ollama error:",
        "HTTPError:",
        "URLError:",
        "TimeoutError:",
    ))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jsonl", type=Path, default=Path("/tmp/qwen-artwork-figures.jsonl"))
    parser.add_argument("--objects", type=Path, default=OBJECTS)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--max-consecutive-errors",
        type=int,
        default=3,
        help="stop after this many consecutive failures (0 disables the guard)",
    )
    parser.add_argument(
        "--max-error-attempts",
        type=int,
        default=3,
        help="quarantine an individual version after this many failed runs",
    )
    args = parser.parse_args()

    reps = representatives(query_rows(), args.objects)
    if args.limit:
        reps = reps[: max(0, args.limit)]
    done = load_done(args.jsonl)
    failure_counts = load_failure_counts(args.jsonl)
    print(f"paintings {len(reps)} resume {len(done)} model={MODEL}", flush=True)
    consecutive_errors = 0
    with args.jsonl.open("a", encoding="utf-8") as progress:
        for index, (row, path) in enumerate(reps, start=1):
            version = str(row["version"])
            if version in done or failure_counts.get(version, 0) >= args.max_error_attempts:
                continue
            record = {
                "version": version,
                "card_id": row.get("card_id"),
                "ct_id": row.get("ct_id"),
                "name": row.get("name"),
                "image_key": path.name,
                "model": MODEL,
                "coordinate_space": "full_card_1000",
            }
            try:
                figures, raw, seconds = classify(str(row.get("name") or ""), path.read_bytes())
                record.update({"figures": figures, "union_box": union_box(figures), "s": seconds})
                if not figures:
                    record["raw"] = raw[:400]
            except Exception as exc:
                record.update({"error": f"{type(exc).__name__}: {exc}", "s": 0})
            if record.get("error"):
                failure_counts[version] = failure_counts.get(version, 0) + 1
                record["quarantined"] = failure_counts[version] >= args.max_error_attempts
                if is_infrastructure_error(record["error"]):
                    consecutive_errors += 1
                else:
                    consecutive_errors = 0
            else:
                consecutive_errors = 0
                done[version] = record
            progress.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            progress.flush()
            print(
                f"{index}/{len(reps)} {version} {row.get('name')} "
                f"figures={len(record.get('figures') or [])} {record.get('s', 0)}s"
                + (f" ERROR {record['error']}" if record.get("error") else ""),
                flush=True,
            )
            if (
                args.max_consecutive_errors > 0
                and consecutive_errors >= args.max_consecutive_errors
            ):
                print(
                    f"stopping after {consecutive_errors} consecutive errors; "
                    "failed versions remain retryable",
                    flush=True,
                )
                return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
