#!/usr/bin/env python3
"""Build server/pokoin-api/shipping-rates.json (+ SPA copy) from live online sources.

Providers (smoke-tested each run):
  - PackZoo GET https://packzoo.com/api/prices  (multi-carrier EU compare)
  - porto-data GitHub JSON (Deutsche Post + La Poste letter grids with effective_from)
  - dao.as/brev/ public letter table (DK domestic + international, post-2026 letter operator)

No manual price overrides. Cheapest non-express quote wins per lane/tier/tracked.
EXTRA_LARGE is the ~20 kg Flex bag profile only.

Usage:
  scripts/sync-shipping-rates.py
  scripts/sync-shipping-rates.py --dry-run
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API_JSON = ROOT / "server" / "pokoin-api" / "shipping-rates.json"
SPA_JSON = ROOT / "market" / "src" / "shipping-rates.json"
CARDVAULT_JSON = (
    Path.home() / "Projects" / "cardvault" / "pokemon_card_vault" / "api" / "shipping-rates.json"
)

PACKZOO = "https://packzoo.com/api/prices"
PORTO_RAW = "https://raw.githubusercontent.com/gruncellka/porto-data/main/porto_data/providers"
DAO_BREV = "https://dao.as/brev/"
DKK_PER_EUR = 7.46
# Approximate mids for PackZoo currencies we have seen (update with sync).
CURRENCY_PER_EUR = {
    "EUR": 1.0,
    "DKK": DKK_PER_EUR,
    "SEK": 11.1,
    "PLN": 4.27,
    "CZK": 25.0,
    "HUF": 395.0,
    "RON": 5.0,
    "BGN": 1.96,
}

# Where Pokoin sellers ship from (seller settings); every lane starts here.
COUNTRIES = ("DK", "DE", "IT", "FR", "NL", "ES", "PL")

# Where buyers can ship to. Keep in sync with SHIP_TO_COUNTRIES in
# market/src/ship-countries.js (market/src/shipping-coverage.test.js checks it).
EU_DESTINATIONS = (
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
    "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
)
WORLD_DESTINATIONS = (
    "GB", "CH", "NO", "IS",
    "US", "CA", "MX", "BR", "AR", "CL",
    "JP", "CN", "HK", "TW", "KR", "SG", "MY", "TH", "PH", "ID", "VN", "IN",
    "AU", "NZ", "AE", "SA", "IL", "TR", "ZA",
)
DESTINATIONS = EU_DESTINATIONS + WORLD_DESTINATIONS

TIERS = [
    {"id": "SMALL", "maxCards": 4},
    {"id": "MEDIUM", "maxCards": 20},
    {"id": "LARGE", "maxCards": 200},
    {"id": "EXTRA_LARGE", "maxCards": 9999},
]

TIER_PROFILES = {
    "SMALL": {"weight": 0.053, "length": 18, "width": 12, "height": 1.0, "grams": 53},
    "MEDIUM": {"weight": 0.085, "length": 20, "width": 14, "height": 1.5, "grams": 85},
    "LARGE": {"weight": 0.165, "length": 22, "width": 16, "height": 2.5, "grams": 165},
    "EXTRA_LARGE": {"weight": 20.0, "length": 60, "width": 40, "height": 40, "grams": 20000},
}

EXCLUDED_SUBSTR = ("express", "vinted")
TRACKED_CARRIERS = (
    "inpost", "dhl", "postnord", "dao", "gls", "dpd", "hermes", "brt", "ups", "bring",
)
UNTRACKED_NAMES = ("poste italiane", "deutsche post", "posta", "la poste")

UA = {"User-Agent": "pokoin-shipping-rates-sync/2.0", "Accept": "application/json"}


def http_json(url: str, timeout: float = 30) -> dict | list:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def to_eur_cents(price: float, currency: str) -> int | None:
    cur = str(currency or "EUR").strip().upper()
    per = CURRENCY_PER_EUR.get(cur)
    if per is None:
        return None
    euros = float(price) if per == 1.0 else float(price) / per
    return max(1, int(round(euros * 100)))


def brand_key(row: dict) -> str:
    return f"{row.get('brandName') or ''} {row.get('provider') or ''}".lower()


def allowed(row: dict) -> bool:
    key = brand_key(row)
    return not any(x in key for x in EXCLUDED_SUBSTR)


# --- PackZoo -----------------------------------------------------------------

def smoke_packzoo() -> bool:
    try:
        rows = fetch_packzoo("IT", "IT", TIER_PROFILES["MEDIUM"])
        ok = any(r.get("price") is not None for r in rows)
        print(f"smoke packzoo: {'ok' if ok else 'empty'} ({len(rows)} rows)")
        return ok
    except Exception as exc:
        print(f"smoke packzoo: FAIL {exc}", file=sys.stderr)
        return False


def fetch_packzoo(frm: str, to: str, profile: dict) -> list[dict]:
    qs = urllib.parse.urlencode(
        {
            "from": frm,
            "to": to,
            "weight": profile["weight"],
            "length": profile["length"],
            "width": profile["width"],
            "height": profile["height"],
        }
    )
    body = http_json(f"{PACKZOO}?{qs}")
    return [r for r in (body.get("results") or []) if r.get("price") is not None]


def pick_packzoo(rows: list[dict], *, tracked: bool, tier: str) -> dict | None:
    if tier == "EXTRA_LARGE":
        usable = [r for r in rows if allowed(r)]
    elif tracked:
        usable = [
            r for r in rows
            if allowed(r) and any(p in brand_key(r) for p in TRACKED_CARRIERS)
        ]
        if not usable:
            usable = [
                r for r in rows
                if allowed(r) and not any(n in brand_key(r) for n in UNTRACKED_NAMES)
            ]
    else:
        letters = [
            r for r in rows
            if allowed(r) and any(n in brand_key(r) for n in UNTRACKED_NAMES)
        ]
        usable = letters or [r for r in rows if allowed(r)]
    if not usable:
        return None

    scored = []
    for row in usable:
        cents = to_eur_cents(row["price"], row.get("currency") or "EUR")
        if cents is None:
            continue
        key = brand_key(row)
        pref = next((i for i, p in enumerate(TRACKED_CARRIERS) if p in key), 99)
        scored.append((cents, pref, row))
    if not scored:
        return None
    cents, _pref, best = min(scored, key=lambda x: (x[0], x[1]))
    return {
        "priceEURCents": cents,
        "carrier": str(best.get("brandName") or "Carrier").strip(),
        "serviceName": (
            "Parcel" if tier == "EXTRA_LARGE"
            else ("Tracked" if tracked else "Untracked letter")
        ),
        "tracked": tracked,
        "rateSource": "packzoo",
        "productClass": "parcel" if tier == "EXTRA_LARGE" else "mixed",
    }


# --- porto-data (Deutsche Post / La Poste letter grids) ----------------------

def smoke_porto() -> bool:
    try:
        data = http_json(f"{PORTO_RAW}/deutschepost/prices/products.json")
        ok = bool(data.get("product_prices"))
        print(f"smoke porto-data DE: {'ok' if ok else 'empty'}")
        return ok
    except Exception as exc:
        print(f"smoke porto-data: FAIL {exc}", file=sys.stderr)
        return False


def _porto_amount(entry: dict, today: date) -> int | None:
    prices = entry.get("price") or entry.get("prices") or []
    if isinstance(prices, dict):
        prices = [prices]
    best = None
    for row in prices:
        amount = row.get("amount", row.get("price"))
        if amount is None:
            continue
        ef = row.get("effective_from")
        et = row.get("effective_to")
        if ef:
            try:
                if date.fromisoformat(str(ef)[:10]) > today:
                    continue
            except ValueError:
                pass
        if et:
            try:
                if date.fromisoformat(str(et)[:10]) < today:
                    continue
            except ValueError:
                pass
        best = int(amount)
    return best


def _weight_tier_for_grams(weights: dict, grams: int) -> str | None:
    # weights: { W0020: {min,max}, ... }
    for wid, band in weights.items():
        if not isinstance(band, dict):
            continue
        lo = int(band.get("min") or 0)
        hi = int(band.get("max") or 0)
        if lo <= grams <= hi:
            return wid
    return None


def _zone_for_dest(zones: list, to_cc: str, from_cc: str) -> str | None:
    to_cc = to_cc.upper()
    from_cc = from_cc.upper()
    if to_cc == from_cc:
        return "domestic"
    for zone in zones:
        codes = {str(c).upper() for c in (zone.get("country_codes") or [])}
        if to_cc in codes:
            return zone.get("id")
    return None


def load_porto_provider(slug: str, carrier: str) -> dict | None:
    try:
        prices = http_json(f"{PORTO_RAW}/{slug}/prices/products.json")
        weights_doc = http_json(f"{PORTO_RAW}/{slug}/weights.json")
        zones_doc = http_json(f"{PORTO_RAW}/{slug}/zones.json")
    except Exception as exc:
        print(f"warn: porto {slug}: {exc}", file=sys.stderr)
        return None
    weights = weights_doc.get("weights") or {}
    zones = zones_doc.get("zones") or []
    return {
        "carrier": carrier,
        "fromCountry": "DE" if slug == "deutschepost" else "FR",
        "product_prices": prices.get("product_prices") or [],
        "weights": weights,
        "zones": zones,
    }


def pick_porto(provider: dict, to_cc: str, grams: int, *, tracked: bool) -> dict | None:
    """Letter tariffs from porto-data are untracked base postage; skip for tracked."""
    if tracked:
        return None
    today = date.today()
    zone = _zone_for_dest(provider["zones"], to_cc, provider["fromCountry"])
    if not zone:
        return None
    tier = _weight_tier_for_grams(provider["weights"], grams)
    if not tier:
        return None
    # Prefer the cheapest product that matches zone + weight tier.
    candidates = []
    for entry in provider["product_prices"]:
        if entry.get("zone") != zone:
            continue
        if entry.get("weight_tier") != tier:
            continue
        # Skip registered / tracked product ids when asking untracked
        pid = str(entry.get("product_id") or "").lower()
        if any(x in pid for x in ("recommand", "einschreib", "tracked", "suivie")):
            continue
        amount = _porto_amount(entry, today)
        if amount is not None:
            candidates.append((amount, entry.get("product_id") or "letter"))
    if not candidates:
        return None
    amount, product = min(candidates, key=lambda x: x[0])
    return {
        "priceEURCents": amount,
        "carrier": provider["carrier"],
        "serviceName": "Untracked letter",
        "tracked": False,
        "rateSource": f"porto-data:{product}",
        "productClass": "letter",
    }


# --- dao letters (DK letter operator since 2026) ------------------------------

def smoke_dao_letters() -> bool:
    try:
        table = fetch_dao_letter_table()
        ok = "intl_100" in table and "domestic_100" in table
        print(f"smoke dao letters: {'ok' if ok else 'empty'} ({sorted(table)})")
        return ok
    except Exception as exc:
        print(f"smoke dao letters: FAIL {exc}", file=sys.stderr)
        return False


def fetch_dao_letter_table() -> dict[str, int]:
    """Parse https://dao.as/brev/ Alm. letter prices → EUR cents keyed by band."""
    req = urllib.request.Request(DAO_BREV, headers={**UA, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", "replace")
    # Rows look like: <td>…Udland alm. 100g</td><td>…46,00</td>
    rows = re.findall(
        r"<td[^>]*>\s*([^<]+?)\s*</td>\s*<td[^>]*>\s*([\d]+[,.][\d]{2})\s*</td>",
        html,
        flags=re.I,
    )
    out: dict[str, int] = {}
    for name, price in rows:
        label = " ".join(str(name).lower().split())
        if "plus" in label or "ekstra hurtig" in label:
            continue  # skip express-ish PLUS
        dkk = float(str(price).replace(",", "."))
        cents = to_eur_cents(dkk, "DKK")
        if cents is None:
            continue
        if "udland" in label and "100" in label:
            out["intl_100"] = cents
        elif "udland" in label and "250" in label:
            out["intl_250"] = cents
        elif "danmark" in label and "100" in label:
            out["domestic_100"] = cents
        elif "danmark" in label and "250" in label:
            out["domestic_250"] = cents
    if "intl_100" not in out or "intl_250" not in out:
        raise RuntimeError(f"dao brev table missing intl bands: {out}")
    if "domestic_100" not in out or "domestic_250" not in out:
        raise RuntimeError(f"dao brev table missing domestic bands: {out}")
    return out


def pick_dao_letter(table: dict[str, int], frm: str, to: str, grams: int, *, tracked: bool) -> dict | None:
    """dao Alm. letters are untracked mailbox post; skip when tracked is required."""
    if tracked or frm.upper() != "DK":
        return None
    domestic = frm.upper() == to.upper()
    if grams <= 100:
        cents = table["domestic_100" if domestic else "intl_100"]
        band = "100g"
    elif grams <= 250:
        cents = table["domestic_250" if domestic else "intl_250"]
        band = "250g"
    else:
        return None  # over letter max — keep PackZoo parcel
    return {
        "priceEURCents": cents,
        "carrier": "dao",
        "serviceName": f"Untracked letter ({band})",
        "tracked": False,
        "rateSource": "dao-brev",
        "productClass": "letter",
    }


# --- merge / write -----------------------------------------------------------

def rate_id(frm: str, to: str, tier: str, tracked: bool) -> str:
    base = f"{frm.lower()}-{to.lower()}-{tier.lower().replace('_', '-')}"
    return base if tracked else f"{base}-untracked"


def merge_quote(existing: dict | None, candidate: dict | None) -> dict | None:
    if not candidate:
        return existing
    if not existing:
        return candidate
    if candidate["priceEURCents"] < existing["priceEURCents"]:
        out = dict(candidate)
        out["providersCompared"] = sorted(
            set((existing.get("providersCompared") or [existing.get("rateSource")])
                + (candidate.get("providersCompared") or [candidate.get("rateSource")]))
        )
        return out
    out = dict(existing)
    srcs = set(existing.get("providersCompared") or [existing.get("rateSource")])
    srcs.add(candidate.get("rateSource"))
    out["providersCompared"] = sorted(srcs)
    return out


def detect_flat_parcel(quotes_by_tier: dict[str, dict]) -> None:
    """If SMALL/MEDIUM/LARGE tracked prices are identical, mark as parcel floor."""
    tracked = {
        t: q for t, q in quotes_by_tier.items()
        if q and q.get("tracked") and t != "EXTRA_LARGE"
    }
    if len(tracked) < 2:
        return
    prices = {q["priceEURCents"] for q in tracked.values()}
    if len(prices) == 1:
        for q in tracked.values():
            q["productClass"] = "parcel"


def report_coverage(rates: list[dict], lanes: list[tuple[str, str]]) -> None:
    """Print every lane/tier with no rate at all, and lanes with no tracked option."""
    have = {(r["fromCountry"], r["toCountry"], r["packageTier"]) for r in rates}
    tracked = {(r["fromCountry"], r["toCountry"]) for r in rates if r.get("tracked")}
    gaps = [
        f"{frm}>{to}:{tier['id']}"
        for frm, to in lanes
        for tier in TIERS
        if (frm, to, tier["id"]) not in have
    ]
    untracked_only = [f"{frm}>{to}" for frm, to in lanes if (frm, to) not in tracked]
    print(f"coverage: {len(lanes)} lanes, {len(gaps)} lane/tier gaps, {len(untracked_only)} lanes without tracked")
    if gaps:
        print("  gaps: " + " ".join(gaps[:80]) + (" …" if len(gaps) > 80 else ""))
    if untracked_only:
        print("  untracked only: " + " ".join(untracked_only[:80]) + (" …" if len(untracked_only) > 80 else ""))


SPA_FIELDS = ("id", "fromCountry", "toCountry", "packageTier", "maxCards", "priceEURCents", "carrier", "serviceName", "active", "tracked")


def spa_catalog(catalog: dict) -> dict:
    """The SPA only previews prices: keep the fields shipping-quote.js reads."""
    return {
        "tiers": catalog["tiers"],
        "rates": [{k: r[k] for k in SPA_FIELDS if k in r} for r in catalog["rates"]],
        "source": {"fetchedAt": catalog["source"]["fetchedAt"], "providers": catalog["source"]["providers"]},
    }


def build_catalog(*, sleep_s: float = 0.12) -> dict:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    packzoo_ok = smoke_packzoo()
    porto_ok = smoke_porto()
    dao_ok = smoke_dao_letters()
    if not packzoo_ok and not porto_ok and not dao_ok:
        raise SystemExit("no providers passed smoke test")

    porto_providers = []
    if porto_ok:
        for slug, carrier in (("deutschepost", "Deutsche Post"), ("laposte", "La Poste")):
            prov = load_porto_provider(slug, carrier)
            if prov:
                porto_providers.append(prov)
                print(f"loaded porto-data {slug} ({len(prov['product_prices'])} price rows)")

    dao_table = fetch_dao_letter_table() if dao_ok else {}

    # Cache PackZoo: (from,to,tier) -> rows
    pz_cache: dict[tuple, list] = {}
    rates: list[dict] = []
    lanes = [(a, b) for a in COUNTRIES for b in DESTINATIONS]

    for frm, to in lanes:
        lane_quotes: dict[str, dict] = {}
        for tier, profile in TIER_PROFILES.items():
            key = (frm, to, tier)
            rows: list[dict] = []
            if packzoo_ok:
                if key not in pz_cache:
                    try:
                        pz_cache[key] = fetch_packzoo(frm, to, profile)
                    except Exception as exc:
                        print(f"warn packzoo {frm}->{to} {tier}: {exc}", file=sys.stderr)
                        pz_cache[key] = []
                    time.sleep(sleep_s)
                rows = pz_cache[key]

            for tracked in (True, False):
                if tier == "EXTRA_LARGE" and not tracked:
                    continue  # bag is always a tracked parcel
                best = None
                if rows:
                    best = merge_quote(best, pick_packzoo(rows, tracked=tracked, tier=tier))
                for prov in porto_providers:
                    if prov["fromCountry"] != frm:
                        continue
                    best = merge_quote(
                        best,
                        pick_porto(prov, to, profile["grams"], tracked=tracked),
                    )
                if dao_table:
                    best = merge_quote(
                        best,
                        pick_dao_letter(dao_table, frm, to, profile["grams"], tracked=tracked),
                    )
                if not best:
                    continue
                best["fetchedAt"] = now
                lane_quotes[f"{tier}:{'T' if tracked else 'U'}"] = best

                rid = rate_id(frm, to, tier, tracked)
                rates.append({
                    "id": rid,
                    "fromCountry": frm,
                    "toCountry": to,
                    "packageTier": tier,
                    "maxCards": next(t["maxCards"] for t in TIERS if t["id"] == tier),
                    "priceEURCents": best["priceEURCents"],
                    "carrier": best["carrier"],
                    "serviceName": best["serviceName"],
                    "active": True,
                    "tracked": tracked,
                    "rateSource": best.get("rateSource"),
                    "productClass": best.get("productClass"),
                    "fetchedAt": now,
                    "providersCompared": best.get("providersCompared") or [best.get("rateSource")],
                })

        # Flat-parcel detection on tracked letter tiers
        by_tier = {}
        for k, q in lane_quotes.items():
            tier_name, flag = k.split(":")
            if flag == "T":
                by_tier[tier_name] = q
        detect_flat_parcel(by_tier)
        # propagate productClass back onto rate rows
        for rate in rates:
            if rate["fromCountry"] != frm or rate["toCountry"] != to:
                continue
            q = by_tier.get(rate["packageTier"])
            if q and rate.get("tracked") and q.get("productClass"):
                rate["productClass"] = q["productClass"]

    rates.sort(key=lambda r: (r["fromCountry"], r["toCountry"], r["packageTier"], not r["tracked"]))
    print(f"built {len(rates)} rate rows across {len(lanes)} lanes")
    report_coverage(rates, lanes)
    providers = [
        p for p, ok in (
            ("packzoo", packzoo_ok),
            ("porto-data", porto_ok),
            ("dao-brev", dao_ok),
        ) if ok
    ]
    return {
        "tiers": TIERS,
        "rates": rates,
        "source": {
            "providers": providers,
            "fetchedAt": now,
            "api": {
                "packzoo": PACKZOO,
                "portoData": PORTO_RAW,
                "daoBrev": DAO_BREV,
            },
            "note": (
                "Live PackZoo compare merged with porto-data + dao letter grids. "
                "Cheapest non-express wins. No manual overrides."
            ),
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--also-cardvault", action="store_true")
    ap.add_argument("--sleep", type=float, default=0.12)
    args = ap.parse_args()

    catalog = build_catalog(sleep_s=args.sleep)
    text = json.dumps(catalog, indent=2, ensure_ascii=False) + "\n"
    if args.dry_run:
        print(text[:2500], "…")
        return 0

    API_JSON.write_text(text, encoding="utf-8")
    SPA_JSON.write_text(json.dumps(spa_catalog(catalog), separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {API_JSON.relative_to(ROOT)}")
    print(f"wrote {SPA_JSON.relative_to(ROOT)}")
    if args.also_cardvault and CARDVAULT_JSON.is_file():
        CARDVAULT_JSON.write_text(text, encoding="utf-8")
        print(f"wrote {CARDVAULT_JSON}")

    # Remove obsolete override + old script name note
    old_overrides = ROOT / "server" / "pokoin-api" / "shipping-rates.overrides.json"
    if old_overrides.is_file():
        old_overrides.unlink()
        print(f"removed {old_overrides.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
