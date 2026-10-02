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


# --- shared HTML helpers -------------------------------------------------------

def _cached_text(cache: Path, name: str, url: str, pause: float = 0.4) -> str:
    path = cache / "raw" / name
    if path.exists():
        return path.read_text(encoding="utf-8", errors="replace")
    text = _get(url).text
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    time.sleep(pause)  # one page at a time, politely
    return text


def _plain(fragment: str) -> str:
    import html
    import re

    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment or ""))).strip()


def _safe_name(value: str) -> str:
    import re

    return re.sub(r"[^A-Za-z0-9._-]+", "_", value)[:150]


# --- Battle Spirits Saga: official card database (battlespirits-saga.com) ------

BSS_BASE = "https://www.battlespirits-saga.com"


def battle_spirits_saga(cache: Path):
    import re

    first = _cached_text(cache, "bss-cards-575001.html", f"{BSS_BASE}/cards/?search=true&category=575001")
    categories = re.findall(r'<option value="(57\d{4})"[^>]*>\s*([^<]+?)\s*</option>', first)
    cards = []
    for category, label in categories:
        page = _cached_text(cache, f"bss-cards-{category}.html", f"{BSS_BASE}/cards/?search=true&category={category}")
        set_code = (re.match(r"\[([^\]]+)\]", label) or [None, ""])[1]
        set_name = re.sub(r"^\[[^\]]+\]\s*", "", label).strip().title() or label
        for card_no in dict.fromkeys(re.findall(r'detail\.php\?card_no=([A-Za-z0-9_-]+)', page)):
            detail = _cached_text(cache, f"bss-detail-{_safe_name(card_no)}.html", f"{BSS_BASE}/cards/detail.php?card_no={card_no}", 0.25)
            head = re.search(r"<span>([^<]+)</span>\s*\|\s*<span>([^<]*)</span>", detail)
            name = re.search(r'<div class="cardName">(.*?)</div>', detail, re.S)
            img = re.search(r'<img src="\.\./(images/cards/card/[^"]+)"', detail)
            cards.append({
                "key": card_no,
                "name": _plain(name.group(1)) if name else card_no,
                "set_name": set_name,
                "set_code": set_code,
                "collector": head.group(1).strip() if head else card_no,
                "rarity": head.group(2).strip() if head else "",
                "image_url": f"{BSS_BASE}/{img.group(1)}" if img else f"{BSS_BASE}/images/cards/card/{card_no}.png",
                "source": "battlespirits-saga-official",
                "source_url": f"{BSS_BASE}/cards/detail.php?card_no={card_no}",
                "language": "EN",
            })
    return cards, True


# --- The Spoils: the-spoils-cardgame.vercel.app (Cloudinary art) --------------

def the_spoils(cache: Path):
    import re
    from urllib.parse import quote

    def load():
        page = _get("https://the-spoils-cardgame.vercel.app/database").text
        pushes = [json.loads('"' + m + '"') for m in re.findall(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)', page)]
        payload = "".join(pushes)
        start = payload.find('{"cards":[')
        cards, _ = json.JSONDecoder().raw_decode(payload, start + len('{"cards":'))
        return cards

    data = _cached_json(cache, "spoils-cards.json", load)
    cards = []
    for raw in data:
        if not raw.get("id") or not raw.get("name"):
            continue
        set_name = raw.get("set") or "Unknown"
        cards.append({
            "key": raw["id"],
            "name": raw["name"].strip(),
            "set_name": set_name,
            "set_code": "",
            "collector": "",
            "rarity": str(raw.get("rarity") or "").title(),
            "image_url": "https://res.cloudinary.com/dyosufzhf/image/upload/the-spoils/"
                         f"{quote(set_name)}/{raw['id']}.jpg",
            "source": "the-spoils-cardgame",
            "source_url": "https://the-spoils-cardgame.vercel.app/database",
            "language": "EN",
            "attributes": {"type": raw.get("type"), "trade": raw.get("trade"), "cost": raw.get("cost")},
        })
    return cards, True


# --- My Little Pony CCG: data.mlpmerch.com (blogger originals) ----------------

def my_little_pony(cache: Path):
    import re

    page = _cached_text(cache, "mlpmerch-ccg-all.html", "https://data.mlpmerch.com/ccg/all/")
    cards = []
    for block in page.split("class='data-small-long'")[1:]:
        full = re.search(r"<a href='(https://[^']+/s1600/[^']+)'", block)
        name = re.search(r"<a href='/ccg/details/([^/']+)/'>(.*?)</a></b>\s*#\s*([^<]*)<br", block, re.S)
        if not name:
            continue
        set_name = re.search(r"<a href='/ccg/set/[^']+'>(.*?)</a>", block)
        card_type = re.search(r"<a href='/ccg/type/[^']+'>(.*?)</a>", block)
        rarity = re.search(r"<a href='/ccg/rarity/[^']+'>(.*?)</a>", block)
        cards.append({
            "key": name.group(1),
            "name": _plain(name.group(2)),
            "set_name": _plain(set_name.group(1)) if set_name else "Unknown",
            "set_code": "",
            "collector": _plain(name.group(3)),
            "rarity": _plain(rarity.group(1)) if rarity else "",
            "image_url": full.group(1) if full else "",
            "source": "mlpmerch-ccg",
            "source_url": f"https://data.mlpmerch.com/ccg/details/{name.group(1)}/",
            "language": "EN",
            "attributes": {"type": _plain(card_type.group(1)) if card_type else ""},
        })
    return cards, True


# --- Force of Will: FoWDB (fowdb.altervista.org) ------------------------------

FOW_BASE = "https://www.fowdb.altervista.org"


def force_of_will(cache: Path):
    import re

    search = _cached_text(cache, "fowdb-search.html", f"{FOW_BASE}/cards/search")
    sets = re.findall(r'<option\s+value="([a-z0-9]+)"[^>]*>\s*([^<]+?)\s*</option>', search)
    cards, seen = [], set()
    for code, label in sets:
        set_name = re.sub(r"\s*-\s*\([^)]*\)\s*$", "", label).strip()
        for page_no in range(1, 60):
            page = _cached_text(cache, f"fowdb-{code}-{page_no}.html", f"{FOW_BASE}/cards?set={code}&page={page_no}")
            items = re.findall(
                r'href="https://www\.fowdb\.altervista\.org/card/([^"]+)"[^>]*>(?:<!--.*?-->)*\s*<img src="images/thumbs/([^"]+)"[^>]*alt="([^"]*)"',
                page, re.S,
            )
            new = [i for i in items if i[0] not in seen]
            if not new:
                break
            for card_code, thumb, name in new:
                seen.add(card_code)
                from urllib.parse import unquote
                code_text = unquote(card_code).replace("+", " ")
                rarity = (re.search(r"-\d+([A-Z]+)$", code_text) or [None, ""])[1]
                cards.append({
                    "key": code_text,
                    "name": _plain(name) or code_text,
                    "set_name": set_name,
                    "set_code": code.upper(),
                    "collector": code_text,
                    "rarity": rarity,
                    "image_url": f"{FOW_BASE}/images/cards/{thumb.split('?')[0]}",
                    "image_fallback": f"{FOW_BASE}/images/thumbs/{thumb.split('?')[0]}",
                    "source": "fowdb",
                    "source_url": f"{FOW_BASE}/card/{card_code}",
                    "language": "EN",
                })
    return cards, True


# --- World of Warcraft TCG: wowcards.info ------------------------------------

WOW_BASE = "http://www.wowcards.info"


def world_of_warcraft(cache: Path):
    import re

    home = _cached_text(cache, "wowcards-home.html", f"{WOW_BASE}/")
    editions = list(dict.fromkeys(re.findall(r'href="/edition/([^"/]+)/en"', home)))
    cards = []
    for edition in editions:
        page = _cached_text(cache, f"wowcards-{edition}.html", f"{WOW_BASE}/edition/{edition}/en")
        title = re.search(r"<h1[^>]*>(.*?)</h1>", page, re.S) or re.search(r"<title>(.*?)</title>", page, re.S)
        set_name = _plain(title.group(1)).split(" - ")[0].replace(" | WoW TCG", "").strip() if title else edition
        for row in re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S):
            link = re.search(r'href="/card/[^/]+/en/([^/]+)/([^"]+)"[^>]*>(.*?)</a>', row, re.S)
            if not link:
                continue
            number, slug, name = link.group(1), link.group(2), _plain(link.group(3))
            rarity = re.search(r'<span class="q\d+">\s*([^<]+?)\s*</span>', row)
            cards.append({
                "key": f"{edition}:{number}",
                "name": name,
                "set_name": set_name,
                "set_code": edition,
                "collector": number,
                "rarity": rarity.group(1) if rarity else "",
                "image_url": f"{WOW_BASE}/scans/{edition}/en/{number}_{slug}.jpg",
                "source": "wowcards-info",
                "source_url": f"{WOW_BASE}/card/{edition}/en/{number}/{slug}",
                "language": "EN",
            })
    return cards, True


# --- Dragoborne: dragoborne.fandom.com (MediaWiki API) -------------------------

DRAGO_API = "https://dragoborne.fandom.com/api.php"


def dragon_born(cache: Path):
    import re
    from urllib.parse import quote

    def api(params: str, name: str):
        return _cached_json(cache, name, lambda: _get(f"{DRAGO_API}?{params}&format=json").json())

    pages = []
    for category in ("Booster_Pack", "Trial_Deck"):
        listing = api(f"action=query&list=categorymembers&cmtitle=Category:{category}&cmlimit=50", f"drago-cat-{category}.json")
        pages += [m["title"] for m in listing.get("query", {}).get("categorymembers", [])]
    rows = []
    for title in pages:
        text = api(f"action=parse&page={quote(title)}&prop=wikitext", f"drago-{_safe_name(title)}.json")
        wikitext = text.get("parse", {}).get("wikitext", {}).get("*", "")
        set_name = re.sub(r"^(Booster Pack|Trial Deck) Vol\. \d+:\s*", "", title)
        for line in re.split(r"\n\|-\n", wikitext):
            cells = [c.strip() for c in line.split("\n|") if c.strip()]
            cells = [c.lstrip("|").strip() for c in cells]
            if len(cells) >= 5 and re.match(r"DB-[A-Z]+\d+/\d+", cells[0]):
                card_name = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]+)\]\]", r"\1", cells[1])
                rows.append((cells[0], card_name, set_name, cells[4]))
    images = {}
    names = sorted({r[1] for r in rows})
    for i in range(0, len(names), 40):
        batch = names[i:i + 40]
        data = api("action=query&prop=pageimages&piprop=original&titles=" + quote("|".join(batch)),
                   f"drago-img-{i}.json")
        for page in data.get("query", {}).get("pages", {}).values():
            if page.get("original"):
                images[page["title"]] = page["original"]["source"]
    cards = []
    for number, name, set_name, rarity in rows:
        cards.append({
            "key": number,
            "name": name,
            "set_name": set_name,
            "set_code": number.split("/")[0],
            "collector": number,
            "rarity": rarity,
            "image_url": images.get(name, ""),
            "image_referer": "https://dragoborne.fandom.com/",
            "source": "dragoborne-wiki",
            "source_url": f"https://dragoborne.fandom.com/wiki/{quote(name.replace(' ', '_'))}",
            "language": "EN",
        })
    return cards, True


ADAPTERS = {
    "final_fantasy": final_fantasy,
    "star_wars_destiny": star_wars_destiny,
    "weiss_schwarz": weiss_schwarz,
    "battle_spirits_saga": battle_spirits_saga,
    "the_spoils": the_spoils,
    "my_little_pony": my_little_pony,
    "force_of_will": force_of_will,
    "world_of_warcraft": world_of_warcraft,
    "dragon_born": dragon_born,
}


def fetch(game: str, cache: Path):
    adapter = ADAPTERS.get(game)
    if not adapter:
        raise SystemExit(f"no source adapter for {game} yet")
    return adapter(cache)
