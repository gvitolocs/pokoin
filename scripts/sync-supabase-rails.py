#!/usr/bin/env python3
"""Publish cheap browse lists from Oracle Postgres to Supabase.

Oracle stays source of truth and search. This script uses short statement
timeouts so a CardTrader refresh cannot hold it for minutes.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

API_ORIGIN = os.environ.get("API_ORIGIN", "http://127.0.0.1:18080").rstrip("/")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SECRET_ACCESS_KEY") or ""
PROMO_SLUGS = [
    "mega-evolution",
    "phantasmal-flames",
    "black-bolt",
    "white-flare",
    "destined-rivals",
]


def die(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def get_json(url: str, timeout: int = 12):
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        print(f"skip {url}: {error}", file=sys.stderr)
        return None


def upsert(table: str, rows: list[dict], on_conflict: str) -> None:
    if not rows:
        return
    body = json.dumps(rows).encode()
    request = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{table}?on_conflict={on_conflict}",
        data=body,
        method="POST",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        response.read()


def card_id(card: dict) -> str:
    return str(card.get("id") or card.get("card_id") or "")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def tiles_from_cards(cards: list[dict]) -> list[dict]:
    out = []
    seen = set()
    for card in cards or []:
        cid = card_id(card)
        if not cid or cid in seen:
            continue
        seen.add(cid)
        out.append({"card_id": cid, "payload": card, "updated_at": now_iso()})
    return out


def rail(rail_id: str, cards: list, meta: dict | None = None) -> dict:
    return {"id": rail_id, "cards": cards or [], "meta": meta or {}, "updated_at": now_iso()}


def psql_top_sold() -> list[dict]:
    sql = r"""
SET statement_timeout = '30s';
SELECT row_to_json(t)
FROM (
  SELECT
    c.card_id::text AS id,
    c.card_id::text AS card_id,
    c.ct_id,
    c.name,
    c.set_name,
    coalesce(c.card_number, '') AS number,
    coalesce(c.card_number, '') AS card_number,
    coalesce(c.rarity, 'Card') AS rarity,
    'single' AS "itemKind",
    'card' AS "productType",
    '/marketplace/en/cards/' || c.card_id::text AS "canonicalPath",
    '/marketplace/en/cards/' || c.card_id::text AS canonical_path,
    coalesce(c.cdn_image_url, c.image_url, '') AS "imageUrl",
    coalesce(c.cdn_image_url, c.image_url, '') AS "gridImageUrl",
    coalesce(c.cdn_image_url, c.image_url, '') AS "heroImageUrl",
    coalesce(c.cdn_image_url, c.image_url, '') AS "tileImageUrl"
  FROM public.marketplace_search_candidates c
  WHERE c.item_kind = 'single'
    AND c.product_type = 'card'
    AND coalesce(c.cdn_image_url, c.image_url) IS NOT NULL
  ORDER BY c.search_weight DESC NULLS LAST, c.card_id DESC
  LIMIT 1000
) t;
"""
    try:
        raw = subprocess.check_output(
            [
                "docker",
                "exec",
                "-i",
                "pokoin-marketplace-postgres",
                "psql",
                "-U",
                "pokoin_marketplace",
                "-d",
                "pokoin_marketplace",
                "-At",
                "-P",
                "pager=off",
            ],
            input=sql.encode(),
            timeout=45,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as error:
        print(f"top_sold sql skipped: {error}", file=sys.stderr)
        return []
    rows = []
    for line in raw.decode().splitlines():
        line = line.strip()
        if not line or line == "SET":
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            row["set"] = row.get("set_name") or ""
            rows.append(row)
    return rows


def main() -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        die("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")

    rails = []
    tiles = []

    home = get_json(f"{API_ORIGIN}/api/marketplace-home-page")
    if home and isinstance(home, dict):
        cards = home.get("cards") or []
        sections = home.get("sections") or {}
        by_id = {card_id(card): card for card in cards if card_id(card)}

        def take(ids):
            out = []
            for raw_id in ids or []:
                card = by_id.get(str(raw_id))
                if card:
                    out.append(card)
            return out

        rails.extend(
            [
                rail("new_cards", take(sections.get("newArrivalIds"))),
                rail("featured", take(sections.get("featuredIds"))),
                rail("best_sellers", take(sections.get("bestSellerIds"))),
                rail("spotlight", take(sections.get("spotlightIds"))),
            ]
        )
        tiles.extend(tiles_from_cards(cards))

    top = psql_top_sold()
    if top:
        rails.append(rail("top_sold", top, {"limit": 1000}))
        tiles.extend(tiles_from_cards(top))

    expansions = get_json(f"{API_ORIGIN}/api/marketplace-expansion-page?limit=80")
    if expansions and isinstance(expansions, dict):
        rows = expansions.get("expansions") or expansions.get("sets") or []
        rails.append(rail("set_index", [], {"expansions": rows}))

    for slug in PROMO_SLUGS:
        page = get_json(
            f"{API_ORIGIN}/api/marketplace-expansion-page?slug={slug}&limit=48&offset=0&productType=card",
            timeout=15,
        )
        if page and page.get("cards"):
            rails.append(
                rail(
                    f"set:{slug}",
                    page.get("cards") or [],
                    {
                        "expansion": page.get("expansion") or {"slug": slug},
                        "hasMore": bool(page.get("hasMore")),
                        "name": (page.get("expansion") or {}).get("name") or slug,
                    },
                )
            )
            tiles.extend(tiles_from_cards(page.get("cards") or []))

    if not rails:
        die("no rails collected; oracle API/SQL both empty")

    # Dedupe tiles
    unique = {}
    for row in tiles:
        unique[row["card_id"]] = row
    tiles = list(unique.values())

    upsert("marketplace_rails", rails, "id")
    for i in range(0, len(tiles), 200):
        upsert("marketplace_card_tiles", tiles[i : i + 200], "card_id")
    print(f"published rails={len(rails)} tiles={len(tiles)}")


if __name__ == "__main__":
    main()
