#!/usr/bin/env python3
"""Classify leftover JPEGs as card vs product with Qwen-VL on llama.cpp.

CardTrader category_id is the ingest source of truth
(`cardtrader_pokemon_category_product_type`). Use this when that id is
missing, unknown, or a Singles (73/78) leftover is not a 63:88 card photo.

Writes public.marketplace_visual_kind on --apply, then
apply_cardtrader_category_kind(). Qwen runs on nezopt llama.cpp (:11436),
not Ollama. Leftover JPEGs are the nezopt NVMe tree. Never crop on the Pi.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qwen_llama import chat_image

OBJECTS = Path(
    os.environ.get("POKOIN_NVME_LEFTOVERS", "/home/nez/data/pokoin-leftovers")
) / "objects"
MODEL = "qwen3-vl:32b-instruct"
PSQL = [
    "docker",
    "exec",
    "-i",
    "pokoin-marketplace-postgres-15t",
    "psql",
    "-U",
    "pokoin_marketplace",
    "-d",
    "pokoin_marketplace",
    "-v",
    "ON_ERROR_STOP=1",
    "-At",
]
PROMPT = """This is a Pokemon TCG catalog photo. Classify the OBJECT, not the print language.

Return ONLY JSON:
{"kind":"card"|"product","product_type":"card"|"accessory"|"sealed_product","why":"<=12 words"}

card = one playable trading card (Pokemon, Trainer, Energy, jumbo/oversized card). Card template, HP, weakness/retreat, energy symbol, or collector number.
product = box, tin, frame, condition marker, sleeves, playmat, binder, dice, storage, blister, booster pack, display stand, memorabilia. Not a playable card.
"""
KIND_RE = re.compile(
    r'\{[^{}]*"kind"\s*:\s*"(card|product)"[^{}]*\}',
    re.I,
)
CARD_RATIO = (0.62, 0.78)


def image_key(image: str) -> str:
    name = str(image or "").split("?", 1)[0]
    return name.rsplit("/", 1)[-1]


def leftover_path(image: str) -> Path | None:
    key = image_key(image)
    if not key:
        return None
    path = OBJECTS / key
    return path if path.is_file() else None


def jpeg_size(path: Path) -> tuple[int, int] | None:
    data = path.read_bytes()
    if data[:2] != b"\xff\xd8":
        return None
    index = 2
    while index + 9 < len(data):
        if data[index] != 0xFF:
            return None
        marker = data[index + 1]
        if marker in (0xC0, 0xC1, 0xC2):
            height = int.from_bytes(data[index + 5 : index + 7], "big")
            width = int.from_bytes(data[index + 7 : index + 9], "big")
            return width, height
        if marker in (0xD8, 0xD9):
            index += 2
            continue
        length = int.from_bytes(data[index + 2 : index + 4], "big")
        if length < 2:
            return None
        index += 2 + length
    return None


def looks_like_card_photo(path: Path) -> bool:
    size = jpeg_size(path)
    if not size:
        return True
    width, height = size
    if height <= 0:
        return True
    ratio = width / height
    return CARD_RATIO[0] <= ratio <= CARD_RATIO[1]


def parse_kind(text: str) -> dict:
    blob = str(text or "")
    match = KIND_RE.search(blob)
    raw = match.group(0) if match else blob[blob.find("{") : blob.rfind("}") + 1]
    data = json.loads(raw)
    kind = str(data.get("kind") or "").strip().lower()
    if kind not in {"card", "product"}:
        raise ValueError(f"bad kind {kind!r}")
    product_type = str(data.get("product_type") or "").strip().lower()
    if kind == "card":
        product_type = "card"
    elif product_type not in {"accessory", "sealed_product"}:
        product_type = "accessory"
    return {
        "kind": kind,
        "item_kind": "single" if kind == "card" else "product",
        "product_type": product_type,
        "why": str(data.get("why") or "").strip()[:160],
    }


def classify(path: Path) -> dict:
    t0 = time.time()
    text = chat_image(PROMPT, path.read_bytes(), model=MODEL, max_tokens=80)
    parsed = parse_kind(text)
    parsed["s"] = round(time.time() - t0, 2)
    parsed["raw"] = text.strip()[:400]
    return parsed


def psql(sql: str) -> str:
    result = subprocess.run(
        [*PSQL, "-c", sql],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def queue_sql(suspects: bool, limit: int) -> str:
    cap = max(int(limit or 0), 0)
    limit_sql = f"limit {cap}" if cap else ""
    if suspects:
        where = """
          b.category_id in (73, 78)
          and c.item_kind = 'single'
          and c.product_type = 'card'
          and coalesce(c.card_number, '') !~ '[0-9]{1,4}[a-z]?/[0-9]{1,4}'
        """
    else:
        where = """
          b.category_id is null
          or b.category_id not in (
            59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69,
            73, 74, 78, 86, 118, 136, 190, 203, 211
          )
        """
    return f"""
      select json_build_object(
        'ct_id', b.id,
        'card_id', c.card_id,
        'name', b.name,
        'set_name', c.set_name,
        'category_id', b.category_id,
        'item_kind', c.item_kind,
        'product_type', c.product_type,
        'image', coalesce(c.cdn_image_url, c.image_url, b.cdn_image_url, b.image_url)
      )
      from public.pokoin_pokemon_blueprints b
      join public.marketplace_cards c on c.ct_id = b.id
      left join public.marketplace_visual_kind v on v.ct_id = b.id
      where v.ct_id is null
        and ({where})
      order by b.imported_at desc nulls last, b.id desc
      {limit_sql}
    """


def load_done(jsonl: Path) -> dict[int, dict]:
    done = {}
    if not jsonl.is_file():
        return done
    for line in jsonl.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        done[int(row["ct_id"])] = row
    return done


def apply_row(row: dict) -> None:
    payload = json.dumps(
        {
            "ct_id": int(row["ct_id"]),
            "item_kind": row["item_kind"],
            "product_type": row["product_type"],
            "model": MODEL,
            "why": row.get("why") or "",
            "image_key": row.get("image_key") or "",
        }
    )
    escaped = payload.replace("'", "''")
    sql = f"""
      insert into public.marketplace_visual_kind (
        ct_id, item_kind, product_type, model, why, image_key, classified_at
      )
      select
        (j->>'ct_id')::bigint,
        j->>'item_kind',
        j->>'product_type',
        j->>'model',
        coalesce(j->>'why', ''),
        coalesce(j->>'image_key', ''),
        now()
      from (select '{escaped}'::jsonb as j) source
      on conflict (ct_id) do update set
        item_kind = excluded.item_kind,
        product_type = excluded.product_type,
        model = excluded.model,
        why = excluded.why,
        image_key = excluded.image_key,
        classified_at = now();
    """
    psql(sql)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jsonl", default="/tmp/qwen-kind.jsonl")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--suspects",
        action="store_true",
        help="Singles (73/78) with no collector fraction whose leftover is not 63:88",
    )
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    rows = []
    for line in psql(queue_sql(args.suspects, args.limit)).splitlines():
        if line.strip():
            rows.append(json.loads(line))
    jsonl_path = Path(args.jsonl)
    done = load_done(jsonl_path)
    print(f"queue {len(rows)} resume {len(done)} suspects={int(args.suspects)}", flush=True)

    applied = 0
    with jsonl_path.open("a", encoding="utf-8") as progress:
        for index, row in enumerate(rows, start=1):
            ct_id = int(row["ct_id"])
            if ct_id in done:
                continue
            path = leftover_path(row.get("image") or "")
            record = {
                "ct_id": ct_id,
                "card_id": row.get("card_id"),
                "name": row.get("name"),
                "set_name": row.get("set_name"),
                "category_id": row.get("category_id"),
            }
            if path is None:
                record.update({"kind": "missing", "why": "no local leftover", "s": 0})
            elif args.suspects and looks_like_card_photo(path):
                record.update({"kind": "skip", "why": "card-shaped leftover", "s": 0, "image_key": path.name})
            else:
                try:
                    parsed = classify(path)
                except (TimeoutError, ValueError, json.JSONDecodeError, OSError) as exc:
                    print(f"FAIL {index}/{len(rows)} {row['name']}: {exc}", flush=True)
                    time.sleep(2)
                    try:
                        parsed = classify(path)
                    except Exception as exc2:
                        record.update({
                            "kind": "error",
                            "why": f"{type(exc2).__name__}: {exc2}",
                            "s": 0,
                            "image_key": path.name,
                        })
                        progress.write(json.dumps(record, ensure_ascii=False) + "\n")
                        progress.flush()
                        done[ct_id] = record
                        continue
                record.update(parsed)
                record["image_key"] = path.name
                if args.apply and record.get("kind") in {"card", "product"}:
                    apply_row(record)
                    applied += 1
            progress.write(json.dumps(record, ensure_ascii=False) + "\n")
            progress.flush()
            done[ct_id] = record
            print(
                f"{index}/{len(rows)} {row['name']} cat={row.get('category_id')} "
                f"qwen={record.get('kind')} {record.get('product_type') or ''} "
                f"{record.get('s') or 0}s",
                flush=True,
            )
            if args.dry_run:
                continue

    if args.apply and applied:
        summary = psql("select public.apply_cardtrader_category_kind();")
        print(f"applied {applied} {summary}", flush=True)


if __name__ == "__main__":
    main()
