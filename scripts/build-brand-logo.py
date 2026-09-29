#!/usr/bin/env python3
"""Build the official Pokoin wordmark as standalone SVGs (no font, no bitmap).

Mirrors the topbar markup in market/src/components/Chrome.jsx and the
.brand-word CSS in market/src/styles.css: Fredoka 700 "P", the pixel coin
mascot as the first "o", "koın" with a yellow coin dot on the i, letter
spacing -0.02em and a navy 0.07em drop shadow. Glyphs become paths and the
mascot becomes pixel rectangles, so the files render the same everywhere.

    python3 scripts/build-brand-logo.py        # needs fontTools + Pillow

Writes brand/logo/*.svg, brand/mascot/pokoin-mascot.svg and market/public/brand/*.svg.
"""
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
LETTER_SPACING = -0.02 * EM
SHADOW = 0.07 * EM
COIN_WIDTH = 0.98 * EM
COIN_MARGIN = (0.06 * EM, 0.02 * EM, 0.01 * EM)  # top, right, left
DOT_SIZE = 0.26 * EM
DOT_TOP = 0.20 * EM


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


def build():
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
        advance = hmtx[name][0] + LETTER_SPACING
        start = x
        x += advance
        return start, advance

    letter("P")
    top, right, left = COIN_MARGIN
    x += left
    coin_h = COIN_WIDTH * 192 / 208
    outer = coin_h + top
    coin_y = (EM - outer) / 2 + top  # align-items: center inside the 1em line
    coin_svg, _ = mascot_group(x, coin_y, COIN_WIDTH)
    x += COIN_WIDTH + right
    letter("k")
    letter("o")
    i_start, i_width = letter("ı")
    letter("n")
    # .brand-i::after: centred on the ı box, 0.2em below the content-area top.
    dot_cx = i_start + i_width / 2
    dot_cy = half_leading + DOT_TOP + DOT_SIZE / 2
    dot = (dot_cx, dot_cy, DOT_SIZE / 2)

    width = x - LETTER_SPACING  # trailing spacing is not ink
    pad = 20
    view_w = width + pad * 2
    view_h = EM + SHADOW + pad * 2
    text = " ".join(paths)
    cx, cy, r = dot

    def svg(fill, shadow=True, title="Pokoin"):
        body = []
        if shadow:
            body.append(f'<g transform="translate(0 {SHADOW:.0f})" fill="{NAVY}"><path d="{text}"/>'
                        f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}"/></g>')
        body.append(f'<path fill="{fill}" d="{text}"/>')
        body.append(f'<circle fill="{COIN}" cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}"/>')
        body.append(coin_svg)
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{-pad} {-pad} {view_w:.0f} {view_h:.0f}" '
            f'width="{view_w / 10:.0f}" height="{view_h / 10:.0f}" role="img" aria-label="{title}">'
            f"<title>{title}</title>{''.join(body)}</svg>\n"
        )

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
    targets = [ROOT / "market/public/brand"]
    for name, data in outputs.items():
        folder = ROOT / ("brand/mascot" if "mascot" in name else "brand/logo")
        for target in (folder, *targets):
            target.mkdir(parents=True, exist_ok=True)
            (target / name).write_text(data)
    print(f"wordmark {view_w:.0f}×{view_h:.0f} units, mascot {cols}×{rows} px, {len(runs)} runs")


if __name__ == "__main__":
    build()
