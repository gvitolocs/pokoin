#!/usr/bin/env python3
"""python3 scripts/match-refreshed-pokemon-artwork.test.py"""
import importlib.util
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("match_refreshed", HERE / "match-refreshed-pokemon-artwork.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class LateScanTest(unittest.TestCase):
    def test_id_list_reads_the_psql_value_line(self):
        self.assertEqual(mod.id_list("SET\n414196,412545\n"), [414196, 412545])
        self.assertEqual(mod.id_list("\n"), [])

    def test_only_leftover_jpegs_count_as_scans(self):
        names = [
            "414196_espeon-ex.jpg",
            "414196_espeon-ex_homepage.webp",
            "412545_espeon-ex_homepage.webp",
            "notes.txt",
            "abc_x.jpg",
        ]
        self.assertEqual(mod.scanned_ct_ids(names), {414196})

    def test_late_singletons_need_a_scan_on_disk(self):
        with tempfile.TemporaryDirectory() as tmp:
            objects = pathlib.Path(tmp)
            (objects / "414196_promo-espeon-ex-028-30th-celebration-simplified-chinese.jpg").write_bytes(b"x")
            (objects / "412545_espeon-ex_homepage.webp").write_bytes(b"x")
            self.assertEqual(mod.late_scan_ids([412545, 414196], objects), [414196])
            self.assertEqual(mod.late_scan_ids([], objects), [])


if __name__ == "__main__":
    unittest.main()
