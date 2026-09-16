#!/usr/bin/env python3
"""Pull missing expansion wordmarks from Serebii onto Pi leftover CDN.

Serebii hosts set logos at https://www.serebii.net/card/logo/{compact}.png
(altergenesis.png, abysseye.png). We keep Watchtower wordmarks and leftover
logos we already have. New files land on replica + pi-home
objects/expansions/logos/{slug}.png and fill empty
pokoin_pokemon_expansions.logo_image_url on nezopt 15T.

Do not write R2. Do not overwrite existing logos or wordmarks.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

UA = os.environ.get(
    "POKOIN_SEREBII_UA",
    "Mozilla/5.0 (compatible; PokoinBot/1.0; +https://pokoin.com)",
)
HOST = os.environ.get("POKOIN_PI_HOST", "pi-home")
PI_OBJECTS = os.environ.get("POKOIN_PI_OBJECTS", "/srv/pokoin/card-images/objects")
REPLICA_OBJECTS = Path(
    os.environ.get(
        "POKOIN_REPLICA_OBJECTS",
        "/home/nez/mnt/mybook/pokoin-pi-card-images/objects",
    )
)
CDN_BASE = os.environ.get("POKOIN_CARD_CDN_BASE_URL", "https://cdn.pokoin.com").rstrip("/")
PG_CONTAINER = os.environ.get("POKOIN_MARKETPLACE_POSTGRES", "pokoin-marketplace-postgres-15t")
EXPANSIONS_JSON = Path(os.environ.get("POKOIN_EXPANSIONS_JSON", "/tmp/pokoin-expansions.json"))
STAGING = Path(os.environ.get("POKOIN_SEREBII_LOGO_DIR", "/tmp/pokoin-serebii-logos"))
CTX = ssl.create_default_context()
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

SKIP_KEYS = {
    "bw",
    "champion",
    "classic",
    "dex",
    "dpt",
    "engpromo",
    "english",
    "ex",
    "first",
    "howtoplayds",
    "japanese",
    "jppromo",
    "neo",
    "popseries",
    "raidbattles",
    "sm",
    "swsh",
    "xy",
}

# Compact Serebii filename → Pokoin expansion slug when compact match fails.
ALIASES = {
    "arceus": "platinum-arceus",
    "base": "base-set",
    "blackbolt-jp": "black-bolt-sv11b",
    "blackwhite": "black-and-white",
    "deltareign": "delta-reign",
    "expedition": "expedition-base-set",
    "gloryofteamrocket": "the-glory-of-team-rocket",
    "heartgoldsoulsilver": "heartgold-and-soulsilver",
    "hotairarena": "heat-wave-arena",
    "pokemondetectivepikachu": "detective-pikachu",
    "pokemongo": "pokemon-tcg-pokemon-go",
    "scarletviolet": "scarlet-and-violet",
    "smpromo": "sm-black-star-promos",
    "smpromos": "sm-black-star-promos",
    "spromo": "s-p-sword-and-shield-promos",
    "sunmoon": "sun-and-moon",
    "svpromo": "sv-black-star-promos",
    "svpromos": "sv-black-star-promos",
    "swshpromo": "swsh-black-star-promos",
    "swshpromos": "swsh-black-star-promos",
    "swordshield": "sword-and-shield",
    "vs": "pokemon-vs",
    "whiteflare-jp": "white-flare-sv11w",
    "xypromo": "xy-black-star-promos",
    "xypromos": "xy-black-star-promos",
}

SERIES_PAGES = [
    "https://www.serebii.net/card/",
    "https://www.serebii.net/card/xy.shtml",
    "https://www.serebii.net/card/sm.shtml",
    "https://www.serebii.net/card/swsh.shtml",
    "https://www.serebii.net/card/bw.shtml",
    "https://www.serebii.net/card/dpt.shtml",
    "https://www.serebii.net/card/ex.shtml",
    "https://www.serebii.net/card/neo.shtml",
    "https://www.serebii.net/card/first.shtml",
    "https://www.serebii.net/card/popseries.shtml",
    "https://www.serebii.net/card/abysseye/",
    "https://www.serebii.net/card/sv/",
    "https://www.serebii.net/card/scarletviolet.shtml",
    "https://www.serebii.net/card/megaevolution.shtml",
]

VARIANT_RE = re.compile(
    r"reverse-holo|reverse holo|master-ball|master ball|poke-ball-reverse|"
    r"poké ball reverse|poke ball reverse",
    re.I,
)

WORDMARK_SLUGS = {
    "151",
    "ascended-heroes",
    "black-bolt",
    "chaos-rising",
    "destined-rivals",
    "journey-together",
    "mega-evolution",
    "obsidian-flames",
    "paldea-evolved",
    "paldean-fates",
    "paradox-rift",
    "perfect-order",
    "phantasmal-flames",
    "pitch-black",
    "prismatic-evolutions",
    "scarlet-and-violet",
    "shrouded-fable",
    "stellar-crown",
    "surging-sparks",
    "temporal-forces",
    "twilight-masquerade",
    "white-flare",
}


def compact(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def compact_no_and(value: str) -> str:
    slug = str(value or "").lower()
    slug = re.sub(r"-and-", "-", slug)
    slug = re.sub(r"\band\b", "", slug)
    return compact(slug)


def slugify(value: str) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower().replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:140]


def is_variant(slug: str, name: str = "") -> bool:
    return bool(VARIANT_RE.search(f"{slug} {name}"))


def http_get(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as resp:
        return resp.read()


def fetch_text(url: str) -> str:
    try:
        return http_get(url).decode("latin-1", "replace")
    except Exception as exc:
        print(f"warn fetch {url}: {exc}", flush=True)
        return ""


def extract_keys(html: str) -> set[str]:
    keys: set[str] = set()
    for match in re.finditer(r"/card/logo/([a-z0-9-]+)\.png", html, re.I):
        key = match.group(1).lower()
        if key.endswith("-th"):
            continue
        keys.add(key)
    for match in re.finditer(r'href=["\']/card/([a-z0-9-]+)/?["\']', html, re.I):
        key = match.group(1).lower()
        if key in {"logo", "image", "images"}:
            continue
        keys.add(key)
    return keys


def discover_keys() -> set[str]:
    keys: set[str] = set()
    for url in SERIES_PAGES:
        html = fetch_text(url)
        if not html:
            continue
        found = extract_keys(html)
        keys |= found
        print(f"serebii {url} +{len(found)} (total {len(keys)})", flush=True)
        time.sleep(0.25)
    return {key for key in keys if key not in SKIP_KEYS}


def load_catalog() -> list[dict]:
    if EXPANSIONS_JSON.is_file():
        payload = json.loads(EXPANSIONS_JSON.read_text())
        rows = payload.get("expansions") or payload
        if isinstance(rows, list) and rows:
            return rows
    raw = http_get("https://api.pokoin.com/api/marketplace-expansion-page?limit=2000")
    payload = json.loads(raw.decode("utf-8"))
    EXPANSIONS_JSON.write_bytes(raw)
    return payload.get("expansions") or []


def existing_logo_files() -> dict[str, Path]:
    found: dict[str, Path] = {}
    for folder in ("logos", "wordmarks"):
        root = REPLICA_OBJECTS / "expansions" / folder
        if not root.is_dir():
            continue
        for path in root.iterdir():
            if not path.is_file():
                continue
            if path.name.startswith(".") or path.stem.endswith("_homepage"):
                continue
            slug = path.stem.lower()
            found.setdefault(slug, path)
    return found


def pick_slug(key: str, catalog: list[dict]) -> str | None:
    if key in ALIASES:
        return ALIASES[key]
    wanted = compact(key)
    wanted_no_and = compact_no_and(key)
    exact: list[str] = []
    stripped: list[str] = []
    for row in catalog:
        slug = str(row.get("slug") or slugify(row.get("name") or "")).strip()
        if not slug or is_variant(slug, row.get("name") or ""):
            continue
        if compact(slug) == wanted:
            exact.append(slug)
        elif compact_no_and(slug) == wanted or compact(slug) == wanted_no_and:
            stripped.append(slug)
    pool = exact or stripped
    if not pool:
        return None

    def rank(slug: str) -> tuple:
        promo = 1 if "promo" in slug else 0
        if "promo" in key:
            promo = 0 if "promo" in slug else 1
        return (promo, len(slug), slug)

    return sorted(set(pool), key=rank)[0]


def download_logo(key: str) -> bytes | None:
    url = f"https://www.serebii.net/card/logo/{key}.png"
    try:
        body = http_get(url, timeout=40)
    except urllib.error.HTTPError as exc:
        print(f"skip {key}: HTTP {exc.code}", flush=True)
        return None
    except Exception as exc:
        print(f"skip {key}: {exc}", flush=True)
        return None
    if not body.startswith(PNG_MAGIC):
        print(f"skip {key}: not png ({len(body)} bytes)", flush=True)
        return None
    if len(body) < 400:
        print(f"skip {key}: tiny {len(body)} bytes", flush=True)
        return None
    return body


def psql(sql: str) -> str:
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
            "-v",
            "ON_ERROR_STOP=1",
            "-A",
            "-t",
        ],
        input=sql,
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise SystemExit(proc.returncode)
    return proc.stdout


def write_files(jobs: list[dict]) -> None:
    logos = REPLICA_OBJECTS / "expansions" / "logos"
    logos.mkdir(parents=True, exist_ok=True)
    staging_logos = STAGING / "expansions" / "logos"
    staging_logos.mkdir(parents=True, exist_ok=True)
    for job in jobs:
        dest = logos / f"{job['slug']}.png"
        dest.write_bytes(job["body"])
        (staging_logos / f"{job['slug']}.png").write_bytes(job["body"])
        print(f"wrote {dest} ({len(job['body'])} bytes)", flush=True)


def push_pi() -> None:
    src = f"{STAGING}/expansions/logos/"
    dest = f"{HOST}:{PI_OBJECTS}/expansions/logos/"
    subprocess.run(
        ["rsync", "-a", "--info=stats1", src, dest],
        check=True,
    )


def update_postgres(jobs: list[dict]) -> None:
    if not jobs:
        return
    lines = ["BEGIN;"]
    for job in jobs:
        slug = job["slug"].replace("'", "''")
        url = f"{CDN_BASE}/expansions/logos/{job['slug']}.png".replace("'", "''")
        key = f"expansions/logos/{job['slug']}.png".replace("'", "''")
        lines.append(
            f"""
UPDATE public.pokoin_pokemon_expansions
SET
  logo_image_url = '{url}',
  logo_object_key = '{key}',
  logo_imported_at = now(),
  updated_at = now()
WHERE trim(both '-' from lower(regexp_replace(replace(public.unaccent(name), '&', ' and '), '[^a-zA-Z0-9]+', '-', 'g'))) = '{slug}'
  AND coalesce(logo_image_url, '') = ''
  AND name !~* 'reverse holo|master ball';
"""
        )
    lines.append(
        """
SELECT count(*) FILTER (WHERE coalesce(logo_image_url, '') <> '')::int AS with_logo,
       count(*)::int AS expansions
FROM public.pokoin_pokemon_expansions;
COMMIT;
"""
    )
    out = psql("\n".join(lines))
    print(out.strip(), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    if args.self_test:
        catalog = [
            {"slug": "abyss-eye", "name": "Abyss Eye"},
            {"slug": "alter-genesis", "name": "Alter Genesis"},
            {"slug": "the-glory-of-team-rocket", "name": "The Glory of Team Rocket"},
            {"slug": "heat-wave-arena", "name": "Heat Wave Arena"},
            {"slug": "scarlet-and-violet", "name": "Scarlet & Violet"},
            {"slug": "delta-reign", "name": "Delta Reign"},
        ]
        assert pick_slug("abysseye", catalog) == "abyss-eye"
        assert pick_slug("altergenesis", catalog) == "alter-genesis"
        assert pick_slug("gloryofteamrocket", catalog) == "the-glory-of-team-rocket"
        assert pick_slug("hotairarena", catalog) == "heat-wave-arena"
        assert pick_slug("scarletviolet", catalog) == "scarlet-and-violet"
        assert pick_slug("deltareign", catalog) == "delta-reign"
        print("self-test ok")
        return 0

    catalog = load_catalog()
    existing = existing_logo_files()
    keys = sorted(discover_keys())
    print(f"catalog={len(catalog)} existing_files={len(existing)} serebii_keys={len(keys)}", flush=True)

    planned: list[dict] = []
    unmatched: list[str] = []
    skipped_have = []
    skipped_wordmark = []
    skipped_no_row = []

    catalog_slugs = {
        str(row.get("slug") or slugify(row.get("name") or "")).strip()
        for row in catalog
    }

    seen_slugs: set[str] = set()
    for key in keys:
        slug = pick_slug(key, catalog)
        if not slug:
            unmatched.append(key)
            continue
        wordmark_path = REPLICA_OBJECTS / "expansions" / "wordmarks" / f"{slug}.png"
        if slug in WORDMARK_SLUGS or wordmark_path.is_file():
            skipped_wordmark.append((key, slug))
            continue
        if slug in existing:
            skipped_have.append((key, slug))
            continue
        if slug not in catalog_slugs and slug != "delta-reign":
            skipped_no_row.append((key, slug))
            continue
        if slug in seen_slugs:
            continue
        seen_slugs.add(slug)
        planned.append({"key": key, "slug": slug})

    print(f"planned={len(planned)} have_file={len(skipped_have)} wordmark={len(skipped_wordmark)} no_row={len(skipped_no_row)} unmatched={len(unmatched)}")
    if unmatched:
        print("unmatched:", ", ".join(unmatched))
    if skipped_no_row:
        print("alias_no_row:", ", ".join(f"{k}->{s}" for k, s in skipped_no_row))
    for job in planned:
        print(f"  {job['key']:28} -> {job['slug']}")

    if not args.apply:
        print("dry-run; pass --apply to download, rsync Pi, and UPDATE 15T")
        return 0

    downloaded: list[dict] = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futs = {pool.submit(download_logo, job["key"]): job for job in planned}
        for fut in as_completed(futs):
            job = futs[fut]
            body = fut.result()
            time.sleep(0.05)
            if not body:
                continue
            downloaded.append({**job, "body": body})
            print(f"got {job['key']} -> {job['slug']} {len(body)} bytes", flush=True)

    db_jobs = [job for job in downloaded if job["slug"] in catalog_slugs]
    write_files(downloaded)
    push_pi()
    update_postgres(db_jobs)
    print(json.dumps({
        "downloaded": [job["slug"] for job in sorted(downloaded, key=lambda row: row["slug"])],
        "db": [job["slug"] for job in sorted(db_jobs, key=lambda row: row["slug"])],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
