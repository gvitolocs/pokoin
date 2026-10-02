"""Free public card catalogs for the Cardmarket-only games.

Each adapter returns (cards, complete). A card is a dict with:
  key (stable within the game), name, set_name, set_code, collector, rarity,
  image_url, source, source_url, version, language, attributes.
`complete=True` means the source is the whole catalog, so the 2019 Wayback
sample rows can be dropped after their Cardmarket ids are carried over.

Raw responses are cached under <cache>/raw/ so a rerun is offline.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36 PokoinCatalog/1.0"


def _get(url: str, *, method: str = "GET", body: dict | None = None, timeout: int = 90):
    import requests

    for attempt in range(4):
        try:
            if method == "POST":
                resp = requests.post(url, json=body, headers={"User-Agent": USER_AGENT}, timeout=timeout)
            else:
                resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
            if resp.status_code == 200:
                return resp
            if resp.status_code in (403, 404):
                resp.raise_for_status()
        except Exception:
            if attempt == 3:
                raise
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed")


def _cached_json(cache: Path, name: str, loader):
    path = cache / "raw" / name
    if path.exists():
        return json.loads(path.read_text())
    data = loader()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False))
    return data


# --- Final Fantasy TCG: Square Enix official card browser -------------------

FF_RARITY = {
    "C": "Common", "R": "Rare", "H": "Hero", "L": "Legend", "S": "Starter",
    "B": "Boss", "PR": "Promo", "P": "Promo",
}


def final_fantasy(cache: Path):
    url = "https://fftcg.square-enix-games.com/en/get-cards"
    body = {"language": "en", "text": "", "type": [], "element": [], "cost": [], "rarity": [], "power": [],
            "category_1": [], "set": [], "multicard": "", "ex_burst": "", "code": "", "special": "", "exactmatch": 0}
    data = _cached_json(cache, "fftcg-get-cards.json", lambda: _get(url, method="POST", body=body).json())
    cards = []
    for raw in data.get("cards", []):
        code = str(raw.get("code") or "").strip()
        if not code:
            continue
        sets = raw.get("set") or []
        full = ((raw.get("images") or {}).get("full") or [])
        image = next((u for u in full if u.endswith("_eg.jpg")), full[0] if full else "")
        cards.append({
            "key": code,
            "name": (raw.get("name_en") or "").strip() or code,
            "set_name": sets[0] if sets else "Unknown",
            "set_code": "",
            "collector": code,
            "rarity": FF_RARITY.get(str(raw.get("rarity") or ""), str(raw.get("rarity") or "")),
            "image_url": image,
            "source": "square-enix-fftcg",
            "source_url": "https://fftcg.square-enix-games.com/en/card-browser",
            "language": "EN",
            "attributes": {
                "type": raw.get("type_en"), "job": raw.get("job_en"), "element": raw.get("element"),
                "cost": raw.get("cost"), "power": raw.get("power"), "category": raw.get("category_1"),
                "reprint_sets": sets[1:],
            },
        })
    return cards, True


# --- Star Wars Destiny: SWD Renewed Hope public API --------------------------

def star_wars_destiny(cache: Path):
    base = "https://db.swdrenewedhope.com/api/public"
    data = _cached_json(cache, "swdrh-cards.json", lambda: _get(f"{base}/cards/").json())
    cards = []
    for raw in data:
        code = str(raw.get("code") or "").strip()
        if not code:
            continue
        name = (raw.get("name") or "").strip()
        subtitle = (raw.get("subtitle") or "").strip()
        cards.append({
            "key": code,
            "name": f"{name} - {subtitle}" if subtitle else name,
            "set_name": raw.get("set_name") or "Unknown",
            "set_code": raw.get("set_code") or "",
            "collector": str(raw.get("position") or ""),
            "rarity": raw.get("rarity_name") or "",
            "image_url": raw.get("imagesrc") or "",
            "source": "swd-renewed-hope",
            "source_url": raw.get("url") or "",
            "language": "EN",
            "attributes": {
                "type": raw.get("type_name"), "faction": raw.get("faction_name"),
                "affiliation": raw.get("affiliation_name"), "illustrator": raw.get("illustrator"),
                "cost": raw.get("cost"), "health": raw.get("health"), "sides": raw.get("sides"),
            },
        })
    return cards, True


# --- Weiss Schwarz: CCondeluci EN + JP databases (official ws-tcg.com art) ----

WS_REPOS = (("EN", "CCondeluci/WeissSchwarz-ENG-DB"), ("JP", "CCondeluci/WeissSchwarz-JP-DB"))


def _lenient_json(text: str):
    import re

    try:
        return json.loads(text)
    except ValueError:
        # Hand-edited set files sometimes keep a trailing comma.
        return json.loads(re.sub(r",\s*([}\]])", r"\1", text))


def _encoredecks_images(cache: Path) -> dict[tuple[str, str], str]:
    """(lang, card code) -> EncoreDecks image URL (460x641, sharper than ws-tcg.com)."""
    import concurrent.futures as cf

    base = "https://www.encoredecks.com"
    series = _cached_json(cache, "encoredecks-serieslist.json", lambda: _get(f"{base}/api/serieslist").json())

    def load(entry):
        try:
            return _cached_json(
                cache, f"encoredecks-series-{entry['_id']}.json",
                lambda: _get(f"{base}/api/series/{entry['_id']}/cards").json(),
            )
        except Exception as error:
            print(f"[weiss_schwarz] EncoreDecks series {entry.get('_id')} failed: {error}", flush=True)
            return []

    images: dict[tuple[str, str], str] = {}
    with cf.ThreadPoolExecutor(max_workers=4) as pool:
        for cards in pool.map(load, [e for e in series if e.get("_id")]):
            for card in cards or []:
                code = str(card.get("cardcode") or "").strip()
                path = str(card.get("imagepath") or "").strip()
                if code and path:
                    images[(str(card.get("lang") or "").upper(), code.upper())] = f"{base}/images/{path}"
    return images


def weiss_schwarz(cache: Path):
    cards = []
    skipped: list[str] = []
    encore = _encoredecks_images(cache)
    print(f"[weiss_schwarz] EncoreDecks images for {len(encore)} card codes", flush=True)
    for lang, repo in WS_REPOS:
        listing = _cached_json(
            cache, f"ws-{lang}-index.json",
            lambda repo=repo: _get(f"https://api.github.com/repos/{repo}/contents/DB").json(),
        )
        for entry in listing:
            if not str(entry.get("name", "")).endswith(".json"):
                continue
            try:
                rows = _cached_json(
                    cache, f"ws-{lang}-{entry['name']}",
                    lambda entry=entry: _lenient_json(_get(entry["download_url"]).text),
                )
            except ValueError as error:
                print(f"[weiss_schwarz] skipped malformed {lang} {entry['name']}: {error}", flush=True)
                skipped.append(f"{lang}:{entry['name']}")
                continue
            for raw in rows:
                code = str(raw.get("code") or "").strip()
                if not code:
                    continue
                rarity = str(raw.get("rarity") or "").strip()
                cards.append({
                    # Same code can be reprinted at another rarity (RR vs SP):
                    # each rarity is its own printing.
                    "key": f"{lang}:{code}:{rarity}",
                    "name": (raw.get("name") or "").strip() or code,
                    "set_name": (raw.get("expansion") or "").strip() or raw.get("set") or "Unknown",
                    "set_code": f"{raw.get('set') or ''}/{raw.get('release') or ''}".strip("/"),
                    "collector": code,
                    "rarity": rarity,
                    # Official ws-tcg.com art first; EncoreDecks (community site, 460x641)
                    # only fills the official 404s so we don't bulk-pull from them.
                    "image_url": raw.get("image") or encore.get((lang, code.upper())) or "",
                    "image_fallback": encore.get((lang, code.upper())) or "",
                    "source": "ws-ccondeluci-db",
                    "source_url": f"https://github.com/{repo}",
                    "language": lang,
                    "attributes": {
                        "side": raw.get("side"), "type": raw.get("type"), "color": raw.get("color"),
                        "level": raw.get("level"), "cost": raw.get("cost"), "power": raw.get("power"),
                        "traits": raw.get("attributes"),
                    },
                })
    if skipped:
        print(f"[weiss_schwarz] {len(skipped)} set files skipped: {skipped}", flush=True)
    return cards, True


ADAPTERS = {
    "final_fantasy": final_fantasy,
    "star_wars_destiny": star_wars_destiny,
    "weiss_schwarz": weiss_schwarz,
}


def fetch(game: str, cache: Path):
    adapter = ADAPTERS.get(game)
    if not adapter:
        raise SystemExit(f"no source adapter for {game} yet")
    return adapter(cache)
