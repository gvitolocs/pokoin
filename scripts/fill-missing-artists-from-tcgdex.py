#!/usr/bin/env python3
"""Fill leftover artist gaps from TCGdex when pokemontcg.io has no illustrator."""
from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.error
import urllib.request
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from subprocess import run

CONTAINER = "pokoin-marketplace-postgres-15t"
APPLY = "--apply" in sys.argv
TCGDEX = "https://api.tcgdex.net/v2/en"
ID_ALIAS = {
    "me1": "me01",
    "me3": "me03",
    "sv7": "sv07",
    "sv8": "sv08",
    "sv8pt5": "sv08.5",
    "sv9": "sv09",
    "swsh45sv": "sv03.5",
}

def psql(sql: str) -> str:
    result = run(
        [
            "docker",
            "exec",
            "-i",
            CONTAINER,
            "psql",
            "-U",
            "pokoin_marketplace",
            "-d",
            "pokoin_marketplace",
            "-v",
            "ON_ERROR_STOP=1",
            "-At",
        ],
        input=sql,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(result.stderr or result.stdout or f"psql {result.returncode}")
    return result.stdout


def get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "pokoin-artist-fill/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as handle:
            return json.loads(handle.read().decode())
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def fold(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").lower())


def collector(num: str) -> str:
    text = str(num or "")
    slash = re.search(r"(\d{1,4})[a-z]?\s*/\s*\d{1,4}", text, re.I)
    if slash:
        return str(int(slash.group(1)))
    promo = re.search(r"\b([A-Z]{2,6}\s*\d{1,4}[a-z]?)\b", text, re.I)
    if promo:
        return re.sub(r"\s+", "", promo.group(1)).upper()
    plain = re.search(r"^(\d{1,4})[a-z]?$", text.strip(), re.I)
    return str(int(plain.group(1))) if plain else ""


def names_ok(left: str, right: str) -> bool:
    a, b = fold(left), fold(right)
    if not a or not b:
        return False
    return a == b or a in b or b in a


def local_ids(number: str) -> list[str]:
    raw = collector(number)
    if not raw:
        return []
    out = [raw]
    if raw.isdigit():
        out.append(raw.zfill(3))
        out.append(str(int(raw)))
    seen = []
    for item in out:
        if item not in seen:
            seen.append(item)
    return seen


def sql_literal(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


sets = get_json(f"{TCGDEX}/sets") or []
by_id = {str(row.get("id") or "").lower(): row for row in sets}
by_name = {}
for row in sets:
    key = fold(row.get("name") or "")
    by_name.setdefault(key, []).append(row)

missing = []
for line in psql(
    """
SELECT c.ct_id || E'\\t' || coalesce(c.name,'') || E'\\t' || coalesce(c.card_number,'')
  || E'\\t' || coalesce(e.name,'') || E'\\t' || coalesce(e.official_id,'') || E'\\t' || coalesce(e.code,'')
FROM marketplace_cards c
LEFT JOIN marketplace_blueprint_artists a ON a.blueprint_id = c.ct_id
JOIN pokoin_pokemon_blueprints b ON b.id = c.ct_id
JOIN pokoin_pokemon_expansions e ON e.expansion_id = b.expansion_id
WHERE coalesce(nullif(a.illustrator,''), nullif(a.artist,'')) IS NULL
  AND coalesce(c.item_kind, 'single') = 'single'
  AND e.nationality IN ('western', 'american', 'french');
"""
).splitlines():
    if not line.strip():
        continue
    ct_id, name, num, set_name, official, code = (line.split("\t") + [""] * 6)[:6]
    missing.append(
        {
            "ct_id": int(ct_id),
            "name": name,
            "num": num,
            "set_name": set_name,
            "official": official.lower(),
            "code": code.lower(),
        }
    )


def resolve_set(row: dict):
    for key in (row["official"], ID_ALIAS.get(row["official"], ""), row["code"]):
        if key and key in by_id:
            return by_id[key]
    hits = by_name.get(fold(row["set_name"])) or []
    if len(hits) == 1:
        return hits[0]
    return None


set_cards = {}
card_cache = {}
CACHE_LOCK = threading.Lock()


def cards_for(set_id: str):
    with CACHE_LOCK:
        if set_id in set_cards:
            return set_cards[set_id]
    detail = get_json(f"{TCGDEX}/sets/{urllib.parse.quote(set_id)}") or {}
    cards = list(detail.get("cards") or [])
    with CACHE_LOCK:
        set_cards[set_id] = cards
    return cards


def load_card(card_id: str):
    with CACHE_LOCK:
        if card_id in card_cache:
            return card_cache[card_id]
    loaded = get_json(f"{TCGDEX}/cards/{urllib.parse.quote(card_id)}")
    with CACHE_LOCK:
        card_cache[card_id] = loaded
    return loaded


def match_row(row: dict):
    tset = resolve_set(row)
    if not tset:
        return None, "set_not_found"
    ids = set(local_ids(row["num"]))
    if not ids:
        return None, "no_collector"
    tight = []
    for card in cards_for(tset["id"]):
        local = str(card.get("localId") or "")
        if local in ids:
            tight.append(card)
            continue
        if local.isdigit() and any(item.isdigit() and int(item) == int(local) for item in ids if item.isdigit()):
            tight.append(card)
    if not tight:
        return None, "card_not_in_set"
    detail = None
    for card in tight:
        loaded = load_card(card["id"])
        if not loaded:
            continue
        artist = (loaded.get("illustrator") or loaded.get("artist") or "").strip()
        if not artist:
            continue
        if not names_ok(row["name"], loaded.get("name") or ""):
            continue
        detail = loaded
        break
    if not detail:
        return None, "no_illustrator"
    return {
        "ct_id": row["ct_id"],
        "artist": detail.get("illustrator") or detail.get("artist"),
        "source_card_id": detail.get("id"),
        "name": row["name"],
    }, "ok"


stats = {"missing": len(missing), "ok": 0, "fail": 0, "reasons": {}}
fills = []
with ThreadPoolExecutor(max_workers=6) as pool:
    futures = {pool.submit(match_row, row): row for row in missing}
    for future in as_completed(futures):
        hit, reason = future.result()
        if hit:
            stats["ok"] += 1
            fills.append(hit)
        else:
            stats["fail"] += 1
            stats["reasons"][reason] = stats["reasons"].get(reason, 0) + 1

print(json.dumps({**stats, "fills": len(fills), "apply": APPLY, "sample": fills[:8]}, indent=2, default=str))
Path("/tmp/fill-missing-artists-tcgdex.json").write_text(json.dumps({"stats": stats, "fills": fills}, indent=2) + "\n")

if not APPLY or not fills:
    raise SystemExit(0)

values = []
for row in fills:
    artist = row["artist"]
    norm = re.sub(r"\s+", " ", artist).strip().lower()
    values.append(
        f"({row['ct_id']}, {row['ct_id']}, {sql_literal(artist)}, {sql_literal(artist)}, {sql_literal(norm)}, "
        f"'tcgdex', {sql_literal(row['source_card_id'])}, {sql_literal(f'{TCGDEX}/cards/{row['source_card_id']}')}, "
        f"0.88, 'tcgdex_set_collector', {sql_literal(json.dumps({'sourceCard': {'id': row['source_card_id']}}))})"
    )

psql("ALTER TABLE marketplace_blueprint_artists DISABLE TRIGGER marketplace_blueprint_artists_copy_same_art;")
for offset in range(0, len(values), 400):
    chunk = values[offset : offset + 400]
    psql(
        """
INSERT INTO marketplace_blueprint_artists (
  blueprint_id, ct_id, artist, illustrator, normalized_artist, source, source_card_id, source_url, confidence, match_reason, raw_metadata
) VALUES
"""
        + ",\n".join(chunk)
        + "\nON CONFLICT (blueprint_id) DO NOTHING;"
    )
    print(f"inserted {min(offset + len(chunk), len(values))}/{len(values)}", flush=True)
psql("ALTER TABLE marketplace_blueprint_artists ENABLE TRIGGER marketplace_blueprint_artists_copy_same_art;")
copied = psql("SELECT public.marketplace_copy_same_art_artists();").strip()
try:
    counts = psql("SELECT public.refresh_marketplace_artist_card_counts();").strip()
except SystemExit as error:
    counts = str(error)[:200]
print(json.dumps({"copied": copied, "counts": counts}, indent=2))
