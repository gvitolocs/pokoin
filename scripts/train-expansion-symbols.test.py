import importlib.util
import unittest
from pathlib import Path

from PIL import Image

spec = importlib.util.spec_from_file_location('symbols', Path(__file__).with_name('train-expansion-symbols.py'))
symbols = importlib.util.module_from_spec(spec)
spec.loader.exec_module(symbols)


class SymbolTrainingTests(unittest.TestCase):
    def test_same_artwork_cannot_cross_split_even_across_sets(self):
        for key in ['v589520', 'v1234', 'v94502']:
            assignments = [symbols.art_split(key) for _ in range(12)]
            self.assertEqual(len(set(assignments)), 1)
        self.assertEqual(symbols.art_split('v589520'), 'val')

    def test_layout_selects_printed_symbol_side(self):
        self.assertLess(symbols.symbol_box('sv8pt5')[2], .2)
        self.assertLess(symbols.symbol_box('swsh12pt5')[2], .2)
        self.assertLess(symbols.symbol_box('sm12')[2], .2)
        self.assertGreater(symbols.symbol_box('xy2')[0], .89)
        self.assertGreater(symbols.symbol_box('bw8')[0], .89)
        with self.assertRaises(ValueError):
            symbols.symbol_box('base1')

    def test_artwork_is_outside_model_input(self):
        im = Image.new('RGB', (630, 880), 'white')
        modified = im.copy()
        modified.paste('black', (0, 0, 630, 750))
        for family in ['sv', 'swsh', 'xy']:
            self.assertEqual(symbols.crop_symbol(im, family).tobytes(), symbols.crop_symbol(modified, family).tobytes())

    def test_camera_and_clean_have_same_tensor_shape(self):
        im = Image.new('RGB', (1260, 1760), 'white')
        for degraded in [False, True]:
            self.assertEqual(symbols.crop_symbol(im, 'sv', degraded).size, (64, 48))


if __name__ == '__main__':
    unittest.main()
