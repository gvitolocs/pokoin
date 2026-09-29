#!/usr/bin/env python3
"""Refresh server/pokoin-api/shipping-rates.json (+ SPA copy) from PackZoo.

PackZoo public API: GET https://packzoo.com/api/prices
  ?from=&to=&weight=&length=&width=&height=

There was never a daily updater on nezopt — checkout seeded hand stubs on
2026-09-27 (docs/CHECKOUT_EUR.md: "Replace when the real matrix arrives").
This script is that matrix pull. Run manually or via the accompanying timer.

Usage:
  scripts/sync-shipping-rates-from-packzoo.py           # write JSON files
  scripts/sync-shipping-rates-from-packzoo.py --dry-run # print only
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API_JSON = ROOT / "server" / "pokoin-api" / "shipping-rates.json"
SPA_JSON = ROOT / "market" / "src" / "shipping-rates.json"
OVERRIDES_JSON = ROOT / "server" / "pokoin-api" / "shipping-rates.overrides.json"
CARDVAULT_JSON = Path.home() / "Projects" / "cardvault" / "pokemon_card_vault" / "api" / "shipping-rates.json"

PACKZOO = "https://packzoo.com/api/prices"
# ECB-ish mid; PackZoo returns DKK for many DK origins.
DKK_PER_EUR = 7.46
# PackZoo often returns only flat parcels for DK international (DAO 150 DKK for
# every letter size). Refuse letter-tier quotes above this ceiling unless overridden.
LETTER_TIER_MAX_CENTS = 1500

# Tier → PackZoo package profile (card mailers + Flex trunk bag).
TIER_PROFILES = {
    "SMALL": {"weight": 0.053, "length": 18, "width": 12, "height": 1.0},   # ≤4 cards
    "MEDIUM": {"weight": 0.085, "length": 20, "width": 14, "height": 1.5},  # ≤20
    "LARGE": {"weight": 0.165, "length": 22, "width": 16, "height": 2.5},   # ≤200 cards (letter/mailer)
    "EXTRA_LARGE": {"weight": 20.0, "length": 60, "width": 40, "height": 40},  # ~20 kg Flex bag only
}

# Prefer real card-seller carriers for tracked; Vinted Go is marketplace-only.
# Never pick Express SKUs — PackZoo lists them and they dominate brand prefs.
EXCLUDED_SUBSTR = ("express", "vinted")
# Only these brands count as tracked seller shipping (Poste ordinaria / DE Brief stay untracked).
TRACKED_CARRIERS = (
    "inpost",
    "dhl",
    "postnord",
    "dao",
    "gls",
    "dpd",
    "hermes",
    "brt",
    "ups",
    "bring",
)
# Posta ordinaria / cheap letter = untracked.
UNTRACKED_NAMES = ("poste italiane", "deutsche post", "posta")


def fetch_prices(from_cc: str, to_cc: str, profile: dict) -> list[dict]:
    qs = urllib.parse.urlencode(
        {
            "from": from_cc,
            "to": to_cc,
            "weight": profile["weight"],
            "length": profile["length"],
            "width": profile["width"],
            "height": profile["height"],
        }
    )
    req = urllib.request.Request(
        f"{PACKZOO}?{qs}",
        headers={"User-Agent": "pokoin-shipping-rates-sync/1.0", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.load(resp)
    return [r for r in body.get("results") or [] if r.get("price") is not None]


def to_eur_cents(price: float, currency: str) -> int:
    cur = (currency or "EUR").upper()
    if cur == "EUR":
        euros = float(price)
    elif cur == "DKK":
        euros = float(price) / DKK_PER_EUR
    else:
        raise ValueError(f"unsupported currency {currency}")
    return max(1, int(round(euros * 100)))


def brand_key(row: dict) -> str:
    return f"{row.get('brandName') or ''} {row.get('provider') or ''}".lower()


def allowed(row: dict) -> bool:
    key = brand_key(row)
    return not any(x in key for x in EXCLUDED_SUBSTR)


def pick_tracked(rows: list[dict], *, package_tier: str = "") -> dict | None:
    """Cheapest non-express tracked carrier (InPost/DHL/…); never Posta ordinaria.

    EXTRA_LARGE is the ~20 kg Flex bag — national posts (Poste / Deutsche Post
    Paket) are valid parcel options there.
    """
    tier = str(package_tier or "").upper()
    if tier == "EXTRA_LARGE":
        usable = [r for r in rows if allowed(r)]
    else:
        usable = [
            r for r in rows
            if allowed(r) and any(p in brand_key(r) for p in TRACKED_CARRIERS)
        ]
        if not usable:
            usable = [
                r for r in rows
                if allowed(r) and not any(n in brand_key(r) for n in UNTRACKED_NAMES)
            ]
    if not usable:
        return None

    def score(row: dict) -> tuple:
        key = brand_key(row)
        pref = next((i for i, p in enumerate(TRACKED_CARRIERS) if p in key), len(TRACKED_CARRIERS))
        cents = to_eur_cents(row["price"], row.get("currency") or "EUR")
        return (cents, pref)

    return min(usable, key=score)


def pick_untracked(rows: list[dict]) -> dict | None:
    letters = [
        r for r in rows
        if allowed(r) and any(n in brand_key(r) for n in UNTRACKED_NAMES)
    ]
    pool = letters or [r for r in rows if allowed(r)] or list(rows)
    return min(pool, key=lambda r: to_eur_cents(r["price"], r.get("currency") or "EUR")) if pool else None



def apply_pick(rate: dict, pick: dict) -> None:
    cents = to_eur_cents(pick["price"], pick.get("currency") or "EUR")
    rate["priceEURCents"] = cents
    rate["carrier"] = str(pick.get("brandName") or rate.get("carrier") or "Carrier").strip()
    # Keep serviceName meaningful; bag tier stays Parcel.
    if str(rate.get("packageTier")).upper() == "EXTRA_LARGE":
        rate["serviceName"] = "Parcel"
    elif rate.get("tracked") is False:
        rate["serviceName"] = "Untracked letter"
    else:
        rate["serviceName"] = "Tracked"


def apply_overrides(catalog: dict) -> int:
    """Verified rows beat PackZoo (see shipping-rates.overrides.json)."""
    if not OVERRIDES_JSON.is_file():
        return 0
    payload = json.loads(OVERRIDES_JSON.read_text(encoding="utf-8"))
    by_id = {row["id"]: row for row in catalog.get("rates") or []}
    applied = 0
    for overlay in payload.get("rates") or []:
        rate_id = overlay.get("id")
        target = by_id.get(rate_id)
        if not target:
            print(f"warn: override id missing in catalog: {rate_id}", file=sys.stderr)
            continue
        before = target.get("priceEURCents")
        for key in ("priceEURCents", "carrier", "serviceName", "tracked"):
            if key in overlay:
                target[key] = overlay[key]
        target["rateSource"] = overlay.get("source") or "override"
        applied += 1
        print(
            f"override {rate_id}: {before} → {target['priceEURCents']} "
            f"({target.get('carrier')} {target.get('serviceName')})"
        )
    return applied


def sync_catalog(catalog: dict, *, sleep_s: float = 0.15) -> dict:
    cache: dict[tuple, list[dict]] = {}
    rates = catalog.get("rates") or []
    for rate in rates:
        if rate.get("active") is False:
            continue
        tier = str(rate.get("packageTier") or "").upper()
        profile = TIER_PROFILES.get(tier)
        if not profile:
            continue
        frm = str(rate.get("fromCountry") or "").upper()
        to = str(rate.get("toCountry") or "").upper()
        key = (frm, to, tier)
        if key not in cache:
            try:
                cache[key] = fetch_prices(frm, to, profile)
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                print(f"warn: {frm}->{to} {tier}: {exc}", file=sys.stderr)
                cache[key] = []
            time.sleep(sleep_s)
        rows = cache[key]
        if not rows:
            print(f"skip: no PackZoo rows for {frm}->{to} {tier}", file=sys.stderr)
            continue
        want_tracked = rate.get("tracked") is not False
        pick = pick_tracked(rows, package_tier=tier) if want_tracked else pick_untracked(rows)
        if not pick:
            print(f"skip: no pick for {rate.get('id')}", file=sys.stderr)
            continue
        cents = to_eur_cents(pick["price"], pick.get("currency") or "EUR")
        # Letter tiers must not ingest flat international parcel floors (e.g. DAO 150 DKK).
        if tier != "EXTRA_LARGE" and cents > LETTER_TIER_MAX_CENTS:
            print(
                f"skip: {rate.get('id')} PackZoo {cents}¢ looks like a parcel floor "
                f"(>{LETTER_TIER_MAX_CENTS}¢ letter ceiling) — keep existing / use override",
                file=sys.stderr,
            )
            continue
        before = rate.get("priceEURCents")
        apply_pick(rate, pick)
        rate["rateSource"] = "packzoo"
        print(
            f"{rate['id']}: {before} → {rate['priceEURCents']} "
            f"({rate['carrier']} {rate['serviceName']})"
        )
    applied = apply_overrides(catalog)
    catalog["source"] = {
        "provider": "packzoo+overrides",
        "api": PACKZOO,
        "overrides": str(OVERRIDES_JSON.relative_to(ROOT)),
        "overridesApplied": applied,
        "note": (
            "PackZoo compare plus verified overrides. PackZoo omits some letter "
            "products (e.g. PostNord Breve til Udlandet); overrides win."
        ),
    }
    return catalog


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--also-cardvault", action="store_true", help="Also write CardVault api copy if present")
    args = ap.parse_args()

    catalog = json.loads(API_JSON.read_text(encoding="utf-8"))
    sync_catalog(catalog)

    text = json.dumps(catalog, indent=2, ensure_ascii=False) + "\n"
    if args.dry_run:
        print(text[:2000], "…")
        return 0

    API_JSON.write_text(text, encoding="utf-8")
    SPA_JSON.write_text(text, encoding="utf-8")
    print(f"wrote {API_JSON.relative_to(ROOT)}")
    print(f"wrote {SPA_JSON.relative_to(ROOT)}")
    if args.also_cardvault and CARDVAULT_JSON.is_file():
        CARDVAULT_JSON.write_text(text, encoding="utf-8")
        print(f"wrote {CARDVAULT_JSON}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
