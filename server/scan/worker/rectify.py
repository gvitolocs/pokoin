"""Perspective-corrected canonical card crops for Pokemon YOLO boxes."""
import cv2
import numpy as np
import card_quad

CARD_W, CARD_H = 630, 880


def rectify(rgb, box, *, pad=0.08):
    h, w = rgb.shape[:2]
    x1, y1, x2, y2 = [int(round(v)) for v in box['xyxy']]
    bw = max(1, x2 - x1); bh = max(1, y2 - y1)
    px = int(round(bw * pad)); py = int(round(bh * pad))
    sx1 = max(0, x1 - px); sy1 = max(0, y1 - py)
    sx2 = min(w, x2 + px); sy2 = min(h, y2 + py)
    sub = rgb[sy1:sy2, sx1:sx2]
    best = None
    box_area = float(bw * bh)
    if sub.size:
        for cand in card_quad.detect(sub, live=True):
            if 'quad' not in cand:
                continue
            quad = np.asarray(cand['quad'], dtype=np.float32)
            area = abs(cv2.contourArea(np.asarray(quad, dtype=np.float32).reshape(4, 1, 2)))
            if area < 0.55 * box_area:
                continue
            sides = np.linalg.norm(quad - np.roll(quad, -1, axis=0), axis=1)
            ratio = sides.min() / max(float(sides.max()), 1e-6)
            if not 0.62 <= ratio <= 0.80:
                continue
            if best is None or area > best[1]:
                best = (quad + np.array([sx1, sy1], dtype=np.float32), area)
    if best is not None:
        quad = card_quad.ordered(best[0])
        sides = np.linalg.norm(quad - np.roll(quad, -1, axis=0), axis=1)
        qw = max(8, int(round(max(sides[0], sides[2]))))
        qh = max(8, int(round(max(sides[1], sides[3]))))
        if qh >= qw:
            dest = np.array([[0, 0], [CARD_W - 1, 0], [CARD_W - 1, CARD_H - 1], [0, CARD_H - 1]], dtype=np.float32)
            image = cv2.warpPerspective(rgb, cv2.getPerspectiveTransform(quad, dest), (CARD_W, CARD_H))
        else:
            dest = np.array([[0, 0], [CARD_H - 1, 0], [CARD_H - 1, CARD_W - 1], [0, CARD_W - 1]], dtype=np.float32)
            image = np.ascontiguousarray(np.rot90(cv2.warpPerspective(rgb, cv2.getPerspectiveTransform(quad, dest), (CARD_H, CARD_W)), k=-1))
        return {'image': image, 'method': 'quad', 'quad': best[0].tolist()}
    crop = rgb[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]
    if crop.size == 0:
        crop = rgb[max(0, sy1):max(0, sy2), max(0, sx1):max(0, sx2)]
    if crop.shape[0] >= crop.shape[1]:
        image = cv2.resize(crop, (CARD_W, CARD_H), interpolation=cv2.INTER_AREA)
    else:
        image = np.ascontiguousarray(np.rot90(cv2.resize(crop, (CARD_H, CARD_W), interpolation=cv2.INTER_AREA), k=-1))
    return {'image': image, 'method': 'box', 'quad': None}
