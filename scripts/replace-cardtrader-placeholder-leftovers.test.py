#!/usr/bin/env python3
import io
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

from PIL import Image

mod = SourceFileLoader(
    "replace_ct_placeholder",
    str(Path(__file__).with_name("replace-cardtrader-placeholder-leftovers.py")),
).load_module()


def ct_back_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (186, 260), (180, 180, 180)).save(buf, "JPEG", quality=40)
    raw = buf.getvalue()
    if len(raw) > mod.CT_BYTES:
        buf = io.BytesIO()
        Image.new("RGB", (186, 260), (180, 180, 180)).save(buf, "JPEG", quality=10)
        raw = buf.getvalue()
    if len(raw) < mod.CT_BYTES:
        raw = raw + b"\0" * (mod.CT_BYTES - len(raw))
    return raw[: mod.CT_BYTES]


class ReplaceCardTraderBackTests(unittest.TestCase):
    def test_only_186x260_7920_byte_jpeg_counts(self):
        folder = Path(tempfile.mkdtemp())
        back = folder / "286874_fighting-energy.jpg"
        back.write_bytes(ct_back_bytes())
        self.assertEqual(back.stat().st_size, 7920)
        self.assertTrue(mod.is_cardtrader_back(back))
        other = folder / "141029_electabuzz.jpg"
        Image.new("RGB", (180, 255), (20, 30, 40)).save(other, "JPEG")
        self.assertFalse(mod.is_cardtrader_back(other))

    def test_pokoin_card_is_63_88_not_cardtrader(self):
        card = mod.pokoin_card()
        self.assertEqual(card.size, (630, 880))
        self.assertNotEqual(card.size, (186, 260))

    def test_stamped_leftover_is_not_cardtrader_size(self):
        folder = Path(tempfile.mkdtemp())
        dest = folder / "286874_fighting-energy.jpg"
        mod.write_leftover(dest, mod.pokoin_card())
        with Image.open(dest) as image:
            self.assertEqual(image.size, (630, 880))
        self.assertFalse(mod.is_cardtrader_back(dest))
        webp = dest.with_name(dest.stem + "_homepage.webp")
        self.assertTrue(webp.is_file())
        with Image.open(webp) as tile:
            self.assertEqual(tile.size[0], 240)


if __name__ == "__main__":
    unittest.main()
