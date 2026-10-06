"""Acceptance tests for the condition grader (server/scan/worker/condition.py).

Run: ~/Projects/BattleScan/.venv/bin/python server/scan/tests/condition_test.py -v
With CARDSCAN_MODELS set the worker's YOLO box is used, as in production.
"""
import glob
import importlib.util
import json
import math
import os
import sys
import time
import unittest
from pathlib import Path

import cv2
import numpy as np

WORKER = Path(__file__).resolve().parents[1] / "worker"
sys.path.insert(0, str(WORKER))
import condition as C  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "condition"
DIALGA = FIXTURES / "dialga-it-sleeved-worn.png"
OBJECTS = Path("/home/nez/data/pokoin-leftovers/objects")
CLEAN = ["100247_caterpie-001-264-fusion-strike.jpg", "200510_trevenant-017-264-fusion-strike.jpg",
         "212448_flapple-holo-rare-tg02-tg30-astral-radiance.jpg", "224956_decidueye-003-190-shiny-star-v.jpg",
         "225723_dragonite-v-154-swsh-black-star-promos.jpg", "276734_fuecoco-shiny-promo-079-sv-black-star-promos.jpg"]
VINTED = [Path("/home/nez/Projects/BattleScan/images/vinted"), Path("/home/nez/Projects/BattleScan/images/vinted_mew_expedition")]
ORDER = ["NM", "SP", "MP", "PL", "PO"]


def load_app():
    spec = importlib.util.spec_from_file_location("scan_worker_app", WORKER / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


APP = load_app()
if os.environ.get("CARDSCAN_MODELS"):
    try:
        APP._load()
    except Exception as exc:  # models missing: geometry-only grading
        print("YOLO unavailable:", exc, file=sys.stderr)


def grade(rgb, back=None):
    enc = lambda x: cv2.imencode(".png", cv2.cvtColor(x, cv2.COLOR_RGB2BGR))[1].tobytes()
    return C.assess_bytes(enc(rgb), enc(back) if back is not None else None, APP._condition_detect)


def read(path):
    return C.decode(Path(path).read_bytes())


def worse(a, b):
    return ORDER.index(a) > ORDER.index(b)


def composite(card, size=1400, angle=7.0, seed=0):
    """Card on a dark textured table, rotated, with mild perspective."""
    rng = np.random.default_rng(seed)
    table = (rng.normal(38, 9, (size, size, 3)) + np.linspace(0, 18, size)[None, :, None]).clip(0, 255).astype(np.uint8)
    table = cv2.GaussianBlur(table, (0, 0), 1.2)
    h, w = card.shape[:2]
    s = 0.55 * size / h
    cw, ch = w * s, h * s
    c = np.array([size / 2, size / 2])
    pts = np.array([[-cw / 2, -ch / 2], [cw / 2, -ch / 2], [cw / 2, ch / 2], [-cw / 2, ch / 2]])
    a = math.radians(angle)
    rot = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    dst = pts @ rot.T + c
    dst[0] += [8, 5]
    dst[1] += [-6, 9]                                   # mild perspective
    m = cv2.getPerspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]), np.float32(dst))
    warped = cv2.warpPerspective(card, m, (size, size))
    mask = cv2.warpPerspective(C._rounded_mask_for(card.shape[:2]).astype(np.uint8) * 255, m, (size, size)) > 127
    out = table.copy()
    out[mask] = warped[mask]
    return out


def wear(card):
    out = card.copy()
    h, w = out.shape[:2]
    out[:, :4] = (240, 240, 240)                        # left edge band inside the card
    r = 10
    for ys, xs in ((slice(0, r), slice(0, r * 3)), (slice(0, r * 3), slice(0, r)),
                   (slice(0, r), slice(w - 3 * r, w)), (slice(0, 3 * r), slice(w - r, w)),
                   (slice(h - r, h), slice(0, 3 * r)), (slice(h - 3 * r, h), slice(0, r)),
                   (slice(h - r, h), slice(w - 3 * r, w)), (slice(h - 3 * r, h), slice(w - r, w))):
        out[ys, xs] = (240, 240, 240)
    return out


def crease(card):
    out = card.copy().astype(np.float32)
    h, w = out.shape[:2]
    layer = out.copy()
    cv2.line(layer, (int(0.15 * w), int(0.20 * h)), (int(0.80 * w), int(0.45 * h)), (235, 235, 235), 2, cv2.LINE_AA)
    return cv2.addWeighted(out, 0.2, layer, 0.8, 0).clip(0, 255).astype(np.uint8)


def off_centre(card):
    """Crop the right border and pad the left with that side's border colour (~2.3x)."""
    h, w = card.shape[:2]
    bw = int(0.035 * w)
    cut = int(bw * 0.45)
    colour = np.median(card[h // 3: 2 * h // 3, 2:bw - 2].reshape(-1, 3), axis=0).astype(np.uint8)
    body = card[:, :w - cut]
    pad = np.tile(colour, (h, cut, 1))
    return cv2.resize(np.hstack([pad, body]), (w, h), interpolation=cv2.INTER_AREA)


def clean_cards():
    if not OBJECTS.is_dir():
        raise unittest.SkipTest("leftover scans not available")
    return [(name, read(OBJECTS / name)) for name in CLEAN if (OBJECTS / name).exists()]


class ConditionTest(unittest.TestCase):
    def test_a_dialga_worn(self):
        r = grade(read(DIALGA))
        print("\nDialga:", json.dumps({k: r[k] for k in ("grade", "score", "flags", "reasons")}))
        self.assertIn(r["grade"], {"MP", "PL"})
        self.assertIn("sleeve_glare", r["flags"])
        self.assertIn("back_not_seen", r["flags"])
        self.assertGreater(r["edges"]["left"], r["edges"]["right"])

    def test_b_clean_scans_nm(self):
        for name, card in clean_cards():
            with self.subTest(name=name):
                r = grade(card)
                self.assertIn(r["grade"], {"NM", "SP"}, (name, r["score"], r["reasons"]))
                self.assertEqual(r["surface"]["creases"], [], name)

    def test_c_composited_on_table(self):
        for name, card in clean_cards():
            with self.subTest(name=name):
                r = grade(composite(card))
                self.assertNotEqual(r["card"]["detector"], "full-frame", name)
                self.assertIn(r["grade"], {"NM", "SP"}, (name, r["score"], r["reasons"]))

    def test_d_synthetic_wear(self):
        for name, card in clean_cards():
            with self.subTest(name=name):
                a, b = grade(card), grade(wear(card))
                self.assertGreaterEqual(a["score"] - b["score"], 12, (name, a["score"], b["score"], b["reasons"]))
                self.assertTrue(worse(b["grade"], a["grade"]), (name, a["grade"], b["grade"]))

    def test_e_synthetic_crease(self):
        for name, card in clean_cards():
            with self.subTest(name=name):
                r = grade(crease(card))
                self.assertTrue(r["surface"]["creases"], (name, r["reasons"]))
                self.assertFalse(worse("MP", r["grade"]), (name, r["grade"]))

    def test_f_off_centre(self):
        for name, card in clean_cards():
            with self.subTest(name=name):
                r = grade(off_centre(card))
                self.assertGreaterEqual(r["centering"]["worst"], 65, (name, r["centering"]))

    def test_g_speed(self):
        card = clean_cards()[0][1]
        img = composite(card, size=1600)
        times = []
        for _ in range(3):
            t = time.perf_counter()
            grade(img)
            times.append(time.perf_counter() - t)
        self.assertLess(sorted(times)[1], 0.4, times)

    def test_h_endpoint_helper(self):
        r = APP._condition_image(DIALGA.read_bytes())
        self.assertIn(r["grade"], ORDER)
        self.assertIn("ms", r)
        json.dumps(r)
        with self.assertRaises(Exception) as ctx:
            APP._condition_image(b"")
        self.assertEqual(getattr(ctx.exception, "status_code", None), 400)

    def test_i_vinted_real_photos(self):
        files = [f for d in VINTED for f in sorted(glob.glob(str(d / "*.jpg")))]
        if not files:
            raise unittest.SkipTest("Vinted photos not available")
        detectors, times = [], []
        for f in files:
            t = time.perf_counter()
            r = C.assess_bytes(Path(f).read_bytes(), None, APP._condition_detect)
            times.append(time.perf_counter() - t)
            json.dumps(r)
            self.assertIn(r["grade"], ORDER)
            detectors.append(r["card"]["detector"])
        found = sum(d not in ("full-frame",) for d in detectors) / len(detectors)
        self.assertGreaterEqual(found, 0.6, detectors)
        self.assertLess(float(np.median(times)), 0.4)

    def test_j_back_photo_counts(self):
        # A back with a whitened edge must make the grade worse than front-only.
        card = clean_cards()[0][1]
        back = np.zeros_like(card)
        back[:] = (40, 90, 190)                         # Pokemon-back blue border
        h, w = back.shape[:2]
        back[int(0.06 * h):int(0.94 * h), int(0.06 * w):int(0.94 * w)] = (60, 110, 200)
        clean = grade(card, back)
        worn_back = back.copy()
        worn_back[:, w - 5:] = (225, 230, 240)
        worn = grade(card, worn_back)
        self.assertNotIn("back_not_seen", clean["flags"])
        self.assertIn("back", worn)
        self.assertLess(worn["score"], clean["score"] - 8, (clean["score"], worn["score"], worn["reasons"]))


if __name__ == "__main__":
    unittest.main()
