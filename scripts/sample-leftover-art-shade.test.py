from PIL import Image
import unittest

from importlib.machinery import SourceFileLoader
from pathlib import Path

MOD = SourceFileLoader(
    'sample_leftover_art_shade',
    str(Path(__file__).resolve().parents[1] / 'scripts' / 'sample-leftover-art-shade.py'),
).load_module()


class ArtShadeTest(unittest.TestCase):
    def test_darken_keeps_hue_and_hex(self):
        shade = MOD.darken_for_caption(40, 180, 90)
        self.assertRegex(shade, r'^#[0-9a-f]{6}$')
        red = int(shade[1:3], 16)
        green = int(shade[3:5], 16)
        blue = int(shade[5:7], 16)
        self.assertGreater(green, red)
        self.assertGreater(green, blue)

    def test_artcut_samples_the_bottom_of_the_illustration(self):
        image = Image.new('RGB', (100, 40), (0, 0, 255))
        for x in range(100):
            for y in range(28, 40):
                image.putpixel((x, y), (200, 40, 40))
        shade = MOD.shade_from_image(image, already_cut=True)
        red = int(shade[1:3], 16)
        blue = int(shade[5:7], 16)
        self.assertGreater(red, blue)


if __name__ == '__main__':
    unittest.main()
