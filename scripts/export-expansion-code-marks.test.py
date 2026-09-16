#!/usr/bin/env python3
import importlib.util
import unittest
from io import BytesIO
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "export_expansion_code_marks",
    ROOT / "scripts" / "export-expansion-code-marks.py",
)
marks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(marks)


class ExpansionCodeMarksTest(unittest.TestCase):
    def test_codes_match_spa_abbrev_and_watchtower(self):
        codes = marks.load_set_codes(ROOT / "market" / "src" / "set-logos.js")
        self.assertEqual(marks.expansion_code("Scarlet & Violet", codes), "SV1")
        self.assertEqual(
            marks.expansion_code("ex Starter Set: Quaxly & Mimikyu ex", codes),
            "QM",
        )
        self.assertEqual(
            marks.expansion_code("Southeast Asia Gym Promos", codes),
            "SAGP",
        )
        self.assertEqual(marks.expansion_code("CSV1: Eternal Birth", codes), "CEB")
        self.assertEqual(
            marks.expansion_code("McDonald's Match Battle 2022", codes),
            "MMB2",
        )
        self.assertEqual(marks.set_slug("Scarlet & Violet"), "scarlet-and-violet")

    def test_plate_is_dark_not_white(self):
        png = marks.render_mark("QM")
        img = Image.open(BytesIO(png)).convert("RGBA")
        self.assertEqual(img.size, (160, 92))
        plate = img.getpixel((14, 46))
        corner = img.getpixel((0, 0))
        self.assertLess(plate[0], 80)
        self.assertGreater(plate[3], 200)
        self.assertEqual(corner[3], 0)


if __name__ == "__main__":
    unittest.main()
