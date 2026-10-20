#!/usr/bin/env python3
"""Embed artofpkm clean artworks in the CLIP art-box space of artbox-clip.npz.

The gallery (pokemon-card-extension/scripts/out/artbox-clip.npz) holds one
OpenCLIP ViT-B-32 laion2b_s34b_b79k vector per printing, taken from the
leftover JPEG's ART_BOX (0.07, 0.115, 0.93, 0.515). Clean artworks come in two
shapes, so each gets the crops that resemble that box:

- portrait (card-sized painting, full arts): the same ART_BOX fractions, plus the
  whole painting;
- landscape (the illustration window only): the whole painting, plus a 4% inset.

Output: OUT/clean-clip.npy (rows × 512 float32, L2-normalised) and
OUT/clean-clip.jsonl (one row per vector: artwork_id, variant, asset path).
Matching against the gallery is done by tools/clean-art-match (Rust).

  /home/nez/Projects/ai-toolkit/venv/bin/python scripts/embed-clean-artworks.py \
    --dump /home/nez/mnt/mybook/datasets/tcg/artofpkm/catalog668-20261020 --out OUT
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

ART_BOX = (0.07, 0.115, 0.93, 0.515)
CLIP_MODEL = "ViT-B-32"
CLIP_PRETRAINED = "laion2b_s34b_b79k"


def crops(image: Image.Image):
    w, h = image.size
    if h > w:
        l, t, r, b = ART_BOX
        yield "artbox", image.crop((int(w * l), int(h * t), int(w * r), int(h * b)))
        yield "whole", image
    else:
        yield "whole", image
        dx, dy = int(w * 0.04), int(h * 0.04)
        yield "inset4", image.crop((dx, dy, w - dx, h - dy))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    import torch
    import open_clip

    model, _, preprocess = open_clip.create_model_and_transforms(CLIP_MODEL, pretrained=CLIP_PRETRAINED, device="cpu")
    model.eval()
    rows, tensors = [], []
    for line in (args.dump / "artworks.jsonl").open():
        art = json.loads(line)
        for asset in art["assets"]:
            image = Image.open(args.dump / asset["path"]).convert("RGB")
            for variant, crop in crops(image):
                rows.append({"artwork_id": art["artwork_id"], "variant": variant, "role": asset["role"],
                             "asset": asset["path"], "width": image.size[0], "height": image.size[1]})
                tensors.append(preprocess(crop))
    vecs = []
    with torch.inference_mode():
        for i in range(0, len(tensors), 64):
            v = model.encode_image(torch.stack(tensors[i : i + 64]))
            vecs.append((v / v.norm(dim=-1, keepdim=True)).numpy().astype(np.float32))
            print(f"embedded {min(i + 64, len(tensors))}/{len(tensors)}", flush=True)
    np.save(args.out / "clean-clip.npy", np.concatenate(vecs))
    with (args.out / "clean-clip.jsonl").open("w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


if __name__ == "__main__":
    main()
