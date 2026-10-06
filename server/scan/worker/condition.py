"""Physical condition estimate for one trading card from phone photos.

Classical computer vision (numpy + OpenCV), deterministic and explainable: no
trained model exists yet. The front photo is required; a photo of the back is
optional but is where most edge whitening shows, so callers should send it.

Pipeline per side: locate the card (rectangle hypotheses scored by edge
support, so a penny sleeve or toploader edge loses to the card's own edge) ->
warp to 630x880 -> glare mask -> centering (outer edge to printed inner frame)
-> edge and corner whitening relative to that side's own border colour ->
surface creases (thin straight ridges that are not printed design lines or
holo texture). Penalties add up to a 0..100 score mapped to CardTrader grades.

CLI: python condition.py FRONT [--back BACK] [--crease confirmed|none] | python condition.py --summary IMG...
"""
from __future__ import annotations

import json
import math
import sys
import time

import cv2
import numpy as np

import card_quad

cv2.setNumThreads(1)

W, H = 630, 880
RATIO = 63 / 88
CORNER_RADIUS = 0.048 * W          # Pokemon cards: ~3 mm radius on a 63 mm card.
GRADES = ((88, "NM"), (75, "SP"), (58, "MP"), (40, "PL"))
GRADE_ORDER = ["NM", "SP", "MP", "PL", "PO"]
REFINE = False
WORK_MAX = 960                     # long side used for localisation


# ---------------------------------------------------------------- decoding

def decode(blob: bytes) -> np.ndarray:
    data = np.frombuffer(blob, np.uint8)
    bgr = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("not an image")
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


# ------------------------------------------------------------ localisation

def _ordered(points) -> np.ndarray:
    return card_quad.ordered(np.asarray(points, np.float32))


def _sides(quad: np.ndarray) -> np.ndarray:
    return np.linalg.norm(quad - np.roll(quad, -1, axis=0), axis=1)


def _ratio(quad: np.ndarray) -> float:
    s = _sides(quad)
    a, b = (s[0] + s[2]) / 2, (s[1] + s[3]) / 2
    return float(min(a, b) / max(a, b, 1e-6))


def _area(quad: np.ndarray) -> float:
    return float(abs(cv2.contourArea(quad.astype(np.float32))))


def _support(lab: np.ndarray, quad: np.ndarray) -> tuple[float, list[float]]:
    """Fraction of each side whose outside differs in colour from its inside."""
    h, w = lab.shape[:2]
    off = max(2.0, 0.006 * max(h, w))
    centre = quad.mean(axis=0)
    per_side = []
    for i in range(4):
        p, q = quad[i], quad[(i + 1) % 4]
        t = np.linspace(0.08, 0.92, 48)[:, None]
        pts = p + (q - p) * t
        d = q - p
        n = np.array([-d[1], d[0]], np.float32) / max(1e-6, float(np.linalg.norm(d)))
        if np.dot((p + q) / 2 - centre, n) < 0:
            n = -n                               # n points outward
        outside, inside = pts + n * off, pts - n * off
        ok = ((outside[:, 0] >= 0) & (outside[:, 0] < w) & (outside[:, 1] >= 0) & (outside[:, 1] < h))
        if ok.mean() < 0.5:
            per_side.append(-1.0)                # side on the image border: unknown
            continue
        o = lab[np.clip(outside[:, 1].astype(int), 0, h - 1), np.clip(outside[:, 0].astype(int), 0, w - 1)]
        k = lab[np.clip(inside[:, 1].astype(int), 0, h - 1), np.clip(inside[:, 0].astype(int), 0, w - 1)]
        delta = np.linalg.norm(o.astype(np.float32) - k.astype(np.float32), axis=1)
        per_side.append(float(((delta > 14) & ok).sum() / max(1, ok.sum())))
    known = [s for s in per_side if s >= 0]
    if not known:
        return 0.0, per_side
    # A real card edge is supported on every visible side; a missing side kills it.
    return float(0.6 * np.mean(known) + 0.4 * np.min(known)), per_side


def _border_likeness(lab: np.ndarray, quad: np.ndarray) -> float:
    """How uniform the ring just inside the quad is: a printed card border is one
    colour all round, while inside a printed inner frame there is artwork."""
    sides = _sides(quad)
    size = float(np.mean(sides))
    vals = []
    for f in (0.012, 0.02):
        inner = quad.mean(axis=0) + (quad - quad.mean(axis=0)) * (1 - 2 * f * size / max(1.0, float(np.mean(sides))))
        for i in range(4):
            p, q = inner[i], inner[(i + 1) % 4]
            t = np.linspace(0.15, 0.85, 40)[:, None]
            pts = p + (q - p) * t
            h, w = lab.shape[:2]
            px = lab[np.clip(pts[:, 1].astype(int), 0, h - 1), np.clip(pts[:, 0].astype(int), 0, w - 1)].astype(np.float32)
            vals.append(px)
    ring = np.concatenate(vals)
    med = np.median(ring, axis=0)
    return float((np.linalg.norm(ring - med, axis=1) < 22).mean())


def _line_hypotheses(gray: np.ndarray) -> list[np.ndarray]:
    h, w = gray.shape
    med = float(np.median(gray))
    edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), max(10, 0.5 * med), max(40, 1.2 * med))
    lines = cv2.HoughLinesP(edges, 1, np.pi / 360, threshold=40,
                            minLineLength=int(0.18 * min(h, w)), maxLineGap=int(0.02 * max(h, w)))
    if lines is None:
        return []
    segs = lines.reshape(-1, 4).astype(np.float32)
    ang = np.degrees(np.arctan2(segs[:, 3] - segs[:, 1], segs[:, 2] - segs[:, 0])) % 180
    length = np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1])
    # Dominant orientation modulo 90 (length-weighted circular mean).
    a4 = np.radians((ang % 90) * 4)
    base = (math.degrees(math.atan2((np.sin(a4) * length).sum(), (np.cos(a4) * length).sum())) / 4) % 90
    families = []
    for target in (base, base + 90):
        diff = np.abs(((ang - target) + 90) % 180 - 90)
        keep = diff < 7
        if not keep.any():
            return []
        th = math.radians(target)
        normal = np.array([-math.sin(th), math.cos(th)], np.float32)
        mid = np.stack([(segs[keep, 0] + segs[keep, 2]) / 2, (segs[keep, 1] + segs[keep, 3]) / 2], 1)
        rho = mid @ normal
        order = np.argsort(rho)
        merged: list[list[float]] = []
        for r, L in zip(rho[order], length[keep][order]):
            if merged and r - merged[-1][0] < 0.007 * max(h, w):
                m = merged[-1]
                m[0] = (m[0] * m[1] + r * L) / (m[1] + L)
                m[1] += L
            else:
                merged.append([float(r), float(L)])
        merged.sort(key=lambda m: -m[1])
        families.append((normal, [m[0] for m in merged[:10]]))
    (n1, r1), (n2, r2) = families
    out = []
    for i in range(len(r1)):
        for j in range(i + 1, len(r1)):
            a, b = sorted((r1[i], r1[j]))
            for k in range(len(r2)):
                for m in range(k + 1, len(r2)):
                    c, d = sorted((r2[k], r2[m]))
                    da, dc = b - a, d - c
                    if min(da, dc) / max(da, dc) < 0.64 or min(da, dc) / max(da, dc) > 0.80:
                        continue
                    if da * dc < 0.05 * h * w:
                        continue
                    A = np.stack([n1, n2])
                    corners = [np.linalg.solve(A, np.array([x, y], np.float32)) for x, y in ((a, c), (a, d), (b, d), (b, c))]
                    out.append(_ordered(corners))
    return out


def _refine(lab: np.ndarray, quad: np.ndarray, span_frac: float = 0.02) -> np.ndarray:
    """Snap each side to its strongest colour transition within +-2% of the card width."""
    h, w = lab.shape[:2]
    labf = lab.astype(np.float32)
    centre = quad.mean(axis=0)
    span = span_frac * float(np.mean(_sides(quad)))
    gap = max(1.5, 0.004 * max(h, w))
    lines = []
    for i in range(4):
        p, q = quad[i], quad[(i + 1) % 4]
        d = (q - p) / max(1e-6, float(np.linalg.norm(q - p)))
        n = np.array([-d[1], d[0]], np.float32)
        if np.dot((p + q) / 2 - centre, n) < 0:
            n = -n
        t = np.linspace(0.12, 0.88, 64)[:, None]
        pts = p + (q - p) * t
        best_off, best_val = 0.0, -1.0
        for off in np.arange(-span, span + 0.5, 0.5):
            o = pts + n * (off + gap)
            k = pts + n * (off - gap)
            ok = (o[:, 0] >= 0) & (o[:, 0] < w) & (o[:, 1] >= 0) & (o[:, 1] < h)
            if ok.mean() < 0.5:
                continue
            a = labf[np.clip(o[:, 1].astype(int), 0, h - 1), np.clip(o[:, 0].astype(int), 0, w - 1)]
            b = labf[np.clip(k[:, 1].astype(int), 0, h - 1), np.clip(k[:, 0].astype(int), 0, w - 1)]
            val = float(np.median(np.linalg.norm(a - b, axis=1)[ok]))
            # Ties go to the outer offset: the card edge is outside its own printed border lines.
            if val > best_val * 1.05 or (val >= best_val * 0.97 and off > best_off and val > 0):
                best_off, best_val = float(off), max(val, best_val)
        lines.append((p + n * best_off, d))
    out = []
    for i in range(4):
        (p1, d1), (p2, d2) = lines[i - 1], lines[i]
        A = np.array([[d1[0], -d2[0]], [d1[1], -d2[1]]], np.float32)
        try:
            t = np.linalg.solve(A, (p2 - p1).astype(np.float32))
            out.append(p1 + d1 * t[0])
        except np.linalg.LinAlgError:
            return quad
    return _ordered(out)


def _iou_box(quad: np.ndarray, box) -> float:
    x1, y1 = quad.min(axis=0)
    x2, y2 = quad.max(axis=0)
    a1, b1, a2, b2 = box
    iw = max(0.0, min(x2, a2) - max(x1, a1))
    ih = max(0.0, min(y2, b2) - max(y1, b1))
    inter = iw * ih
    return float(inter / max(1e-6, (x2 - x1) * (y2 - y1) + (a2 - a1) * (b2 - b1) - inter))


def locate(rgb: np.ndarray, box=None) -> tuple[np.ndarray, str, dict]:
    """Return the card quad (TL, TR, BR, BL in rgb pixels), detector name and debug info.

    `box` is an optional [x1, y1, x2, y2] card box from the worker's YOLO
    detector: line rectangles that agree with it win, otherwise the box's own
    sides are snapped to the strongest nearby colour edge."""
    h, w = rgb.shape[:2]
    scale = min(1.0, WORK_MAX / max(h, w))
    small = cv2.resize(rgb, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else rgb
    sh, sw = small.shape[:2]
    lab = cv2.cvtColor(small, cv2.COLOR_RGB2LAB)
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    hyps: list[tuple[np.ndarray, str]] = []
    for c in card_quad.detect(small):
        if "quad" in c:
            hyps.append((_ordered(c["quad"]), "card-quad"))
    hyps += [(q, "card-lines") for q in _line_hypotheses(gray)]
    if box is not None:
        # Lines inside the padded detector box only: wood grain, fingers and
        # binder pages outside it no longer set the dominant orientation.
        x1, y1, x2, y2 = [float(v) * scale for v in box]
        px, py = 0.1 * (x2 - x1), 0.1 * (y2 - y1)
        cx1, cy1 = int(max(0, x1 - px)), int(max(0, y1 - py))
        cx2, cy2 = int(min(sw, x2 + px)), int(min(sh, y2 + py))
        if cx2 - cx1 > 40 and cy2 - cy1 > 40:
            off = np.array([cx1, cy1], np.float32)
            hyps += [(q + off, "card-lines") for q in _line_hypotheses(gray[cy1:cy2, cx1:cx2])]
    frame = np.array([[0, 0], [sw - 1, 0], [sw - 1, sh - 1], [0, sh - 1]], np.float32)
    scored = []
    for quad, name in hyps:
        r = _ratio(quad)
        if not RATIO - 0.055 <= r <= RATIO + 0.055:
            continue                              # printed inner frames are rarely 63:88
        area = _area(quad) / (sh * sw)
        if area < 0.04 or area > 1.02:
            continue
        support, per_side = _support(lab, quad)
        scored.append((support, area, quad, name, per_side, _border_likeness(lab, quad)))
    scan_shaped = abs(min(sw, sh) / max(sw, sh) - RATIO) < 0.025
    if box is not None:
        b = [float(v) * scale for v in box]
        if scan_shaped and _iou_box(frame, b) >= 0.85:
            return frame / scale, "full-frame", {"support": None}
        near = [x for x in scored if _iou_box(x[2], b) >= 0.75]
        if near:
            support, area, best, best_name, per_side, _ = max(near, key=lambda x: _iou_box(x[2], b) + 0.2 * x[0] - 1.0 * abs(_ratio(x[2]) - RATIO))
            return best / scale, "yolo+lines", {"support": round(support, 3), "sides": [round(v, 2) for v in per_side]}
        quad = _refine(lab, np.array([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], np.float32), span_frac=0.03)
        support, per_side = _support(lab, quad)
        return quad / scale, "yolo", {"support": round(support, 3), "sides": [round(v, 2) for v in per_side]}
    # A gallery scan is already cropped to the card: its frame is the card edge.
    if scan_shaped and not any(a > 0.92 and s > 0.6 for s, a, *_ in scored):
        return frame / scale, "full-frame", {"support": None}
    if not scored or max(s for s, *_ in scored) < 0.45:
        return frame / scale, "full-frame", {"support": None, "no_outline": True}
    # Printed inner frames are well supported too; the card is the OUTERMOST
    # card-shaped rectangle whose edge support is close to the best one.
    def rank(x):
        support, area, quad, _, _, border = x
        return 0.5 * support + 0.5 * border + 0.15 * min(area, 0.6) - 1.5 * abs(_ratio(quad) - RATIO)
    support, area, best, best_name, per_side, _ = max(scored, key=rank)
    best = _refine(lab, best) if REFINE else best
    support, per_side = _support(lab, best)
    best_info = {"support": round(support, 3), "sides": [round(v, 2) for v in per_side]}
    return best / scale, ("card-quad" if best_name == "card-quad" else "card-lines"), best_info


def warp(rgb: np.ndarray, quad: np.ndarray) -> np.ndarray:
    quad = _ordered(quad)
    s = _sides(quad)
    if (s[0] + s[2]) > (s[1] + s[3]):            # landscape: rotate so the long side is vertical
        quad = np.roll(quad, -1, axis=0)
    dest = np.array([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], np.float32)
    return cv2.warpPerspective(rgb, cv2.getPerspectiveTransform(quad.astype(np.float32), dest), (W, H),
                               flags=cv2.INTER_AREA, borderMode=cv2.BORDER_REPLICATE)


# ------------------------------------------------------------ measurements

def _rounded_mask(inset: float = 0.0) -> np.ndarray:
    m = np.zeros((H, W), np.uint8)
    r = int(round(CORNER_RADIUS))
    i = int(round(inset))
    cv2.rectangle(m, (i + r, i), (W - 1 - i - r, H - 1 - i), 255, -1)
    cv2.rectangle(m, (i, i + r), (W - 1 - i, H - 1 - i - r), 255, -1)
    for cx, cy in ((i + r, i + r), (W - 1 - i - r, i + r), (W - 1 - i - r, H - 1 - i - r), (i + r, H - 1 - i - r)):
        cv2.circle(m, (cx, cy), r, 255, -1)
    return m > 0


def _rounded_mask_for(shape: tuple) -> np.ndarray:
    """Rounded-corner card mask for an arbitrary (h, w) image of one card."""
    h, w = shape[:2]
    m = np.zeros((h, w), np.uint8)
    r = int(round(0.048 * w))
    cv2.rectangle(m, (r, 0), (w - 1 - r, h - 1), 255, -1)
    cv2.rectangle(m, (0, r), (w - 1, h - 1 - r), 255, -1)
    for cx, cy in ((r, r), (w - 1 - r, r), (w - 1 - r, h - 1 - r), (r, h - 1 - r)):
        cv2.circle(m, (cx, cy), r, 255, -1)
    return m > 0


def _glare(card: np.ndarray) -> np.ndarray:
    return (card.min(axis=2) >= 246)


def _side_strip(lab: np.ndarray, side: str, start: int, stop: int) -> np.ndarray:
    """Band of pixels `start`..`stop` px inward from one side, as (along, depth, 3)."""
    cut = int(CORNER_RADIUS * 1.6)
    if side == "left":
        return lab[cut:H - cut, start:stop].copy()
    if side == "right":
        return lab[cut:H - cut, W - stop:W - start][:, ::-1].copy()
    if side == "top":
        return lab[start:stop, cut:W - cut].transpose(1, 0, 2).copy()
    return lab[H - stop:H - start, cut:W - cut][::-1].transpose(1, 0, 2).copy()


WHITE = np.array([255.0, 128.0, 128.0], np.float32)     # white in OpenCV 8-bit Lab


def _whiteness_gain(px: np.ndarray, ref) -> np.ndarray:
    """How much closer to white `px` is than `ref` (Lab). Covers every border:
    yellow and blue lose colour, silver and black get lighter."""
    ref = np.asarray(ref, np.float32)
    d_ref = np.linalg.norm(ref - WHITE, axis=-1)
    d_px = np.linalg.norm(px - WHITE, axis=-1)
    return d_ref - d_px


def _whitening(px: np.ndarray, border: np.ndarray) -> np.ndarray:
    """Pixels clearly whiter than this side's border colour, and near-white themselves."""
    return (_whiteness_gain(px, border) > 28) & (np.linalg.norm(px - WHITE, axis=-1) < 70)


def measure(card: np.ndarray, back: bool = False) -> dict:
    lab = cv2.cvtColor(card, cv2.COLOR_RGB2LAB).astype(np.float32)
    glare = _glare(card)
    inside = _rounded_mask()
    out: dict = {}

    # Border colour per side: median of the band 1%..2% in (modern borders are ~3%).
    borders = {}
    for side in ("top", "right", "bottom", "left"):
        band = _side_strip(lab, side, int(0.01 * W), int(0.02 * W)).reshape(-1, 3)
        borders[side] = np.median(band, axis=0)

    back = back or _looks_like_back(lab, borders)

    # Centering: per scan line, first depth where colour leaves the border colour.
    depth = {}
    for side in ("top", "right", "bottom", "left"):
        strip = _side_strip(lab, side, 0, int(0.16 * W))           # (along, depth, 3)
        ref = borders[side]
        far = np.linalg.norm(strip - ref, axis=2) > (18 if not back else 14)
        # Require 3 consecutive "far" pixels so print noise does not stop the scan.
        run = far[:, :-2] & far[:, 1:-1] & far[:, 2:]
        lo = int(0.02 * W)
        run[:, :lo] = False
        hit = run.argmax(axis=1).astype(np.float32)
        hit[~run.any(axis=1)] = np.nan
        depth[side] = float(np.nanmedian(hit)) if np.isfinite(hit).sum() > 0.3 * len(hit) else float("nan")
    lr = [depth["left"], depth["right"]]
    tb = [depth["top"], depth["bottom"]]

    def share(pair):
        if not all(math.isfinite(v) for v in pair) or sum(pair) <= 0:
            return None
        a = 100 * pair[0] / sum(pair)
        return [round(a, 1), round(100 - a, 1)]

    lrs, tbs = share(lr), share(tb)
    worst = max([max(s) for s in (lrs, tbs) if s] or [50.0])
    out["centering"] = {"left_right": lrs, "top_bottom": tbs, "worst": round(worst, 1),
                        "border_px": {k: (round(v, 1) if math.isfinite(v) else None) for k, v in depth.items()}}

    # Edges: fraction of positions along each side whose outer band is whitened.
    # Whitening is local: compare each position with that side's median at the
    # same depth, so smooth printed gradients (SV silver, holo borders) cancel.
    # Coloured borders are also compared with the deeper border colour, which
    # catches a side that is whitened along its whole length.
    edges = {}
    band_lo, band_hi = 1, int(0.014 * W) + 1     # wear lives in the outermost ~1.4%
    glare3 = np.repeat(glare[..., None], 3, axis=2).astype(np.float32)
    for side in ("top", "right", "bottom", "left"):
        strip = _side_strip(lab, side, band_lo, band_hi)             # (along, depth, 3)
        gl = _side_strip(glare3, side, band_lo, band_hi)[..., 0] > 0
        profile = np.median(strip, axis=0)                           # (depth, 3)
        L = strip[..., 0]
        chroma = np.hypot(strip[..., 1] - 128, strip[..., 2] - 128)
        p_chroma = np.hypot(profile[:, 1] - 128, profile[:, 2] - 128)
        local = _whitening(strip, profile[None, :, :])
        if back:
            # Card backs share one saturated blue border: wear is where it turns
            # lighter and loses its blue (b* rises towards neutral 128).
            ref = borders[side]
            local |= _whiteness_gain(strip, ref) > 22
        white = local & ~gl
        # Printed white (copyright line, V-card swooshes) continues deeper into the
        # border; wear starts at the very edge and fades inward.
        deep = _side_strip(lab, side, band_hi, 2 * band_hi)
        deep_white = (_whiteness_gain(deep, np.median(deep, axis=0)[None, :, :]) > 28).mean(axis=1) > 0.3
        # Whole-length whitening cancels in the side median, so also compare each
        # position's outermost pixels with the same position a little further in.
        inner = _side_strip(lab, side, band_lo + 6, band_lo + 10).mean(axis=1)
        edge_gain = _whiteness_gain(strip[:, :3].mean(axis=1), inner) > 28
        hit = (((white.sum(axis=1) >= 2) & white[:, :3].any(axis=1)) | edge_gain) & ~deep_white
        valid = ~(gl.mean(axis=1) > 0.5)
        edges[side] = round(float(hit[valid].mean()) if valid.any() else 0.0, 3)
    out["edges"] = edges

    # Corners: ring just inside the rounded outline, within the corner square.
    corners = {}
    ring = inside & ~_rounded_mask(inset=0.025 * W)
    sq = int(CORNER_RADIUS * 1.8)
    boxes = {"tl": (slice(0, sq), slice(0, sq), ("top", "left")),
             "tr": (slice(0, sq), slice(W - sq, W), ("top", "right")),
             "br": (slice(H - sq, H), slice(W - sq, W), ("bottom", "right")),
             "bl": (slice(H - sq, H), slice(0, sq), ("bottom", "left"))}
    for name, (ys, xs, near) in boxes.items():
        m = ring[ys, xs] & ~glare[ys, xs]
        px = lab[ys, xs][m]
        if len(px) < 20:
            corners[name] = 0.0
            continue
        border = np.median(np.stack([borders[near[0]], borders[near[1]]]), axis=0)
        white = _whitening(px, border)
        corners[name] = round(float(white.mean()), 3)
    out["corners"] = corners

    out["surface"] = _surface(card, glare)
    out["glare"] = round(float(glare[inside].mean()), 4)
    out["is_back"] = bool(back)
    return out


def _looks_like_back(lab: np.ndarray, borders: dict) -> bool:
    """Pokemon backs have a saturated blue border all round."""
    blue = 0
    for b in borders.values():
        L, A, B = b
        if B < 112 and A < 140 and L > 40:       # Lab b* well into blue
            blue += 1
    return blue >= 3


def _surface(card: np.ndarray, glare: np.ndarray) -> dict:
    gray = cv2.cvtColor(card, cv2.COLOR_RGB2GRAY)
    lsd = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD)
    segs = lsd.detect(gray)[0]
    ridges: list[tuple] = []
    if segs is None:
        return {"creases": [], "scratch_density": 0.0, "candidates": 0}
    segs = segs.reshape(-1, 4)
    margin = 0.04 * W
    length = np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1])
    ang = np.degrees(np.arctan2(segs[:, 3] - segs[:, 1], segs[:, 2] - segs[:, 0])) % 180
    axis_dist = np.minimum(np.abs(((ang + 90) % 180) - 90), np.abs(ang - 90))
    # Texture families: many segments sharing one non-axis angle (holo etching, sparkles).
    bins = np.round(ang / 3).astype(int) % 60
    # Foil etching is many PARALLEL lines; a broken crease is many pieces of ONE
    # line, so count distinct perpendicular offsets per angle bin.
    th = np.radians(bins * 3.0)
    offset = np.round(((segs[:, 0] + segs[:, 2]) / 2 * -np.sin(th) + (segs[:, 1] + segs[:, 3]) / 2 * np.cos(th)) / 8)
    families = {}
    for b_, o_, L_ in zip(bins, offset, length):
        if L_ > 0.03 * W:
            families.setdefault(int(b_), set()).add(int(o_))
    texture = np.array([len(families.get(int(b_), ())) >= 10 for b_ in bins])
    blur = cv2.GaussianBlur(gray.astype(np.float32), (3, 3), 0)
    for (x1, y1, x2, y2), L, ad, tex in zip(segs, length, axis_dist, texture):
        if ad < 6 or tex or L < 0.025 * W:
            continue                              # printed frame / text line, or foil texture
        if min(x1, x2) < margin or max(x1, x2) > W - margin or min(y1, y2) < margin or max(y1, y2) > H - margin:
            continue
        # Ridge test: centre line differs from both flanks, flanks agree with each other.
        d = np.array([x2 - x1, y2 - y1], np.float32) / max(L, 1e-6)
        n = np.array([-d[1], d[0]], np.float32)
        t = np.linspace(0.1, 0.9, 24)[:, None]
        pts = np.array([x1, y1], np.float32) + (np.array([x2, y2], np.float32) - np.array([x1, y1], np.float32)) * t

        def sample(offset):
            p = pts + n * offset
            return blur[np.clip(p[:, 1].astype(int), 0, H - 1), np.clip(p[:, 0].astype(int), 0, W - 1)]

        c = sample(0)
        a = (sample(4) + sample(5)) / 2
        b = (sample(-4) + sample(-5)) / 2
        ridge = np.minimum(np.abs(c - a), np.abs(c - b))
        step = np.abs(a - b)
        is_ridge = (np.sign(c - a) == np.sign(c - b)) & (ridge > 9) & (ridge > 1.2 * step)
        p = pts.astype(int)
        if glare[np.clip(p[:, 1], 0, H - 1), np.clip(p[:, 0], 0, W - 1)].mean() > 0.3:
            continue
        if is_ridge.mean() < 0.6:
            continue
        ridges.append((float(x1), float(y1), float(x2), float(y2)))
    chains = _chain(ridges, gap=0.06 * W)
    creases = [c for c in chains if c["length"] >= 0.12 * W]
    scratches = sum(c["parts"] for c in chains if c["length"] < 0.12 * W)
    return {"creases": [{k: c[k] for k in ("x1", "y1", "x2", "y2", "length")} for c in creases],
            "scratch_density": round(min(1.0, scratches / 40), 3)}


def _chain(segs: list[tuple], gap: float) -> list[dict]:
    """Join collinear ridge segments: a crease is often broken by print or wear."""
    groups = [[s] for s in segs]
    merged = True
    while merged:
        merged = False
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                if _collinear(_span(groups[i]), _span(groups[j]), gap):
                    groups[i] += groups.pop(j)
                    merged = True
                    break
            if merged:
                break
    out = []
    for g in groups:
        x1, y1, x2, y2 = _span(g)
        out.append({"x1": round(x1), "y1": round(y1), "x2": round(x2), "y2": round(y2),
                    "length": round(math.hypot(x2 - x1, y2 - y1)), "parts": len(g)})
    return out


def _span(group: list[tuple]) -> tuple:
    pts = np.array([[s[0], s[1]] for s in group] + [[s[2], s[3]] for s in group], float)
    centre = pts.mean(axis=0)
    _, _, vt = np.linalg.svd(pts - centre)
    d = vt[0]
    t = (pts - centre) @ d
    a, b = centre + d * t.min(), centre + d * t.max()
    return float(a[0]), float(a[1]), float(b[0]), float(b[1])


def _collinear(s1: tuple, s2: tuple, gap: float) -> bool:
    a1, b1 = np.array(s1[:2]), np.array(s1[2:])
    a2, b2 = np.array(s2[:2]), np.array(s2[2:])
    d1 = (b1 - a1) / max(1e-6, np.linalg.norm(b1 - a1))
    d2 = (b2 - a2) / max(1e-6, np.linalg.norm(b2 - a2))
    if abs(float(np.dot(d1, d2))) < math.cos(math.radians(6)):
        return False
    n = np.array([-d1[1], d1[0]])
    if abs(float(np.dot(a2 - a1, n))) > 5 or abs(float(np.dot(b2 - a1, n))) > 5:
        return False
    t = sorted([0.0, float(np.dot(b1 - a1, d1))])
    u = sorted([float(np.dot(a2 - a1, d1)), float(np.dot(b2 - a1, d1))])
    return max(t[0], u[0]) - min(t[1], u[1]) <= gap


# ----------------------------------------------------------------- scoring

def _penalties(m: dict) -> dict:
    e = np.array(list(m["edges"].values()))
    c = np.array(list(m["corners"].values()))
    ex = np.clip(e - 0.06, 0, None)
    cx = np.clip(c - 0.10, 0, None)
    edges = float(min(45.0, 80 * ex.mean() + 50 * ex.max()))
    corners = float(min(25.0, 25 * cx.mean() + 20 * cx.max()))
    s = m["surface"]
    surface = float(min(40.0, 22 * len(s["creases"]) + 12 * s["scratch_density"]))
    worst = m["centering"]["worst"]
    centering = float(min(20.0, max(0.0, worst - 60) * 0.8))
    return {"edges": round(edges, 1), "corners": round(corners, 1), "surface": round(surface, 1),
            "centering": round(centering, 1)}


def _grade(score: float) -> str:
    for cut, name in GRADES:
        if score >= cut:
            return name
    return "PO"


def _reasons(m: dict, label: str) -> list[str]:
    out = []
    for side, f in m["edges"].items():
        if f >= 0.15:
            out.append(f"Whitening on the {side} edge{label} ({round(100 * f)}% of its length)")
    names = {"tl": "top-left", "tr": "top-right", "br": "bottom-right", "bl": "bottom-left"}
    worn = [names[k] for k, v in m["corners"].items() if v >= 0.2]
    if worn:
        out.append(f"Corner wear{label}: {', '.join(worn)}")
    if m["surface"]["creases"]:
        out.append(f"Possible crease{label} ({len(m['surface']['creases'])} line(s))")
    if m["surface"]["scratch_density"] >= 0.25:
        out.append(f"Surface scratches{label}")
    return out


def _side(rgb: np.ndarray, quad=None, box=None) -> tuple[dict, dict]:
    h, w = rgb.shape[:2]
    if quad is not None:
        q, detector, info = _ordered(quad), "given", {}
    else:
        q, detector, info = locate(rgb, box)
    s = _sides(q)
    card = warp(rgb, q)
    m = measure(card)
    m["card"] = {"quad": [[round(float(x), 1), round(float(y), 1)] for x, y in q], "detector": detector,
                 "warped_size": [W, H], "support": info.get("support")}
    m["_short_side"] = float(min((s[0] + s[2]) / 2, (s[1] + s[3]) / 2))
    m["_no_outline"] = bool(info.get("no_outline"))
    return m, info


CREASE_HINTS = (None, "confirmed", "none")


def assess(rgb: np.ndarray, quad=None, back_rgb: np.ndarray | None = None, back_quad=None,
           box=None, back_box=None, crease: str | None = None) -> dict:
    """Grade one card. `box`/`back_box`: optional YOLO [x1,y1,x2,y2] hints.

    `crease` is what the person holding the card says: "confirmed" means a crease
    breaks the surface, which Cardmarket grades Poor (the card is recognisable
    even sleeved, so it is not tournament legal); "none" overrides a false
    detection. Photo detection alone only caps the grade at MP and asks for
    confirmation: on real listings it is not reliable enough to call Poor."""
    if crease not in CREASE_HINTS:
        raise ValueError("crease must be 'confirmed', 'none' or omitted")
    front, _ = _side(rgb, quad, box)
    back = None
    if back_rgb is not None:
        back, _ = _side(back_rgb, back_quad, back_box)
    elif front["is_back"]:
        # Caller sent only a back: grade it as the back.
        front, back = None, front
    sides = [x for x in (front, back) if x is not None]
    pens = [_penalties(x) for x in sides]
    flags = []
    if front is None:
        flags.append("front_not_seen")
    if back is None:
        flags.append("back_not_seen")
    # Centering from the front (back centering is not what sellers grade on).
    cen = pens[0]["centering"] if front is not None else 0.0
    wear = [p["edges"] + p["corners"] + p["surface"] for p in pens]
    total_wear = max(wear) + 0.35 * min(wear) if len(wear) == 2 else wear[0]
    score = max(0.0, 100.0 - cen - total_wear)
    grade = _grade(score)
    detected = any(x["surface"]["creases"] for x in sides)
    if crease == "confirmed":
        grade = "PO"
        score = min(score, 39.9)
        flags.append("crease_confirmed")
    elif detected and crease != "none":
        if GRADE_ORDER.index(grade) < GRADE_ORDER.index("MP"):
            grade = "MP"
        flags.append("crease_suspected")
    confidence = 0.85
    for x in sides:
        if x["glare"] > 0.02:
            flags.append("sleeve_glare")
            confidence -= 0.15
        if x["_short_side"] < 350:
            flags.append("low_resolution")
            confidence -= 0.2
        if x["_no_outline"] or x["card"]["detector"] == "full-frame" and x["card"]["support"] is None and x["_no_outline"]:
            flags.append("no_card_outline")
            confidence -= 0.3
    if back is None:
        confidence -= 0.15
    reasons = []
    if front is not None:
        reasons += _reasons(front, "")
        c = front["centering"]
        if c["worst"] >= 62:
            reasons.append(f"Off-centre front ({c['worst']:.0f}/{100 - c['worst']:.0f})")
    if back is not None:
        reasons += _reasons(back, " (back)")
    if crease == "none":
        reasons = [r for r in reasons if not r.startswith("Possible crease")]
    if crease == "confirmed":
        reasons.insert(0, "Crease breaks the surface: recognisable even sleeved, so Poor on Cardmarket")
    elif "crease_suspected" in flags:
        reasons.append("Check the possible crease in hand: if it breaks the surface the card is Poor")
    if not reasons:
        reasons.append("No visible wear on the photographed side(s)")

    def public(x):
        return {"card": x["card"], "edges": x["edges"], "corners": x["corners"], "surface": x["surface"],
                "centering": x["centering"], "glare": x["glare"]}

    base = front if front is not None else back
    p0 = pens[sides.index(base)]
    result = {
        "grade": grade, "score": round(score, 1), "confidence": round(max(0.05, confidence), 2),
        "card": base["card"],
        "centering": {**base["centering"], "penalty": p0["centering"]},
        "edges": {**base["edges"], "penalty": p0["edges"]},
        "corners": {**base["corners"], "penalty": p0["corners"]},
        "surface": {**base["surface"], "penalty": p0["surface"]},
        "flags": sorted(set(flags)), "reasons": reasons,
    }
    if back is not None and front is not None:
        pb = pens[1]
        result["back"] = {**public(back), "penalties": pb}
    elif back is not None:
        result["back"] = {**public(back), "penalties": pens[0]}
    return result


def assess_bytes(blob: bytes, back: bytes | None = None, detect=None, crease: str | None = None) -> dict:
    """`detect(rgb) -> [{"xyxy": [...], "conf": f}]` is the worker's YOLO detector when loaded."""
    front = decode(blob)
    back_rgb = decode(back) if back else None

    def best_box(rgb):
        if detect is None:
            return None
        try:
            boxes = detect(rgb)
        except Exception:
            return None
        boxes = [b for b in boxes if b.get("conf", 0) >= 0.5]
        if not boxes:
            return None
        h, w = rgb.shape[:2]
        # The card being graded is the biggest confident box nearest the centre.
        def key(b):
            x1, y1, x2, y2 = b["xyxy"]
            cx, cy = (x1 + x2) / 2 / w - 0.5, (y1 + y2) / 2 / h - 0.5
            return (x2 - x1) * (y2 - y1) / (w * h) - 0.5 * math.hypot(cx, cy)
        return max(boxes, key=key)["xyxy"]

    return assess(front, back_rgb=back_rgb, box=best_box(front),
                  back_box=best_box(back_rgb) if back_rgb is not None else None, crease=crease)


def _cli_detector():
    """Use the worker's YOLO detector when its models are configured (CARDSCAN_MODELS)."""
    import os
    if not os.environ.get("CARDSCAN_MODELS"):
        return None
    try:
        import app
        app._load()
        return app._detect
    except Exception as exc:                      # models missing: geometry only
        print(f"condition: YOLO unavailable ({exc})", file=sys.stderr)
        return None


def _main(argv: list[str]) -> int:
    summary = "--summary" in argv
    argv = [a for a in argv if a != "--summary"]
    back = None
    crease = None
    if "--crease" in argv:
        i = argv.index("--crease")
        crease = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    if "--back" in argv:
        i = argv.index("--back")
        back = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    for path in argv:
        t = time.perf_counter()
        with open(path, "rb") as fh:
            blob = fh.read()
        back_blob = open(back, "rb").read() if back else None
        r = assess_bytes(blob, back_blob, _cli_detector(), crease)
        r["ms"] = round(1000 * (time.perf_counter() - t))
        if summary:
            print(path, r["grade"], r["score"], r["card"]["detector"], ",".join(r["flags"]), "|", "; ".join(r["reasons"]))
        else:
            print(json.dumps(r))
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
