#!/usr/bin/env python3
"""Publish cheap browse lists from Oracle Postgres to Supabase.

Oracle stays source of truth and search. CardTrader snapshots stay on Oracle.
This script publishes ranked rails plus compact card weights, using short
statement timeouts so a CardTrader refresh cannot hold it for minutes.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from valkey_cache import get_json as valkey_get_json
    from valkey_cache import set_json as valkey_set_json
except ImportError:
    def valkey_get_json(_key):
        return None

    def valkey_set_json(_key, _value, _ttl):
        return False

API_ORIGIN = os.environ.get("API_ORIGIN", "http://127.0.0.1:18080").rstrip("/")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SECRET_ACCESS_KEY") or ""
# 1 PKN = 0.005 USDT. EUR asks use the same rate (Oracle marketplace_price_pkn_from_cardtrader).
PKN_USDT_PRICE = os.environ.get("PKN_USDT_PRICE") or os.environ.get("PKN_CHECKOUT_USDT_PRICE") or "0.005"
CARDTRADER_AUTH_TOKEN = os.environ.get("CARDTRADER_AUTH_TOKEN") or ""
CARDTRADER_API_BASE = "https://api.cardtrader.com/api/v2"
PROMO_SLUGS = [
    "mega-evolution",
    "phantasmal-flames",
    "black-bolt",
    "white-flare",
    "destined-rivals",
]
LIVE_SET_NAMES = (
    "Mega Evolution",
    "Phantasmal Flames",
    "Black Bolt",
    "White Flare",
    "Destined Rivals",
)

TILE_SQL = r"""
    c.card_id::text AS id,
    c.card_id::text AS card_id,
    c.ct_id,
    c.name,
    c.set_name,
    c.set_name AS set,
    coalesce(c.card_number, '') AS number,
    coalesce(c.card_number, '') AS card_number,
    coalesce(c.rarity, 'Card') AS rarity,
    'single' AS "itemKind",
    'card' AS "productType",
    '/marketplace/en/cards/' || c.card_id::text AS "canonicalPath",
    '/marketplace/en/cards/' || c.card_id::text AS canonical_path,
    coalesce(c.cdn_image_url, c.image_url, '') AS "imageUrl",
    case
      when coalesce(c.homepage_image_url, '') like '%_homepage.webp%' then c.homepage_image_url
      else regexp_replace(
        regexp_replace(coalesce(c.cdn_image_url, c.image_url, ''), '[?#].*$', ''),
        '\.(jpe?g|png|webp)$',
        '_homepage.webp',
        'i'
      )
    end AS "gridImageUrl",
    coalesce(c.cdn_image_url, c.image_url, '') AS "heroImageUrl",
    case
      when coalesce(c.homepage_image_url, '') like '%_homepage.webp%' then c.homepage_image_url
      else regexp_replace(
        regexp_replace(coalesce(c.cdn_image_url, c.image_url, ''), '[?#].*$', ''),
        '\.(jpe?g|png|webp)$',
        '_homepage.webp',
        'i'
      )
    end AS "tileImageUrl",
    round(coalesce(
      cache.cheapest_price_pkn,
      public.marketplace_price_pkn_from_cardtrader(w.median_sold_eur, null, 'EUR')
    )::numeric, 2) AS price,
    round(coalesce(
      cache.cheapest_price_pkn,
      public.marketplace_price_pkn_from_cardtrader(w.median_sold_eur, null, 'EUR')
    )::numeric, 2) AS "lowest_price_pkn",
    (coalesce(cache.eligible_listing_count, 0) > 0 OR coalesce(w.native_listed, 0) > 0) AS "isMarketAvailable",
    (coalesce(cache.eligible_listing_count, 0) > 0 OR coalesce(w.native_listed, 0) > 0) AS "inStock",
    coalesce(w.combined_weight, 0) AS "listingWeight",
    coalesce(w.best_seller_score, 0) AS "bestSellerScore",
    coalesce(w.featured_score, 0) AS "featuredScore",
    coalesce(w.sold_7d, 0) AS "sold7d",
    coalesce(w.new_7d, 0) AS "new7d",
    coalesce(w.sold_value_eur_7d, 0) AS "soldGmvEur",
    w.median_sold_eur AS "medianSoldEur"
"""


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


def psql_json_lines(sql: str, timeout: int = 45) -> list[dict]:
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
            timeout=timeout,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as error:
        print(f"psql skipped: {error}", file=sys.stderr)
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
            row["set"] = row.get("set_name") or row.get("set") or ""
            rows.append(row)
    return rows


def session_sql(timeout: str = "30s") -> str:
    rate = str(PKN_USDT_PRICE).replace("'", "")
    return f"SET statement_timeout = '{timeout}';\nSELECT set_config('app.pkn_usdt_price', '{rate}', true);\n"


def take_unique(cards: list, limit: int, exclude: set | None = None) -> list:
    return take_rail(cards, limit, exclude=exclude, unique_names=False, max_per_set=None)


def take_rail(
    cards: list,
    limit: int,
    exclude: set | None = None,
    exclude_names: set | None = None,
    unique_names: bool = True,
    max_per_set: int | None = None,
) -> list:
    skip = set(exclude or [])
    names: set[str] = set(exclude_names or [])
    per_set: dict[str, int] = {}
    out = []
    for card in cards or []:
        cid = card_id(card)
        if not cid or cid in skip:
            continue
        nk = name_key(card)
        if unique_names and nk and nk in names:
            continue
        set_name = str(card.get("set") or card.get("set_name") or "")
        if max_per_set and set_name and per_set.get(set_name, 0) >= max_per_set:
            continue
        skip.add(cid)
        if nk:
            names.add(nk)
        if set_name:
            per_set[set_name] = per_set.get(set_name, 0) + 1
        out.append(card)
        if len(out) >= limit:
            break
    return out


COLLECTOR_RE = re.compile(r"(\d+)\s*/\s*(\d+)")


def collector_pair(card: dict):
    blob = " ".join(str(card.get(key) or "") for key in ("number", "card_number", "rarity"))
    match = COLLECTOR_RE.search(blob)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def name_key(card: dict) -> str:
    return re.sub(r"\s+", " ", str(card.get("name") or "").strip().lower())


def has_tile_price(card: dict) -> bool:
    try:
        amount = float(card.get("price") or card.get("lowest_price_pkn") or 0)
    except (TypeError, ValueError):
        amount = 0
    return amount > 0


BASIC_ENERGY_RE = re.compile(
    r"^(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy|dragon|colorless)\s+energy$",
    re.I,
)


def is_basic_energy(card: dict) -> bool:
    return bool(BASIC_ENERGY_RE.match(str(card.get("name") or "").strip()))


ENERGY_NAME_RE = re.compile(r"\benergy\b", re.I)


def is_energy_card(card: dict) -> bool:
    return is_basic_energy(card) or bool(ENERGY_NAME_RE.search(str(card.get("name") or "")))


def pick_live_homepage(cards: list[dict], limit: int) -> list[dict]:
    """One chase + one in-set card per live English set, unique names, PKN first."""
    groups: dict[str, list] = {name: [] for name in LIVE_SET_NAMES}
    for card in cards or []:
        set_name = str(card.get("set") or card.get("set_name") or "")
        if set_name in groups:
            groups[set_name].append(card)

    def pick(rows, chase: bool, exclude_ids: set):
        inset = []
        for card in rows:
            cid = card_id(card)
            if not cid or cid in exclude_ids:
                continue
            pair = collector_pair(card)
            if chase:
                if pair and pair[0] > pair[1]:
                    return card
                continue
            if pair and pair[0] > pair[1]:
                continue
            inset.append(card)
        if chase:
            return None
        inset.sort(key=lambda card: 0 if is_energy_card(card) else 1, reverse=True)
        return inset[0] if inset else None

    mixed = []
    seen_ids = set()
    seen_names = set()

    def add(card):
        if not card or len(mixed) >= limit:
            return False
        cid = card_id(card)
        key = name_key(card)
        if not cid or cid in seen_ids or (key and key in seen_names):
            return False
        seen_ids.add(cid)
        if key:
            seen_names.add(key)
        mixed.append(card)
        return True

    def add_kind(rows, chase: bool):
        exclude = set(seen_ids)
        for _ in range(16):
            card = pick(rows, chase, exclude)
            if not card:
                return
            cid = card_id(card)
            key = name_key(card)
            if (key and key in seen_names) or (not chase and is_energy_card(card)):
                exclude.add(cid)
                continue
            if add(card):
                return
            exclude.add(cid)

    for name in LIVE_SET_NAMES:
        rows = groups[name]
        add_kind(rows, True)
        add_kind(rows, False)
    for card in cards or []:
        if is_energy_card(card):
            continue
        add(card)
    return mixed


def psql_weighted_cards(order_sql: str, extra_where: str = "", limit: int = 1000) -> list[dict]:
    sql = f"""
{session_sql("30s")}
SELECT row_to_json(t)
FROM (
  SELECT
    {TILE_SQL}
  FROM public.marketplace_card_weights w
  JOIN public.marketplace_search_candidates c
    ON c.card_id::text = w.card_id
  LEFT JOIN public.cardtrader_blueprint_listing_cache cache
    ON cache.blueprint_id = c.ct_id
  WHERE c.item_kind = 'single'
    AND c.product_type = 'card'
    AND coalesce(c.cdn_image_url, c.image_url) IS NOT NULL
    AND w.combined_weight > 0
    {extra_where}
  ORDER BY {order_sql}
  LIMIT {int(limit)}
) t;
"""
    return psql_json_lines(sql)


def psql_catalog_fallback(limit: int = 1000) -> list[dict]:
    sql = f"""
{session_sql("30s")}
SELECT row_to_json(t)
FROM (
  SELECT
    {TILE_SQL}
  FROM public.marketplace_search_candidates c
  LEFT JOIN public.marketplace_card_weights w
    ON w.card_id = c.card_id::text
  LEFT JOIN public.cardtrader_blueprint_listing_cache cache
    ON cache.blueprint_id = c.ct_id
  WHERE c.item_kind = 'single'
    AND c.product_type = 'card'
    AND coalesce(c.cdn_image_url, c.image_url) IS NOT NULL
  ORDER BY c.search_weight DESC NULLS LAST, c.card_id DESC
  LIMIT {int(limit)}
) t;
"""
    return psql_json_lines(sql)


def psql_live_set_cards(per_set: int = 4) -> list[dict]:
    names = ", ".join("'" + name.replace("'", "''") + "'" for name in LIVE_SET_NAMES)
    chase_n = max(2, int(per_set) // 4)
    inset_n = max(4, int(per_set) - chase_n)
    sql = f"""
{session_sql("20s")}
SELECT row_to_json(t)
FROM (
  SELECT *
  FROM (
    SELECT
      ranked.*,
      row_number() OVER (
        PARTITION BY ranked.set_name, ranked.is_chase
        ORDER BY ranked.card_id DESC
      ) AS rn
    FROM (
      SELECT
        {TILE_SQL},
        CASE
          WHEN coalesce(c.card_number, '') ~ '[[:digit:]]+[[:space:]]*/[[:space:]]*[[:digit:]]+'
           AND (regexp_match(c.card_number, '([[:digit:]]+)[[:space:]]*/[[:space:]]*([[:digit:]]+)'))[1]::int
             > (regexp_match(c.card_number, '([[:digit:]]+)[[:space:]]*/[[:space:]]*([[:digit:]]+)'))[2]::int
          THEN 1
          ELSE 0
        END AS is_chase
      FROM public.marketplace_search_candidates c
      LEFT JOIN public.marketplace_card_weights w
        ON w.card_id = c.card_id::text
      LEFT JOIN public.cardtrader_blueprint_listing_cache cache
        ON cache.blueprint_id = c.ct_id
      WHERE c.item_kind = 'single'
        AND c.product_type = 'card'
        AND coalesce(c.cdn_image_url, c.image_url) IS NOT NULL
        AND c.set_name = ANY(ARRAY[{names}]::text[])
    ) ranked
  ) numbered
  WHERE (numbered.is_chase = 1 AND numbered.rn <= {chase_n})
     OR (numbered.is_chase = 0 AND numbered.rn <= {inset_n})
  ORDER BY numbered.is_chase DESC, numbered.rn,
    array_position(ARRAY[{names}]::text[], numbered.set_name)
) t;
"""
    return [publish_card(row) for row in psql_json_lines(sql, timeout=30)]


def psql_tiles_for_ids(ids: list[str]) -> dict[str, dict]:
    clean = [str(item) for item in ids if str(item).isdigit()][:400]
    if not clean:
        return {}
    array = ", ".join("'" + item + "'" for item in clean)
    sql = f"""
{session_sql("20s")}
SELECT row_to_json(t)
FROM (
  SELECT
    {TILE_SQL}
  FROM public.marketplace_search_candidates c
  LEFT JOIN public.marketplace_card_weights w
    ON w.card_id = c.card_id::text
  LEFT JOIN public.cardtrader_blueprint_listing_cache cache
    ON cache.blueprint_id = c.ct_id
  WHERE c.card_id::text = ANY(ARRAY[{array}]::text[])
) t;
"""
    return {card_id(row): row for row in psql_json_lines(sql, timeout=30)}


def publish_card(card: dict) -> dict:
    out = {
        key: value
        for key, value in (card or {}).items()
        if key not in {"rn", "is_chase"} and not str(key).startswith("_")
    }
    if out.get("set_name") and not out.get("set"):
        out["set"] = out["set_name"]
    return out


def pkn_from_eur(eur) -> float | None:
    try:
        amount = float(eur)
    except (TypeError, ValueError):
        return None
    rate = float(PKN_USDT_PRICE)
    if amount <= 0 or rate <= 0:
        return None
    return round(amount / rate, 2)


def overlay_pkn(cards: list[dict]) -> list[dict]:
    priced = psql_tiles_for_ids([card_id(card) for card in cards or []])
    out = []
    for card in cards or []:
        extra = priced.get(card_id(card))
        if not extra:
            out.append(publish_card(card))
            continue
        merged = dict(card)
        for key in ("price", "lowest_price_pkn", "isMarketAvailable", "inStock", "medianSoldEur"):
            if extra.get(key) not in (None, ""):
                merged[key] = extra[key]
        out.append(publish_card(merged))
    return out


def _cardtrader_rows(payload) -> list[dict]:
    rows = []
    if isinstance(payload, dict):
        for value in payload.values():
            if isinstance(value, list):
                rows.extend(item for item in value if isinstance(item, dict))
            elif isinstance(value, dict):
                rows.append(value)
    elif isinstance(payload, list):
        rows.extend(item for item in payload if isinstance(item, dict))
    return rows


def _cardtrader_ask_eur(rows: list[dict]) -> float | None:
    ranked = []
    fallback = []
    for row in rows or []:
        if row.get("on_vacation"):
            continue
        cents = row.get("price_cents")
        try:
            cents_n = int(cents)
        except (TypeError, ValueError):
            continue
        if cents_n <= 0:
            continue
        props = row.get("properties_hash") if isinstance(row.get("properties_hash"), dict) else {}
        if props.get("signed") or props.get("altered"):
            continue
        currency = str(row.get("price_currency") or (row.get("price") or {}).get("currency") or "EUR").upper()
        if currency not in ("EUR", "USDT", "USD"):
            continue
        eur = cents_n / 100
        cond = str(props.get("condition") or "").lower()
        lang = str(props.get("pokemon_language") or "en").lower()
        reverse = bool(props.get("pokemon_reverse"))
        nm = cond in {"near mint", "mint", "nm"}
        english = lang in {"en", "eng", "english"}
        if nm and english:
            ranked.append((1 if reverse else 0, eur))
        else:
            fallback.append(eur)
    if ranked:
        ranked.sort()
        return ranked[0][1]
    return min(fallback) if fallback else None


def overlay_cardtrader_asks(cards: list[dict], limit: int = 40) -> list[dict]:
    token = CARDTRADER_AUTH_TOKEN.strip()
    if not token:
        print("cardtrader overlay skipped: no CARDTRADER_AUTH_TOKEN", file=sys.stderr)
        return cards
    needed = []
    seen = set()
    for card in cards or []:
        if has_tile_price(card):
            continue
        blueprint = str(card.get("ct_id") or "")
        cid = card_id(card)
        if not blueprint.isdigit() or not cid or cid in seen:
            continue
        seen.add(cid)
        needed.append((cid, blueprint))
        if len(needed) >= limit:
            break
    priced = {}
    to_fetch = []
    for cid, blueprint in needed:
        cached = valkey_get_json(f"pkn:ct:{blueprint}")
        if isinstance(cached, dict) and "pkn" in cached:
            if cached.get("pkn"):
                priced[cid] = cached["pkn"]
            continue
        to_fetch.append((cid, blueprint))
    for index, (cid, blueprint) in enumerate(to_fetch):
        if index:
            time.sleep(0.2)
        url = f"{CARDTRADER_API_BASE}/marketplace/products?{urllib.parse.urlencode({'blueprint_id': blueprint})}"
        request = urllib.request.Request(
            url,
            headers={"Accept": "application/json", "Authorization": f"Bearer {token}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            print(f"cardtrader skip blueprint={blueprint}: {error}", file=sys.stderr)
            continue
        eur = _cardtrader_ask_eur(_cardtrader_rows(payload))
        pkn = pkn_from_eur(eur)
        if pkn is None:
            valkey_set_json(f"pkn:ct:{blueprint}", {"pkn": None}, 300)
            continue
        valkey_set_json(f"pkn:ct:{blueprint}", {"pkn": pkn, "eur": eur}, 21600)
        priced[cid] = pkn
    if priced:
        print(
            f"cardtrader overlay priced={len(priced)} fetched={len(to_fetch)} of {len(needed)}",
            file=sys.stderr,
        )
    out = []
    for card in cards or []:
        pkn = priced.get(card_id(card))
        if pkn is None:
            out.append(card)
            continue
        merged = dict(card)
        merged["price"] = pkn
        merged["lowest_price_pkn"] = pkn
        merged["priceSource"] = "cardtrader_live"
        out.append(merged)
    return out


def psql_weight_rows(limit: int = 2000) -> list[dict]:
    sql = f"""
{session_sql("20s")}
SELECT row_to_json(t)
FROM (
  SELECT
    w.card_id,
    w.combined_weight AS weight,
    w.sold_7d,
    w.new_7d,
    w.listed_now AS listed,
    w.native_listed,
    jsonb_build_object(
      'sold1d', w.sold_1d,
      'soldQty7d', w.sold_qty_7d,
      'gmvEur7d', w.sold_value_eur_7d,
      'medianEur', w.median_sold_eur,
      'sellThrough', w.sell_through,
      'daysOfSupply', w.days_of_supply,
      'demand', w.demand_score,
      'bestSeller', w.best_seller_score,
      'featured', w.featured_score,
      'ctSold7d', w.ct_sold_7d,
      'nativeSold7d', w.native_sold_7d,
      'hot24h', w.hot_score_24h
    ) AS stats,
    w.updated_at
  FROM public.marketplace_card_weights w
  WHERE w.combined_weight > 0
  ORDER BY w.combined_weight DESC, w.card_id DESC
  LIMIT {int(limit)}
) t;
"""
    rows = []
    for row in psql_json_lines(sql, timeout=30):
        rows.append(
            {
                "card_id": str(row.get("card_id") or ""),
                "weight": row.get("weight") or 0,
                "sold_7d": int(row.get("sold_7d") or 0),
                "new_7d": int(row.get("new_7d") or 0),
                "listed": int(row.get("listed") or 0),
                "native_listed": int(row.get("native_listed") or 0),
                "stats": row.get("stats") or {},
                "updated_at": row.get("updated_at") or now_iso(),
            }
        )
    return [row for row in rows if row["card_id"]]


def main() -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        die("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")

    rails = []
    tiles = []

    home = get_json(f"{API_ORIGIN}/api/marketplace-home-page")
    home_new = []
    home_spotlight = []
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

        home_new = take(sections.get("newArrivalIds"))
        home_spotlight = take(sections.get("spotlightIds"))
        tiles.extend(tiles_from_cards(overlay_pkn(cards)))

    top = psql_weighted_cards(
        "w.sold_qty_7d DESC, w.demand_score DESC, c.card_id DESC",
        extra_where="AND w.sold_qty_7d >= 3 AND w.listed_now > 0",
        limit=48,
    )
    if not top:
        top = psql_catalog_fallback(48)
    best = take_rail(
        [
            card
            for card in psql_weighted_cards(
                "w.sold_qty_7d DESC, w.best_seller_score DESC, c.card_id DESC",
                extra_where=(
                    "AND w.sold_qty_7d >= 3 AND w.listed_now > 0"
                    " AND c.name !~* '^(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy|dragon|colorless) energy$'"
                    " AND (w.median_sold_eur IS NULL OR w.median_sold_eur <= 15)"
                ),
                limit=48,
            )
            if not is_basic_energy(card)
        ],
        12,
    )
    best_ids = {card_id(card) for card in best}
    best_names = {name_key(card) for card in best if name_key(card)}
    featured = take_rail(
        [
            card
            for card in psql_weighted_cards(
                "w.sell_through DESC NULLS LAST, w.demand_score DESC, w.sold_qty_7d DESC, c.card_id DESC",
                extra_where=(
                    "AND w.sold_qty_7d >= 3 AND w.listed_now >= 8 AND w.demand_score > 0"
                    " AND c.name !~* '^(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy|dragon|colorless) energy$'"
                ),
                limit=64,
            )
            if not is_basic_energy(card)
        ],
        12,
        exclude=best_ids,
        exclude_names=best_names,
        max_per_set=2,
    )
    if len(featured) < 12:
        featured.extend(
            take_rail(
                [
                    card
                    for card in psql_weighted_cards(
                        "w.sell_through DESC NULLS LAST, w.demand_score DESC, w.sold_qty_7d DESC, c.card_id DESC",
                        extra_where=(
                            "AND w.sold_qty_7d >= 3 AND w.listed_now >= 8 AND w.demand_score > 0"
                            " AND (w.median_sold_eur IS NULL OR w.median_sold_eur <= 15)"
                            " AND c.name !~* '^(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy|dragon|colorless) energy$'"
                        ),
                        limit=48,
                    )
                    if not is_basic_energy(card)
                ],
                12 - len(featured),
                exclude=best_ids | {card_id(card) for card in featured},
                exclude_names=best_names | {name_key(card) for card in featured if name_key(card)},
                max_per_set=2,
            )
        )
    live_pool = overlay_pkn(psql_live_set_cards(16))
    new_cards = overlay_cardtrader_asks(pick_live_homepage(live_pool, 12), limit=16)
    spotlight = overlay_cardtrader_asks(pick_live_homepage(live_pool, 16), limit=20)
    if not new_cards:
        new_cards = overlay_cardtrader_asks(overlay_pkn(home_new))
    if not spotlight:
        spotlight = overlay_cardtrader_asks(overlay_pkn(home_spotlight)) or new_cards

    meta_rate = {"pknUsdt": float(PKN_USDT_PRICE)}
    rails.append(rail("new_cards", new_cards, {"source": "live_sets_chase_inset", **meta_rate}))
    rails.append(rail("spotlight", spotlight, {"source": "live_sets_chase_inset", **meta_rate}))
    rails.append(rail("featured", featured, {"source": "trending_sellthrough", **meta_rate}))
    rails.append(rail("best_sellers", best, {"source": "units_7d", **meta_rate}))
    rails.append(rail("top_sold", top[:48], {"limit": 48, "source": "units_demand", **meta_rate}))
    tiles.extend(tiles_from_cards(top[:48]))
    tiles.extend(tiles_from_cards(best))
    tiles.extend(tiles_from_cards(featured))
    tiles.extend(tiles_from_cards(new_cards))
    tiles.extend(tiles_from_cards(spotlight))

    if not any(row["cards"] or row["id"] == "set_index" for row in rails):
        die("no rails collected; oracle API/SQL both empty")

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
            set_cards = overlay_pkn(page.get("cards") or [])
            expansion = dict(page.get("expansion") or {"slug": slug})
            card_count = int(expansion.get("cardCount") or page.get("total") or 0)
            if card_count > 0:
                expansion["cardCount"] = card_count
            rails.append(
                rail(
                    f"set:{slug}",
                    set_cards,
                    {
                        "expansion": expansion,
                        "hasMore": bool(page.get("hasMore")),
                        "name": expansion.get("name") or slug,
                        "cardCount": card_count,
                        "total": card_count,
                    },
                )
            )
            tiles.extend(tiles_from_cards(set_cards))

    unique = {}
    for row in tiles:
        cid = row["card_id"]
        existing = unique.get(cid)
        if not existing:
            unique[cid] = row
            continue
        incoming = row.get("payload") or {}
        old = existing.get("payload") or {}
        if has_tile_price(incoming) and not has_tile_price(old):
            unique[cid] = row
            continue
        if incoming.get("priceSource") == "cardtrader_live" and old.get("priceSource") != "cardtrader_live":
            unique[cid] = row
    tiles = list(unique.values())

    upsert("marketplace_rails", rails, "id")
    for i in range(0, len(tiles), 200):
        upsert("marketplace_card_tiles", tiles[i : i + 200], "card_id")

    weights = psql_weight_rows(2000)
    for i in range(0, len(weights), 200):
        upsert("marketplace_card_weights", weights[i : i + 200], "card_id")

    print(f"published rails={len(rails)} tiles={len(tiles)} weights={len(weights)}")


if __name__ == "__main__":
    main()
