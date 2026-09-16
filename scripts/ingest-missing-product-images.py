#!/usr/bin/env python3
"""Pull CardTrader full photos onto leftover CDN keys.

Sealed / accessory blueprints often land with only a CardTrader preview_
URL and no leftover JPEG, so the desk paints missing-card.webp. New-set
singles can sit on the 186×260 `card_uploader` JPEG until CardTrader
uploads the scan — same missing-card on the set desk.

Never hotlink CardTrader from the SPA. Encode homepage webp here (not on
the Pi). Set `POKOIN_INGEST_EXPANSION=World Championship Decks 2025` to
refresh one set's singles from blueprint `image.url` / `show` (PNG or JPEG).
After leftovers land, CLIP same-art groups those name buckets on nezopt 15T
unless `POKOIN_SKIP_VERSION_MATCH=1`. Placeholder sweeps skip CLIP.
Set `POKOIN_INGEST_PLACEHOLDERS=1` to replace every leftover JPEG on the Pi
that is still the 186×260 CardTrader logo (same key, full slug from the
filename — `{ct_id}-{leftover-slug}.jpg` on CardTrader). CardTrader GET runs
on Oracle `pokoin-marketplace` (home IP is rate-limited). Pillow JPEG/webp
stays on nezopt. Do not HUP `pokoin-card-images` after rsync (HUP stops the
Node process).
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HOST = os.environ.get("POKOIN_PI_HOST", "pi-home")
OUT = Path(os.environ.get("POKOIN_PRODUCT_IMAGE_DIR", "/tmp/pokoin-product-images"))
PI_OBJECTS = os.environ.get("POKOIN_PI_OBJECTS", "/srv/pokoin/card-images/objects")
REPLICA_OBJECTS = Path(
    os.environ.get(
        "POKOIN_REPLICA_OBJECTS",
        "/home/nez/data/pokoin-leftovers/objects",
    )
)
EXPANSION = os.environ.get("POKOIN_INGEST_EXPANSION", "").strip()
IDS = [
    int(part)
    for part in os.environ.get("POKOIN_INGEST_IDS", "").split(",")
    if part.strip().isdigit()
]
_ID_FILE = os.environ.get("POKOIN_INGEST_ID_FILE", "").strip()
if _ID_FILE:
    IDS.extend(
        int(part)
        for part in Path(_ID_FILE).read_text().replace("\n", ",").split(",")
        if part.strip().isdigit()
    )
IDS = sorted(set(IDS))
PLACEHOLDERS = os.environ.get("POKOIN_INGEST_PLACEHOLDERS", "").strip().lower() in {
    "1",
    "true",
    "yes",
}
PLACEHOLDER_MAX_BYTES = int(os.environ.get("POKOIN_PLACEHOLDER_MAX_BYTES", "20000"))
PLACEHOLDER_BYTES = int(os.environ.get("POKOIN_PLACEHOLDER_BYTES", "7920"))
# 186×260 is the CardTrader logo. 255×361 leftovers are old catalog thumbs.
# 312×437 leftovers are another tiny catalog thumb (SV Magnemite 241905);
# CardTrader full is ~749×1050. Desk upscales both; MIN_SCAN_WIDTH treats
# them as placeholders so ingest can replace them.
MIN_SCAN_WIDTH = int(os.environ.get("POKOIN_MIN_SCAN_WIDTH", "400"))
CT_FETCH_HOST = os.environ.get("POKOIN_CT_FETCH_HOST", "pokoin-marketplace")
CT_FETCH_WORKERS = int(os.environ.get("POKOIN_CT_FETCH_WORKERS", "4"))
PG_CONTAINER = os.environ.get("POKOIN_MARKETPLACE_POSTGRES", "pokoin-marketplace-postgres-15t")
VERSION_MATCH_PYTHON = os.environ.get(
    "POKOIN_VERSION_MATCH_PYTHON",
    "/home/nez/Projects/ai-toolkit/venv/bin/python",
)
VERSION_MATCH_SCRIPT = Path(
    os.environ.get(
        "POKOIN_VERSION_MATCH_SCRIPT",
        "/home/nez/Projects/pokemon-card-extension/scripts/cluster-name-version-sets.py",
    )
)
REF = int(os.environ.get("HOMEPAGE_IMAGE_REFERENCE_WIDTH", "240"))
QUALITY = int(os.environ.get("HOMEPAGE_IMAGE_QUALITY", "82"))
UA = "Pokoin leftover ingest (https://pokoin.com)"
SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20"]

CTX = ssl.create_default_context()

MISSING_SQL = r"""
COPY (
  SELECT
    card_id::text,
    ct_id::text,
    name,
    expansion_name,
    product_type,
    item_kind,
    image_url
  FROM public.marketplace_search_candidates
  WHERE coalesce(cdn_image_url, '') = ''
    AND image_url LIKE '%cardtrader.com%'
    AND (
      item_kind = 'product'
      OR expansion_name ~* 'product'
      OR product_type NOT IN ('card', '')
    )
  ORDER BY expansion_name, name, card_id
) TO STDOUT WITH CSV HEADER
"""


def name_slug(name: str) -> str:
    text = str(name or "").strip().lower().replace("'", "").replace("’", "")
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def leftover_key(ct_id: str, name: str, image_url: str = "") -> str:
    ct_id = str(ct_id or "").strip()
    match = re.search(
        rf"(?:^|/)(?:card-images/)?{re.escape(ct_id)}_([^/?#]+)\.(?:jpe?g|png|webp)",
        str(image_url or ""),
        re.I,
    )
    if match:
        stem = re.sub(r"_homepage$", "", match.group(1), flags=re.I)
        if ct_id and stem:
            return f"{ct_id}_{stem}.jpg"
    slug = name_slug(name)
    if not ct_id or not slug:
        return ""
    return f"{ct_id}_{slug}.jpg"


def abs_cardtrader(url: str) -> str:
    text = str(url or "").strip()
    if not text:
        return ""
    if text.startswith("http://") or text.startswith("https://"):
        return text
    if text.startswith("/"):
        return f"https://cardtrader.com{text}"
    return f"https://cardtrader.com/{text}"


def full_urls(preview_url: str) -> list[str]:
    text = abs_cardtrader(preview_url)
    if not text:
        return []
    out: list[str] = []

    def add(url: str) -> None:
        url = abs_cardtrader(url)
        if url and url not in out:
            out.append(url)

    add(text.replace("/preview_", "/").replace("preview_", "", 1) if "preview_" in text else "")
    if "/preview_" in text:
        add(text.replace("/preview_", "/show_"))
    elif "preview_" in text.rsplit("/", 1)[-1]:
        head, name = text.rsplit("/", 1)
        add(f"{head}/{name.replace('preview_', 'show_', 1)}")
    if "preview_" not in text.rsplit("/", 1)[-1]:
        add(text)
    return [url for url in out if url]


def blueprint_urls(ct_id: str, slug: str) -> list[str]:
    ct_id = str(ct_id or "").strip()
    slug = str(slug or "").strip().strip("-")
    if not ct_id or not slug:
        return []
    base = f"https://www.cardtrader.com/uploads/blueprints/image/{ct_id}"
    names = (
        f"{ct_id}-{slug}.jpg",
        f"show_{ct_id}-{slug}.jpg",
        f"{ct_id}-{slug}(2).jpg",
        f"show_{ct_id}-{slug}(2).jpg",
        f"{slug}.jpg",
        f"show_{slug}.jpg",
        f"{slug}(2).jpg",
        f"show_{slug}(2).jpg",
        f"{ct_id}-{slug}.png",
        f"show_{ct_id}-{slug}.png",
        f"{ct_id}-{slug}.webp",
        f"show_{ct_id}-{slug}.webp",
    )
    return [f"{base}/{name}" for name in names]


def candidate_urls(row: dict) -> list[str]:
    image = str(row.get("image_url") or "")
    cdn = str(row.get("cdn_image_url") or image)
    ct_id = str(row.get("ct_id") or "").strip()
    key = leftover_key(ct_id, row.get("name") or "", cdn or image)
    stem = (
        key[len(ct_id) + 1 : -4]
        if ct_id and key.startswith(f"{ct_id}_") and key.endswith(".jpg")
        else name_slug(row.get("name") or "")
    )
    out: list[str] = []
    for url in (
        abs_cardtrader(row.get("full_url") or ""),
        abs_cardtrader(row.get("show_url") or ""),
        *blueprint_urls(ct_id, stem),
        *blueprint_urls(ct_id, name_slug(row.get("name") or "")),
        *full_urls(row.get("full_url") or ""),
        *full_urls(row.get("show_url") or ""),
        *full_urls(image),
    ):
        if not url or url in out:
            continue
        if "preview_" in url.rsplit("/", 1)[-1]:
            continue
        if "cardtrader.com" not in url.lower() and "blueprint" not in url.lower():
            continue
        out.append(url)
    return out


def fetch(url: str) -> bytes | None:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "image/png,image/jpeg,image/webp,image/*"},
    )
    try:
        with urllib.request.urlopen(req, timeout=25, context=CTX) as response:
            if response.status != 200:
                return None
            ctype = str(response.headers.get("Content-Type") or "").lower()
            if "image/" not in ctype:
                return None
            data = response.read()
            return data or None
    except (urllib.error.URLError, TimeoutError, ssl.SSLError, urllib.error.HTTPError):
        return None


def fetch_first(urls: list[str]) -> bytes | None:
    for url in urls:
        data = fetch(url)
        if data and len(data) > 9000:
            return data
    return None


def oracle_fetch_worker() -> int:
    jobs_path = Path(os.environ.get("POKOIN_CT_FETCH_JOBS", "/tmp/pokoin-ct-fetch-jobs.json"))
    out = Path(os.environ.get("POKOIN_CT_FETCH_OUT", "/tmp/pokoin-ct-fetch-out"))
    out.mkdir(parents=True, exist_ok=True)
    jobs = json.loads(jobs_path.read_text())
    keys = list(jobs.keys())
    saved = failed = 0

    def one(key: str) -> tuple[str, bool]:
        data = fetch_first(jobs.get(key) or [])
        if not data:
            return key, False
        (out / key).write_bytes(data)
        return key, True

    workers = max(1, min(CT_FETCH_WORKERS, 4))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(one, key) for key in keys]
        for index, fut in enumerate(as_completed(futures), 1):
            key, ok = fut.result()
            if ok:
                saved += 1
            else:
                failed += 1
            if index % 25 == 0 or index == len(keys):
                print(f"oracle_fetch {index}/{len(keys)} saved={saved} fail={failed}", flush=True)
    print(f"oracle_fetch_done saved={saved} fail={failed} out={out}", flush=True)
    return 0


def prefetch_cardtrader(jobs: dict[str, list[str]]) -> dict[str, bytes]:
    if not jobs:
        return {}
    if not CT_FETCH_HOST:
        return {key: data for key, urls in jobs.items() if (data := fetch_first(urls))}
    jobs_path = Path("/tmp/pokoin-ct-fetch-jobs.json")
    jobs_path.write_text(json.dumps(jobs))
    script = Path(__file__).resolve()
    remote_script = "/tmp/ingest-missing-product-images.py"
    subprocess.run(["scp", *SSH_OPTS, str(script), f"{CT_FETCH_HOST}:{remote_script}"], check=True)
    subprocess.run(["scp", *SSH_OPTS, str(jobs_path), f"{CT_FETCH_HOST}:/tmp/pokoin-ct-fetch-jobs.json"], check=True)
    subprocess.run(
        ["ssh", *SSH_OPTS, CT_FETCH_HOST, "python3", remote_script, "--oracle-fetch"],
        check=True,
    )
    raw = Path("/tmp/pokoin-ct-fetch-out")
    raw.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["rsync", "-a", "--info=stats1", f"{CT_FETCH_HOST}:/tmp/pokoin-ct-fetch-out/", f"{raw}/"],
        check=True,
    )
    bodies: dict[str, bytes] = {}
    for path in raw.iterdir():
        if path.is_file() and path.stat().st_size > 9000:
            bodies[path.name] = path.read_bytes()
    print(f"oracle_bodies={len(bodies)}/{len(jobs)}", flush=True)
    return bodies


def write_jpeg(dest: Path, data: bytes) -> bool:
    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.size == (186, 260) or image.size[0] < MIN_SCAN_WIDTH:
                return False
            image.convert("RGB").save(dest, "JPEG", quality=92, optimize=True)
        return dest.exists() and dest.stat().st_size > 9000
    except Exception as exc:
        print(f"jpeg fail {dest.name}: {exc}", file=sys.stderr)
        return False


def is_placeholder(path: Path) -> bool:
    from PIL import Image

    try:
        with Image.open(path) as image:
            return image.size == (186, 260) or image.size[0] < MIN_SCAN_WIDTH
    except Exception:
        return True


def write_homepage(jpg_path: Path) -> Path | None:
    from PIL import Image

    dest = jpg_path.with_name(jpg_path.stem + "_homepage.webp")
    try:
        with Image.open(jpg_path) as image:
            image = image.convert("RGB")
            width, height = image.size
            if width > REF:
                height = max(1, round(height * REF / width))
                image = image.resize((REF, height), Image.LANCZOS)
            image.save(dest, "WEBP", quality=QUALITY, method=6)
        return dest
    except Exception as exc:
        print(f"webp fail {jpg_path.name}: {exc}", file=sys.stderr)
        return None


def dump_sql() -> str:
    if IDS:
        needles = ",".join(str(n) for n in IDS)
        return f"""
COPY (
  SELECT
    c.card_id::text,
    c.ct_id::text,
    c.name,
    c.set_name as expansion_name,
    c.product_type,
    c.item_kind,
    coalesce(c.cdn_image_url, c.image_url) as image_url,
    coalesce(c.cdn_image_url, '') as cdn_image_url,
    b.blueprint->'image'->>'url' as full_url,
    b.blueprint->'image'->'show'->>'url' as show_url
  FROM public.marketplace_search_candidates c
  LEFT JOIN public.cardtrader_pokemon_blueprints b
    ON b.id = c.ct_id
  WHERE c.item_kind = 'single'
    AND (c.ct_id IN ({needles}) OR c.card_id IN ({needles}))
  ORDER BY c.card_id
) TO STDOUT WITH CSV HEADER
"""
    if not EXPANSION:
        return MISSING_SQL
    needle = EXPANSION.replace("'", "''")
    return f"""
COPY (
  SELECT
    c.card_id::text,
    c.ct_id::text,
    c.name,
    c.set_name as expansion_name,
    c.product_type,
    c.item_kind,
    coalesce(c.cdn_image_url, c.image_url) as image_url,
    coalesce(c.cdn_image_url, '') as cdn_image_url,
    b.blueprint->'image'->>'url' as full_url,
    b.blueprint->'image'->'show'->>'url' as show_url
  FROM public.marketplace_search_candidates c
  LEFT JOIN public.cardtrader_pokemon_blueprints b
    ON b.id = c.ct_id
  WHERE (
      c.set_name ILIKE '%{needle}%'
      OR c.expansion_name ILIKE '%{needle}%'
    )
    AND c.item_kind = 'single'
  ORDER BY c.card_id
) TO STDOUT WITH CSV HEADER
"""


def placeholder_rows_from_pi() -> list[dict]:
    """Leftover JPEGs that are still the CardTrader 186×260 logo (~7920 bytes)."""
    remote = (
        f"find {PI_OBJECTS} -maxdepth 1 -type f -name '*.jpg' "
        f"-size {PLACEHOLDER_BYTES}c -printf '%f\\n'"
    )
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", HOST, remote],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(result.stderr.decode() or "pi leftover list failed")
    rows: list[dict] = []
    seen: set[str] = set()
    for line in result.stdout.decode().splitlines():
        name = line.strip()
        match = re.match(r"^(\d+)_(.+)\.jpg$", name, re.I)
        if not match:
            continue
        ct_id, stem = match.group(1), match.group(2)
        if stem.endswith("_homepage") or ct_id in seen:
            continue
        seen.add(ct_id)
        rows.append(
            {
                "card_id": str(int(ct_id) * 2),
                "ct_id": ct_id,
                "name": stem.replace("-", " "),
                "expansion_name": "",
                "product_type": "card",
                "item_kind": "single",
                "image_url": name,
                "cdn_image_url": name,
            }
        )
    rows.sort(key=lambda row: int(row["ct_id"]))
    return rows


def psql_copy(sql: str) -> list[dict]:
    result = subprocess.run(
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
        input=sql.encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        result = subprocess.run(
            [
                "ssh",
                "-o",
                "BatchMode=yes",
                HOST,
                "docker exec -i pokoin-marketplace-postgres-replica psql -U pokoin_marketplace -d pokoin_marketplace -v ON_ERROR_STOP=1",
            ],
            input=sql.encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    if result.returncode != 0:
        raise SystemExit(result.stderr.decode() or "psql dump failed")
    return list(csv.DictReader(io.StringIO(result.stdout.decode())))


def dump_rows() -> list[dict]:
    return psql_copy(dump_sql())


def enrich_blueprint_urls(rows: list[dict]) -> list[dict]:
    ids = sorted({str(row.get("ct_id") or "").strip() for row in rows if str(row.get("ct_id") or "").isdigit()})
    if not ids:
        return rows
    sql = f"""
COPY (
  SELECT
    b.id::text AS ct_id,
    b.blueprint->'image'->>'url' AS full_url,
    b.blueprint->'image'->'show'->>'url' AS show_url
  FROM public.cardtrader_pokemon_blueprints b
  WHERE b.id IN ({",".join(ids)})
) TO STDOUT WITH CSV HEADER
"""
    extra = {row["ct_id"]: row for row in psql_copy(sql)}
    for row in rows:
        found = extra.get(str(row.get("ct_id") or "").strip()) or {}
        if found.get("full_url") and not row.get("full_url"):
            row["full_url"] = found["full_url"]
        if found.get("show_url") and not row.get("show_url"):
            row["show_url"] = found["show_url"]
    return rows


def has_cardtrader_scan(row: dict) -> bool:
    for url in (row.get("full_url"), row.get("show_url")):
        text = abs_cardtrader(url or "")
        if not text:
            continue
        name = text.rsplit("/", 1)[-1]
        if "preview_" in name or "card_uploader" in text:
            continue
        return True
    return False


def replica_has_scan(key: str) -> bool:
    path = REPLICA_OBJECTS / key
    if not path.is_file() or path.stat().st_size <= PLACEHOLDER_MAX_BYTES:
        return False
    return not is_placeholder(path)


def ingest(rows: list[dict]) -> tuple[int, int, int]:
    OUT.mkdir(parents=True, exist_ok=True)
    jobs: dict[str, list[str]] = {}
    planned: list[tuple[dict, str, Path]] = []
    saved = skipped = failed = 0
    for row in rows:
        key = leftover_key(row.get("ct_id") or "", row.get("name") or "", row.get("image_url") or "")
        if not key:
            failed += 1
            continue
        dest = OUT / key
        replica = REPLICA_OBJECTS / key
        existing = dest if dest.exists() else replica if replica.exists() else None
        if (
            existing
            and existing.stat().st_size > PLACEHOLDER_MAX_BYTES
            and not is_placeholder(existing)
        ):
            if not dest.with_name(dest.stem + "_homepage.webp").exists() and dest.exists():
                write_homepage(dest)
            skipped += 1
            continue
        urls = candidate_urls(row)
        if not urls:
            print(f"miss {row.get('ct_id')} {row.get('name')}", file=sys.stderr)
            failed += 1
            continue
        jobs[key] = urls
        planned.append((row, key, dest))
    print(f"cardtrader_jobs={len(jobs)} host={CT_FETCH_HOST or 'local'}", flush=True)
    bodies = prefetch_cardtrader(jobs)
    for index, (row, key, dest) in enumerate(planned, 1):
        data = bodies.get(key)
        if not data:
            print(f"miss {row.get('ct_id')} {row.get('name')}", file=sys.stderr)
            failed += 1
            continue
        if not write_jpeg(dest, data):
            print(f"placeholder {row.get('ct_id')} {row.get('name')}", file=sys.stderr)
            failed += 1
            continue
        write_homepage(dest)
        saved += 1
        if index % 25 == 0 or saved <= 5:
            print(f"{index}/{len(planned)} saved={saved} skip={skipped} fail={failed} {key}", flush=True)
    return saved, skipped, failed


def push() -> None:
    subprocess.run(
        [
            "rsync",
            "-a",
            "--info=stats1",
            f"{OUT}/",
            f"{HOST}:{PI_OBJECTS}/",
        ],
        check=True,
    )
    if REPLICA_OBJECTS.is_dir():
        subprocess.run(
            ["rsync", "-a", "--info=stats1", f"{OUT}/", f"{REPLICA_OBJECTS}/"],
            check=True,
        )
    # Do not HUP pokoin-card-images: HUP stops the Node process.


def write_replaced_ids(rows: list[dict], saved: int) -> None:
    if not saved:
        return
    ids = sorted(
        {
            int(row["ct_id"])
            for row in rows
            if str(row.get("ct_id") or "").isdigit()
            and (OUT / leftover_key(row.get("ct_id") or "", row.get("name") or "", row.get("image_url") or "")).exists()
            and (OUT / leftover_key(row.get("ct_id") or "", row.get("name") or "", row.get("image_url") or "")).stat().st_size
            > PLACEHOLDER_MAX_BYTES
        }
    )
    dest = Path(os.environ.get("POKOIN_PLACEHOLDER_ID_FILE", "/tmp/pokoin-placeholder-ingest-ids.json"))
    dest.write_text("[" + ",".join(str(n) for n in ids) + "]\n")
    print(f"replaced_ids={len(ids)} {dest}", flush=True)


def version_match_argv(expansion: str = "", ids: list[int] | None = None) -> list[str]:
    """CLIP same-art groups for leftover ingest. 7900 XTX, apply on 15T."""
    cmd = [VERSION_MATCH_PYTHON, str(VERSION_MATCH_SCRIPT), "--refresh-candidates"]
    needle = str(expansion or "").strip()
    if needle:
        cmd.extend(["--expansion", needle])
        return cmd
    found = sorted({int(n) for n in ids or [] if int(n) > 0})
    if not found:
        return []
    cmd.extend(["--ids", ",".join(str(n) for n in found)])
    return cmd


def match_imported_version_sets(rows: list[dict]) -> None:
    if PLACEHOLDERS:
        return
    skip = os.environ.get("POKOIN_SKIP_VERSION_MATCH", "").strip().lower()
    if skip in {"1", "true", "yes"}:
        print("skip version match", flush=True)
        return
    ids = [int(row["card_id"]) for row in rows if str(row.get("card_id") or "").isdigit()]
    cmd = version_match_argv(EXPANSION, ids)
    if not cmd:
        return
    env = os.environ.copy()
    env.setdefault("HIP_VISIBLE_DEVICES", "0")
    print("version match " + " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, env=env)


def main() -> int:
    rows = placeholder_rows_from_pi() if PLACEHOLDERS else dump_rows()
    if PLACEHOLDERS:
        rows = enrich_blueprint_urls(rows)
        rows = [row for row in rows if has_cardtrader_scan(row)]
    print(f"missing_rows={len(rows)} out={OUT}", flush=True)
    saved, skipped, failed = ingest(rows)
    print(f"done saved={saved} skip={skipped} fail={failed}", flush=True)
    write_replaced_ids(rows, saved)
    if saved or skipped:
        push()
        print("pushed to Pi leftover objects", flush=True)
        match_imported_version_sets(rows)
    return 0 if saved or skipped else 1


if __name__ == "__main__":
    if "--oracle-fetch" in sys.argv:
        raise SystemExit(oracle_fetch_worker())
    raise SystemExit(main())
