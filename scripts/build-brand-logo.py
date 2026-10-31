#!/usr/bin/env python3
"""Build the official Pokoin wordmark as standalone SVGs (no font, no bitmap).

Mirrors the topbar markup in solid/src/components/Chrome.jsx and the
.brand-word CSS in market/src/styles.css: Fredoka 700 "P", the pixel coin
mascot as the first "o", "koın" with a yellow coin dot on the i, letter
spacing -0.02em and a navy 0.07em drop shadow. Glyphs become paths and the
mascot becomes pixel rectangles, so the files render the same everywhere.

    python3 scripts/build-brand-logo.py        # needs fontTools + Pillow

The landing variant preserves the landing CSS proportions and one-em line box.

Writes brand/logo/*.svg, brand/mascot/pokoin-mascot.svg and market/public/brand/*.svg.
"""
from dataclasses import dataclass
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / "home/fredoka-wordmark.ttf"
MASCOT = ROOT / "market/src/assets/pokoin-mascot@8x.png"
MASCOT_SCALE = 8

WHITE = "#ffffff"
NAVY = "#23376e"
COIN = "#ffd23f"

EM = 1000.0  # font units per em; all layout below is in these units


@dataclass(frozen=True)
class WordmarkLayout:
    letter_spacing: float
    coin_width: float
    coin_margin: tuple[float, float, float]  # top, right, left
    dot_size: float
    dot_top: float
    pad: float = 20
    shadow: float = 70
    # CSS text runs include trailing letter-spacing in their layout width.
    include_trailing_spacing: bool = False
    overflow_visible: bool = False
    kern_text_runs: bool = False
    dot_from_line_box: bool = False


MARKET_LAYOUT = WordmarkLayout(-20, 980, (60, 20, 10), 260, 200)
LANDING_LAYOUT = WordmarkLayout(
    -25, 780, (0, 20, 20), 190, 170,
    pad=0, shadow=0, include_trailing_spacing=True, overflow_visible=True,
    kern_text_runs=True, dot_from_line_box=True,
)


def mascot_rects():
    """Pixel runs of the mascot on its native grid: [(x, y, w, (r,g,b,a))]."""
    im = Image.open(MASCOT).convert("RGBA")
    cols, rows = im.width // MASCOT_SCALE, im.height // MASCOT_SCALE
    px = im.load()
    runs = []
    for gy in range(rows):
        gx = 0
        while gx < cols:
            c = px[gx * MASCOT_SCALE + MASCOT_SCALE // 2, gy * MASCOT_SCALE + MASCOT_SCALE // 2]
            start = gx
            while gx < cols and px[gx * MASCOT_SCALE + MASCOT_SCALE // 2, gy * MASCOT_SCALE + MASCOT_SCALE // 2] == c:
                gx += 1
            if c[3] > 0:
                runs.append((start, gy, gx - start, c))
    return cols, rows, runs


def color(c):
    r, g, b, a = c
    hexa = f"#{r:02x}{g:02x}{b:02x}"
    return hexa if a == 255 else f"{hexa}\" fill-opacity=\"{a / 255:.3f}"


def mascot_group(x, y, width):
    cols, rows, runs = mascot_rects()
    cell = width / cols
    parts = [f'<g transform="translate({x:.2f} {y:.2f}) scale({cell:.4f})" shape-rendering="crispEdges">']
    for gx, gy, w, c in runs:
        parts.append(f'<rect x="{gx}" y="{gy}" width="{w}" height="1" fill="{color(c)}"/>')
    parts.append("</g>")
    return "".join(parts), width * rows / cols


def glyph_path(font, name, x, baseline):
    glyphs = font.getGlyphSet()
    pen = SVGPathPen(glyphs)
    glyphs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, baseline)))
    return pen.getCommands()


def pair_kerning(font, left, right):
    """Read pair adjustments from the bundled subset's format-1 GPOS tables."""
    adjustment = 0
    for lookup in font["GPOS"].table.LookupList.Lookup:
        if lookup.LookupType != 2:
            continue
        for subtable in lookup.SubTable:
            if subtable.Format != 1 or left not in subtable.Coverage.glyphs:
                continue
            pairs = subtable.PairSet[subtable.Coverage.glyphs.index(left)]
            for pair in pairs.PairValueRecord:
                if pair.SecondGlyph == right and pair.Value1:
                    adjustment += getattr(pair.Value1, "XAdvance", 0)
    return adjustment


def wordmark_renderer(layout):
    font = TTFont(FONT)
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    ascent, descent = font["hhea"].ascent, font["hhea"].descent
    # line-height: 1 → the 1em line box centres the ascent+descent content area.
    half_leading = (EM - (ascent - descent)) / 2
    baseline = half_leading + ascent

    x = 0.0
    paths = []
    coin_svg = ""
    dot = None

    def letter(ch):
        nonlocal x
        name = cmap[ord(ch)]
        paths.append(glyph_path(font, name, x, baseline))
        advance = hmtx[name][0] + layout.letter_spacing
        start = x
        x += advance
        return start, advance

    letter("P")
    top, right, left = layout.coin_margin
    x += left
    coin_h = layout.coin_width * 192 / 208
    outer = coin_h + top
    coin_y = (EM - outer) / 2 + top  # align-items: center inside the 1em line
    coin_svg, _ = mascot_group(x, coin_y, layout.coin_width)
    x += layout.coin_width + right
    letter("k")
    # Only "ko" shares a CSS text run; P, dotless i, and n are separate flex items.
    if layout.kern_text_runs:
        x += pair_kerning(font, cmap[ord("k")], cmap[ord("o")])
    letter("o")
    i_start, i_width = letter("ı")
    letter("n")
    # Landing .brand-i is a flex item with a one-em line box; its pseudo-element
    # top is relative to that box. Keep the original market content-area origin.
    dot_cx = i_start + i_width / 2
    dot_origin = 0 if layout.dot_from_line_box else half_leading
    dot_cy = dot_origin + layout.dot_top + layout.dot_size / 2
    dot = (dot_cx, dot_cy, layout.dot_size / 2)

    width = x if layout.include_trailing_spacing else x - layout.letter_spacing
    pad = layout.pad
    view_w = width + pad * 2
    view_h = EM + layout.shadow + pad * 2
    text = " ".join(paths)
    cx, cy, r = dot

    def svg(fill, shadow=True, title="Pokoin"):
        body = []
        if shadow:
            body.append(f'<g transform="translate(0 {layout.shadow:.0f})" fill="{NAVY}"><path d="{text}"/>'
                        f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}"/></g>')
        body.append(f'<path fill="{fill}" d="{text}"/>')
        body.append(f'<circle fill="{COIN}" cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}"/>')
        body.append(coin_svg)
        if layout.overflow_visible:
            # Keep the CSS line box exactly one em, with no padding or shadow space.
            viewport = f'viewBox="0 0 {view_w:g} {view_h:g}" overflow="visible" '
        else:
            viewport = f'viewBox="{-pad} {-pad} {view_w:.0f} {view_h:.0f}" '
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" {viewport}'
            f'width="{view_w / 10:.0f}" height="{view_h / 10:.0f}" role="img" aria-label="{title}">'
            f"<title>{title}</title>{''.join(body)}</svg>\n"
        )

    return svg, view_w, view_h


def build():
    svg, view_w, view_h = wordmark_renderer(MARKET_LAYOUT)
    landing_svg, _, _ = wordmark_renderer(LANDING_LAYOUT)
    cols, rows, runs = mascot_rects()
    mascot = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {cols} {rows}" width="{cols * 8}" height="{rows * 8}" '
        f'shape-rendering="crispEdges" role="img" aria-label="Pokoin coin mascot"><title>Pokoin coin mascot</title>'
        + "".join(f'<rect x="{gx}" y="{gy}" width="{w}" height="1" fill="{color(c)}"/>' for gx, gy, w, c in runs)
        + "</svg>\n"
    )

    outputs = {
        "pokoin-logo.svg": svg(WHITE),  # white letters + navy shadow, for dark backgrounds
        "pokoin-logo-flat.svg": svg(WHITE, shadow=False),
        "pokoin-logo-navy.svg": svg(NAVY, shadow=False),  # for light backgrounds
        "pokoin-mascot.svg": mascot,
    }
    # The landing variant belongs only to the website, not the marketplace app.
    outputs["pokoin-logo-landing.svg"] = landing_svg(WHITE, shadow=False)
    for name, data in outputs.items():
        folder = ROOT / ("brand/mascot" if "mascot" in name else "brand/logo")
        targets = [folder]
        if name != "pokoin-logo-landing.svg":
            targets.append(ROOT / "market/public/brand")
        for target in targets:
            target.mkdir(parents=True, exist_ok=True)
            (target / name).write_text(data)
    print(f"wordmark {view_w:.0f}×{view_h:.0f} units, mascot {cols}×{rows} px, {len(runs)} runs")


if __name__ == "__main__":
    build()
