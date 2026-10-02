#!/usr/bin/env python3
"""Import a complete card catalog for a Cardmarket-only game into its Pokoin DB.

The nine games in docs/CARDMARKET_GAMES.md have no CardTrader catalog. Their
`pokoin_<game>` databases (nezopt writer, streamed to the Pi replica) were
first filled from 2019 Wayback snapshots of Cardmarket listings: a thin sample
with almost no images. This script replaces that with full catalogs from free
public sources (see scripts/catalog/sources.py), keeping any Cardmarket
product id the Wayback rows carried.

    python scripts/catalog/import_catalog.py final_fantasy            # dry run
    python scripts/catalog/import_catalog.py final_fantasy --images --apply

Steps with --apply:
  1. upsert rows into <schema>.cardmarket_products (stable synthetic ids);
  2. carry Wayback Cardmarket ids onto matching rows, then drop the Wayback
     rows that a full source replaces (--replace-wayback, default on when the
     source is complete);
  3. images (--images): download, keep high resolution (<= 1050 px tall)
     JPEG + 240 px `_homepage.webp`, rsync to the Pi CDN objects/<prefix>/;
  4. drop candidates whose raw row is gone, then
     refresh_cardmarket_marketplace_projections().

Run with ~/.venvs/pokoin-catalog/bin/python (Pillow + requests).
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sources  # noqa: E402

CONTAINER = os.environ.get("POKOIN_WRITER_CONTAINER", "pokoin-marketplace-postgres-15t")
PGUSER = os.environ.get("POKOIN_WRITER_USER", "pokoin_marketplace")
CATALOG_DIR = Path(os.environ.get("POKOIN_CATALOG_DIR", str(Path.home() / "pokoin-catalogs")))
PI_HOST = os.environ.get("POKOIN_CDN_HOST", "pi-home")
PI_OBJECTS = os.environ.get("POKOIN_CDN_OBJECTS", "/srv/pokoin/card-images/objects")
PI_OWNER = os.environ.get("POKOIN_CDN_OWNER", "nes:nes")
CDN_BASE = "https://cdn.pokoin.com"
# Ids are allocated sequentially from ID_FIRST and kept per source key (stored
# on the row as blueprint.source_key). Public card id = id * 2 must stay below
# 999_000_000: the site reads larger ids as provisional Storm Emeralda stamps
# (workers/public-card-id.js PROVISIONAL_PUBLIC_OFFSET) and rewrites them.
ID_FIRST = 100_000_000  # above every Cardmarket idProduct
ID_LAST = 499_000_000
FULL_MAX_HEIGHT = 1050
HOMEPAGE_WIDTH = 240
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36 PokoinCatalog/1.0"

GAMES = {
    "weiss_schwarz": "weiss-schwarz",
    "final_fantasy": "final-fantasy",
    "force_of_will": "force-of-will",
    "world_of_warcraft": "world-of-warcraft",
    "battle_spirits_saga": "battle-spirits-saga",
    "star_wars_destiny": "star-wars-destiny",
    "dragon_born": "dragon-born",
    "my_little_pony": "my-little-pony",
    "the_spoils": "the-spoils",
}


def log(*parts):
    print(*parts, flush=True)


def existing_rows(db: str, schema: str) -> dict[str, dict]:
    """source_key -> stored id, Cardmarket ids and image keys of imported rows."""
    out = psql(db, f"""select coalesce(json_agg(json_build_object(
        'key', blueprint->>'source_key', 'id', id, 'cm', card_market_ids,
        'full', cdn_object_key, 'home', homepage_object_key)), '[]')
      from {schema}.cardmarket_products where blueprint ? 'source_key'""")
    rows: dict[str, dict] = {}
    for row in json.loads(out.strip() or "[]"):
        key = row.get("key")
        if not key:
            continue
        current = rows.get(key)
        # A rerun after a partial renumber sees both ids: keep the in-range one.
        if current is None or not (ID_FIRST <= int(current["id"]) <= ID_LAST):
            rows[key] = row
    return rows


def allocate_ids(cards: list[dict], existing: dict[str, dict]) -> dict[str, int]:
    """Keep every in-range id already stored for a key; number new keys after the max."""
    ids: dict[str, int] = {}
    for card in cards:
        old = existing.get(str(card["key"]))
        if old and ID_FIRST <= int(old["id"]) <= ID_LAST:
            ids[str(card["key"])] = int(old["id"])
    next_id = max([ID_FIRST - 1, *ids.values()]) + 1
    order = sorted(
        (c for c in cards if str(c["key"]) not in ids),
        key=lambda c: (str(c.get("set_name") or ""), str(c.get("collector") or ""), str(c["key"])),
    )
    for card in order:
        if next_id > ID_LAST:
            raise SystemExit("id range exhausted")
        ids[str(card["key"])] = next_id
        next_id += 1
    return ids


def slugify(value: str, limit: int = 80) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return (text[:limit].strip("-")) or "card"


def compact(value: str) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "", text)


def wayback_name_key(name: str) -> str:
    # Cardmarket appends "(V.1 - Rare)" style version tags to names.
    return compact(re.sub(r"\s*\((?:V\.\s*\d+[^)]*|[^)]*Rare[^)]*)\)\s*$", "", str(name or "")))


def psql(db: str, sql: str, stdin: str | None = None) -> str:
    # SQL goes over stdin: a 66k-id array overflows the argument list.
    cmd = ["docker", "exec", "-i", CONTAINER, "psql", "-U", PGUSER, "-d", db, "-v", "ON_ERROR_STOP=1", "-At", "-q"]
    script = sql.rstrip().rstrip(";") + ";\n" + (stdin or "")
    proc = subprocess.run(cmd, input=script, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"psql {db} failed: {proc.stderr.strip()[:2000]}")
    return proc.stdout


def build_rows(game: str, cards: list[dict], ids: dict[str, int]) -> list[dict]:
    prefix = GAMES[game]
    rows, seen = [], {}
    for card in cards:
        key = str(card["key"])
        row_id = ids[key]
        if row_id in seen:
            if seen[row_id] != key:
                raise SystemExit(f"id collision {row_id}: {seen[row_id]} vs {key}")
            continue
        seen[row_id] = key
        file_stem = f"{row_id}_{slugify(card['name'])}"
        fixed = {"collector_number": card.get("collector") or "", "cm_rarity": card.get("rarity") or ""}
        if card.get("language"):
            fixed["language"] = card["language"]
        rows.append({
            "id": row_id,
            "name": card["name"],
            "version": card.get("version") or None,
            "category_id": 1,
            "image_url": card.get("image_url") or None,
            "image_fallback": card.get("image_fallback") or None,
            "image_referer": card.get("image_referer") or None,
            "expansion": {"name": card.get("set_name") or "Unknown", "code": card.get("set_code") or ""},
            "blueprint": {
                "source": card["source"],
                "source_key": key,
                "source_url": card.get("source_url") or "",
                "fixed_properties": fixed,
                "attributes": card.get("attributes") or {},
            },
            "cdn_object_key": f"{prefix}/{file_stem}.jpg",
            "homepage_object_key": f"{prefix}/{file_stem}_homepage.webp",
            "card_market_ids": [],
        })
    return rows


def wayback_rows(db: str, schema: str) -> list[dict]:
    out = psql(db, f"""select coalesce(json_agg(json_build_object(
        'id', id, 'name', name, 'set', expansion->>'name',
        'rarity', blueprint->'fixed_properties'->>'cm_rarity')), '[]')
      from {schema}.cardmarket_products where blueprint->>'source' = 'cardmarket-wayback'""")
    return json.loads(out.strip() or "[]")


def carry_cardmarket_ids(rows: list[dict], wayback: list[dict]) -> int:
    by_key: dict[tuple[str, str], list[dict]] = {}
    by_name: dict[str, list[dict]] = {}
    for row in rows:
        name_key = wayback_name_key(row["name"])
        by_key.setdefault((name_key, compact(row["expansion"]["name"])), []).append(row)
        by_name.setdefault(name_key, []).append(row)
    by_code: dict[str, list[dict]] = {}
    for row in rows:
        code = compact(row["blueprint"]["fixed_properties"].get("collector_number") or "")
        if code:
            by_code.setdefault(code, []).append(row)
            # FF codes carry a rarity letter (3-020H); Cardmarket names omit it.
            by_code.setdefault(re.sub(r"[a-z]+$", "", code), []).append(row)
    matched = 0
    for old in wayback:
        name_key = wayback_name_key(old["name"])
        hits = []
        paren = re.search(r"\(([^()]*\d[^()]*)\)\s*$", str(old["name"] or ""))
        if paren:
            code_hits = by_code.get(compact(paren.group(1))) or []
            base = compact(re.sub(r"\s*\([^()]*\)\s*$", "", old["name"]))
            hits = [r for r in code_hits if compact(r["name"]) == base] or code_hits
        if not hits:
            hits = by_key.get((name_key, compact(old.get("set") or ""))) or []
        if not hits and len(by_name.get(name_key, [])) == 1:
            hits = by_name[name_key]
        if len(hits) != 1:
            continue
        ids = hits[0]["card_market_ids"]
        if old["id"] not in ids:
            ids.append(old["id"])
        matched += 1
    return matched


def fetch_bytes(url: str, attempts: int = 3, referer: str | None = None) -> bytes:
    import requests

    headers = {"User-Agent": USER_AGENT}
    if referer:
        # Wiki CDNs (Fandom) serve card art to their own pages only.
        headers["Referer"] = referer
    last = None
    for attempt in range(attempts):
        try:
            resp = requests.get(url, headers=headers, timeout=40)
            if resp.status_code == 200 and resp.content:
                return resp.content
            last = f"HTTP {resp.status_code}"
            if resp.status_code in (403, 404, 410):
                break
        except Exception as error:  # network hiccup: retry
            last = str(error)
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(last or "download failed")


def render_image(raw: bytes, full_path: Path, homepage_path: Path) -> tuple[int, int]:
    from PIL import Image

    with Image.open(io.BytesIO(raw)) as img:
        img.load()
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            base = Image.new("RGB", img.size, (255, 255, 255))
            base.paste(img, mask=img.split()[-1])
            img = base
        else:
            img = img.convert("RGB")
        if img.height > FULL_MAX_HEIGHT:
            width = round(img.width * FULL_MAX_HEIGHT / img.height)
            img = img.resize((width, FULL_MAX_HEIGHT), Image.LANCZOS)
        full_path.parent.mkdir(parents=True, exist_ok=True)
        img.save(full_path, "JPEG", quality=90, optimize=True, progressive=True)
        home_h = round(img.height * HOMEPAGE_WIDTH / img.width)
        img.resize((HOMEPAGE_WIDTH, home_h), Image.LANCZOS).save(homepage_path, "WEBP", quality=82, method=5)
        return img.width, img.height


def stage_images(game: str, rows: list[dict], concurrency: int) -> dict[int, str]:
    stage = CATALOG_DIR / game / "images"
    results: dict[int, str] = {}

    manifest_path = stage / "sources.json"
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError):
        manifest = {}

    def work(row):
        full = stage / row["cdn_object_key"]
        home = stage / row["homepage_object_key"]
        urls = [u for u in (row.get("image_url"), row.get("image_fallback")) if u]
        rendered = manifest.get(row["cdn_object_key"])
        # Re-render when a better source appeared since (e.g. EncoreDecks over ws-tcg.com).
        primary = urls[0] if urls else None
        legacy_same_source = rendered is None
        if full.exists() and home.exists() and full.stat().st_size > 0 and (rendered == primary or legacy_same_source):
            return row["id"], "cached"
        if not urls:
            return row["id"], "no-source"
        last = None
        for url in dict.fromkeys(urls):
            try:
                render_image(fetch_bytes(url, referer=row.get("image_referer")), full, home)
                manifest[row["cdn_object_key"]] = url
                return row["id"], "ok"
            except Exception as error:
                last = error
        return row["id"], f"failed: {last}"[:200]

    with cf.ThreadPoolExecutor(max_workers=concurrency) as pool:
        for done, (row_id, status) in enumerate(pool.map(work, rows), 1):
            results[row_id] = status
            if done % 250 == 0 or done == len(rows):
                ok = sum(1 for s in results.values() if s in ("ok", "cached"))
                log(f"[images] {game} {done}/{len(rows)} ok={ok}")
                manifest_path.parent.mkdir(parents=True, exist_ok=True)
                manifest_path.write_text(json.dumps(manifest))
    return results


def rename_local_images(game: str, renames: list[tuple[str, str]]) -> None:
    stage = CATALOG_DIR / game / "images"
    for old_key, new_key in renames:
        src, dst = stage / old_key, stage / new_key
        if src.exists() and not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            src.rename(dst)


def rename_pi_images(renames: list[tuple[str, str]]) -> None:
    script = "".join(
        f"[ -e {PI_OBJECTS}/{old} ] && [ ! -e {PI_OBJECTS}/{new} ] && mv {PI_OBJECTS}/{old} {PI_OBJECTS}/{new}\n"
        for old, new in renames
        if re.fullmatch(r"[a-z0-9/_.-]+", old) and re.fullmatch(r"[a-z0-9/_.-]+", new)
    )
    subprocess.run(["ssh", PI_HOST, "bash -s"], input=script + "true\n", text=True, check=True)


def push_images(game: str) -> None:
    prefix = GAMES[game]
    local = CATALOG_DIR / game / "images" / prefix
    if not local.exists():
        return
    subprocess.run(["ssh", PI_HOST, f"mkdir -p {PI_OBJECTS}/{prefix}"], check=True)
    subprocess.run(
        ["rsync", "-a", f"{local}/", f"{PI_HOST}:{PI_OBJECTS}/{prefix}/"],
        check=True,
    )
    subprocess.run(["ssh", PI_HOST, f"chown -R {PI_OWNER} {PI_OBJECTS}/{prefix}"], check=True)


def upsert(db: str, schema: str, rows: list[dict]) -> None:
    # COPY text format: one JSON document per line; backslashes are COPY escapes.
    payload = "".join(json.dumps(row, ensure_ascii=False).replace("\\", "\\\\") + "\n" for row in rows)
    script = (
        "begin;\n"
        "create temp table incoming (doc jsonb) on commit drop;\n"
        "copy incoming (doc) from stdin;\n"
        + payload
        + "\\.\n"
        + f"""
insert into {schema}.cardmarket_products as p (
  id, name, version, category_id, image_url, cdn_image_url, cdn_object_key,
  homepage_image_url, homepage_object_key, card_market_ids, editable_properties,
  blueprint, expansion, cardmarket, imported_at)
select (doc->>'id')::bigint, doc->>'name', doc->>'version', 1, doc->>'image_url',
  doc->>'cdn_image_url', doc->>'cdn_object_key', doc->>'homepage_image_url', doc->>'homepage_object_key',
  coalesce(doc->'card_market_ids', '[]'::jsonb), '[]'::jsonb, doc->'blueprint', doc->'expansion',
  jsonb_build_object('cardmarket_product_ids', coalesce(doc->'card_market_ids', '[]'::jsonb)), now()
from incoming
on conflict (id) do update set
  name = excluded.name,
  version = excluded.version,
  image_url = excluded.image_url,
  cdn_image_url = coalesce(excluded.cdn_image_url, p.cdn_image_url),
  cdn_object_key = coalesce(excluded.cdn_object_key, p.cdn_object_key),
  homepage_image_url = coalesce(excluded.homepage_image_url, p.homepage_image_url),
  homepage_object_key = coalesce(excluded.homepage_object_key, p.homepage_object_key),
  card_market_ids = excluded.card_market_ids,
  blueprint = excluded.blueprint,
  expansion = excluded.expansion,
  cardmarket = excluded.cardmarket,
  imported_at = now();
commit;
"""
    )
    proc = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", "-U", PGUSER, "-d", db, "-v", "ON_ERROR_STOP=1", "-q"],
        input=script,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"upsert failed: {proc.stderr.strip()[:2000]}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("game", choices=sorted(GAMES))
    parser.add_argument("--apply", action="store_true", help="write to the writer DB (default: dry run)")
    parser.add_argument("--images", action="store_true", help="download, render and push images to the Pi CDN")
    parser.add_argument("--keep-wayback", action="store_true", help="keep the 2019 Wayback rows")
    parser.add_argument("--limit", type=int, default=0, help="only the first N cards (testing)")
    parser.add_argument("--concurrency", type=int, default=8)
    args = parser.parse_args()

    game = args.game
    db = f"pokoin_{game}"
    schema = f"marketplace_{game}"
    prefix = GAMES[game]
    cache = CATALOG_DIR / game
    cache.mkdir(parents=True, exist_ok=True)

    cards, complete = sources.fetch(game, cache)
    if args.limit:
        cards = cards[: args.limit]
        complete = False  # a sample never supersedes the Wayback rows
    existing = existing_rows(db, schema)
    ids = allocate_ids(cards, existing)
    rows = build_rows(game, cards, ids)
    renames: list[tuple[str, str]] = []
    for row in rows:
        old = existing.get(row["blueprint"]["source_key"])
        if not old:
            continue
        for cm_id in old.get("cm") or []:
            if cm_id not in row["card_market_ids"]:
                row["card_market_ids"].append(cm_id)
        for old_key, new_key in ((old.get("full"), row["cdn_object_key"]), (old.get("home"), row["homepage_object_key"])):
            if old_key and old_key != new_key:
                renames.append((old_key, new_key))
    if renames:
        log(f"{game}: {len(renames) // 2} cards change id; renaming their image files")
        rename_local_images(game, renames)
    log(f"{game}: {len(rows)} cards from source ({'complete' if complete else 'partial'} catalog)")
    sets = sorted({r["expansion"]["name"] for r in rows})
    log(f"{game}: {len(sets)} sets, e.g. {sets[:5]}")
    with_img = sum(1 for r in rows if r.get("image_url"))
    log(f"{game}: {with_img}/{len(rows)} cards have a source image")

    wayback = wayback_rows(db, schema)
    matched = carry_cardmarket_ids(rows, wayback)
    log(f"{game}: {len(wayback)} Wayback rows, {matched} matched to source cards (Cardmarket id kept)")

    statuses: dict[int, str] = {}
    if args.images:
        statuses = stage_images(game, rows, args.concurrency)
        failed = [s for s in statuses.values() if s.startswith("failed") or s == "no-source"]
        log(f"{game}: images ok={len(statuses) - len(failed)} missing={len(failed)}")
    stage = CATALOG_DIR / game / "images"
    for row in rows:
        if (stage / row["cdn_object_key"]).exists():
            row["cdn_image_url"] = f"{CDN_BASE}/{row['cdn_object_key']}"
            row["homepage_image_url"] = f"{CDN_BASE}/{row['homepage_object_key']}"
        else:
            row["cdn_image_url"] = None
            row["homepage_image_url"] = None
            row["cdn_object_key"] = None
            row["homepage_object_key"] = None
            # No picture we can serve: keep the source for a later retry, but
            # leave image_url empty so the projection never lists a broken tile.
            row["blueprint"]["source_image_url"] = row.get("image_url") or ""
            row["image_url"] = None

    (cache / "rows.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
    if not args.apply:
        log(f"dry run: wrote {cache / 'rows.jsonl'}; rerun with --apply")
        return 0

    if renames:
        rename_pi_images(renames)
    if args.images:
        push_images(game)
        log(f"{game}: images pushed to {PI_HOST}:{PI_OBJECTS}/{prefix}/")
    upsert(db, schema, rows)
    if complete:
        keep = ",".join(str(r["id"]) for r in rows)
        gone = psql(db, f"""with d as (delete from {schema}.cardmarket_products
          where blueprint ? 'source_key' and id <> all(array[{keep}]::bigint[]) returning 1)
          select count(*) from d""")
        if gone.strip() not in ("", "0"):
            log(f"{game}: removed {gone.strip()} rows on retired ids")
    if complete and not args.keep_wayback and wayback:
        psql(db, f"delete from {schema}.cardmarket_products where blueprint->>'source' = 'cardmarket-wayback'")
        log(f"{game}: removed {len(wayback)} Wayback rows (superseded)")
    # Candidates whose raw row is gone, or no longer has a picture to show.
    psql(db, f"""delete from public.marketplace_search_candidates c
      where not exists (
        select 1 from {schema}.cardmarket_products p
        where p.id = c.ct_id
          and coalesce(p.cdn_image_url, p.preview_image_url, p.image_url) is not null)""")
    refreshed = psql(db, f"select public.refresh_cardmarket_marketplace_projections('{schema}', array[1], array['cm_rarity'])")
    psql(db, "select public.refresh_marketplace_set_catalog_counts()")
    counts = psql(db, f"""select count(*), count(*) filter (where cdn_image_url is not null)
      from public.marketplace_search_candidates""")
    log(f"{game}: projections refreshed ({refreshed.strip()}); candidates,imaged = {counts.strip()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
