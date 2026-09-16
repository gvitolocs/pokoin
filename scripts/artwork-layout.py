#!/usr/bin/env python3
"""Album layout per leftover: framed illustration box vs painting-to-edges.

Full-art leftovers still print HP and attacks on the painting. OCR finding
Ability / weakness / Illus is not a layout. CLIP pokoin_version_sets is the
same painting, not the same frame. Secret Rare is not a layout.

Geometry on this JPEG: cream/gold/name-bar, XY yellow era border, SV/Mega
white rules panel, type-tinted flat rules sheet, or no_chrome painting.
Gold pixels in a busy illustration are not a gold rules panel. Catalog
SIR / Full Art / Hidden Fates SV## Shiny Vault / MEP 037–063 / 101–127/M-P illustration promos are the
timid fallback. Paldean Fates n/m Shiny Rare is a framed SV card. Cream paint and a dark HP overlay do not override that.

Reads leftover scans from the NVMe leftover tree (one-time sync from 15T
via scripts/sync-nvme-leftovers-from-15t.sh). JPEG decode on CPU threads;
cream/gold batches on the 7900 XTX (HIP 0). Do not scandir mybook on a pass.

  HIP_VISIBLE_DEVICES=0 /home/nez/Projects/ai-toolkit/venv/bin/python \\
    scripts/artwork-layout.py --repair-no-chrome --apply --gpu --workers 12
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import subprocess
import sys
import tempfile
import json
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

NVME_LEFTOVERS = Path(
    os.environ.get("POKOIN_NVME_LEFTOVERS", "/home/nez/data/pokoin-leftovers")
)
NVME_OBJECT_ROOTS = [
    NVME_LEFTOVERS / "objects",
    Path("/home/nez/Projects/pokoin/PokoinTest/index/cdn_images"),
    Path("/home/nez/Projects/pokoin/PokoinTest/index/cdn_images_delta"),
    Path("/home/nez/pokoincdn/cdn_images_digest/2026-08-30"),
    Path("/home/nez/data/pokoin-artwork-layout-objects"),
]
MYBOOK_OBJECTS = Path("/home/nez/mnt/mybook/pokoin-pi-card-images/objects")
NVME_CACHE = Path("/home/nez/data/pokoin-artwork-layout-objects")
POSTGRES = os.environ.get("POKOIN_MARKETPLACE_POSTGRES", "pokoin-marketplace-postgres-15t")

BLEED_CATALOG_RE = re.compile(
    r"illustration|full\s*art|full-art|fullart|\bart rare\b|special art|"
    r"trainer gallery|galarian gallery|character rare|shiny vault|"
    r"hyper rare|gold secret|rainbow rare|special illustration|"
    r"\bsar\b|\bsir\b",
    re.I,
)
# Trainer Shiny Vault FA (Lady SV86) stays "shiny vault". Pokémon Shiny Rare
# SV## is a framed window (Hidden Fates Diancie SV36).
SHINY_VAULT_RE = re.compile(r"shiny vault", re.I)
POKEMON_SHINY_RARE_RE = re.compile(r"shiny[\s-]*(holo\s*)?rare\b", re.I)
# Full-art paint tokens. Gold/type-panel chrome may override Gold Secret /
# Shiny Rare leftovers that are actually framed (Mega X, SV6 Charmander),
# but not Illustration Rare / SIR / Full-Art (Tepig IR autumn, Milcery IR).
FA_PAINT_RE = re.compile(
    r"illustration rare|special illustration|full\s*art|full-art|fullart|\bsar\b|\bsir\b",
    re.I,
)
GALLERY_NUMBER_RE = re.compile(r"\btg\s*\d{1,3}\s*/\s*tg\s*\d{1,3}\b", re.I)
# First Partner Illustration Collection (MEP 037–063). Not MEP 013 Mega
# Venusaur or MEP 069 cosmos holo — those keep a framed rules sheet.
MEP_ILLUSTRATION_RE = re.compile(r"\bmep\s*0?(?:3[7-9]|4[0-9]|5[0-9]|6[0-3])\b", re.I)
# JP First Partner illustration 101/M-P–124/M-P and Paldea M-P 125–127.
# Not 019/M-P McDonald's (framed window).
MP_ILLUSTRATION_RE = re.compile(
    r"\b1(?:0[1-9]|1[0-9]|2[0-4])\s*/\s*m-p\b|\bm-p\s*12[5-7]\b",
    re.I,
)
# Regular reverse / Poké Ball / Master Ball foil keeps the framed art box.
REVERSE_WINDOW_RE = re.compile(
    r"(?:pok[eé]\s*ball|master\s*ball)\s*reverse|reverse\s*holo|energy\s*reverse|ripple\s*reverse",
    re.I,
)
LANDSCAPE_RE = re.compile(r"\b(?:legend|break)$", re.I)
LANDSCAPE_SKIP_RE = re.compile(
    r"evolution box|combo deck|\bbooster\b|elite trainer",
    re.I,
)
ART_CUT = (0.086, 0.126, 0.828, 0.338)
WESTERN_NAT = re.compile(r"^(western|american|english|european|eu|us)", re.I)
ASIAN_NAT = re.compile(r"japan|chinese|korean|simplified", re.I)
# Regular GX and VMAX are painting-to-the-edges — attacks sit on the art.
# Do not catalog_gx those into a window. Mega Froslass ex Ultra Rare is
# painting-to-edges — Ultra Rare is not an EX window hint. Holo Promo GX
# (SM60) stays geometry. Bare n/m EX prize packs still have a box.
# Stamp prefixes hide n/m ("Stellar Crown Stamp | 030/142").
REGULAR_GX_NAME_RE = re.compile(r"\bgx\b", re.I)
VMAX_NAME_RE = re.compile(r"\bvmax\b", re.I)
FRAME_EX_NAME_RE = re.compile(r"\bex\b", re.I)
FRAME_HOLO_RARE_RE = re.compile(r"holo rare", re.I)
FRAME_BARE_NUM_RE = re.compile(
    r"^(?:promo\s*\|\s*)?\d{1,3}\s*/\s*\d{1,3}$",
    re.I,
)
COLLECTOR_NM_RE = re.compile(r"(\d{1,3})\s*/\s*(\d{1,3})\b")
CHROME_REASONS = frozenset({"gold_rules", "rules_panel"})
ALTERNATE_ART_PROMO_RE = re.compile(r"alternate\s*art\s*promo", re.I)
OCR_CHROME_RE = re.compile(
    r"\b(weakness|resistance|retreat|illus|evolves?|ability|supporter|"
    r"knocked out|mega evolution|poke-body|poke-power)\b",
    re.I,
)
ANCIENT_TRAIT_OCR_RE = re.compile(
    r"(?:"
    r"ancient\s*trait|"
    r"(?:Δ|delta|\b4)\s*evolution\b|"
    r"(?:Ω|omega)\s*barr(?:ier|age)\b|"
    r"(?:α|alpha)\s*(?:recovery|growth)\b|"
    r"(?:θ|theta)\s*(?:stop|max|double|wave)\b|"
    r"you may play this card from your hand to evolve"
    r")",
    re.I,
)
OCR_JSONLS = [
    Path("/home/nez/Projects/pokoin-web/scripts/out/western-full-ocr-gpu.jsonl"),
    Path("/home/nez/Projects/pokoin-web/scripts/out/western-full-ocr.jsonl"),
]
YELLOW_BORDER = 0.40
WHITE_PANEL = 0.40
INNER_FRAME = 0.50
PANEL_FLAT = 0.24
PANEL_LUMA = 140.0
DARK_PANEL_LUMA = 120.0
DARK_PANEL_FLAT = 0.50
GOLD_FLAT = 0.22
GOLD_PANEL_LUMA = 125.0
# Dark HP/name on full art is not a window. Name bar / silver art-box
# need a framed rules sheet or yellow border too (Zoroark window; not Oshawott IR).
FRAMED_FLAT = 0.30
EXT_RANK = {".jpg": 0, ".jpeg": 0, ".webp": 1, ".png": 2}

_LEFTOVER_BY_CT: dict[int, Path] = {}
_OCR_BY_CT: dict[int, dict] = {}


def collector_nm(number: str) -> tuple[int, int] | None:
    """Last printed n/m in the catalog line, ignoring Stamp / WCD prefixes."""
    matches = list(COLLECTOR_NM_RE.finditer(str(number or "")))
    if not matches:
        return None
    last = matches[-1]
    return int(last.group(1)), int(last.group(2))


def catalog_frame_overrides_geometry(name: str, number: str) -> bool:
    """Framed EX that timid geometry calls bleed.

    Regular GX and VMAX are full artwork — never a window override.
    Holo Rare Mega EX (M Venusaur 002/083) and bare n/m EX reprints still
    have a box. Mega Froslass ex Ultra Rare does not. Prefixed collectors
    (Stellar Crown Stamp | 030/142) still have a box when n<=m.
    """
    num = str(number or "").strip()
    name_s = str(name or "")
    if REGULAR_GX_NAME_RE.search(name_s) or VMAX_NAME_RE.search(name_s):
        return False
    ex = bool(FRAME_EX_NAME_RE.search(name_s))
    if not ex:
        return False
    if FA_PAINT_RE.search(num) or is_ultra_rare_fa_ex(name_s, num):
        return False
    if FRAME_HOLO_RARE_RE.search(num):
        return True
    if FRAME_BARE_NUM_RE.match(num):
        return True
    if ex and re.search(r"\bstamp\b", num, re.I):
        nm = collector_nm(num)
        return bool(nm and nm[0] <= nm[1])
    return False


def compact_collector(number: str) -> str:
    matches = re.findall(r"(\d+)\s*/\s*(\d+)", str(number or ""))
    if not matches:
        return ""
    n, m = matches[-1]
    return f"{int(n)}/{int(m)}"


AMAZING_RARE_COLLECTORS = {
    "vivid voltage": {"9/185", "50/185", "82/185", "102/185", "119/185", "138/185"},
    "shining fates": {"17/72", "21/72", "46/72"},
    "legendary heartbeat": {"9/76", "15/76", "33/76", "44/76", "50/76", "56/76"},
    "shiny star v": {"21/190", "36/190", "117/190"},
}


def amazing_set_key(set_name: str) -> str:
    hay = str(set_name or "").lower()
    if "vivid voltage" in hay and "merch" not in hay:
        return "vivid voltage"
    if "shining fates" in hay:
        return "shining fates"
    if "legendary heartbeat" in hay:
        return "legendary heartbeat"
    if "shiny star v" in hay:
        return "shiny star v"
    return ""


def is_amazing_rare(name: str, number: str, rarity: str = "", set_name: str = "") -> bool:
    hay = f"{rarity} {number}"
    if re.search(r"\bamazing\s*rare\b", hay, re.I):
        return True
    collectors = AMAZING_RARE_COLLECTORS.get(amazing_set_key(set_name))
    return bool(collectors and compact_collector(hay) in collectors)



def is_ultra_rare_fa_ex(name: str, number: str) -> bool:
    """XY-era Full Art EX print as Ultra Rare n/m near the set end — no Full-Art token.

    Non-Mega high-slot Ultra Rare EX are painting-to-edges (Pidgeot EX 104/108,
    Darkrai EX 118/122). Mega Ultra Rare with n<=m still have a framed box
    (M Mewtwo ex 159/162, Mega Eelektross 061/217). Secret-style n>m stays FA.
    """
    name_s = str(name or "")
    if not FRAME_EX_NAME_RE.search(name_s):
        return False
    if not re.search(r"\bultra\s*rare\b", str(number or ""), re.I):
        return False
    nm = collector_nm(number)
    if not nm:
        return False
    n, m = nm
    if m <= 0:
        return False
    if n > m:
        return True
    # Mega EX Ultra Rare in-set (n<=m) keeps the illustration window.
    if re.search(r"\bmega\b|^m\s+", name_s, re.I):
        return False
    return n >= max(1, int(m * 0.85)) or (m - n) <= 12


def catalog_layout(name: str, number: str, rarity: str = "", set_name: str = "") -> str:
    text = str(name or "")
    if text and not LANDSCAPE_SKIP_RE.search(text) and LANDSCAPE_RE.search(text):
        return "landscape"
    hay0 = f"{rarity} {number}"
    if ALTERNATE_ART_PROMO_RE.search(hay0):
        return "window"
    if is_amazing_rare(name, number, rarity, set_name):
        return "halfart"
    if REGULAR_GX_NAME_RE.search(text) or VMAX_NAME_RE.search(text):
        return "bleed"
    if is_ultra_rare_fa_ex(name, f"{rarity} {number}".strip()):
        return "bleed"
    hay = f"{rarity} {number}"
    if POKEMON_SHINY_RARE_RE.search(hay):
        return "window"
    if (
        BLEED_CATALOG_RE.search(hay)
        or SHINY_VAULT_RE.search(hay)
        or GALLERY_NUMBER_RE.search(hay)
        or MEP_ILLUSTRATION_RE.search(hay)
        or MP_ILLUSTRATION_RE.search(hay)
    ):
        return "bleed"
    return "window"


def String_name(name: str) -> str:
    return re.sub(r"\s+", " ", str(name or "")).strip()


def leftover_path(objects: Path | None, ct_id: int) -> Path | None:
    hit = _LEFTOVER_BY_CT.get(int(ct_id))
    if hit:
        return hit
    if objects is None or not objects.is_dir():
        return None
    hits = sorted(objects.glob(f"{int(ct_id)}_*.jpg"))
    hits = [path for path in hits if "_homepage" not in path.name.lower()]
    return hits[0] if hits else None


def _file_rank(path: Path) -> tuple[int, int]:
    ext = path.suffix.lower()
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    return (EXT_RANK.get(ext, 9), -size)


def index_leftovers(roots: list[Path], needed: set[int] | None = None) -> dict[int, Path]:
    by_ct: dict[int, Path] = {}
    for root in roots:
        if not root.is_dir():
            continue
        with os.scandir(root) as entries:
            for entry in entries:
                name = entry.name
                lower = name.lower()
                if "_homepage" in lower:
                    continue
                ext = Path(name).suffix.lower()
                if ext not in EXT_RANK:
                    continue
                token = name.split("_", 1)[0]
                if not token.isdigit():
                    continue
                ct_id = int(token)
                if needed is not None and ct_id not in needed:
                    continue
                path = Path(entry.path)
                prev = by_ct.get(ct_id)
                if prev is None or _file_rank(path) < _file_rank(prev):
                    by_ct[ct_id] = path
    return by_ct


def fill_missing_from_mybook(needed: set[int], workers: int) -> int:
    """Copy leftover JPEGs the NVMe trees lack onto an NVMe cache."""
    missing = {ct for ct in needed if ct not in _LEFTOVER_BY_CT}
    if not missing or not MYBOOK_OBJECTS.is_dir():
        return 0
    NVME_CACHE.mkdir(parents=True, exist_ok=True)
    sources: dict[int, Path] = {}
    with os.scandir(MYBOOK_OBJECTS) as entries:
        for entry in entries:
            token = entry.name.split("_", 1)[0]
            if not token.isdigit():
                continue
            ct_id = int(token)
            if ct_id not in missing:
                continue
            if "_homepage" in entry.name.lower():
                continue
            if Path(entry.name).suffix.lower() not in EXT_RANK:
                continue
            path = Path(entry.path)
            prev = sources.get(ct_id)
            if prev is None or _file_rank(path) < _file_rank(prev):
                sources[ct_id] = path

    def copy_one(ct_id: int, src: Path) -> tuple[int, Path | None]:
        dest = NVME_CACHE / src.name
        if not dest.is_file() or dest.stat().st_size == 0:
            dest.write_bytes(src.read_bytes())
        return ct_id, dest

    copied = 0
    with ThreadPoolExecutor(max_workers=max(workers, 1)) as pool:
        futs = [pool.submit(copy_one, ct, src) for ct, src in sources.items()]
        for fut in as_completed(futs):
            ct_id, path = fut.result()
            if path:
                _LEFTOVER_BY_CT[ct_id] = path
                copied += 1
    return copied


def _region_rgb(rgb: np.ndarray, left: float, top: float, width: float, height: float) -> np.ndarray:
    h, w = rgb.shape[:2]
    x0 = int(w * left)
    y0 = int(h * top)
    x1 = int(w * (left + width))
    y1 = int(h * (top + height))
    return rgb[y0:y1, x0:x1]


def _yellow_border_frac(rgb: np.ndarray) -> float:
    """XY / older framed cards keep a yellow outer border; rainbow FA does not."""
    h, w = rgb.shape[:2]
    top = max(1, int(h * 0.035))
    side = max(1, int(w * 0.035))
    parts = (
        rgb[:top].reshape(-1, 3),
        rgb[-top:].reshape(-1, 3),
        rgb[:, :side].reshape(-1, 3),
        rgb[:, -side:].reshape(-1, 3),
    )
    pix = np.concatenate(parts, 0).astype(np.float32)
    r, g, b = pix[:, 0], pix[:, 1], pix[:, 2]
    return float(np.mean((r > 180) & (g > 150) & (b < 150) & (r + 15 >= g)))


def _white_panel_frac(body: np.ndarray) -> float:
    """SV / Mega framed cards keep a white attack panel; full-art painting does not."""
    pix = body.astype(np.float32)
    r, g, b = pix[..., 0], pix[..., 1], pix[..., 2]
    luma = 0.299 * r + 0.587 * g + 0.114 * b
    sat = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
    return float(np.mean((luma > 200) & (sat < 30)))


def _inner_frame_frac(rgb: np.ndarray) -> float:
    """Illustration-window chrome (left/right/bottom of the art box), not the card edge."""
    strips = (
        _region_rgb(rgb, 0.055, 0.16, 0.05, 0.28),
        _region_rgb(rgb, 0.895, 0.16, 0.05, 0.28),
        _region_rgb(rgb, 0.12, 0.44, 0.76, 0.04),
    )
    fracs = []
    for strip in strips:
        pix = strip.astype(np.float32)
        r, g, b = pix[..., 0], pix[..., 1], pix[..., 2]
        luma = 0.299 * r + 0.587 * g + 0.114 * b
        sat = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
        fracs.append(float(np.mean((luma > 150) & (sat < 50))))
    return float(sum(fracs) / 3)


def _panel_stats(body: np.ndarray) -> tuple[float, float]:
    """Flatness and median luma of the lower body (rules sheet vs painting)."""
    pix = body.reshape(-1, 3).astype(np.float32)
    if pix.size == 0:
        return 0.0, 0.0
    med = np.median(pix, axis=0)
    dist = np.linalg.norm(pix - med, axis=1)
    luma = 0.299 * pix[:, 0] + 0.587 * pix[:, 1] + 0.114 * pix[:, 2]
    return float(np.mean(dist < 35)), float(np.median(luma))


def load_ocr_rows(paths: list[Path] | None = None) -> dict[int, dict]:
    by_id: dict[int, dict] = {}
    for jsonl in paths or OCR_JSONLS:
        if not jsonl.is_file():
            continue
        with jsonl.open(encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                row = json.loads(line)
                by_id[int(row["ct_id"])] = row
    return by_id


def ocr_has_chrome(ct_id: int) -> bool | None:
    row = _OCR_BY_CT.get(int(ct_id))
    if not row:
        return None
    if row.get("junk") or not row.get("ok"):
        return False
    return bool(OCR_CHROME_RE.search(str(row.get("text") or "")))



def ocr_is_ancient_trait(ct_id: int) -> bool:
    """XY Ancient Trait half-arts — painting under Ω/α/Δ/θ banner (Altaria 74/108)."""
    row = _OCR_BY_CT.get(int(ct_id))
    if not row or row.get("junk") or not row.get("ok"):
        return False
    return bool(ANCIENT_TRAIT_OCR_RE.search(str(row.get("text") or "")))

def annotate_ocr(record: dict, ct_id: int | None) -> dict:
    if not ct_id:
        return record
    chrome = ocr_has_chrome(int(ct_id))
    if chrome is None:
        return record
    record["ocr_chrome"] = chrome
    if chrome:
        record["source"] = f"{record.get('source') or 'geometry'}+ocr_chrome"
    return record


def _cream_gold_dark(name: np.ndarray, body: np.ndarray) -> tuple[float, float, float, float]:
    body_f = body.astype(np.float32)
    r, g, b = body_f[..., 0], body_f[..., 1], body_f[..., 2]
    cream = float(np.mean((r > 170) & (g > 150) & (b < 210) & (r + 20 > b)))
    gold = float(np.mean((r > 90) & (g > 70) & (r >= g) & (g >= b) & ((r - b) >= 25) & (g > 40)))
    name_f = name.astype(np.float32)
    luma = 0.299 * name_f[..., 0] + 0.587 * name_f[..., 1] + 0.114 * name_f[..., 2]
    dark = float(np.mean(luma < 80))
    name_luma = float(np.mean(luma))
    return cream, gold, dark, name_luma


def layout_from_stats(stats: dict) -> tuple[str, str]:
    cream = float(stats["cream"])
    gold = float(stats["gold"])
    dark = float(stats["dark_name"])
    yellow = float(stats["yellow_border"])
    white = float(stats["white_panel"])
    inner = float(stats["inner_frame"])
    flat = float(stats["panel_flat"])
    luma = float(stats["panel_luma"])
    framed = (
        flat >= FRAMED_FLAT
        or cream >= 0.45
        or white >= WHITE_PANEL
        or yellow >= YELLOW_BORDER
    )
    if cream >= 0.45:
        return "window", "cream_rules"
    # Full art still prints a dark name/HP overlay (Oshawott MEP 051).
    if dark >= 0.28 and framed:
        return "window", "name_bar"
    # Mega X dark gold attack sheet is flat; fire FA / autumn IR paint is brighter.
    if gold >= 0.40 and flat >= GOLD_FLAT and luma <= GOLD_PANEL_LUMA:
        return "window", "gold_rules"
    if white >= WHITE_PANEL:
        return "window", "white_rules"
    # Water-type SV sheet (Quagsire cyan, Quaxly reverse). Light type tint.
    if flat >= PANEL_FLAT and luma >= PANEL_LUMA:
        return "window", "rules_panel"
    # Dark reverse-holo rules sheet (Hop's Cramorant Poké Ball reverse).
    if flat >= DARK_PANEL_FLAT and luma <= DARK_PANEL_LUMA:
        return "window", "dark_rules"
    if yellow >= YELLOW_BORDER:
        return "window", "era_border"
    # Silver illustration box, not FA holographic chrome (Mega Froslass ex 265/217).
    if inner >= INNER_FRAME and framed:
        return "window", "art_box"
    if dark <= 0.20 and cream <= 0.18:
        return "bleed", "no_chrome"
    return "bleed", "no_art_box"


def geometry_from_rgb(rgb: np.ndarray) -> tuple[str, str, dict]:
    h, w = rgb.shape[:2]
    name = _region_rgb(rgb, 0.08, 0.02, 0.62, 0.10)
    body = _region_rgb(rgb, 0.07, 0.50, 0.86, 0.38)
    cream, gold, dark, name_luma = _cream_gold_dark(name, body)
    yellow = _yellow_border_frac(rgb)
    white = _white_panel_frac(body)
    inner = _inner_frame_frac(rgb)
    flat, panel_luma = _panel_stats(body)
    stats = {
        "width": int(w),
        "height": int(h),
        "dark_name": round(dark, 3),
        "cream": round(cream, 3),
        "gold": round(gold, 3),
        "yellow_border": round(yellow, 3),
        "white_panel": round(white, 3),
        "inner_frame": round(inner, 3),
        "panel_flat": round(flat, 3),
        "panel_luma": round(panel_luma, 1),
        "name_luma": round(name_luma, 1),
    }
    geom, reason = layout_from_stats(stats)
    return geom, reason, stats


def geometry_layout(image: Image.Image) -> tuple[str, str, dict]:
    rgb = np.asarray(image.convert("RGB"))
    return geometry_from_rgb(rgb)


def decide_layout(
    catalog: str, geom: str, reason: str, number: str = "", name: str = "",
) -> tuple[str, str]:
    if catalog == "landscape":
        return "landscape", "name"
    if catalog == "halfart":
        return "halfart", "catalog_amazing"
    if VMAX_NAME_RE.search(str(name or "")):
        source = f"agree:{reason}" if geom == "bleed" else "catalog_bleed"
        return "bleed", source
    # Full-art leftovers still have HP and attacks on the painting. Catalog SIR /
    # Shiny Vault / Full Art stay bleed unless a flat gold/type rules sheet says
    # this scan still has a framed box (Flashfire Mega X, SV6 Charmander,
    # Quagsire SVP 156 cyan). Cream paint and a dark HP overlay are not that —
    # Beautifly IR / Accelgor IR stay bleed. Yellow frame alone is not either
    # (Shauna FA).
    if catalog == "bleed" and reason in CHROME_REASONS:
        if FA_PAINT_RE.search(str(number or "")):
            source = f"agree:{reason}" if geom == "bleed" else "catalog_bleed"
            return "bleed", source
        return "window", f"geometry:{reason}"
    if (
        geom == "bleed"
        and reason in {"no_chrome", "no_art_box"}
        and catalog_frame_overrides_geometry(name, number)
    ):
        return "window", "catalog_gx"
    if catalog == "bleed":
        source = f"agree:{reason}" if geom == "bleed" else "catalog_bleed"
        return "bleed", source
    if (
        catalog == "window"
        and geom == "bleed"
        and reason in {"no_chrome", "no_art_box"}
        and REVERSE_WINDOW_RE.search(str(number or ""))
    ):
        return "window", "catalog_reverse"
    if (
        catalog == "window"
        and geom == "bleed"
        and reason in {"no_chrome", "no_art_box"}
        and re.search(r"\bradiant\b", str(name or ""), re.I)
    ):
        return "window", "catalog_radiant"
    if geom == catalog:
        return geom, f"agree:{reason}"
    return geom, f"geometry:{reason}"


def classify_scan(
    path: Path,
    name: str = "",
    number: str = "",
    rarity: str = "",
    set_name: str = "",
) -> dict:
    catalog = catalog_layout(name, number, rarity, set_name)
    record = {
        "path": str(path),
        "catalog": catalog,
        "layout": catalog,
        "source": "catalog",
        "geometry": "",
        "stats": {},
    }
    try:
        with Image.open(path) as image:
            geom, reason, stats = geometry_layout(image)
    except Exception as exc:
        record["error"] = str(exc)
        return record
    record["geometry"] = geom
    record["stats"] = stats
    record["geom_reason"] = reason
    layout, source = decide_layout(catalog, geom, reason, number, name)
    record["layout"] = layout
    record["source"] = source
    token = Path(path).name.split("_", 1)[0]
    if token.isdigit():
        ct_id = int(token)
        annotate_ocr(record, ct_id)
        if ocr_is_ancient_trait(ct_id):
            record["layout"] = "bleed"
            record["source"] = "ocr_ancient_trait"
            record["catalog"] = "bleed"
    return record


def western_rank(nationality: str) -> int:
    text = str(nationality or "")
    if WESTERN_NAT.search(text):
        return 0
    if ASIAN_NAT.search(text):
        return 2
    return 1


def pick_representative(members: list[dict], objects: Path | None = None) -> dict | None:
    ranked = sorted(
        members,
        key=lambda row: (
            western_rank(row.get("nationality") or ""),
            0 if leftover_path(objects, int(row["ct_id"])) else 1,
            -int(row.get("bytes") or 0),
        ),
    )
    for row in ranked:
        path = leftover_path(objects, int(row["ct_id"]))
        if path:
            row = dict(row)
            row["path"] = path
            try:
                row["bytes"] = path.stat().st_size
            except OSError:
                row["bytes"] = 0
            return row
    return None


def art_cut_crop(image: Image.Image) -> Image.Image:
    rgb = image.convert("RGB")
    left, top, width, height = ART_CUT
    w, h = rgb.size
    return rgb.crop(
        (
            int(w * left),
            int(h * top),
            int(w * (left + width)),
            int(h * (top + height)),
        )
    )


def visual_strip(path: Path, layout: str, label: str, dest: Path) -> None:
    with Image.open(path) as raw:
        card = raw.convert("RGB")
        cut = art_cut_crop(card)
        shown = card if layout in {"bleed", "landscape"} else cut
        shown = shown.copy()
        shown.thumbnail((420, 420))
        bar = Image.new("RGB", (shown.width, shown.height + 36), (18, 20, 28))
        bar.paste(shown, (0, 36))
        draw = ImageDraw.Draw(bar)
        try:
            font = ImageFont.load_default()
        except Exception:
            font = None
        draw.text((8, 10), label[:64], fill=(255, 211, 61), font=font)
        dest.parent.mkdir(parents=True, exist_ok=True)
        bar.save(dest, quality=88)


def psql(sql: str) -> str:
    proc = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            POSTGRES,
            "sh",
            "-c",
            'PGPASSWORD="$POSTGRES_PASSWORD" psql -U pokoin_marketplace -d pokoin_marketplace -v ON_ERROR_STOP=1 -A -t -F "\t"',
        ],
        input=sql.encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode() or proc.stdout.decode())
    return proc.stdout.decode()


def load_groups(limit: int = 0, versions: list[str] | None = None) -> dict[str, list[dict]]:
    where = "c.product_type = 'card' and c.item_kind = 'single'"
    if versions:
        joined = ",".join("'" + re.sub(r"[^v0-9A-Za-z_-]", "", v) + "'" for v in versions)
        where += f" and c.version in ({joined})"
    sql = f"""
select c.version, c.ct_id, c.card_id, c.name, c.card_number, c.rarity,
       coalesce(e.nationality, '') as nationality,
       coalesce(c.set_name, c.expansion_name, '') as set_name
from public.marketplace_search_candidates c
left join (
  select name, min(nationality) as nationality
  from public.pokoin_pokemon_expansions
  group by name
) e on e.name = c.expansion_name
where {where}
order by c.version, c.ct_id
"""
    if limit:
        sql += f"\nlimit {int(limit)}"
    groups: dict[str, list[dict]] = defaultdict(list)
    for line in psql(sql).splitlines():
        parts = line.split("\t")
        if len(parts) != 8:
            continue
        version, ct_id, card_id, name, number, rarity, nationality, set_name = parts
        groups[version].append(
            {
                "version": version,
                "ct_id": int(ct_id),
                "card_id": int(card_id),
                "name": name,
                "number": number,
                "rarity": rarity,
                "nationality": nationality,
                "set_name": set_name,
            }
        )
    return groups


def apply_rows(version_rows: list[tuple[str, str, str]], leftover_rows: list[tuple[int, str, str, str]]) -> None:
    handle = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8")
    path = Path(handle.name)
    leftover_path_csv = Path(str(path) + ".leftover.csv")
    try:
        writer = csv.writer(handle)
        for version, layout, source in version_rows:
            writer.writerow([version, layout, source])
        handle.close()
        with leftover_path_csv.open("w", encoding="utf-8") as leftover_file:
            leftover_writer = csv.writer(leftover_file)
            for ct_id, layout, source, version in leftover_rows:
                leftover_writer.writerow([ct_id, layout, source, version])
        remote = "/tmp/pokoin-art-layout-versions.csv"
        remote_left = "/tmp/pokoin-art-layout-leftovers.csv"
        subprocess.run(["docker", "cp", str(path), f"{POSTGRES}:{remote}"], check=True)
        subprocess.run(["docker", "cp", str(leftover_path_csv), f"{POSTGRES}:{remote_left}"], check=True)
        psql(
            f"""
create temp table art_layout_versions (version text, layout text, source text);
\\copy art_layout_versions from '{remote}' csv
create temp table art_layout_leftovers (ct_id bigint, layout text, source text, version text);
\\copy art_layout_leftovers from '{remote_left}' csv
update public.pokoin_version_sets s
   set art_layout = v.layout,
       art_layout_source = v.source,
       updated_at = now()
  from art_layout_versions v
 where s.version = v.version
   and v.layout in ('window','bleed','landscape','halfart');
insert into public.marketplace_leftover_art_layouts (ct_id, layout, source, version, sampled_at)
select ct_id, layout, source, version, now()
  from art_layout_leftovers
 where layout in ('window','bleed','landscape','halfart')
on conflict (ct_id) do update
  set layout = excluded.layout,
      source = excluded.source,
      version = excluded.version,
      sampled_at = now();
update public.marketplace_search_candidates c
   set art_layout = coalesce(
     (select nullif(l.layout, '') from public.marketplace_leftover_art_layouts l where l.ct_id = c.ct_id),
     nullif(s.art_layout, ''),
     c.art_layout
   )
  from public.pokoin_version_sets s
 where s.version = c.version
   and (
     exists (select 1 from art_layout_versions v where v.version = c.version)
     or exists (select 1 from art_layout_leftovers l2 where l2.ct_id = c.ct_id)
   );
"""
        )
    finally:
        path.unlink(missing_ok=True)
        leftover_path_csv.unlink(missing_ok=True)


def _load_rgb(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"))


def _torch_batch_geometry(arrays: list[np.ndarray], device) -> list[tuple[str, str, dict]]:
    import torch
    import torch.nn.functional as F

    names = []
    bodies = []
    sizes = []
    for rgb in arrays:
        h, w = rgb.shape[:2]
        sizes.append((w, h))
        name = np.ascontiguousarray(_region_rgb(rgb, 0.08, 0.02, 0.62, 0.10))
        body = np.ascontiguousarray(_region_rgb(rgb, 0.07, 0.50, 0.86, 0.38))
        names.append(torch.from_numpy(name).permute(2, 0, 1).float().unsqueeze(0))
        bodies.append(torch.from_numpy(body).permute(2, 0, 1).float().unsqueeze(0))
    name_b = torch.cat(
        [F.interpolate(t, size=(48, 96), mode="bilinear", align_corners=False) for t in names],
        0,
    ).to(device)
    body_b = torch.cat(
        [F.interpolate(t, size=(128, 192), mode="bilinear", align_corners=False) for t in bodies],
        0,
    ).to(device)
    r, g, b = body_b[:, 0], body_b[:, 1], body_b[:, 2]
    cream = ((r > 170) & (g > 150) & (b < 210) & (r + 20 > b)).float().mean(dim=(1, 2))
    gold = (
        ((r > 90) & (g > 70) & (r >= g) & (g >= b) & ((r - b) >= 25) & (g > 40))
        .float()
        .mean(dim=(1, 2))
    )
    luma = 0.299 * name_b[:, 0] + 0.587 * name_b[:, 1] + 0.114 * name_b[:, 2]
    dark = (luma < 80).float().mean(dim=(1, 2))
    name_luma = luma.mean(dim=(1, 2))
    cream_l = cream.detach().cpu().tolist()
    gold_l = gold.detach().cpu().tolist()
    dark_l = dark.detach().cpu().tolist()
    luma_l = name_luma.detach().cpu().tolist()
    out: list[tuple[str, str, dict]] = []
    for i, (w, h) in enumerate(sizes):
        stats = {
            "width": int(w),
            "height": int(h),
            "dark_name": round(float(dark_l[i]), 3),
            "cream": round(float(cream_l[i]), 3),
            "gold": round(float(gold_l[i]), 3),
            "name_luma": round(float(luma_l[i]), 1),
        }
        yellow = _yellow_border_frac(arrays[i])
        white = _white_panel_frac(_region_rgb(arrays[i], 0.07, 0.50, 0.86, 0.38))
        inner = _inner_frame_frac(arrays[i])
        stats["yellow_border"] = round(float(yellow), 3)
        stats["white_panel"] = round(float(white), 3)
        stats["inner_frame"] = round(float(inner), 3)
        body = _region_rgb(arrays[i], 0.07, 0.50, 0.86, 0.38)
        flat, panel_luma = _panel_stats(body)
        stats["panel_flat"] = round(float(flat), 3)
        stats["panel_luma"] = round(float(panel_luma), 1)
        geom, reason = layout_from_stats(stats)
        out.append((geom, reason, stats))
    return out


def classify_paths(
    jobs: list[dict],
    workers: int,
    use_gpu: bool,
    batch: int,
) -> list[dict]:
    hits: list[dict | None] = [None] * len(jobs)
    if not jobs:
        return []

    def decode(idx: int) -> tuple[int, np.ndarray | None, str]:
        path = jobs[idx]["path"]
        try:
            return idx, _load_rgb(Path(path)), ""
        except Exception as exc:
            return idx, None, str(exc)

    device = None
    if use_gpu:
        os.environ.setdefault("HIP_VISIBLE_DEVICES", "0")
        import torch

        if not torch.cuda.is_available():
            raise SystemExit("torch.cuda is not available; HIP 0 7900 XTX required")
        device = torch.device("cuda:0")
        name = torch.cuda.get_device_name(0)
        props = torch.cuda.get_device_properties(0)
        vram_g = props.total_memory / (1024**3)
        print(f"gpu {name} vram {vram_g:.1f} GiB device {device}", flush=True)
        if vram_g < 8:
            raise SystemExit("refusing Raphael iGPU; HIP 0 must be the 7900 XTX")

    pending = list(range(len(jobs)))
    while pending:
        chunk = pending[:batch]
        pending = pending[batch:]
        arrays: list[np.ndarray | None] = [None] * len(chunk)
        errors: list[str] = [""] * len(chunk)
        with ThreadPoolExecutor(max_workers=max(workers, 1)) as pool:
            futs = [pool.submit(decode, idx) for idx in chunk]
            for fut in as_completed(futs):
                idx, rgb, err = fut.result()
                pos = chunk.index(idx)
                arrays[pos] = rgb
                errors[pos] = err
        ready = []
        ready_pos = []
        for pos, idx in enumerate(chunk):
            job = jobs[idx]
            catalog = catalog_layout(
                job["name"], job["number"], job["rarity"], job.get("set_name") or "",
            )
            if arrays[pos] is None:
                hits[idx] = {
                    "path": str(job["path"]),
                    "catalog": catalog,
                    "layout": catalog,
                    "source": "catalog",
                    "geometry": "",
                    "stats": {},
                    "error": errors[pos],
                    "job": job,
                }
                continue
            ready.append(arrays[pos])
            ready_pos.append((pos, idx, catalog, job))
        if not ready:
            continue
        if device is not None:
            geoms = _torch_batch_geometry(ready, device)
        else:
            geoms = [geometry_from_rgb(arr) for arr in ready]
        for (pos, idx, catalog, job), (geom, reason, stats) in zip(ready_pos, geoms):
            layout, source = decide_layout(
                catalog, geom, reason, job.get("number") or "", job.get("name") or "",
            )
            record = {
                "path": str(job["path"]),
                "catalog": catalog,
                "layout": layout,
                "source": source,
                "geometry": geom,
                "geom_reason": reason,
                "stats": stats,
                "job": job,
            }
            annotate_ocr(record, job.get("ct_id"))
            hits[idx] = record
        done = len(jobs) - len(pending)
        print(f"classified {done}/{len(jobs)}", flush=True)
    return [hit for hit in hits if hit is not None]


def classify_groups(
    groups: dict[str, list[dict]],
    objects: Path | None,
    visual_dir: Path | None,
    workers: int = 12,
    use_gpu: bool = False,
    batch: int = 128,
) -> tuple[list, list]:
    jobs: list[dict] = []
    plan: list[dict] = []
    for version, members in groups.items():
        catalogs = {
            catalog_layout(m["name"], m["number"], m["rarity"], m.get("set_name") or "")
            for m in members
        }
        rep = pick_representative(members, objects)
        entry = {
            "version": version,
            "members": members,
            "catalogs": catalogs,
            "rep": rep,
        }
        if len(catalogs) == 1 and "landscape" in catalogs:
            plan.append({**entry, "mode": "landscape"})
            continue
        if len(catalogs) == 1 and "halfart" in catalogs:
            plan.append({**entry, "mode": "catalog_only"})
            continue
        if len(catalogs) == 1 and not rep:
            plan.append({**entry, "mode": "catalog_only"})
            continue
        if len(catalogs) == 1 and "bleed" in catalogs and rep:
            plan.append({**entry, "mode": "bleed_rep", "job_index": len(jobs)})
            jobs.append(
                {
                    "path": rep["path"],
                    "name": rep["name"],
                    "number": rep["number"],
                    "rarity": rep["rarity"],
                    "set_name": rep.get("set_name") or "",
                    "version": version,
                }
            )
            continue
        if len(catalogs) == 1 and catalogs == {"window"} and rep:
            plan.append({**entry, "mode": "window_rep", "job_index": len(jobs)})
            jobs.append(
                {
                    "path": rep["path"],
                    "name": rep["name"],
                    "number": rep["number"],
                    "rarity": rep["rarity"],
                    "set_name": rep.get("set_name") or "",
                    "version": version,
                }
            )
            continue
        member_jobs = []
        for member in members:
            path = leftover_path(objects, member["ct_id"])
            if not path:
                member_jobs.append({"member": member, "job_index": None})
                continue
            member_jobs.append({"member": member, "job_index": len(jobs)})
            jobs.append(
                {
                    "path": path,
                    "name": member["name"],
                    "number": member["number"],
                    "rarity": member["rarity"],
                    "set_name": member.get("set_name") or "",
                    "version": version,
                    "ct_id": member["ct_id"],
                }
            )
        plan.append({**entry, "mode": "mixed", "member_jobs": member_jobs})

    hits = classify_paths(jobs, workers=workers, use_gpu=use_gpu, batch=batch)
    version_rows = []
    leftover_rows = []
    for entry in plan:
        version = entry["version"]
        catalogs = entry["catalogs"]
        rep = entry["rep"]
        mode = entry["mode"]
        if mode == "landscape":
            version_rows.append((version, "landscape", "catalog_unanimous"))
            continue
        if mode == "catalog_only":
            version_rows.append((version, next(iter(catalogs)), "catalog_unanimous"))
            continue
        if mode in {"bleed_rep", "window_rep"}:
            hit = hits[entry["job_index"]]
            if mode == "bleed_rep":
                layout = "bleed"
                source = "catalog_unanimous"
                if hit.get("geom_reason") in CHROME_REASONS:
                    layout = "window"
                    source = hit["source"]
                elif hit.get("geometry") == "bleed":
                    layout = "bleed"
                    source = hit["source"]
            else:
                layout = hit["layout"]
                source = hit["source"]
            version_rows.append((version, layout, source))
            if visual_dir and rep:
                visual_strip(
                    Path(rep["path"]),
                    layout,
                    f"{version} {layout} {source}",
                    visual_dir / "clusters" / f"{version}-{layout}.jpg",
                )
            continue
        layouts = []
        for item in entry["member_jobs"]:
            member = item["member"]
            if item["job_index"] is None:
                leftover_rows.append(
                    (
                        member["ct_id"],
                        catalog_layout(
                            member["name"],
                            member["number"],
                            member["rarity"],
                            member.get("set_name") or "",
                        ),
                        "catalog_missing_scan",
                        version,
                    )
                )
                continue
            hit = hits[item["job_index"]]
            leftover_rows.append((member["ct_id"], hit["layout"], hit["source"], version))
            layouts.append(hit["layout"])
            if visual_dir:
                visual_strip(
                    Path(hit["path"]),
                    hit["layout"],
                    f"{member['ct_id']} {hit['layout']}",
                    visual_dir / "mixed" / f"{version}-{member['ct_id']}.jpg",
                )
        if layouts:
            majority = max(set(layouts), key=layouts.count)
            version_rows.append((version, majority, "mixed_majority"))
        elif catalogs:
            version_rows.append((version, next(iter(catalogs)), "catalog_unanimous"))
    return version_rows, leftover_rows


def load_no_chrome_groups() -> dict[str, list[dict]]:
    """Reclassify leftovers: no art-box, gold paint, timid default, MEP/SV promos."""
    sql = """
select c.version, c.ct_id, c.card_id, c.name, c.card_number, c.rarity,
       coalesce(e.nationality, '') as nationality,
       coalesce(c.set_name, c.expansion_name, '') as set_name
from public.marketplace_search_candidates c
left join (
  select name, min(nationality) as nationality
  from public.pokoin_pokemon_expansions
  group by name
) e on e.name = c.expansion_name
left join public.marketplace_leftover_art_layouts l on l.ct_id = c.ct_id
where c.product_type = 'card' and c.item_kind = 'single'
  and (
    exists (
      select 1 from public.pokoin_version_sets s
       where s.version = c.version
         and coalesce(s.art_layout_source, '') ~* 'no_chrome|default|no_art_box|gold_rules|catalog_bleed|name_bar|art_box|cream_rules|catalog_gx'
    )
    or coalesce(l.source, '') ~* 'no_chrome|default|no_art_box|gold_rules|catalog_bleed|name_bar|art_box|cream_rules|catalog_gx'
    or (
      c.name ~* '\\ygx\\y'
      and coalesce(l.layout, '') = 'window'
    )
    or c.expansion_name ilike '%mep black star%'
    or c.expansion_name ilike '%first partner illustration%'
    or c.expansion_name ilike '%sv black star%'
    or (c.card_number ~* 'illustration rare' and l.ct_id is null)
    or (
      coalesce(l.layout, '') = 'window'
      and c.card_number ~* 'illustration rare|special illustration|full.?art|shiny rare'
    )
    or c.card_number ~* '1(?:0[1-9]|1[0-9]|2[0-4])\\s*/\\s*m-p|m-p\\s*12[5-7]'
    or (
      coalesce(l.layout, '') = 'bleed'
      and c.card_number ~* '(pok[eé] ball|master ball) reverse|reverse holo'
      and c.card_number !~* 'illustration|full.?art|shiny rare'
    )
  )
order by c.version, c.ct_id
"""
    groups: dict[str, list[dict]] = defaultdict(list)
    for line in psql(sql).splitlines():
        parts = line.split("\t")
        if len(parts) != 8:
            continue
        version, ct_id, card_id, name, number, rarity, nationality, set_name = parts
        groups[version].append(
            {
                "version": version,
                "ct_id": int(ct_id),
                "card_id": int(card_id),
                "name": name,
                "number": number,
                "rarity": rarity,
                "nationality": nationality,
                "set_name": set_name,
            }
        )
    return groups


def classify_each_leftover(
    groups: dict[str, list[dict]],
    objects: Path | None,
    visual_dir: Path | None,
    workers: int = 12,
    use_gpu: bool = False,
    batch: int = 128,
) -> tuple[list, list]:
    jobs: list[dict] = []
    plan: list[dict] = []
    for version, members in groups.items():
        for member in members:
            path = leftover_path(objects, int(member["ct_id"]))
            entry = {"member": member, "version": version, "job_index": None}
            if path:
                entry["job_index"] = len(jobs)
                jobs.append(
                    {
                        "path": path,
                        "name": member["name"],
                        "number": member["number"],
                        "rarity": member["rarity"],
                        "set_name": member.get("set_name") or "",
                        "version": version,
                        "ct_id": member["ct_id"],
                    }
                )
            plan.append(entry)
    hits = classify_paths(jobs, workers=workers, use_gpu=use_gpu, batch=batch)
    leftover_rows = []
    by_version: dict[str, list[str]] = defaultdict(list)
    for entry in plan:
        member = entry["member"]
        version = entry["version"]
        if entry["job_index"] is None:
            continue
        hit = hits[entry["job_index"]]
        leftover_rows.append((member["ct_id"], hit["layout"], hit["source"], version))
        by_version[version].append(hit["layout"])
        if visual_dir:
            visual_strip(
                Path(hit["path"]),
                hit["layout"],
                f"{member['ct_id']} {hit['layout']}",
                visual_dir / "leftovers" / f"{version}-{member['ct_id']}.jpg",
            )
    version_rows = []
    for version, layouts in by_version.items():
        majority = max(set(layouts), key=layouts.count)
        version_rows.append((version, majority, "leftover_majority"))
    return version_rows, leftover_rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--objects",
        type=Path,
        action="append",
        default=None,
        help="NVMe leftover directories (repeatable). Default: nezopt NVMe trees.",
    )
    parser.add_argument("--visual-dir", type=Path, default=None)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--version", action="append", default=[])
    parser.add_argument("--workers", type=int, default=os.cpu_count() or 8)
    parser.add_argument("--batch", type=int, default=128)
    parser.add_argument("--gpu", action="store_true", default=True)
    parser.add_argument("--no-gpu", action="store_false", dest="gpu")
    parser.add_argument(
        "--repair-no-chrome",
        action="store_true",
        help="Reclassify leftovers stamped no_chrome/no_art_box/gold_rules plus MEP/SV promos.",
    )
    parser.add_argument(
        "--copy-from-mybook",
        action="store_true",
        help="Copy leftover JPEGs the NVMe tree lacks from 15T mybook. Prefer scripts/sync-nvme-leftovers-from-15t.sh once.",
    )
    args = parser.parse_args()
    roots = args.objects or list(NVME_OBJECT_ROOTS)
    global _LEFTOVER_BY_CT, _OCR_BY_CT
    _OCR_BY_CT = load_ocr_rows()
    print(f"ocr leftovers {len(_OCR_BY_CT)}", flush=True)
    if args.repair_no_chrome:
        groups = load_no_chrome_groups()
    else:
        groups = load_groups(limit=0, versions=args.version or None)
    if args.limit:
        items = list(groups.items())[: args.limit]
        groups = dict(items)
    needed = {int(m["ct_id"]) for members in groups.values() for m in members}
    print("index leftovers", " ".join(str(r) for r in roots), flush=True)
    _LEFTOVER_BY_CT = index_leftovers(roots, needed=needed if args.repair_no_chrome else None)
    print(f"indexed {len(_LEFTOVER_BY_CT)} nvme leftovers", flush=True)
    copied = 0
    if args.copy_from_mybook:
        copied = fill_missing_from_mybook(needed, workers=args.workers)
        if copied:
            print(f"copied {copied} missing leftovers onto {NVME_CACHE}", flush=True)
    objects = roots[0] if roots else None
    classify = classify_each_leftover if args.repair_no_chrome else classify_groups
    version_rows, leftover_rows = classify(
        groups,
        objects,
        args.visual_dir,
        workers=args.workers,
        use_gpu=args.gpu,
        batch=args.batch,
    )
    print(
        f"versions {len(version_rows)} leftover_layouts {len(leftover_rows)}",
        flush=True,
    )
    if args.apply:
        apply_rows(version_rows, leftover_rows)
        print("applied", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
