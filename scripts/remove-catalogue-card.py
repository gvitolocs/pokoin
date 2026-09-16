#!/usr/bin/env python3
"""Would-remove / remove a CardTrader blueprint from the Pokoin catalogue.

Public id is leftover ct_id × 2. Giuseppe asked after deleting Theme Deck
Gengar 794206 / CT 397103 (CardTrader page + image 404, no leftover JPEG).

Default is dry-run: prove CT is gone, inventory writer rows, list blockers,
print the SQL + Meili deletes that **would** run. Pass `--apply` to execute
on nezopt 15T (`pokoin-marketplace-postgres-15t`) and delete Meili
`en_{card_id}` on the Pi.

Delete order (writer only — Pi replica streams):

  1. marketplace_search_candidates  (cascades urls / hash4 / variations / nick hits)
  2. marketplace_card_versions
  3. pokoin_version_sets            (candidates FK is NO ACTION)
  4. pokoin_pokemon_blueprints      (cascades marketplace_cards, artists, …)

Never write the Pi replica. Never delete sold_daily / snapshots (history).
Active marketplace_user_listings block --apply unless --force-listings.

Examples:

  python3 scripts/remove-catalogue-card.py 794206
  python3 scripts/remove-catalogue-card.py --ct-id 397103
  python3 scripts/remove-catalogue-card.py 794206 --apply
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

PG_CONTAINER = os.environ.get(
    "POKOIN_MARKETPLACE_POSTGRES",
    "pokoin-marketplace-postgres-15t",
)
PG_USER = os.environ.get("POKOIN_MARKETPLACE_PGUSER", "pokoin_marketplace")
PG_DB = os.environ.get("POKOIN_MARKETPLACE_PGDATABASE", "pokoin_marketplace")
PI_HOST = os.environ.get("POKOIN_PI_HOST", "pi-home")
MEILI_INDEX = os.environ.get("MEILI_MARKETPLACE_INDEX", "marketplace_cards")
API_ORIGIN = os.environ.get("API_ORIGIN", "https://api.pokoin.com").rstrip("/")
SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=12"]
UA = "Pokoin catalogue remove (https://pokoin.com)"


@dataclass
class Probe:
    url: str
    status: int
    final_url: str = ""
    ok_gone: bool = False


@dataclass
class Report:
    card_id: int
    ct_id: int
    identity: dict = field(default_factory=dict)
    counts: dict = field(default_factory=dict)
    version: str = ""
    listings_active: int = 0
    cm_obs: int = 0
    ct_page: Probe | None = None
    ct_preview: Probe | None = None
    cdn_jpg: Probe | None = None
    blockers: list[str] = field(default_factory=list)
    would: list[str] = field(default_factory=list)


def psql(sql: str, timeout: int = 60) -> str:
    proc = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            PG_CONTAINER,
            "psql",
            "-U",
            PG_USER,
            "-d",
            PG_DB,
            "-v",
            "ON_ERROR_STOP=1",
            "-t",
            "-A",
        ],
        input=sql,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "psql failed")
    return proc.stdout


def psql_json(sql: str) -> list[dict]:
    raw = psql(f"SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM ({sql}) q;")
    text = raw.strip() or "[]"
    return json.loads(text)


def http_probe(url: str, timeout: float = 12.0) -> Probe:
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = int(resp.status)
            final = str(resp.geturl() or url)
            # CT sometimes 301-chains into a soft 404 HTML page.
            body = resp.read(256)
            gone = status == 404 or (
                status >= 200
                and status < 400
                and b"404" in body[:64]
                and b"<!DOCTYPE" in body[:64].upper()
            )
            return Probe(url=url, status=status, final_url=final, ok_gone=gone or status == 404)
    except urllib.error.HTTPError as err:
        status = int(err.code)
        return Probe(url=url, status=status, final_url=url, ok_gone=status == 404)
    except Exception:
        return Probe(url=url, status=0, final_url=url, ok_gone=False)


def resolve_ids(card_id: int | None, ct_id: int | None) -> tuple[int, int]:
    if card_id and ct_id:
        if card_id != ct_id * 2:
            raise SystemExit(f"card_id {card_id} is not ct_id {ct_id} × 2")
        return card_id, ct_id
    if card_id:
        return card_id, card_id // 2
    if ct_id:
        return ct_id * 2, ct_id
    raise SystemExit("pass a public card id or --ct-id")


def load_identity(card_id: int, ct_id: int) -> dict:
    rows = psql_json(
        f"""
        SELECT
          c.card_id,
          c.ct_id,
          c.name,
          c.set_name,
          c.card_number,
          c.product_type,
          c.item_kind,
          c.image_url,
          c.cdn_image_url,
          c.preview_image_url,
          c.version,
          c.ct_id AS blueprint_id
        FROM public.marketplace_search_candidates c
        WHERE c.card_id = {card_id} OR c.ct_id = {ct_id}
        LIMIT 1
        """
    )
    if rows:
        return rows[0]
    cards = psql_json(
        f"""
        SELECT card_id, ct_id, name, set_name, card_number, product_type, item_kind,
               image_url, cdn_image_url, preview_image_url, NULL::text AS version,
               ct_id AS blueprint_id
        FROM public.marketplace_cards
        WHERE card_id = {card_id} OR ct_id = {ct_id}
        LIMIT 1
        """
    )
    if cards:
        return cards[0]
    bps = psql_json(
        f"""
        SELECT
          (id * 2) AS card_id,
          id AS ct_id,
          name,
          COALESCE(expansion->>'name', '') AS set_name,
          COALESCE(blueprint->'fixed_properties'->>'collector_number', '') AS card_number,
          'card' AS product_type,
          'single' AS item_kind,
          image_url,
          cdn_image_url,
          preview_image_url,
          NULL::text AS version,
          id AS blueprint_id
        FROM public.pokoin_pokemon_blueprints
        WHERE id = {ct_id}
        LIMIT 1
        """
    )
    return bps[0] if bps else {}


def inventory(card_id: int, ct_id: int, version: str) -> dict[str, int]:
    version_sql = version.replace("'", "''") if version else ""
    vset_select = (
        f"""SELECT 'pokoin_version_sets' AS t, count(*)::int AS n
            FROM public.pokoin_version_sets WHERE version = '{version_sql}'"""
        if version
        else "SELECT 'pokoin_version_sets' AS t, 0::int AS n"
    )
    rows = psql_json(
        f"""
        SELECT * FROM (
          SELECT 'pokoin_pokemon_blueprints' AS t, count(*)::int AS n
            FROM public.pokoin_pokemon_blueprints WHERE id = {ct_id}
          UNION ALL SELECT 'marketplace_cards', count(*)::int
            FROM public.marketplace_cards WHERE card_id = {card_id} OR ct_id = {ct_id}
          UNION ALL SELECT 'marketplace_search_candidates', count(*)::int
            FROM public.marketplace_search_candidates WHERE card_id = {card_id} OR ct_id = {ct_id}
          UNION ALL SELECT 'marketplace_card_urls', count(*)::int
            FROM public.marketplace_card_urls WHERE card_id = {card_id}
          UNION ALL SELECT 'marketplace_card_url_hash4', count(*)::int
            FROM public.marketplace_card_url_hash4 WHERE card_id = {card_id}
          UNION ALL SELECT 'marketplace_card_versions', count(*)::int
            FROM public.marketplace_card_versions WHERE card_id = {card_id} OR ct_id = {ct_id}
          UNION ALL SELECT 'marketplace_blueprint_artists', count(*)::int
            FROM public.marketplace_blueprint_artists WHERE blueprint_id = {ct_id}
          UNION ALL {vset_select}
          UNION ALL SELECT 'marketplace_user_listings_active', count(*)::int
            FROM public.marketplace_user_listings
            WHERE card_id = '{card_id}' AND status = 'active' AND quantity_available > 0
          UNION ALL SELECT 'marketplace_cm_scrape_observations', count(*)::int
            FROM public.marketplace_cm_scrape_observations
            WHERE matched_blueprint_id = {ct_id}
        ) q
        """
    )
    return {str(row["t"]): int(row["n"]) for row in rows}


def ct_urls(ct_id: int, identity: dict) -> tuple[str, str, str]:
    page = f"https://www.cardtrader.com/en/cards/{ct_id}"
    preview = str(
        identity.get("preview_image_url")
        or identity.get("image_url")
        or ""
    ).strip()
    if not preview:
        preview = (
            f"https://www.cardtrader.com/uploads/blueprints/image/{ct_id}/"
            f"preview_{ct_id}.png"
        )
    cdn = f"https://cdn.pokoin.com/{ct_id}.jpg"
    return page, preview, cdn


def build_report(card_id: int, ct_id: int, require_ct_gone: bool) -> Report:
    identity = load_identity(card_id, ct_id)
    version = str(identity.get("version") or f"v{card_id}")
    counts = inventory(card_id, ct_id, version if identity else "")
    page_url, preview_url, cdn_url = ct_urls(ct_id, identity)
    report = Report(
        card_id=card_id,
        ct_id=ct_id,
        identity=identity,
        counts=counts,
        version=version if identity else "",
        listings_active=counts.get("marketplace_user_listings_active", 0),
        cm_obs=counts.get("marketplace_cm_scrape_observations", 0),
        ct_page=http_probe(page_url),
        ct_preview=http_probe(preview_url),
        cdn_jpg=http_probe(cdn_url),
    )

    present = sum(
        n
        for key, n in counts.items()
        if key
        not in {
            "marketplace_user_listings_active",
            "marketplace_cm_scrape_observations",
        }
        and n > 0
    )
    if present == 0 and not identity:
        report.blockers.append("already absent from writer catalogue")

    if require_ct_gone:
        page_gone = bool(report.ct_page and report.ct_page.ok_gone)
        preview_gone = bool(report.ct_preview and report.ct_preview.ok_gone)
        if not (page_gone or preview_gone):
            report.blockers.append(
                "CardTrader still serves page/image "
                f"(page={report.ct_page.status if report.ct_page else '?'}, "
                f"preview={report.ct_preview.status if report.ct_preview else '?'}) "
                "— refuse unless --allow-live-ct"
            )

    if report.listings_active:
        report.blockers.append(
            f"{report.listings_active} active native listing(s) on card_id={card_id}"
        )
    if report.cm_obs:
        report.blockers.append(
            f"{report.cm_obs} marketplace_cm_scrape_observations row(s) "
            "(FK is NO ACTION — null or delete first)"
        )

    report.would = [
        f"DELETE FROM marketplace_search_candidates WHERE card_id={card_id} OR ct_id={ct_id};",
        f"DELETE FROM marketplace_card_versions WHERE card_id={card_id} OR ct_id={ct_id};",
    ]
    if report.version:
        report.would.append(
            f"DELETE FROM pokoin_version_sets WHERE version='{report.version}';"
        )
    report.would.append(f"DELETE FROM pokoin_pokemon_blueprints WHERE id={ct_id};")
    report.would.append(f"Meili DELETE /indexes/{MEILI_INDEX}/documents/en_{card_id}")
    report.would.append(
        f"Verify GET {API_ORIGIN}/api/marketplace-card-page?cardId={card_id}&lang=en → 404"
    )
    return report


def print_report(report: Report) -> None:
    ident = report.identity or {}
    print(f"card_id={report.card_id}  ct_id={report.ct_id}  version={report.version or '—'}")
    if ident:
        print(
            f"  {ident.get('name') or '?'} · {ident.get('card_number') or '?'} · "
            f"{ident.get('set_name') or '?'}"
        )
    print("CardTrader / CDN probes:")
    for label, probe in (
        ("page", report.ct_page),
        ("preview", report.ct_preview),
        ("cdn_jpg", report.cdn_jpg),
    ):
        if not probe:
            continue
        flag = "GONE" if probe.ok_gone else ("LIVE" if probe.status else "ERR")
        print(f"  {label:8} {flag:4} HTTP {probe.status}  {probe.url}")
    print("Writer row counts:")
    for key in sorted(report.counts):
        print(f"  {report.counts[key]:5d}  {key}")
    if report.blockers:
        print("Blockers:")
        for item in report.blockers:
            print(f"  - {item}")
    print("Would remove:")
    for step in report.would:
        print(f"  • {step}")


def apply_sql(card_id: int, ct_id: int, version: str) -> None:
    version_sql = version.replace("'", "''") if version else ""
    stmts = [
        f"DELETE FROM public.marketplace_search_candidates WHERE card_id = {card_id} OR ct_id = {ct_id};",
        f"DELETE FROM public.marketplace_card_versions WHERE card_id = {card_id} OR ct_id = {ct_id};",
    ]
    if version_sql:
        stmts.append(
            f"DELETE FROM public.pokoin_version_sets WHERE version = '{version_sql}';"
        )
    stmts.append(f"DELETE FROM public.pokoin_pokemon_blueprints WHERE id = {ct_id};")
    sql = "BEGIN;\n" + "\n".join(stmts) + "\nCOMMIT;\n"
    out = psql(sql)
    print(out.strip() or "SQL apply ok")


def meili_delete(card_id: int, languages: list[str]) -> None:
    docs = " ".join(f"{lang}_{card_id}" for lang in languages)
    script = f"""
set -e
KEY=$(docker exec pokoin-meili printenv MEILI_MASTER_KEY)
for doc in {docs}; do
  code=$(curl -sS -o /tmp/pokoin-meili-del.json -w '%{{http_code}}' -X DELETE \
    -H "Authorization: Bearer $KEY" \
    "http://127.0.0.1:7700/indexes/{MEILI_INDEX}/documents/$doc")
  echo "$doc $code $(head -c 160 /tmp/pokoin-meili-del.json)"
done
"""
    proc = subprocess.run(
        ["ssh", *SSH_OPTS, PI_HOST, "bash", "-s"],
        input=script,
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "meili delete failed")
    print(proc.stdout.strip())


def verify_api(card_id: int) -> int:
    url = f"{API_ORIGIN}/api/marketplace-card-page?cardId={card_id}&lang=en"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return int(resp.status)
    except urllib.error.HTTPError as err:
        return int(err.code)


def wait_replica_gone(card_id: int, tries: int = 15) -> bool:
    for i in range(1, tries + 1):
        script = (
            "docker exec pokoin-marketplace-postgres-replica "
            "psql -U pokoin_marketplace -d pokoin_marketplace -tAc "
            f"\"SELECT count(*) FROM marketplace_search_candidates WHERE card_id={card_id}\""
        )
        proc = subprocess.run(
            ["ssh", *SSH_OPTS, PI_HOST, script],
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        count = (proc.stdout or "").strip()
        print(f"replica cand={count or '?'} try={i}")
        if count == "0":
            return True
        time.sleep(1)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("card_id", nargs="?", type=int, help="Public card id (ct_id × 2)")
    parser.add_argument("--ct-id", type=int, default=None, help="CardTrader blueprint id")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Execute deletes on nezopt 15T + Meili (default is dry-run)",
    )
    parser.add_argument(
        "--allow-live-ct",
        action="store_true",
        help="Allow apply even when CardTrader still returns the product",
    )
    parser.add_argument(
        "--force-listings",
        action="store_true",
        help="Allow apply even with active native listings",
    )
    parser.add_argument(
        "--meili-langs",
        default="en",
        help="Comma list of Meili doc language prefixes (default: en)",
    )
    args = parser.parse_args()
    card_id, ct_id = resolve_ids(args.card_id, args.ct_id)
    report = build_report(card_id, ct_id, require_ct_gone=not args.allow_live_ct)
    print_report(report)

    blockers = list(report.blockers)
    if args.force_listings:
        blockers = [b for b in blockers if "active native listing" not in b]
    if args.allow_live_ct:
        blockers = [b for b in blockers if "CardTrader still serves" not in b]

    if not args.apply:
        print("\nDry-run only. Re-run with --apply to remove.")
        return 0 if not blockers or blockers == ["already absent from writer catalogue"] else 2

    if "already absent from writer catalogue" in report.blockers and not any(
        report.counts.get(k, 0)
        for k in (
            "pokoin_pokemon_blueprints",
            "marketplace_cards",
            "marketplace_search_candidates",
        )
    ):
        # Still try Meili + API verify for leftovers.
        print("\nWriter already empty — Meili/API cleanup only.")
    elif blockers:
        print("\nRefusing --apply:", "; ".join(blockers))
        return 2

    print("\nApplying…")
    if any(
        report.counts.get(k, 0)
        for k in (
            "pokoin_pokemon_blueprints",
            "marketplace_cards",
            "marketplace_search_candidates",
            "marketplace_card_versions",
            "pokoin_version_sets",
        )
    ):
        apply_sql(card_id, ct_id, report.version)
    langs = [part.strip() for part in args.meili_langs.split(",") if part.strip()]
    meili_delete(card_id, langs or ["en"])
    wait_replica_gone(card_id)
    # Give Meili a moment to finish the enqueued task.
    time.sleep(1.5)
    status = verify_api(card_id)
    print(f"api marketplace-card-page → HTTP {status}")
    if status != 404:
        print("Expected 404 after remove.", file=sys.stderr)
        return 1
    print("Removed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
