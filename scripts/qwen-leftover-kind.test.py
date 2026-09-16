#!/usr/bin/env python3
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

kind = SourceFileLoader(
    "qwen_leftover_kind",
    str(Path(__file__).with_name("qwen-leftover-kind.py")),
).load_module()

SQL = Path(__file__).with_name("sql") / "060_cardtrader_category_kind.sql"


class QwenKindParseTests(unittest.TestCase):
    def test_card_forces_product_type_card(self):
        parsed = kind.parse_kind('{"kind":"card","product_type":"accessory","why":"HP and retreat"}')
        self.assertEqual(parsed["kind"], "card")
        self.assertEqual(parsed["item_kind"], "single")
        self.assertEqual(parsed["product_type"], "card")

    def test_product_defaults_accessory(self):
        parsed = kind.parse_kind('{"kind":"product","why":"plastic frame"}')
        self.assertEqual(parsed["kind"], "product")
        self.assertEqual(parsed["item_kind"], "product")
        self.assertEqual(parsed["product_type"], "accessory")

    def test_sealed_product_type(self):
        parsed = kind.parse_kind(
            'noise {"kind":"product","product_type":"sealed_product","why":"booster box"} trailing'
        )
        self.assertEqual(parsed["product_type"], "sealed_product")


class CategorySqlTests(unittest.TestCase):
    def test_sql_maps_memorabilia_and_storage_off_singles(self):
        sql = SQL.read_text()
        self.assertIn("when 73 then 'card'", sql)
        self.assertIn("when 61 then 'accessory'", sql)
        self.assertIn("when 60 then 'collection_box'", sql)
        self.assertIn("when 118 then 'accessory'", sql)
        self.assertIn("resolved_marketplace_product_type", sql)
        self.assertIn("b.category_id", sql)
        self.assertIn("marketplace_visual_kind", sql)
        self.assertIn("qwen3-vl:32b-instruct", sql)
        self.assertNotIn("<> 'card'", sql)


class JpegRatioTests(unittest.TestCase):
    def test_card_ratio_bounds(self):
        self.assertLess(63 / 88, kind.CARD_RATIO[1])
        self.assertGreater(63 / 88, kind.CARD_RATIO[0])


if __name__ == "__main__":
    unittest.main()
