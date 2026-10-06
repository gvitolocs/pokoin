import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'worker'))
import print_strip


class ParseCollectorTest(unittest.TestCase):
    def test_clean(self):
        got = print_strip.parse_collector([('00Wbard 63/102', 0.9)])
        self.assertIsNotNone(got)
        self.assertEqual(got['num'], '63')
        self.assertEqual(got['den'], '102')

    def test_zero_o(self):
        got = print_strip.parse_collector([('30CE070/128', 0.8)])
        self.assertIsNotNone(got)
        self.assertEqual(got['num'], '70')
        self.assertEqual(got['den'], '128')

    def test_sv_prefix(self):
        got = print_strip.parse_collector([('SV18/SV94 *', 0.9)])
        self.assertIsNotNone(got)
        self.assertEqual(got['num'], 'SV18')
        self.assertEqual(got['den'], 'SV94')

    def test_tg_prefix(self):
        got = print_strip.parse_collector([('TG15/TG30', 0.9)])
        self.assertIsNotNone(got)
        self.assertEqual(got['num'], 'TG15')
        self.assertEqual(got['den'], 'TG30')

    def test_zero_l(self):
        got = print_strip.parse_collector([('054/O86', 0.9)])
        self.assertIsNotNone(got)
        self.assertEqual(got['num'], '54')
        self.assertEqual(got['den'], '86')

    def test_no_collector(self):
        lines = [('Faiblesse', 0.9), ('NIV. 14 No. 25', 0.9)]
        self.assertIsNone(print_strip.parse_collector(lines))
        language, _ = print_strip.detect_language(lines)
        self.assertIsNotNone(language)
        self.assertEqual(language['code'], 'fr')


class DetectLanguageTest(unittest.TestCase):
    def test_italian(self):
        language, _ = print_strip.detect_language(
            [('resistenza', 0.9), ('costo di ritirata', 0.9), ('PV', 0.9)])
        self.assertEqual(language['code'], 'it')

    def test_strip_en_set_code(self):
        language, set_code = print_strip.detect_language(
            [('G PAL EN 123/193', 0.9)])
        self.assertEqual(language['code'], 'en')
        self.assertEqual(set_code, 'PAL')

    def test_hp_english(self):
        language, _ = print_strip.detect_language([('HP 70', 0.9)])
        self.assertEqual(language['code'], 'en')

    def test_pv_tie(self):
        language, _ = print_strip.detect_language([('PV', 0.9)])
        self.assertIsNone(language)


class ParseMagicLineTest(unittest.TestCase):
    def test_r_374(self):
        got = print_strip.parse_magic_line(
            [('R 0374', 0.9), ('LTR • EN LORENZO MASTROIANNI', 0.9)])
        self.assertIsNotNone(got)
        self.assertEqual(got['collector']['num'], '374')
        self.assertEqual(got['set_code'], 'LTR')
        self.assertEqual(got['language']['code'], 'en')

    def test_m_230_italian(self):
        got = print_strip.parse_magic_line([('M 0230', 0.9), ('LTR.IT', 0.8)])
        self.assertIsNotNone(got)
        self.assertEqual(got['collector']['num'], '230')
        self.assertEqual(got['set_code'], 'LTR')
        self.assertEqual(got['language']['code'], 'it')


@unittest.skipUnless(
    os.path.exists('/home/nez/.cache/ppocrv5-onnx/det/inference.onnx'),
    'ppocrv5 models not installed')
class PrintStripOcrTest(unittest.TestCase):
    def test_blank_white_card(self):
        import numpy as np
        strip = print_strip.PrintStrip()
        out = strip.read(np.full((880, 630, 3), 255, np.uint8))
        self.assertIsNone(out['collector'])


if __name__ == '__main__':
    unittest.main()
