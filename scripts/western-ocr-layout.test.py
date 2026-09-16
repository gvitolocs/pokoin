#!/usr/bin/env python3
"""Western leftover OCR chrome crop matches art-cut.js illustration window."""
from __future__ import annotations

import unittest
from PIL import Image

from importlib.machinery import SourceFileLoader
from pathlib import Path

MOD = SourceFileLoader(
    "western_full_ocr",
    str(Path(__file__).resolve().parent / "western-full-ocr.py"),
).load_module()


class WesternChromeCrop(unittest.TestCase):
    def test_art_fractions_match_js(self):
        self.assertEqual(MOD.ART_TOP, 0.125)
        self.assertEqual(MOD.ART_HEIGHT, 0.36)
        self.assertLessEqual(MOD.ART_TOP + MOD.ART_HEIGHT, 0.49)

    def test_regular_card_drops_the_art_window(self):
        im = Image.new("RGB", (330, 460), (20, 20, 20))
        canvas, mode = MOD.western_text_canvas(im, "Holo Rare | 004/102")
        self.assertEqual(mode, "chrome")
        self.assertEqual(canvas.width, 330)
        self.assertLess(canvas.height, 460)
        # Header ~0.155*460 + body from ~0.445*460
        self.assertGreater(canvas.height, 200)

    def test_illustration_rare_keeps_full_scan(self):
        im = Image.new("RGB", (330, 460), (20, 20, 20))
        canvas, mode = MOD.western_text_canvas(im, "Special Illustration Rare | 200/193")
        self.assertEqual(mode, "full")
        self.assertEqual(canvas.size, (330, 460))


if __name__ == "__main__":
    unittest.main()
