import importlib.util
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch
from PIL import Image


SCRIPT = Path(__file__).with_name("build-artwork-figure-masks.py")
SPEC = importlib.util.spec_from_file_location("build_artwork_figure_masks", SCRIPT)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class ArtworkFigureMasksTest(unittest.TestCase):
    def test_boxes_map_from_normalized_full_card(self):
        figures = [{"box": [100, 200, 900, 800]}]
        self.assertEqual(MOD.pixel_boxes(figures, 500, 700), [[50, 140, 450, 560]])

    def test_union_uses_best_candidate_per_figure(self):
        masks = torch.zeros((2, 3, 4, 4))
        masks[0, 1, 0, 0] = 1
        masks[1, 2, 3, 3] = 1
        scores = torch.tensor([[0.1, 0.9, 0.2], [0.1, 0.2, 0.8]])
        union = MOD.union_best_masks(masks, scores)
        self.assertTrue(union[0, 0])
        self.assertTrue(union[3, 3])
        self.assertEqual(int(union.sum()), 2)

    def test_sanitize_removes_evolution_thumbnail_and_duplicate(self):
        figures = [
            {"label": "Oddish icon", "box": [75, 88, 170, 152]},
            {"label": "Gloom", "box": [217, 171, 750, 473]},
            {"label": "Gloom duplicate", "box": [217, 171, 750, 473]},
        ]
        self.assertEqual(
            MOD.sanitize_figures(figures),
            [{"label": "Gloom", "box": [217, 171, 750, 473]}],
        )

    def test_sanitize_keeps_small_cameo_inside_artwork(self):
        cameo = {"label": "Hoppip", "box": [88, 211, 325, 380]}
        self.assertEqual(MOD.sanitize_figures([cameo]), [cameo])

    def test_webp_uses_transparency_not_a_rectangle(self):
        mask = np.zeros((4, 5), dtype=bool)
        mask[1:3, 2] = True
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "v1.webp"
            MOD.write_mask(mask, path)
            with Image.open(path) as image:
                alpha = np.asarray(image.getchannel("A"))
            self.assertEqual(int((alpha > 0).sum()), 2)


if __name__ == "__main__":
    unittest.main()
