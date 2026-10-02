# Printed expansion recognition

The training script reads only a small printed expansion mark or set-code crop
from a rectified card. It supports western BW/XY (bottom right), SM/SWSH
(bottom left) and SV (bottom-left code plate). It does not identify foil,
Poké Ball, Master Ball, language, or artwork variants. The same-artwork printing
picker must continue to offer all variants regardless of a symbol prediction.

## Run on nezopt

Use the existing ROCm environment; training refuses CPU fallback and any GPU
architecture other than gfx1100 (the local 7900 XTX).

```sh
source /home/nez/.config/rocm-env.sh
PYTHON=/home/nez/Projects/ai-toolkit/venv/bin/python
DATA=/home/nez/data/pokoin-expansion-symbols/v1
$PYTHON scripts/train-expansion-symbols.py prepare --output "$DATA" \
  --catalog "$DATA/catalog.jsonl" \
  --images /home/nez/data/pokoin-leftovers/objects \
    /home/nez/Projects/pokoin/PokoinTest/index/cdn_images \
    /home/nez/Projects/pokoin/PokoinTest/index/cdn_images_delta
$PYTHON scripts/train-expansion-symbols.py train --output "$DATA" --epochs 35
$PYTHON scripts/train-expansion-symbols.test.py
$PYTHON scripts/train-expansion-symbols.py predict --output "$DATA" \
  --image /home/nez/data/pokoin-leftovers/objects/316730_crispin.jpg --layout sv
```

The catalog is a read-only export joining marketplace_search_candidates with
pokoin_pokemon_expansions on case-insensitive expansion name. Select singles,
western official sets whose official_id starts bw/xy/sm/swsh/sv; exclude basic
energy names ending Energy. Fields: card_id, ct_id, name, set, code, official_id,
version (CLIP same-artwork key), image_url. Subset/foil labels sharing a printed
mark must map to the parent expansion rather than becoming separate classes.

Only images at least 400 pixels wide with portrait card geometry are accepted.
At least 20 training and 5 validation cards are required per expansion. Crops,
manifests and models live on NVMe outside the Git checkout. The manifest records
the chosen source file and split for every card. Splits use a stable hash of the
same-artwork key across expansions; the user's Crispin group v589520 is always
held out. Training uses small geometric, exposure and noise augmentations and
both original and simulated 640-pixel captures. Validation reports both modes.

## Artifacts and runtime contract

- `classes.json`: ordered output labels, expansion titles, layout IDs and counts.
- `manifest.jsonl`, `crops.npz`: reproducible cards, groups, splits and crop tensors.
- `best.pt`: lowest-error validation checkpoint, CPU-loadable state dictionary.
- `expansion-symbols.ts`: TorchScript inference model.
- `expansion-symbols.onnx`: ONNX opset 17, dynamic batch.
- `metrics.json`: actual GPU/runtime, held-out accuracies, per-set confusion,
  Crispin results, confidence coverage and model checksum.

Model input is RGB float32 NCHW, shape N×3×48×64, scaled to [0,1]. Output is
unnormalized logits in `classes.json` order. Apply softmax for confidence.
Run the crop on a rectified card, never directly on an unaligned camera frame.
The layout family must be supplied independently. The CLI can show hypotheses
for three families when unknown; confidence across wrong-family crops has not
been calibrated and must not automatically choose a set.

Catalog validation is not a real-phone accuracy claim. Before live set selection,
evaluate captured Italian cards, perspective errors, stacks, glare and defocus;
calibrate rejection thresholds including unsupported sets. Until then, treat the
model as an expansion hint among artwork siblings, preserve every version option,
and log crop family, candidates, confidence and rejection reasons. No production
worker is changed by running this training script.

The integration under `server/scan/worker` uses the chosen Milo orientation and
only runs the symbol model after a confident artwork match whose catalog group
contains multiple parent expansions. A 69,706-card catalog snapshot maps foil
subsets to their parent set. A match must be ≥0.95 confident with ≥0.20 margin
and belong to that artwork's expansion candidates. Low-detail, weak, ambiguous,
unsupported and conflicting predictions preserve the artwork ranking. All
printing options stay available and still require seller confirmation.

`scripts/deploy-expansion-symbol-worker.sh` verifies artifact checksums and real
ROCm HTTP inference before switching a systemd drop-in to an immutable release.
It preserves the existing BattleScan working tree and restores the prior worker
if health verification fails. GPU process teardown currently aborts in the
unchanged deployed worker as well as the new worker; HTTP smoke tests report that
existing shutdown issue separately from inference health. Runtime errors reject
the expansion hint and keep recognition running.

## First completed run — 2026-10-01

On nezopt's gfx1100, torch 2.9.1+rocm6.4 / HIP 6.4, 35 epochs completed in
52.7 seconds including export. Dataset: 68 western expansions, 8,500 training
cards and 2,267 held-out cards. No source-file or artwork-group overlap.
Clean accuracy: 99.647%; simulated 640-pixel accuracy: 99.735% (6 errors).
At confidence ≥0.9, coverage was 98.588% with no errors among accepted
validation cards. This threshold is not calibrated for unknown expansions or
real phone captures and is not a production acceptance rule.

Held-out regular Crispin: PRE ct316730 → PRE (98.95%), SCR ct298440 → SCR
(98.76%) at 640 pixels. Separately, the Poké Ball Crispin ct318027 predicts PRE
(97.12%) from the full-resolution crop; it was absent from the training manifest.
The alternate full-art Crispin artwork was in training, in separate artwork groups.

TorchScript SHA256:
`481cc607d962350638159d6a4f5f3056aafe016c58ecb0c7532e8425e8aa9db5`.
ONNX checker passed, and a dynamic batch of 17 images matched TorchScript
within 3.1e-6 logits. CPU vs 7900 XTX logits differed by at most 9.6e-6 with
identical predicted labels. All four regression tests passed. The two exported
models are approximately 1.2 MB each and remain under the external NVMe path
above; model binaries and datasets are not committed to Git.
