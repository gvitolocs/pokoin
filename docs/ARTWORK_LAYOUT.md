# Album artwork layout (framed box vs painting-to-edges)

Full art still has a **card edge** (silver/yellow frame) and HP/attacks.
That is not a window. TCG Companion: a standard card has a rectangular
**art box**; full art has no separate art box — the painting runs to the
card edge and text sits on the scene. MEP 038 Charmander is an
illustration-rare-style promo (First Partner Illustration Collection).

CLIP `pokoin_version_sets` is the **same painting**, not the same frame.
Secret Rare is not a layout. OCR Ability / weakness / Illus appears on
both framed commons and full-art; do not use it as the split.

Two-row album tiles (`.tile-tall` + `ART_CUT_BLEED`) are a **taller
artwork cut** of a bleed leftover — more of the painting, not a leftover
mini-card. A framed Fearow stamped bleed shows the white Repeating Drill
box in that crop; that card is a window.

Map: [CARD_ART.md](CARD_ART.md). Script: `scripts/artwork-layout.py`.

Figure-aware hover data is a separate grounding + segmentation pass. A card's
National Dex number does not say which Pokémon are actually visible in the
painting (cameos and Tag Teams). Run
`scripts/qwen-artwork-figures.py` on nezopt to classify one representative per
CLIP `version`; it writes resumable `scripts/out/qwen-artwork-figures.jsonl` (default `/tmp/…` still works) with
normalized 0–1000 full-card boxes for review. Those rectangles are **SAM2
prompts only** and are never rendered. After review,
`scripts/build-artwork-figure-masks.py` produces transparent silhouette WebPs;
hover scales a masked art duplicate while the square painting stays still.

**nezopt VRAM mutex:** `qwen3-vl:32b-instruct` on Ollama `:11434` needs the whole 7900 XTX (~20 GB).
Stop and mask the text runner first or Ollama falls back to **CPU** (~10× CPU, empty VRAM, timeouts):

```bash
systemctl --user stop llama-server-qwen
systemctl --user mask llama-server-qwen-watch.timer llama-server-qwen-watch.service
# resume figures (JSONL is append/resume)
cd /home/nez/Projects/pokoin-web
python -u scripts/qwen-artwork-figures.py --jsonl scripts/out/qwen-artwork-figures.jsonl
# after the job finishes:
systemctl --user unmask llama-server-qwen-watch.timer llama-server-qwen-watch.service
systemctl --user start llama-server-qwen
```

Confirm GPU with `curl -sS http://127.0.0.1:11434/api/ps` (`size_vram` ≈ 20e9) and
`cat /sys/class/drm/card0/device/mem_info_vram_used` (XTX = `0x744c`). Do not use the
text-only llama.cpp gateway on `:11436` / `:11438` for this job (no mmproj).


## What the album tile reads

Artist API coalesce, leftover first:

1. `marketplace_leftover_art_layouts.layout` for this `ct_id`
2. `marketplace_search_candidates.art_layout`
3. `pokoin_version_sets.art_layout` (majority of leftovers in that CLIP group)
4. SPA rarity fallback: SIR / Full Art / Hidden Fates trainer Shiny Vault (Lady SV86) / Hyper Rare /
   Trainer Ultra Rare / SWSH-SV Secret Rare supporters (Serena, Elesa, Morty SIR) — **not**
   “Secret Rare” on BW/XY items/tools/stadiums (Rocky Helmet 153/149, ACE SPEC), **not**
   SM gold items until Gold Secret, **not** Paldean Fates n/m Shiny Rare, **not** Hidden Fates /
   Shining Fates Pokémon SV## Shiny Rare (framed window). Sword & Shield
   **Amazing Rare** is `halfart` even when CardTrader named it Illustration Rare.
   Do not Dex-zero every trainer into a window. Bare Secret Rare outside SWSH/SV is window.

`.tile-tall` + `ART_CUT_BLEED` is only `bleed` / `landscape` / `item`.
Amazing Rare is one-row `halfart` (`ART_CUT_HALFART`), not a two-row leftover.

## Classify this leftover

XY Ultra Rare EX near the set end (Pidgeot EX 104/108 Evolutions, Darkrai EX 118/122) are Full Art with **no Full-Art token** — catalog + leftover must be `bleed`, not `window` from yellow-edge/name-bar false chrome.


Western OCR jsonl (`scripts/out/western-full-ocr-gpu.jsonl`, then the CPU
file). Use **`text` + `junk`**, not the `crop` field. `crop` is which canvas
we fed PP-OCR (rarity regex drops the art window on commons). Ability /
weakness / Illus on this scan is chrome evidence, not a layout by itself —
Cinderace VMAX Secret Rare also OCRs attacks on the painting.

Geometry on **this JPEG** (NVMe leftover, HIP 0 cream/gold batches):

| Reason | Layout | Example |
| --- | --- | --- |
| `cream_rules` / `name_bar` | window | SM/SV framed (Groudon L-P, Zoroark 061/100). Catalog IR/FA **does not** flip to window on these — cream paint and a dark HP overlay are not a rules box (Beautifly IR, Accelgor IR). |
| `gold_rules` | window | flat gold attack sheet (Mega X 108/106); autumn IR paint is not gold_rules. Catalog bleed **does** flip when this fires. |
| `era_border` | window | XY yellow frame; cyan Water Splash box is not cream |
| `white_rules` | window | SV / Mega white attack sheet (Fearow 103/132) |
| `rules_panel` | window | type-tinted flat sheet (Quagsire SVP 156 cyan, Plasma Freeze Vaporeon 20/116 blue). Catalog bleed **does** flip (SV6 Charmander). |
| `dark_rules` | window | dark reverse-holo sheet (Hop's Cramorant Poké Ball reverse) |
| `name_bar` | window | dark name plate **and** a framed sheet (not FA HP overlay) |
| `art_box` | window | silver illustration-window chrome **and** a framed sheet; not FA holo chrome (Mega Froslass ex 265/217) |
| `no_chrome` / `no_art_box` | bleed | painting to the card edge (IR, MEP 038–063, Lady SV86) |

Repair (per leftover, not one CLIP representative):

```bash
HIP_VISIBLE_DEVICES=0 /home/nez/Projects/ai-toolkit/venv/bin/python \
  scripts/artwork-layout.py --repair-no-chrome --apply --gpu --workers 12
```

Writes 15T `marketplace_leftover_art_layouts` and a leftover-majority on
`pokoin_version_sets` for JP rows without a western OCR file. Leftover JPEGs
come from NVMe (`/home/nez/data/pokoin-leftovers`). One-time HDD catch-up:
`scripts/sync-nvme-leftovers-from-15t.sh`. Do not glob mybook on a pass.

## Incident — Boundaries Crossed Squirtle 29/149

Kanako Eo album showed Common 29/149 as a two-row leftover (HP, Shell Shield,
Water Splash). Leftover `111720` is a framed XY card. Western OCR already had
BASIC / Ability / weakness / Illus. Kanako Eo, `junk=false`.

`geometry:no_chrome` fired because the Water Splash panel is cyan (cream
detector wants a yellow box) and the XY name bar is silver, not dark. CLIP
`v223440` stored **bleed**; the leftover override row was empty; the SPA
painted `.tile-tall`.

Cinderace VMAX `Secret Rare | 194/192` is full-bleed on the leftover and stays
`no_chrome`. The Secret Rare token did not decide either card. VMAX names
are catalog bleed (`scripts/sql/079_vmax_album_bleed.sql`).

## Incident — Quagsire SVP 156 / Chikorita MEP 046

Saboteri album showed Cosmos Holo SVP 156 as a two-row leftover (Rollout,
Drenched Headbutt). Leftover `311313` is a framed Water-type SV promo: the
rules sheet is flat cyan, so cream and white both miss. `rules_panel`
(lower-body pixels near the median, luma ≥ 140) is that sheet.

Chikorita MEP 046 / Totodile MEP 048 are First Partner illustration rares.
Autumn gold in the painting hit `gold_rules` (≥ 0.40 gold pixels) and
stamped window. Gold rules now also need a flat panel (Mega X 108/106);
busy gold paint stays bleed. Catalog Illustration Rare / SIR / Full-Art
with gold_rules or rules_panel stays bleed (Tepig IR autumn, Milcery IR);
Gold Secret Mega X and Shiny Rare SV6 Charmander still flip.

Poké Ball / Master Ball reverse foil (Quaxly `390872`, Hop's Cramorant
`360216`) keeps a framed art box. `dark_rules` is the dark reverse sheet;
catalog `reverse holo` wins over timid `no_chrome`.

## Incident — Accelgor IR / Beautifly IR / Chikorita 104/M-P

Saboteri still had other full arts as one-cell windows after Oshawott /
Excadrill / Froslass. Accelgor IR `342874` is painting-to-edges on a dark
forest; `name_bar` saw the HP overlay plus a flat dark lower half.
Beautifly IR `370857` is parchment paint; `cream_rules` fired on the
scene, not a rules sheet. Catalog IR/FA now stays bleed unless this
leftover has a **flat gold or type-tinted rules panel** (`gold_rules`,
`rules_panel`). Cream paint and a dark name overlay do not flip SIR/IR.

JP First Partner `101/M-P`–`124/M-P` and Paldea `M-P 125`–`127` are the
same illustration series as MEP 037–063. Chikorita `104/M-P` (`395760`)
is bleed. McDonald's `019/M-P` Quaxly (`345784`) stays a framed window.

## Incident — 5ban GX / Plasma Freeze Vaporeon

5ban Graphics album showed GX leftovers as two-row **mini-cards** (HP and
attacks). Regular GX is full artwork — attacks sit on the painting — so
the album tile is bleed with `ART_CUT_BLEED`, not a one-row window and
not the leftover mini-card. Plasma Freeze Vaporeon Uncommon `20/116`
(Refreshing Rain on the blue Team Plasma sheet) stays a window
(`rules_panel`). VMAX leftovers are only full artwork — prize-pack
Vaporeon VMAX `030/203` is album bleed with `ART_CUT_BLEED`, same as
Secret Rare Cinderace VMAX. Holo Rare Mega EX (`M Venusaur ex` 002/083)
still has a framed box. Mega Froslass ex Ultra Rare stays bleed.
`rules_panel` flatness is 0.24 so the Plasma Freeze blue sheet counts.

## Incident — SM gold trainer secrets named Secret Rare

Eske Yoshinob album showed Forbidden Light Mysterious Treasure 145/131
and Team Up Electrocharger 193/181 as **Secret Rare** window tiles
through the gold name bar. The leftovers are the same gold-border
item template as Lost Thunder Electropower (already Gold Secret Rare +
bleed).

pokemon.com TCG Card Database prints those numbers as **Rare Holo**
(Beast Ring [141/131](https://www.pokemon.com/us/pokemon-tcg/pokemon-cards/series/sm6/141/),
Nest Ball [158/149](https://www.pokemon.com/us/pokemon-tcg/pokemon-cards/series/sm1/158/)).
Press checklists omit secret cards. Collector lists (Coded Yellow gold
gallery, PsyPokes “(Gold)”) and TPCi pull-rate ★S “rare Secret —
Trainer/Energy (Gold)” are the gold naming. Pokoin already used
**Gold Secret Rare** for later SM sets. `scripts/sql/078_sm_gold_secret_rare.sql`
renames the 32 SM/GR/FL/UP/TEU leftovers and stamps leftover **bleed**.
Do not reclassify Fighting Energy 169/145 (`gold_rules`). Mega X
108/106 stays window. Forbidden Light JP 100–102/094 FA supporters
stay Secret Rare.

## Incident — PLANETA Igarashi (Blastoise half / Dragonite full)

Stellar Crown Blastoise ex `030/142` is a framed SV ex (window). The
SV Black Star **Stamp** of that printing is the same frame; holo stamp
pixels miss `rules_panel` and the collector is prefixed
(`Stellar Crown Stamp | 030/142`). A `Stamp` + EX n≤m line stays window.
Regular Dragonite GX `152/236` is full artwork (bleed); `catalog_gx` had
forced a one-row window. Onix GX / Aerodactyl GX are the same GX
painting-to-edges. Two-row tiles crop `ART_CUT_BLEED`, not leftover
HP/attacks.

## Incident — XY Ancient Trait → full-art bleed

Altaria `Rare | 74/108` Roaring Skies (`126667`) and other XY Ancient Trait
half-arts (Ω Barrier / Barrage, α Recovery, Δ Evolution, θ Stop, …) paint under
the trait banner. Album treats them as **bleed** / `.tile-tall` (same as FA), not
`modern_window`. Standard framed XY (Altaria `53/108`) stays window.

SPA: `isXyAncientTraitFullArt` collector map. Classifier: `ocr_ancient_trait` when
western OCR hits the trait text (Δ often OCRs as `4 Evolution`).
Review: `market/public/review/artwork-layout/xy-ancient-trait/`.
Same Ancient Trait painting can sit in **two** CLIP `version`s (Roaring Skies
`74/108` `v253334` vs XY46 promo `v264200`). Layout still follows leftover first;
align members of each group when OCR confirms the trait. Version majority alone
was still `window` while STAFF XY46 was already bleed.


## Incident — XY79 Latios promo is full-art bleed

Holo Promo XY79 (ct_id 132137) paints under HP/attacks; yellow `era_border` stored window. Same CLIP `v264274` JP Legendary Shine was already bleed. Album is bleed / `.tile-tall`. SPA: `isXyFullArtPromoBleed` (XY79).
