#!/usr/bin/env python3
import unittest

from importlib.machinery import SourceFileLoader
from pathlib import Path

ingest = SourceFileLoader(
    "ingest_missing_product_images",
    str(Path(__file__).with_name("ingest-missing-product-images.py")),
).load_module()


class LeftoverSlugTests(unittest.TestCase):
    def test_latios_filename_hits_cardtrader_full_slug_jpeg(self):
        row = {
            "ct_id": "373219",
            "name": "Latios",
            "image_url": "373219_latios-csm2d-120-342-csm2d-shining-synergy-gx-starter-deck.jpg",
        }
        key = ingest.leftover_key(row["ct_id"], row["name"], row["image_url"])
        self.assertEqual(
            key,
            "373219_latios-csm2d-120-342-csm2d-shining-synergy-gx-starter-deck.jpg",
        )
        urls = ingest.candidate_urls(row)
        self.assertEqual(
            urls[0],
            "https://www.cardtrader.com/uploads/blueprints/image/373219/373219-latios-csm2d-120-342-csm2d-shining-synergy-gx-starter-deck.jpg",
        )

    def test_chaos_rising_holo_uses_blueprint_png_not_leftover_slug(self):
        row = {
            "ct_id": "390009",
            "name": "Goodra",
            "image_url": "390009_goodra-068-086-chaos-rising.jpg",
            "full_url": "/uploads/blueprints/image/390009/390009-goodra-holo-rare-068-086-chaos-rising.png",
            "show_url": "/uploads/blueprints/image/390009/show_390009-goodra-holo-rare-068-086-chaos-rising.png",
        }
        self.assertEqual(
            ingest.leftover_key(row["ct_id"], row["name"], row["image_url"]),
            "390009_goodra-068-086-chaos-rising.jpg",
        )
        urls = ingest.candidate_urls(row)
        self.assertEqual(
            urls[0],
            "https://cardtrader.com/uploads/blueprints/image/390009/390009-goodra-holo-rare-068-086-chaos-rising.png",
        )
        self.assertTrue(ingest.has_cardtrader_scan(row))
        self.assertFalse(
            ingest.has_cardtrader_scan(
                {
                    "full_url": "/uploads/blueprints/image/fallbacks/card_uploader/preview.png",
                }
            )
        )


class SmallScanTests(unittest.TestCase):
    def test_id_file_targets_leftover_or_public_id(self):
        ingest.IDS = [158374]
        sql = ingest.dump_sql()
        self.assertIn("c.ct_id IN (158374)", sql)
        self.assertIn("c.card_id IN (158374)", sql)
        ingest.IDS = []

    def test_magnemite_slug2_without_id_prefix(self):
        row = {
            "ct_id": "241905",
            "name": "Magnemite",
            "image_url": "241905_magnemite-063-198-scarlet-violet.jpg",
        }
        urls = ingest.candidate_urls(row)
        self.assertIn(
            "https://www.cardtrader.com/uploads/blueprints/image/241905/magnemite-063-198-scarlet-violet(2).jpg",
            urls,
        )

    def test_255px_catalog_thumb_is_not_a_kept_leftover(self):
        from PIL import Image

        dest = Path("/tmp/pokoin-255x361-test.jpg")
        Image.new("RGB", (255, 361), (20, 30, 40)).save(dest, "JPEG")
        self.assertTrue(ingest.is_placeholder(dest))
        self.assertFalse(ingest.write_jpeg(Path("/tmp/pokoin-255x361-out.jpg"), dest.read_bytes()))
        dest.unlink(missing_ok=True)


class VersionMatchArgvTests(unittest.TestCase):
    def test_expansion_beats_id_list(self):
        argv = ingest.version_match_argv("30th Celebration JP", [790994])
        self.assertEqual(argv[-2:], ["--expansion", "30th Celebration JP"])
        self.assertNotIn("--ids", argv)

    def test_ids_when_no_expansion(self):
        argv = ingest.version_match_argv("", [790994, 395497, 790994])
        self.assertEqual(argv[-2:], ["--ids", "395497,790994"])

    def test_empty_without_scope(self):
        self.assertEqual(ingest.version_match_argv("", []), [])


if __name__ == "__main__":
    unittest.main()
