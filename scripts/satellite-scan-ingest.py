#!/usr/bin/env python3
"""Satellite-game CardTrader scan ingest (multigame re-import, waves 2-4).

Fetches blueprint scans from CardTrader on Oracle (the GET hop), encodes JPEG +
homepage webp on nezopt onto the NVMe leftover tree with each game's CDN
prefix, and stamps cdn_image_url on the writer DB. Never R2, never the Pi as
an encode target. Map: docs/MULTIGAME_REIMPORT.md.

Encoding helpers are imported from ingest-missing-product-images.py so the
image treatment is identical to Pokemon.

Nezopt: ai-toolkit venv python (Pillow), run as main.
Oracle: python3 --oracle-fetch (stdlib only), jobs file -> raw bytes dir.

Env:
  POKOIN_SCAN_WORKERS      fetch concurrency (default 16; keep <=8 per runner
                           and <=2 runners — 48 concurrent tripped Cloudflare)
  POKOIN_SCAN_CHUNK        rows per chunk (default 5000)
  POKOIN_SCAN_GAMES        comma list to restrict (default all satellite games)
  POKOIN_SCAN_TAG          distinguishes concurrent runners (remote job/out dirs)
  POKOIN_CT_FETCH_HOST     empty string = fetch from THIS host (nezopt home IP)
  POKOIN_SCAN_STATE/FAILS  progress + 7-day failure memo (skip when fail >=40%)
"""
from __future__ import annotations

import csv
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from pathlib import Path

SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20"]
CT_FETCH_HOST = os.environ.get("POKOIN_CT_FETCH_HOST", "pokoin-marketplace")
WORKERS = int(os.environ.get("POKOIN_SCAN_WORKERS", "16"))
CHUNK = int(os.environ.get("POKOIN_SCAN_CHUNK", "5000"))
PG = os.environ.get("POKOIN_MARKETPLACE_POSTGRES", "pokoin-marketplace-postgres-15t")
PG_USER = "pokoin_marketplace"
OBJECTS = Path(os.environ.get("POKOIN_NVME_LEFTOVERS", "/home/nez/data/pokoin-leftovers")) / "objects"
RAW_OUT = Path(os.environ.get("POKOIN_SCAN_RAW", "/tmp/pokoin-scan-raw"))
STATE = Path(os.environ.get("POKOIN_SCAN_STATE", "/tmp/pokoin-scan-state.json"))
FAILS = Path(os.environ.get("POKOIN_SCAN_FAILS", "/tmp/pokoin-scan-fails.json"))
# Tag separates concurrent runners (distinct jobs/out files on Oracle).
TAG = os.environ.get("POKOIN_SCAN_TAG", "")
FAIL_TTL = int(os.environ.get("POKOIN_SCAN_FAIL_TTL", str(7 * 86400)))
CDN_BASE = "https://cdn.pokoin.com/"

# slug -> (database, schema, cdn prefix)
GAMES = {
    "sorcery": ("pokoin_sorcery", "marketplace_sorcery", "sorcery/"),
    "gundam": ("pokoin_gundam", "marketplace_gundam", "gundam/"),
    "lorcana": ("pokoin_lorcana", "marketplace_lorcana", "lorcana/"),
    "star-wars": ("pokoin_star_wars", "marketplace_star_wars", "star-wars/"),
    "union-arena": ("pokoin_union_arena", "marketplace_union_arena", "union-arena/"),
    "digimon": ("pokoin_digimon", "marketplace_digimon", "digimon/"),
    "flesh-and-blood": ("pokoin_flesh_and_blood", "marketplace_flesh_and_blood", "flesh-and-blood/"),
    "dragon-ball-super": ("pokoin_dragon_ball_super", "marketplace_dragon_ball_super", "dragon-ball-super/"),
    "vanguard": ("pokoin_vanguard", "marketplace_vanguard", "vanguard/"),
    "one-piece": ("pokoin_one_piece", "marketplace_one_piece", "one-piece/"),
    "riftbound": ("pokoin_riftbound", "marketplace_riftbound", "riftbound/"),
    "yugioh": ("pokoin_yugioh", "marketplace_yugioh", "yugioh/"),
    "magic": ("pokoin_magic", "marketplace_magic", "magic/"),
}

_HELPER = None


def _helper_path() -> str:
    return str(Path(__file__).resolve().parent / "ingest-missing-product-images.py")


def helper():
    global _HELPER
    if _HELPER is None:
        spec = importlib.util.spec_from_file_location("pokemon_ingest_helpers", _helper_path())
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _HELPER = mod
    return _HELPER


def log(msg: str) -> None:
    print(time.strftime("%FT%TZ", time.gmtime()), msg, flush=True)


def psql(db: str, sql: str) -> str:
    out = subprocess.run(
        ["docker", "exec", "-i", PG, "psql", "-U", PG_USER, "-d", db, "-At", "-v", "ON_ERROR_STOP=1"],
        input=sql.encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
        timeout=120,
    )
    return out.stdout.decode()


def _db_for(schema: str) -> str:
    for db, sch, _prefix in GAMES.values():
        if sch == schema:
            return db
    raise SystemExit(f"unknown schema {schema}")


def dump_chunk(schema: str, limit: int) -> list[dict]:
    sql = f"""
COPY (
  SELECT
    b.id::text AS ct_id,
    b.name,
    coalesce(b.cardtrader_image_url, b.image_url) AS image_url,
    b.blueprint->'image'->>'url' AS full_url,
    b.blueprint->'image'->'show'->>'url' AS show_url
  FROM {schema}.cardtrader_blueprints b
  WHERE b.cdn_image_url IS NULL
    AND coalesce(b.cardtrader_image_url, b.image_url) IS NOT NULL
  LIMIT {limit}
) TO STDOUT WITH CSV HEADER
"""
    rows = []
    reader = csv.DictReader(io.StringIO(psql(_db_for(schema), sql)))
    for row in reader:
        rows.append(row)
    return rows


def load_fails() -> dict:
    if FAILS.exists():
        try:
            return json.loads(FAILS.read_text())
        except Exception:
            return {}
    return {}


def save_fails(fails: dict) -> None:
    cutoff = time.time() - FAIL_TTL
    FAILS.write_text(json.dumps({k: v for k, v in fails.items() if v > cutoff}))


def jobs_for(rows: list[dict], prefix: str) -> tuple[dict[str, list[str]], list[dict]]:
    mod = helper()
    fails = load_fails()
    cutoff = time.time() - FAIL_TTL
    jobs: dict[str, list[str]] = {}
    planned: list[dict] = []
    for row in rows:
        key = mod.leftover_key(row.get("ct_id") or "", row.get("name") or "", row.get("image_url") or "")
        if not key:
            continue
        key = prefix + key
        if (OBJECTS / key).exists():
            continue
        if fails.get(key, 0) > cutoff:
            continue
        urls = mod.candidate_urls(row)
        if not urls:
            continue
        jobs[key] = urls
        row["key"] = key
        planned.append(row)
    return jobs, planned


def fetch_with_retry(mod, urls: list[str], attempts: int = 3) -> bytes | None:
    """CT challenges flap minute-to-minute once an IP is flagged; bridge them."""
    for attempt in range(attempts):
        data = mod.fetch_first(urls)
        if data:
            return data
        if attempt < attempts - 1:
            time.sleep(2 * (attempt + 1))
    return None


def local_fetch(jobs: dict[str, list[str]]) -> dict[str, bytes]:
    """Fetch from this host (nezopt home IP) — used when Oracle is blocked."""
    mod = helper()
    shutil.rmtree(RAW_OUT, ignore_errors=True)
    RAW_OUT.mkdir(parents=True, exist_ok=True)
    saved = failed = 0

    def one(key: str) -> tuple[str, bool]:
        data = fetch_with_retry(mod, jobs.get(key) or [])
        if not data:
            return key, False
        dest = RAW_OUT / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return key, True

    with ThreadPoolExecutor(max_workers=max(1, WORKERS)) as pool:
        futures = [pool.submit(one, key) for key in jobs]
        for index, fut in enumerate(as_completed(futures), 1):
            key, good = fut.result()
            if good:
                saved += 1
            else:
                failed += 1
            if index % 250 == 0 or index == len(futures):
                print(f"local_fetch {index}/{len(futures)} saved={saved} fail={failed}", flush=True)
    # Only this chunk's keys — the raw dir may hold older chunks' files.
    bodies = {
        p.relative_to(RAW_OUT).as_posix(): p.read_bytes()
        for p in RAW_OUT.rglob("*")
        if p.is_file() and p.stat().st_size > 9000 and p.relative_to(RAW_OUT).as_posix() in jobs
    }
    log(f"local_bodies={len(bodies)}/{len(jobs)}")
    return bodies


def oracle_fetch(jobs: dict[str, list[str]]) -> dict[str, bytes]:
    if not jobs:
        return {}
    # Read per call: run_game rotates POKOIN_CT_FETCH_HOST when rotating hosts.
    host = os.environ.get("POKOIN_CT_FETCH_HOST", CT_FETCH_HOST)
    if not host:
        return local_fetch(jobs)
    jobs_path = Path(f"/tmp/pokoin-scan-jobs{TAG}.json")
    jobs_path.write_text(json.dumps(jobs))
    script = Path(__file__).resolve()
    helper_path = Path(_helper_path())
    remote_script = "/tmp/satellite-scan-ingest.py"
    remote_out = f"/tmp/pokoin-scan-out{TAG}"
    subprocess.run(["scp", *SSH_OPTS, str(script), f"{host}:{remote_script}"], check=True)
    subprocess.run(
        ["scp", *SSH_OPTS, str(helper_path), f"{host}:/tmp/ingest-missing-product-images.py"],
        check=True,
    )
    subprocess.run(["scp", *SSH_OPTS, str(jobs_path), f"{host}:{jobs_path}"], check=True)
    env = f"POKOIN_SCAN_WORKERS={WORKERS} POKOIN_SCAN_JOBS={jobs_path} POKOIN_SCAN_OUT={remote_out}"
    try:
        subprocess.run(
            ["ssh", *SSH_OPTS, host,
             f"rm -rf {remote_out} && {env} python3 {remote_script} --oracle-fetch"],
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        # Remote fetch died (challenge, ssh hiccup) — treat as empty chunk so
        # run_game cools down and flips host instead of crashing.
        log(f"remote fetch on {host} failed rc={exc.returncode}")
        return {}
    shutil.rmtree(RAW_OUT, ignore_errors=True)
    RAW_OUT.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["rsync", "-a", "--info=stats1", f"{host}:{remote_out}/", f"{RAW_OUT}/"],
        check=True,
    )
    # Only this chunk's keys — the raw dir may hold older chunks' files.
    bodies = {
        p.relative_to(RAW_OUT).as_posix(): p.read_bytes()
        for p in RAW_OUT.rglob("*")
        if p.is_file() and p.stat().st_size > 9000 and p.relative_to(RAW_OUT).as_posix() in jobs
    }
    log(f"oracle_bodies={len(bodies)}/{len(jobs)}")
    return bodies


def _encode_one(payload: tuple[str, bytes]) -> str:
    key, data = payload
    mod = helper()
    dest = OBJECTS / key
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not mod.write_jpeg(dest, data):
        return "fail"
    if not mod.write_homepage(dest):
        return "fail"
    return "ok"


def encode(bodies: dict[str, bytes]) -> tuple[list[str], int]:
    items = list(bodies.items())
    ok: list[str] = []
    failed = 0
    if not items:
        return ok, failed
    procs = min(len(items), max(1, os.cpu_count() or 4))
    with ProcessPoolExecutor(max_workers=procs) as pool:
        statuses = pool.map(_encode_one, items, chunksize=16)
        for (key, _data), status in zip(items, statuses):
            if status == "ok":
                ok.append(key)
            else:
                failed += 1
    return ok, failed


def stamp_cdn(db: str, schema: str, prefix: str, keys: list[str]) -> int:
    if not keys:
        return 0
    seen = {}
    for key in keys:
        if not key.startswith(prefix):
            continue  # never stamp another game's key into this DB
        ct_id = key[len(prefix):].split("_", 1)[0]
        if not ct_id.isdigit():
            continue
        seen[ct_id] = key  # one key per blueprint id; the join is per ct_id
    rows = [f"{ct_id},{key}" for ct_id, key in seen.items()]
    if not rows:
        return 0
    payload = ("\n".join(rows) + "\n").encode()
    sql_before = f"""
BEGIN;
CREATE TEMP TABLE scan_keys(ct_id bigint PRIMARY KEY, key text);
\\copy scan_keys FROM STDIN WITH (FORMAT csv)
"""
    sql_after = f"""\\.
UPDATE {schema}.cardtrader_blueprints b
SET cdn_image_url = '{CDN_BASE}' || s.key,
    cdn_object_key = s.key,
    homepage_image_url = '{CDN_BASE}' || regexp_replace(s.key, '\\.jpg$', '_homepage.webp'),
    homepage_object_key = regexp_replace(s.key, '\\.jpg$', '_homepage.webp')
FROM scan_keys s
WHERE b.id = s.ct_id
  AND b.cdn_image_url IS NULL;
COMMIT;
SELECT count(*) FROM {schema}.cardtrader_blueprints WHERE cdn_image_url IS NOT NULL;
"""
    out = subprocess.run(
        ["docker", "exec", "-i", PG, "psql", "-U", PG_USER, "-d", db, "-At", "-v", "ON_ERROR_STOP=1"],
        input=sql_before.encode() + payload + sql_after.encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=300,
    )
    if out.returncode != 0:
        raise RuntimeError(
            f"stamp_cdn {db} failed rc={out.returncode}: {out.stderr.decode(errors='replace')[-800:]}"
        )
    return int((out.stdout.decode().strip().splitlines() or ["0"])[-1])


def load_state() -> dict:
    if STATE.exists():
        return json.loads(STATE.read_text())
    return {}


def save_state(state: dict) -> None:
    STATE.write_text(json.dumps(state, indent=1, sort_keys=True))


def stamp_existing(db: str, schema: str, prefix: str, rows: list[dict]) -> int:
    """Rows whose JPEG already sits on the NVMe tree but cdn_image_url is NULL."""
    mod = helper()
    keys = []
    for row in rows:
        key = mod.leftover_key(row.get("ct_id") or "", row.get("name") or "", row.get("image_url") or "")
        if key and (OBJECTS / (prefix + key)).exists():
            keys.append(prefix + key)
    if keys:
        return stamp_cdn(db, schema, prefix, keys)
    return 0


def run_game(slug: str) -> None:
    db, schema, prefix = GAMES[slug]
    state = load_state()
    game_state = state.setdefault(slug, {"ok": 0, "fail": 0, "chunks": 0})
    log(f"== {slug} {db} prefix={prefix}")
    empty_streak = 0
    for _ in range(200):  # hard chunk cap per game
        rows = dump_chunk(schema, CHUNK)
        if not rows:
            log(f"{slug}: no more missing rows")
            break
        pre = stamp_existing(db, schema, prefix, rows)
        jobs, planned = jobs_for(rows, prefix)
        if not planned:
            if pre == 0:
                log(f"{slug}: {len(rows)} rows stuck without candidate urls — stopping game (manual review)")
                break
            log(f"{slug}: stamped existing objects={pre}")
            continue
        log(f"{slug}: chunk rows={len(rows)} jobs={len(jobs)}")
        bodies = oracle_fetch(jobs)
        if not bodies:
            # Zero bodies usually means the current host got challenged.
            empty_streak += 1
            if empty_streak >= 3 and len(jobs) < 200:
                # Small tail chunk failing repeatedly = dead rows (no real CT
                # scan), not a block — memoize so the game can move on.
                # Big chunks are treated as rate limiting and never memoized.
                fails = load_fails()
                now = time.time()
                for key in jobs:
                    fails[key] = now
                save_fails(fails)
                log(f"{slug}: memoized {len(jobs)} dead-tail keys after {empty_streak} empty chunks")
            if empty_streak >= 30:
                log(f"{slug}: 30 consecutive empty chunks — giving up for now (resume later)")
                break
            if os.environ.get("POKOIN_SCAN_ROTATE"):
                log(f"{slug}: empty chunk {empty_streak} — cooling down and switching host")
                time.sleep(420)
                cur = os.environ.get("POKOIN_CT_FETCH_HOST", CT_FETCH_HOST)
                os.environ["POKOIN_CT_FETCH_HOST"] = "" if cur else "pokoin-marketplace"
            else:
                time.sleep(420)
            continue
        empty_streak = 0
        ok, failed = encode(bodies)
        stamped = stamp_cdn(db, schema, prefix, ok)
        if failed and failed < 0.4 * max(1, len(bodies)):
            # Memoize only when the chunk looks healthy: a high fail rate means
            # CardTrader rate limiting / outage — do not poison the memo.
            ok_set = set(ok)
            fails = load_fails()
            now = time.time()
            for key in bodies:
                if key not in ok_set:
                    fails[key] = now
            save_fails(fails)
        game_state["ok"] += len(ok)
        game_state["fail"] += failed
        game_state["chunks"] += 1
        save_state(state)
        log(f"{slug}: encoded_ok={len(ok)} enc_fail={failed} stamped={stamped} total_ok={game_state['ok']}")
        if not ok:
            break
        if os.environ.get("POKOIN_SCAN_ROTATE"):
            # Alternate egress per chunk so neither IP accumulates a block.
            cur = os.environ.get("POKOIN_CT_FETCH_HOST", CT_FETCH_HOST)
            os.environ["POKOIN_CT_FETCH_HOST"] = "" if cur else "pokoin-marketplace"
            time.sleep(60)


def oracle_fetch_worker() -> int:
    jobs_path = Path(os.environ.get("POKOIN_SCAN_JOBS", "/tmp/pokoin-scan-jobs.json"))
    out = Path(os.environ.get("POKOIN_SCAN_OUT", "/tmp/pokoin-scan-out"))
    out.mkdir(parents=True, exist_ok=True)
    jobs = json.loads(jobs_path.read_text())

    mod = helper()
    saved = failed = 0

    def one(key: str) -> tuple[str, bool]:
        data = fetch_with_retry(mod, jobs.get(key) or [])
        if not data:
            return key, False
        dest = out / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return key, True

    workers = max(1, WORKERS)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(one, key) for key in jobs]
        for index, fut in enumerate(as_completed(futures), 1):
            key, good = fut.result()
            if good:
                saved += 1
            else:
                failed += 1
            if index % 250 == 0 or index == len(futures):
                print(f"oracle_fetch {index}/{len(futures)} saved={saved} fail={failed}", flush=True)
    print(f"oracle_fetch_done saved={saved} fail={failed}", flush=True)
    return 0


def main() -> int:
    OBJECTS.mkdir(parents=True, exist_ok=True)
    wanted = [g for g in (os.environ.get("POKOIN_SCAN_GAMES", "").split(",") if os.environ.get("POKOIN_SCAN_GAMES") else []) if g]
    games = wanted or list(GAMES)
    for slug in games:
        if slug not in GAMES:
            raise SystemExit(f"unknown game {slug}")
        run_game(slug)
    log("ALL GAMES DONE")
    return 0


if __name__ == "__main__":
    if "--oracle-fetch" in sys.argv:
        raise SystemExit(oracle_fetch_worker())
    raise SystemExit(main())
