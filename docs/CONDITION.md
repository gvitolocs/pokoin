# Card condition grader (v1, classical CV)

`POST /condition` on the scan worker (`server/scan/worker/app.py`), module
`server/scan/worker/condition.py`. Multipart `file` = front photo (required),
`back` = back photo (optional, strongly recommended). No trained model yet.

| Stage | How | Output |
| --- | --- | --- |
| Locate | YOLO card box (worker `_detect`, when loaded) + Hough line rectangles inside the padded box; best IoU with the box wins. No box: rectangle ranking by edge support + border uniformity. 63:88 images are taken as full-frame scans. | `card.quad`, `card.detector` |
| Warp | Perspective to 630×880 portrait | — |
| Glare | Pixels with all channels ≥ 246 inside the rounded card | flag `sleeve_glare` (> 2%) |
| Centering | Per side, first depth where colour leaves the outer border colour (1–2% band) | `centering.left_right`, `top_bottom`, `worst` |
| Edges | Outermost 1.4%: per position, whitening = moved ≥ 28 Lab units toward white vs the side's per-depth median or vs the same position 6–10 px in; ignored where the white continues deeper (printed copyright / V swooshes). Backs: any loss of the standard blue. | fraction of each side |
| Corners | Ring inside the rounded outline (r = 4.8% W), whitening vs adjacent border colour | fraction per corner |
| Surface | LSD segments, not axis-aligned, not a foil family (≥ 10 parallel offsets in one 3° bin), ridge-shaped; collinear pieces chained | `creases` (≥ 12% W), `scratch_density` |
| Score | 100 − centering(max 20) − wear; wear = worst side + 0.35 × other side when the back is sent | `score`, `grade` |

Grades: ≥ 88 NM, ≥ 75 SP, ≥ 58 MP, ≥ 40 PL, else PO.

Creases (Cardmarket, help.cardmarket.com/en/CardCondition): a crease that breaks the surface makes the
card recognisable even sleeved, so it is not tournament legal = **Poor**.
- `crease=confirmed` (query param, CLI `--crease confirmed`): the holder confirms it → grade PO, score < 40, flag `crease_confirmed`.
- Crease detected in the photo only → grade capped at MP, flag `crease_suspected`, reason asks for a check in hand. Never PO on its own:
  on the 25-listing Vinted dev set the 3 detections matched no seller-reported crease and missed the 2 that were reported.
- `crease=none` overrides a false detection (no cap, no flag).

Flags: `back_not_seen`, `front_not_seen`, `sleeve_glare`, `low_resolution`, `no_card_outline`, `crease_suspected`, `crease_confirmed`.

## Known limits (2026-10-06)
- Seller-labelled Vinted dev set (25 listings, front+back): exact 11/25, within one grade 19/25, MAE 0.96 vs 1.04 for always-MP. Signal is weak; treat grades as advisory.
- CardTrader gallery scans have a light 1–3 px rim that reads as edge whitening.
- Printed artwork lines can pass the crease test; holo/etched foil needs the family filter.
- Next step: learned model on `BattleScan/images/vinted_condition` (gbot, front+back, seller labels) once it has ≥ 300 listings.
