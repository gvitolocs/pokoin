import sys
import unittest
from pathlib import Path
import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'worker'))
import rectify


def make_photo(w=1200, h=1000, cw=315, ch=440, angle=12.0):
    img = np.full((h, w, 3), 110, np.uint8)
    a = np.radians(angle)
    cos, sin = abs(np.cos(a)), abs(np.sin(a))
    bw, bh = int(np.ceil(cw * cos + ch * sin)) + 4, int(np.ceil(cw * sin + ch * cos)) + 4
    x1 = (w - bw) // 2; y1 = (h - bh) // 2
    cx, cy = x1 + bw / 2, y1 + bh / 2
    M = cv2.getRotationMatrix2D((cx, cy), angle, 1.0)

    def rot(pts):
        out = np.empty_like(pts)
        out[:, 0] = M[0, 0] * (pts[:, 0] - cx) - M[0, 1] * (pts[:, 1] - cy) + cx
        out[:, 1] = M[1, 0] * (pts[:, 0] - cx) + M[1, 1] * (pts[:, 1] - cy) + cy
        return out

    x0, y0 = cx - cw / 2, cy - ch / 2
    outer = rot(np.array([[x0, y0], [x0 + cw, y0], [x0 + cw, y0 + ch], [x0, y0 + ch]], dtype=np.float32))
    cv2.fillConvexPoly(img, outer.astype(np.int32), (0, 200, 255))
    pad = 12
    inner = rot(np.array([[x0 + pad, y0 + pad], [x0 + cw - pad, y0 + pad],
                          [x0 + cw - pad, y0 + ch - pad], [x0 + pad, y0 + ch - pad]], dtype=np.float32))
    cv2.fillConvexPoly(img, inner.astype(np.int32), (255, 128, 0))
    box = {'xyxy': [float(x1), float(y1), float(x1 + bw), float(y1 + bh)]}
    return img, box


def ring_hue_ok(out):
    h = cv2.cvtColor(out, cv2.COLOR_RGB2HSV)[:, :, 0].astype(np.float32)
    ring = np.concatenate([h[:6, :].ravel(), h[-6:, :].ravel(),
                           h[:, :6].ravel(), h[:, -6:].ravel()])
    return float(np.mean((ring >= 90) & (ring <= 100)))


class RectifyTest(unittest.TestCase):
    def test_rotated_card_is_warped_to_canonical_portrait(self):
        img, box = make_photo()
        out = rectify.rectify(img, box)
        self.assertEqual(out['method'], 'quad')
        self.assertEqual(out['image'].shape, (880, 630, 3))
        self.assertEqual(len(out['quad']), 4)
        self.assertGreater(ring_hue_ok(out['image']), 0.8)

    def test_landscape_card_still_portrait_output(self):
        img, box = make_photo(cw=440, ch=315, angle=12.0)
        out = rectify.rectify(img, box)
        self.assertEqual(out['method'], 'quad')
        self.assertEqual(out['image'].shape, (880, 630, 3))

    def test_flat_noise_falls_back_to_box(self):
        rng = np.random.default_rng(7)
        img = rng.integers(0, 255, (1000, 1200, 3), dtype=np.uint8)
        out = rectify.rectify(img, {'xyxy': [300., 200., 700., 600.]})
        self.assertEqual(out['method'], 'box')
        self.assertIsNone(out['quad'])
        self.assertEqual(out['image'].shape, (880, 630, 3))

    def test_box_touching_border_does_not_raise(self):
        img, box = make_photo()
        box = {'xyxy': [0., 0., img.shape[1] - 1., img.shape[0] - 1.]}
        out = rectify.rectify(img, box)
        self.assertEqual(out['image'].shape, (880, 630, 3))


if __name__ == '__main__':
    unittest.main()
