#!/usr/bin/env python3
"""Load western leftover OCR jsonl into marketplace_card_ocr (writer Postgres).

Default input: scripts/out/western-full-ocr-gpu.jsonl (canonical checkout or
sibling). Dry-run unless --apply. Does not restart the Pi API — apply SQL
093_marketplace_card_ocr.sql on the writer first, then this import, then
deploy poko-market only when Honcho hermes-peer1 / poko-peer1 are safe.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_JSONL = Path(
    os.environ.get(
        "POKOIN_OCR_JSONL",
        str(Path.home() / "Projects/pokoin-web/scripts/out/western-full-ocr-gpu.jsonl"),
    )
)
UPSERT = """
insert into public.marketplace_card_ocr (
  card_id, leftover_id, name, set_name, card_number, text, junk, ok,
  engine, crop, line_count, updated_at
) values (
  %(card_id)s, %(leftover_id)s, %(name)s, %(set_name)s, %(card_number)s,
  %(text)s, %(junk)s, %(ok)s, %(engine)s, %(crop)s, %(line_count)s, now()
)
on conflict (card_id) do update set
  leftover_id = excluded.leftover_id,
  name = excluded.name,
  set_name = excluded.set_name,
  card_number = excluded.card_number,
  text = excluded.text,
  junk = excluded.junk,
  ok = excluded.ok,
  engine = excluded.engine,
  crop = excluded.crop,
  line_count = excluded.line_count,
  updated_at = now()
"""


def writer_dsn() -> str:
    return (
        os.environ.get("MARKETPLACE_WRITER_DATABASE_URL")
        or os.environ.get("MARKETPLACE_DATABASE_URL")
        or ""
    ).strip()


def row_from_json(obj: dict) -> dict | None:
    if not obj.get("ok"):
        return None
    text = str(obj.get("text") or "").strip()[:1500]
    if not text:
        return None
    card_id = obj.get("card_id")
    ct_id = obj.get("ct_id")
    if card_id is None and ct_id is None:
        return None
    leftover = int(ct_id) if ct_id is not None else int(card_id) // 2
    public = str(int(card_id) if card_id is not None else leftover * 2)
    return {
        "card_id": public,
        "leftover_id": leftover,
        "name": str(obj.get("name") or "")[:200] or None,
        "set_name": str(obj.get("expansion") or "")[:200] or None,
        "card_number": str(obj.get("num") or "")[:120] or None,
        "text": text,
        "junk": bool(obj.get("junk")),
        "ok": True,
        "engine": str(obj.get("engine") or "")[:80] or None,
        "crop": str(obj.get("crop") or "")[:40] or None,
        "line_count": int(obj.get("lines") or 0) or None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jsonl", type=Path, default=DEFAULT_JSONL)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    if not args.jsonl.is_file():
        print(f"missing jsonl: {args.jsonl}", file=sys.stderr)
        return 1

    rows = []
    with args.jsonl.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            packed = row_from_json(json.loads(line))
            if packed:
                rows.append(packed)
            if args.limit and len(rows) >= args.limit:
                break

    print(f"rows_ready={len(rows)} from {args.jsonl}")
    if not args.apply:
        print("dry-run only; pass --apply to write")
        return 0

    dsn = writer_dsn()
    if not dsn:
        print("MARKETPLACE_WRITER_DATABASE_URL (or MARKETPLACE_DATABASE_URL) required", file=sys.stderr)
        return 1
    try:
        import psycopg
    except ImportError:
        print("import-marketplace-card-ocr: need psycopg (pip install psycopg[binary])", file=sys.stderr)
        return 2

    written = 0
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            for batch_start in range(0, len(rows), 500):
                batch = rows[batch_start : batch_start + 500]
                cur.executemany(UPSERT, batch)
                written += len(batch)
                print(f"upserted {written}/{len(rows)}")
        conn.commit()
    print(f"done written={written}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
