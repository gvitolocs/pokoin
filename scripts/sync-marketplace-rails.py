#!/usr/bin/env python3
"""Publish browse rails into Pi Postgres (marketplace_rails). No Supabase. Public card_id only.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
import random
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
POSTGRES_CONTAINER = os.environ.get("POKOIN_MARKETPLACE_POSTGRES") or "pokoin-marketplace-postgres-replica"
# 1 PKN = 0.005 USDT. EUR asks use the same rate (Oracle marketplace_price_pkn_from_cardtrader).
PKN_USDT_PRICE = os.environ.get("PKN_USDT_PRICE") or os.environ.get("PKN_CHECKOUT_USDT_PRICE") or "0.005"
CARDTRADER_AUTH_TOKEN = os.environ.get("CARDTRADER_AUTH_TOKEN") or ""
CARDTRADER_API_BASE = "https://api.cardtrader.com/api/v2"
PROMO_SLUGS = [
    "storm-emeralda",
    "mega-evolution",
    "phantasmal-flames",
    "black-bolt",
    "white-flare",
    "destined-rivals",
]
LIVE_SET_NAMES = (
    "Storm Emeralda",
    "Mega Evolution",
    "Phantasmal Flames",
    "Black Bolt",
    "White Flare",
    "Destined Rivals",
)

# CardTrader files League Promo backpacks as singles with a region as the
# collector number. Keep trainer cards like Nemona's Backpack (083/091).
NOT_MERCH_SINGLE_SQL = r"""
    AND NOT (
      c.name ~* '(^|[^a-z0-9])backpack([^a-z0-9]|$)'
      AND coalesce(c.card_number, '') !~ '[0-9]{1,4}[A-Za-z]?/[0-9]{1,4}'
    )
"""

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
    coalesce(c.artist, '') AS artist,
    coalesce(c.illustrator, '') AS illustrator,
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


def _sql_literal(value) -> str:
    return json.dumps(value, ensure_ascii=False).replace("'", "''")


def upsert(table: str, rows: list[dict], on_conflict: str) -> None:
    if not rows:
        return
    if table == "marketplace_rails":
        values = ",".join(
            "('{id}', '{cards}'::jsonb, '{meta}'::jsonb, now())".format(
                id=row["id"].replace("'", "''"),
                cards=_sql_literal(row.get("cards") or []),
                meta=_sql_literal(row.get("meta") or {}),
            )
            for row in rows
        )
        psql_json_lines(
            "INSERT INTO public.marketplace_rails (id, cards, meta, updated_at) VALUES "
            + values
            + " ON CONFLICT (id) DO UPDATE SET cards = EXCLUDED.cards, meta = EXCLUDED.meta, updated_at = now(); SELECT 1;",
            required=True,
        )
        return
    if table == "marketplace_card_tiles":
        values = ",".join(
            "('{id}', '{payload}'::jsonb, now())".format(
                id=str(row["card_id"]).replace("'", "''"),
                payload=_sql_literal(row.get("payload") or {}),
            )
            for row in rows
        )
        psql_json_lines(
            "INSERT INTO public.marketplace_card_tiles (card_id, payload, updated_at) VALUES "
            + values
            + " ON CONFLICT (card_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(); SELECT 1;",
            required=True,
        )
        return
    print(f"skip unknown table {table}", file=sys.stderr)


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


def psql_json_lines(sql: str, timeout: int = 45, required: bool = False) -> list[dict]:
    try:
        raw = subprocess.check_output(
            [
                "docker",
                "exec",
                "-i",
                POSTGRES_CONTAINER,
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
        if required:
            die(f"required postgres operation failed ({POSTGRES_CONTAINER}): {error}")
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
    """One chase + one in-set card per live set, unique names, PKN first."""
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


# Homepage New cards: curated printings, matched by set + collector number +
# name. Same Pokémon names are different variants and must stay separate.
# Do not sort this list after retrieval.
NEW_CARDS_LIMIT = 20
NEW_CARDS_SET_ALIASES = (
    "storm emeralda",
    "storm emeralda (japanese)",
    "m6",
    "japanese storm emeralda",
)
NEW_CARDS_SET_NEEDLES = ("storm emeralda",)
NEW_CARDS_CURATED = (
    {"name": "Mega Rayquaza ex", "number": "113/076", "note": "MUR / Gold"},
    {"name": "Mega Rayquaza ex", "number": "110/076", "note": "SAR"},
    {"name": "Raikou ex", "number": "108/076", "note": "SAR"},
    {"name": "Mega Rayquaza ex", "number": "095/076", "note": "SR"},
    {"name": "Zinnia's Trust", "number": "112/076", "note": "SAR"},
    {"name": "Kyogre", "number": "080/076", "note": "AR"},
    {"name": "Mega Golisopod ex", "number": "107/076", "note": "SAR"},
    {"name": "Kecleon", "number": "088/076", "note": "AR"},
    {"name": "Mega Golurk ex", "number": "109/076", "note": "SAR"},
    {"name": "Groudon", "number": "084/076", "note": "AR"},
    {"name": "Aarune", "number": "111/076", "note": "SAR"},
    {"name": "Growlithe", "number": "078/076", "note": "AR"},
    {"name": "Zinnia's Trust", "number": "102/076", "note": "SR"},
    {"name": "Talonflame ex", "number": "096/076", "note": "SR"},
    {"name": "Raikou ex", "number": "092/076", "note": "SR"},
    {"name": "Emcee's Hype", "number": "100/076", "note": "SR"},
    {"name": "Aarune", "number": "101/076", "note": "SR"},
    {"name": "Mega Malamar ex", "number": "094/076", "note": "SR"},
    {"name": "Altaria", "number": "087/076", "note": "AR"},
    {"name": "Azurill", "number": "086/076", "note": "AR"},
)

# Homepage Featured: 30 random 30th Anniversary singles. Daily seed so the
# 5-minute publisher does not reshuffle the carousel every tick.
FEATURED_LIMIT = 30
FEATURED_SET_ALIASES = (
    "30th celebration",
    "30th celebration jp",
    "30th celebration (japanese)",
    "30th celebration simplified chinese",
    "30th anniversary celebration: first partner illustration collection",
)
FEATURED_SET_NEEDLES = (
    "30th celebration",
    "30th anniversary celebration",
)
FEATURED_ACCESSORY_RE = re.compile(r"\b(box|frame|marker|storage)\b", re.I)
FEATURED_COLLECTOR_RE = re.compile(r"\d+\s*/\s*(?:\d+|30th)", re.I)


def featured_day_seed(now: datetime | None = None) -> str:
    dt = now or datetime.now(timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d")


def is_featured_accessory(card: dict) -> bool:
    blob = " ".join(str(card.get(key) or "") for key in ("number", "card_number", "rarity"))
    if FEATURED_COLLECTOR_RE.search(blob):
        return False
    return bool(FEATURED_ACCESSORY_RE.search(str(card.get("name") or "")))


def pick_featured_cards(
    cards: list[dict],
    limit: int = FEATURED_LIMIT,
    *,
    seed: str | None = None,
    rng: random.Random | None = None,
) -> list[dict]:
    """Random 30th Anniversary singles. Keep name variants. Skip energy and merch."""
    pool = []
    for card in cards or []:
        if not set_matches_aliases(card, FEATURED_SET_ALIASES, FEATURED_SET_NEEDLES):
            continue
        if is_energy_card(card) or is_featured_accessory(card):
            continue
        pool.append(card)
    mixer = rng if rng is not None else random.Random(seed if seed is not None else featured_day_seed())
    shuffled = list(pool)
    mixer.shuffle(shuffled)
    return take_rail(shuffled, limit, unique_names=False)


def fold_name(value: str) -> str:
    text = re.sub(r"\s+", " ", str(value or "").strip().lower())
    return text.replace("’", "'").replace("‘", "'").replace("`", "'")


def spec_label(spec: dict) -> str:
    note = str(spec.get("note") or "").strip()
    label = f"{spec.get('name') or ''} — {spec.get('number') or ''}".strip(" —")
    return f"{label} — {note}" if note else label


def set_matches_aliases(card: dict, aliases: tuple[str, ...], needles: tuple[str, ...] = ()) -> bool:
    name = fold_name(card.get("set") or card.get("set_name") or card.get("expansion") or "")
    slug = fold_name(card.get("set_slug") or card.get("slug") or "")
    if name in aliases or slug in aliases or slug.replace("-", " ") in aliases:
        return True
    return any(needle in name or needle in slug.replace("-", " ") for needle in needles)


def pick_curated_cards(
    cards: list[dict],
    specs: tuple[dict, ...] | list[dict],
    *,
    set_aliases: tuple[str, ...] = (),
    set_needles: tuple[str, ...] = (),
) -> tuple[list[dict], list[dict]]:
    """Keep spec order. Never dedupe by Pokémon name. Never fill a miss with another printing."""
    pool = []
    for card in cards or []:
        if set_aliases or set_needles:
            if not set_matches_aliases(card, set_aliases, set_needles):
                continue
        pool.append(card)

    used: set[str] = set()
    matched: list[dict] = []
    missing: list[dict] = []
    for spec in specs:
        want_name = fold_name(spec.get("name") or "")
        want_number = collector_pair({"number": spec.get("number") or ""})
        found = None
        number_only = []
        for card in pool:
            cid = card_id(card)
            if not cid or cid in used:
                continue
            if collector_pair(card) != want_number:
                continue
            if fold_name(card.get("name") or "") == want_name:
                found = card
                break
            number_only.append(card)
        if not found:
            extra = ""
            if number_only:
                other = number_only[0]
                extra = (
                    f" (collector hit name={other.get('name')!r} "
                    f"number={other.get('number') or other.get('card_number')!r}; not substituted)"
                )
            print(f"new_cards curated missing: {spec_label(spec)}{extra}", file=sys.stderr)
            missing.append(spec)
            continue
        used.add(card_id(found))
        matched.append(found)
    return matched, missing


def psql_weighted_cards(
    order_sql: str,
    extra_where: str = "",
    limit: int = 1000,
    require_weight: bool = True,
) -> list[dict]:
    weight_filter = "AND w.combined_weight > 0" if require_weight else ""
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
    {NOT_MERCH_SINGLE_SQL}
    {weight_filter}
    {extra_where}
  ORDER BY {order_sql}
  LIMIT {int(limit)}
) t;
"""
    return psql_json_lines(sql)


def psql_daily_sales_cards(limit: int = 96, metric: str = "units") -> list[dict]:
    """Rank cards from the latest fully materialized CardTrader sales day.

    A row in cardtrader_sold_daily represents CardTrader listings that disappeared
    between daily snapshots. Keep both unit quantity and listing-event counts so
    clients can distinguish a large removed listing from many separate removals.
    """
    order_sql = (
        "r.sample_count DESC, r.sold_qty DESC"
        if metric == "events"
        else "r.sold_qty DESC, r.sample_count DESC"
    )
    sql = f"""
{session_sql("30s")}
SELECT row_to_json(t)
FROM (
  WITH latest AS (
    SELECT max(observed_day) AS day
    FROM public.cardtrader_sold_daily
  ),
  sales AS (
    SELECT
      d.blueprint_id,
      d.observed_day AS day,
      sum(d.sold_qty)::bigint AS sold_qty,
      sum(d.sample_count)::bigint AS sample_count,
      min(d.min_pkn) AS min_pkn,
      max(d.max_pkn) AS max_pkn,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY d.median_pkn) AS median_pkn
    FROM public.cardtrader_sold_daily d
    JOIN latest l ON l.day = d.observed_day
    GROUP BY d.blueprint_id, d.observed_day
  ),
  ranked AS (
    SELECT
      s.*,
      sum(s.sold_qty) OVER ()::bigint AS total_sold_qty,
      sum(s.sample_count) OVER ()::bigint AS total_sample_count,
      count(*) OVER ()::integer AS total_cards
    FROM sales s
  )
  SELECT
    {TILE_SQL},
    r.day::text AS "salesDay",
    r.sold_qty AS "dailySoldQty",
    r.sample_count AS "dailySaleSamples",
    round(r.median_pkn::numeric, 2) AS "dailyMedianPkn",
    round(r.min_pkn::numeric, 2) AS "dailyMinPkn",
    round(r.max_pkn::numeric, 2) AS "dailyMaxPkn",
    r.total_sold_qty AS "dailyTotalSoldQty",
    r.total_sample_count AS "dailyTotalSaleSamples",
    r.total_cards AS "dailyActiveCards"
  FROM ranked r
  JOIN public.marketplace_search_candidates c
    ON c.ct_id = r.blueprint_id
  LEFT JOIN public.marketplace_card_weights w
    ON w.card_id = c.card_id::text
  LEFT JOIN public.cardtrader_blueprint_listing_cache cache
    ON cache.blueprint_id = c.ct_id
  WHERE c.item_kind = 'single'
    AND c.product_type = 'card'
    AND coalesce(c.cdn_image_url, c.image_url) IS NOT NULL
    {NOT_MERCH_SINGLE_SQL}
  ORDER BY {order_sql}, c.card_id DESC
  LIMIT {int(limit)}
) t;
"""
    return psql_json_lines(sql)


def psql_best_sellers_cards(limit: int = 96) -> list[dict]:
    """Rank the trailing seven data days by sanitized removal samples.

    Quantity is exposed only as diagnostics: one removed listing is one observed
    sale event, regardless of whether that listing carried one or 500 units.
    """
    sql = f"""
{session_sql("30s")}
SELECT row_to_json(t)
FROM (
  WITH latest AS (
    SELECT max(observed_day) AS day
    FROM public.cardtrader_sold_daily
  ),
  sales AS (
    SELECT
      d.blueprint_id,
      min(d.observed_day) AS first_day,
      max(d.observed_day) AS last_day,
      sum(d.sample_count)::bigint AS sample_count,
      sum(d.sold_qty)::bigint AS removed_qty
    FROM public.cardtrader_sold_daily d
    JOIN latest l ON d.observed_day BETWEEN l.day - 6 AND l.day
    GROUP BY d.blueprint_id
  )
  SELECT
    {TILE_SQL},
    s.first_day::text AS "salesWindowStart",
    s.last_day::text AS "salesWindowEnd",
    s.sample_count AS "weeklySaleSamples",
    s.removed_qty AS "weeklyRemovedListingQuantity"
  FROM sales s
  JOIN public.marketplace_search_candidates c
    ON c.ct_id = s.blueprint_id
  LEFT JOIN public.marketplace_card_weights w
    ON w.card_id = c.card_id::text
  LEFT JOIN public.cardtrader_blueprint_listing_cache cache
    ON cache.blueprint_id = c.ct_id
  WHERE c.item_kind = 'single'
    AND c.product_type = 'card'
    AND coalesce(c.cdn_image_url, c.image_url) IS NOT NULL
    {NOT_MERCH_SINGLE_SQL}
  ORDER BY s.sample_count DESC, s.removed_qty DESC, c.card_id DESC
  LIMIT {int(limit)}
) t;
"""
    return psql_json_lines(sql)


def psql_price_gainers(limit: int = 48) -> list[dict]:
    """Sold-median % up vs ~30d ago (or the start of daily history until that exists)."""
    sql = f"""
{session_sql("45s")}
SELECT row_to_json(t)
FROM (
  SELECT
    {TILE_SQL}
  FROM (
    WITH span AS (
      SELECT min(observed_day) AS first_day, max(observed_day) AS last_day
      FROM public.marketplace_listing_stats_daily
      WHERE source = 'cardtrader' AND median_sold_eur IS NOT NULL
    ),
    windows AS (
      SELECT
        first_day,
        last_day,
        GREATEST(first_day, last_day - 30) AS baseline_from,
        CASE
          WHEN last_day - first_day >= 30 THEN last_day - 27
          ELSE first_day + 1
        END AS baseline_to,
        GREATEST(first_day, last_day - 2) AS recent_from,
        last_day AS recent_to
      FROM span
    ),
    base AS (
      SELECT
        s.card_id,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.median_sold_eur) AS med,
        sum(s.sold_quantity) AS qty
      FROM public.marketplace_listing_stats_daily s, windows w
      WHERE s.source = 'cardtrader'
        AND s.median_sold_eur > 0
        AND s.observed_day BETWEEN w.baseline_from AND w.baseline_to
      GROUP BY 1
      HAVING sum(s.sold_quantity) >= 4
    ),
    recent AS (
      SELECT
        s.card_id,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.median_sold_eur) AS med,
        sum(s.sold_quantity) AS qty
      FROM public.marketplace_listing_stats_daily s, windows w
      WHERE s.source = 'cardtrader'
        AND s.median_sold_eur > 0
        AND s.observed_day BETWEEN w.recent_from AND w.recent_to
      GROUP BY 1
      HAVING sum(s.sold_quantity) >= 4
    )
    SELECT
      n.card_id,
      (n.med - b.med) / b.med AS pct
    FROM recent n
    JOIN base b ON b.card_id = n.card_id
    WHERE b.med >= 0.50
      AND n.med > b.med * 1.08
      AND n.med <= b.med * 6
  ) g
  JOIN public.marketplace_search_candidates c
    ON c.card_id::text = g.card_id
  LEFT JOIN public.marketplace_card_weights w
    ON w.card_id = c.card_id::text
  LEFT JOIN public.cardtrader_blueprint_listing_cache cache
    ON cache.blueprint_id = c.ct_id
  WHERE c.item_kind = 'single'
    AND c.product_type = 'card'
    AND coalesce(c.cdn_image_url, c.image_url) IS NOT NULL
    {NOT_MERCH_SINGLE_SQL}
  ORDER BY g.pct DESC, c.card_id DESC
  LIMIT {int(limit)}
) t;
"""
    return psql_json_lines(sql, timeout=60)


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
    {NOT_MERCH_SINGLE_SQL}
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
        {NOT_MERCH_SINGLE_SQL}
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


def psql_cards_for_set_aliases(
    aliases: tuple[str, ...],
    like_needles: tuple[str, ...] = (),
    limit: int = 400,
) -> list[dict]:
    lowered = [item.strip().lower() for item in aliases if str(item).strip()]
    if not lowered and not like_needles:
        return []
    clauses = []
    if lowered:
        exact = ", ".join("'" + item.replace("'", "''") + "'" for item in lowered)
        clauses.append(f"lower(btrim(c.set_name)) = ANY(ARRAY[{exact}]::text[])")
    for needle in like_needles:
        clean = str(needle).replace("'", "''").replace("%", "").replace("_", "")
        if clean:
            clauses.append(f"c.set_name ILIKE '%{clean}%'")
    set_filter = " OR ".join(clauses)
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
  WHERE c.item_kind = 'single'
    AND c.product_type = 'card'
    AND coalesce(c.cdn_image_url, c.image_url) IS NOT NULL
    {NOT_MERCH_SINGLE_SQL}
    AND ({set_filter})
  LIMIT {int(limit)}
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


try:
    from pokoin_public_card import rewrite_public_card
except ImportError:
    rewrite_public_card = None

def publish_card(card: dict) -> dict:
    if rewrite_public_card:
        return rewrite_public_card(card)
    out = {
        key: value
        for key, value in (card or {}).items()
        if key not in {"rn", "is_chase", "ct_id", "ctId"} and not str(key).startswith("_")
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
    w.listed_qty_now AS listed_qty,
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
      'popular', w.popular_score,
      'listedQty', w.listed_qty_now,
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

    top = psql_daily_sales_cards()
    event_top = psql_daily_sales_cards(metric="events")
    top_meta = {
        "source": "cardtrader_removed_sale",
        "metric": "units_removed",
        "methodology": (
            "CardTrader listings removed since the previous daily snapshot; "
            "removals can include sales or withdrawals."
        ),
    }
    if top:
        top_meta.update({
            "day": top[0].get("salesDay"),
            "soldQty": top[0].get("dailyTotalSoldQty", 0),
            "listingEvents": top[0].get("dailyTotalSaleSamples", 0),
            "activeCards": top[0].get("dailyActiveCards", 0),
        })
    else:
        top = psql_weighted_cards(
            "w.popular_score DESC, w.listed_qty_now DESC, c.card_id DESC",
            extra_where="AND w.popular_score > 0 AND c.name !~* 'energy'",
            limit=48,
            require_weight=False,
        )
        top_meta = {"source": "listing_population_growth_30d", "fallback": True}
        event_top = []
    if not top:
        top = psql_catalog_fallback(48)
    best = take_rail(
        [card for card in psql_best_sellers_cards() if not is_energy_card(card)],
        12,
    )
    best_ids = {card_id(card) for card in best}
    best_names = {name_key(card) for card in best if name_key(card)}
    top = take_rail(
        [
            card
            for card in top
            if not is_energy_card(card)
        ],
        24,
    )
    event_top = take_rail(
        [card for card in event_top if not is_energy_card(card)],
        24,
    )
    featured_day = featured_day_seed()
    featured_pool = overlay_pkn(
        psql_cards_for_set_aliases(FEATURED_SET_ALIASES, FEATURED_SET_NEEDLES, limit=400)
    )
    featured = pick_featured_cards(featured_pool, FEATURED_LIMIT, seed=featured_day)
    featured_from_thirtieth = bool(featured)
    if len(featured) < FEATURED_LIMIT:
        print(
            f"featured 30th anniversary {len(featured)}/{FEATURED_LIMIT}",
            file=sys.stderr,
        )
    if not featured:
        print("featured 30th anniversary empty; falling back to sell-through", file=sys.stderr)
        featured = take_rail(
            [
                card
                for card in psql_weighted_cards(
                    "w.sell_through DESC NULLS LAST, w.demand_score DESC, w.sold_qty_7d DESC, c.card_id DESC",
                    extra_where=(
                        "AND w.sold_qty_7d >= 3 AND w.listed_qty_now >= 8 AND w.demand_score > 0"
                        " AND c.name !~* '^(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy|dragon|colorless) energy$'"
                    ),
                    limit=64,
                )
                if not is_basic_energy(card)
            ],
            FEATURED_LIMIT,
            exclude=best_ids,
            exclude_names=best_names,
            max_per_set=2,
        )
    live_pool = overlay_pkn(psql_live_set_cards(16))
    curated_pool = overlay_pkn(
        psql_cards_for_set_aliases(NEW_CARDS_SET_ALIASES, NEW_CARDS_SET_NEEDLES, limit=400)
    )
    new_cards, new_cards_missing = pick_curated_cards(
        curated_pool,
        NEW_CARDS_CURATED,
        set_aliases=NEW_CARDS_SET_ALIASES,
        set_needles=NEW_CARDS_SET_NEEDLES,
    )
    if new_cards_missing:
        print(
            "new_cards curated missing "
            + "; ".join(spec_label(spec) for spec in new_cards_missing),
            file=sys.stderr,
        )
    if not new_cards:
        print("new_cards curated empty; not substituting another printing", file=sys.stderr)
    new_cards = overlay_cardtrader_asks(new_cards[:NEW_CARDS_LIMIT], limit=24)
    spotlight = overlay_cardtrader_asks(pick_live_homepage(live_pool, 16), limit=20)
    if not spotlight:
        spotlight = overlay_cardtrader_asks(overlay_pkn(home_spotlight)) or new_cards

    meta_rate = {"pknUsdt": float(PKN_USDT_PRICE)}
    new_meta = {
        "source": "curated_set_number_name",
        "set": "Storm Emeralda",
        "rank": "curated",
        **meta_rate,
    }
    if new_cards_missing:
        new_meta["missing"] = [spec_label(spec) for spec in new_cards_missing]
    rails.append(rail("new_cards", new_cards, new_meta))
    rails.append(rail("spotlight", spotlight, {"source": "live_sets_chase_inset", **meta_rate}))
    if featured_from_thirtieth:
        featured_meta = {
            "source": "thirtieth_anniversary_random",
            "set": "30th Celebration",
            "rank": "daily_shuffle",
            "day": featured_day,
            **meta_rate,
        }
    else:
        featured_meta = {"source": "trending_sellthrough", **meta_rate}
    rails.append(rail("featured", featured, featured_meta))
    best_meta = {
        "source": "cardtrader_removed_sale_7d",
        "metric": "observed_sales",
        "windowStart": best[0].get("salesWindowStart") if best else None,
        "windowEnd": best[0].get("salesWindowEnd") if best else None,
        "methodology": (
            "Trailing seven data days ranked by sanitized CardTrader removal samples. "
            "Removed listing quantity is diagnostic only; removals are not confirmed orders."
        ),
        **meta_rate,
    }
    rails.append(rail("best_sellers", best, best_meta))
    if event_top:
        sales_meta = {
            **top_meta,
            "metric": "observed_sales",
            "observedSales": top_meta.get("listingEvents", 0),
            "removedListingQuantity": top_meta.get("soldQty", 0),
            "methodology": (
                "Ranked by individual CardTrader removal samples. Removed listing "
                "quantity is diagnostic only and is not counted as confirmed sales."
            ),
        }
        rails.append(rail("top_sold", event_top, {"limit": 24, **sales_meta, **meta_rate}))
        rails.append(rail(
            "top_sold_events",
            event_top,
            {"limit": 24, **sales_meta, **meta_rate},
        ))
        rails.append(rail(
            "top_sold_quantity",
            top[:48],
            {"limit": 48, **top_meta, "metric": "removed_listing_quantity", **meta_rate},
        ))
    else:
        rails.append(rail("top_sold", top[:48], {"limit": 48, **top_meta, **meta_rate}))

    tiles.extend(tiles_from_cards(top[:48]))
    tiles.extend(tiles_from_cards(event_top))
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
            f"{API_ORIGIN}/api/marketplace-expansion-page?slug={slug}&limit=120&offset=0&productType=card",
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

    # card weights were a Supabase leftover; Pi SPA does not read them.

    print(f"published rails={len(rails)} tiles={len(tiles)}")


if __name__ == "__main__":
    main()
