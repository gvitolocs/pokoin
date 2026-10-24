# Versions tab (rarities vs same artwork)

Desk **More versions...** and `{canonicalPath}/versions` are **not**
CardTrader’s dump. CardTrader’s Espurr Nihil Zero IR tab is four products:
JP regular, JP illustration rare, EN regular, EN illustration rare. Pokoin
splits that:

| Section | What | Not |
| --- | --- | --- |
| **Rarity Lineup** | Other **rarities** of this card in **this set** (regular ↔ illustration rare ↔ reverse / poké ball of the same collector). Secret numbers (`087/080`) pair with the in-set card (`032/080`). FA / SIR / gold secrets of the same name join that same lineup (Storm Emeralda Mega Rayquaza 058 / 095 / 110 / 113). | Language. Two different arts of the same species in the set (Cottonee **009** and **010**). |
| **Era grids** | CLIP printings of this illustration, grouped by TCG block. Item, supporter, stadium, and energy cards also list every other printing of the same English name — those are reprints even when the painting changed (Dark Explorers Ultra Ball and Sun & Moon 135/149). A Pokémon with the same name stays off this list unless the artwork match put it here. JP/EN/CN stay in the same block. Full EN/JP/CN expansion lists: [TCG_ERAS.md](TCG_ERAS.md). | |
| **Original / Neo / e-Card / …** | Pre-EX is split (Original, Neo, Legendary Collection, VS / web, e-Card). Platinum and Call of Legends are their own blocks. | Do not dump WotC into one **Legacy** heading. Do not map Pokémon Card★web onto Legendary Collection. |

Each `public_id` keeps its own page. The desk `<select>` between ‹ › is the
rarity list (label is `Illustration Rare 087/080`, not the set pair). Under
the scan, CardTrader-style **set-symbol circles** always show for this
illustration (`GET /api/marketplace-version-set`), including a singleton
expansion. Changing the rarity select (Ultra Rare → Full-Art) must refetch
that group — do not build the circles from exact-name search (that is every
printing of the English name, so the row never moved). **More versions...**
stays under the circles whenever there is a rarity lineup or other artwork
(`{canonicalPath}/versions`). More than five expansions drop the circles and
keep only that link. The versions page then groups that CLIP list by TCG era
(`tcgEra` in `market/src/set-logos.js`, catalog `market/src/tcg-eras.js`).
Era headings are gold links to `/marketplace/eras/{id}` (Neo →
`/marketplace/eras/neo`). **Rarity Lineup** is not an era.
Mixed-era dumps (League Promos, Play! Prize Pack Series, theme-deck
exclusives, prerelease / misc promos, …) do **not** get an Other heading when
the same illustration already lives in a dated set: `inheritEraFromArtwork`
uses the CLIP peer’s collector n/d, then a unique peer era. Stamp text that
names a set (`Perfect Order Stamped`, `SVP`) can classify without CLIP.

When a CLIP group has **one** illustrator and **one** card name, empty
siblings copy that artist (`marketplace_copy_same_art_artists`, source
`same_artwork`) **except energy cards** (name ending in Energy: Fighting
Energy, Double Colorless Energy, Rainbow Energy). Those stay empty unless
OCR / pokemontcg.io / TCGdex / pkmncards wrote the credit. Trainers named
Energy Removal still copy. Donor lookup is `artist.card_id = c.card_id` (public leftover
× 2). INSERT still uses leftover `c.ct_id` as the artists PK. 30th Celebration
JP Charizard 137/103 (`790994`) has no printed credit; the desk link is
Mitsuhiro Arita from the Base Set / Classic Charizard siblings. Two
illustrators or two names in the group stay empty. Never overwrite an existing
`marketplace_blueprint_artists` row except a CLIP copy that pkmncards.com
name+set+number contradicts (Southern Islands Ledyba 7/18 is Keiko Fukuyama,
not Skyridge Masako Yamashita). Desk/search then read `candidates.artist`
([ARTISTS.md](ARTISTS.md)).

API: `GET /api/marketplace-card-page?cardId=` includes that CLIP key as
`version` and `card.version` on desk load (`versionCount` is
`member_count`). Same-set rarities (UR / FA / SIR / Gold) are `rarities`,
from English name + expansion — not the CLIP cluster. `GET /api/marketplace-version-set?cardId=` → same-art CLIP group
(`pokoin_version_sets` + `marketplace_search_candidates.version`). Count is
trigger-maintained `member_count`. The desk `<select>` cycles `rarities`
(`market/src/card-versions.js`); ‹ › walk expansion neighbors, not that lineup.
Tile PKN is the listed cheapest from `cheapest_homepage_cache_blueprint`
(same overlay as search / set desk). Last-day sold median still fills tiles
with no live ask (`GET /api/marketplace-card-sales?cardId=` →
`series.lastMedianPkn`). The SPA fires **one sales request per unpriced id**
(cap 48). `999…` stamps go through `realPublicCardId`.
Same-art tiles may show a text `JP`/`EN`/`CN` badge.

The desk **same-name rail** is a different surface
(`GET /api/marketplace-search-page?query="{name}"`, then exact `name`, up to
eight pages of 96). Do not feed that list into either versions section.

---

## Name bucket

`cluster-name-version-sets.name_key`:

| Keep together | Keep apart |
| --- | --- |
| `Alolan Exeggutor ex` = `Alolan exeggutor ex` | XY **EX** ≠ SV **ex** (`Ho-Oh EX` ≠ `Ho-Oh ex`) |
| `Unown [P]` = `Unown [P] LV.13` (printed level) | `Unown [P]` ≠ `Unown [Q]` |
| `Mega Lopunny & Jigglypuff Tag Team GX` = `Mega Lopunny & Jigglypuff GX` | Pokémon **LV.X** stays (`Feraligatr` ≠ `Feraligatr LV.X`) |

When two leftovers share a `ct_id` prefix (Unown JP `137186` vs Kingambit
public id), pick the JPEG whose slug matches the card name.

---

## How the illustration is matched

Same English name + same leftover painting. The Sep 6 `--all` pass used
illustration-box CLIP unique-nearest only (≥0.80, margin 0.04) so Flareon /
Pikachu δ would not chain. Cost: reprints whose CLIP nearest-neighbor was
almost tied (DP34 0.765 vs the other Arita art 0.764) stayed singleton.
About **12.8k of ~69k printings** were singleton keys (~18%). Typical miss:
true same-illustration EN/JP promo pair, leftover pixels clear, CLIP margin
too tight. A 0.45 pixel floor then glued *other* balloon arts
(Stormfront 16/100 ↔ SVP 135 at ~0.493).

WCD 2012–2016 and 30th JP XY **EX** leftovers were CardTrader-named
`Genesect ex`. `name_key` keeps **EX ≠ ex**, so CLIP never joined Plasma
Blast 11/101. Leftover pixels ≥ 0.55 (30th Genesect 0.96 despite the
Pikachu stamp). Those stamps rename to `EX` and pin onto the XY EX stack
(`STAMP_EX_PINS`). 30th SV Pikachu / Greninja / Fuecoco stay `ex`
(CLIP ~0.80 to XY EX, leftover pixels ~0.1).

The 2026-09-10 pipeline raised the cluster pixel floor to **0.55**, preferred
collector leftover slugs over `full-v4`, and re-clustered every name. Live
result: **4409 / 69294** singleton printings (**6.4%**). Remaining singles are
mostly unique illustrations plus washed leftovers (BW64 + BW-P 147 is an
`artbox-pin`).

Run on nezopt (RX 7900 XTX, leftover JPEGs on the 15T replica — never crop
on the Pi):

```bash
# tests → cluster every name → apply Oracle Postgres primary → SQL fixtures
# (Pi replica follows; do not write version sets on the replica)
/home/nez/Projects/pokemon-card-extension/scripts/version-sets-pipeline.sh --dry-run
/home/nez/Projects/pokemon-card-extension/scripts/version-sets-pipeline.sh
```

`--reencode` rebuilds illustration-box CLIP (`scripts/out/artbox-clip.npz`).
Skip it when that cache is current. Do not encode CardTrader 186×260
`card_uploader` backs or Pokoin missing-card leftover stamps (630×880) —
identical coins would glue every missing Fighting Energy into one painting.
Those leftovers stay singleton `v{card_id}`. Pixel poses cache by leftover filename
in `scripts/out/artbox-pixel.npz`. `--apply-cached` writes
`scripts/out/version-groups.json` if Pi SSH drops after matching.
`--verify` checks the fixture pairs below. Map: [GAMES.md](GAMES.md),
[CARD_ART.md](CARD_ART.md).

New CardTrader leftovers: leftover ingest calls this for that expansion.
Do not leave imported printings on singleton `v{card_id}` until a later
`--all`. Incremental:

```bash
# from pokoin-web, after leftovers exist on the 15T replica
scripts/match-imported-version-sets.sh --expansion "30th Celebration JP"
scripts/match-imported-version-sets.sh --ids 790994
```

One-name probe:

```bash
HIP_VISIBLE_DEVICES=0 /home/nez/Projects/ai-toolkit/venv/bin/python \
  /home/nez/Projects/pokemon-card-extension/scripts/cluster-name-version-sets.py \
  "Pikachu δ Delta Species" --dry-run
```

### 1. Illustration-box CLIP (leftover JPEG, Espurr window)

Not the thin searchbar `artcut/` strip. Any Pikachu face looks like any
other in that crop. Prefer the leftover whose slug matches the collector
number; generic `full-v4` scans lose that tie.

- ≥ **0.94** — stamps / reverse holos of the same crop
- ≥ **0.80** — only when that pair is each cluster’s **unique nearest**
  (second-best ≥ **0.04** worse)
- Do **not** union-find at 0.80 or 0.90
- Do **not** union leftover-catalog CLIP first

The 2026-09-06 `--all` pass chained every Flareon / Pikachu δ into one key
because species embeddings sit at ≥ 0.83. Tight unique-nearest stopped the
chain and left **PCG-P 112 as a singleton** until step 3.

### 2. Catalog CLIP only if there is no artbox vector

≥ 0.83 onto the unique nearest cluster (margin 0.04). Orphan EX-holo reprints
can attach here (Cacturne EX Sandstorm → Celestial Storm / Champion Road /
Miracle of the Desert) without gluing BREAKthrough to that art.

### 3. Equalized 64×64 pixels when CLIP cannot split poses

CLIP art-box scores ~**0.90** between different Pikachu δ poses (running
Holon 079 vs leaning Legend Maker 093/92). Equalized illustration pixels
separate them (~0.90 same pose, ~0.10 other pose). Mutual unique nearest
≥ **0.70**, margin **0.12**. CLIP unique-nearest is **vetoed** when leftover
pixels are below **0.40** (EX Dark Dragonair 31/109 vs 32/109 is ~0.87 CLIP
and ~0.08 pixels). After that, **clusters** auto-merge at pixel ≥ **0.80**
and unique-nearest (or a leftover pair) at ≥ **0.55**, so JP Rocket Gang
can join Team Rocket + Legendary Collection when both EN scans already
share a key (Challenge! JP sits at ~0.77 to each EN printing) **without**
gluing Stormfront 16/100 to SVP 135 (~0.493). DP34 McDonald’s 031/DP-P sits
at leftover pixels ~**0.595** — CLIP unique-nearest cannot pick that pair
over D&P 24/130 (the other Arita painting). A leftover singleton can still
CLIP-attach at ≥ **0.72** when pixels are ≥ **0.20** (Dark Charizard JP
~0.73 / 0.32). Face-weighted pixels (0.6 character crop / 0.4 illustration
window) so EN/JP frames and WCD stamps of the same pose still match. Reprint
stacks auto-merge at ≥ **0.90** — unique-nearest cannot pick one pair among
Celebrations / JP / CN / WCD of Tapu Lele GX 60/145. Same crop math as
`artwork-lang-pipeline.pixel_art_vec` (`PIXEL_BOX` 0.16 / 0.155 / 0.84 /
0.50, `PIXEL_FACE_BOX` 0.28 / 0.16 / 0.72 / 0.40). 0.80 was too tight for
EN vs JP frames of the same illustration.

Worked examples (also the extension print-langs fill when `eur` is empty):

| `public_id` | Printing | Pose |
| --- | --- | --- |
| `504600` | JP PCG Promos **PCG-P 112** | leaning |
| `233564` | EN EX Legend Maker **093/92** | same art → **artwork together** |
| `233090` | EN EX Holon Phantoms **079/110** | running → **other artwork** |
| `236234` | EN Emerging Powers **010/098** | Himeno sky |
| `271986` | JP Black Collection **004/053** | same art → **artwork together** |
| `236230` | EN Emerging Powers **009/098** | Nishida flowers → **other artwork** (not a rarity of 010) |
| `240808` | EN Guardians Rising **60/145** | Tapu Lele GX regular |
| `270564` | JP Alolan Moonlight **022/050** | same art → **artwork together** |
| `241092` | EN Guardians Rising **137/145** FA | other art → **other artwork** |
| `227266` | EN DP Black Star Promos **DP34** | Arita promo balloon |
| `557286` | JP DP Promos **031/DP-P** | same art → **artwork together** |
| `227970` | EN Diamond & Pearl **24/130** | the other Arita painting → **other artwork** |
| `256260` | EN Stormfront **16/100** | balloons / Intense Fight JP |
| `596910` | EN SV Black Star Promos **SVP 135** | different balloon art → **other artwork** |

Espurr’s 12 arts were seeded from
[test.pokoin.com/espurr](https://test.pokoin.com/espurr)
(`apply-version-sets.py`). **`/espurr` is a frozen review board**
(`market/public/review/espurr.json`, catalog-CLIP snapshot). Live clustering
is art-box CLIP then pixels — do not copy the board’s ≥0.83 leftover-catalog
rule. `test.pokoin.com/` 307s to `/sanitize`. Every other name uses this script.

`pokoin_version_sets.source = artbox-pin` is skipped on `--all` so CLIP
cannot split a confirmed stack. Fezandipiti ex regular UR `v589958` is one.
BW64 + BW-P 147 (`v222076`) is another: the JP leftover is 21 KB and leftover
pixels are ~0.233. Air Balloon (`v258812`) is an **item trainer** pin: gold
`213/202` is the same leftover painting as uncommon `156/202`, plus JP Sword,
Shiny Star V, VMAX Climax, Black Bolt, and Mega reprints. Full-Art / SIR stay
other keys. 30th Celebration JP Charizard `137/103` (`v243508`) is Arita
Base Set art with a gold frame and Pikachu stamp in the illustration box —
CLIP 0.88 to Classic `003/034`, leftover pixels 0.44. BW Promos Victini
`BW-P 234` (`v293030`) is the same Japanese leftover as CardTrader’s Noble
Victories `234/197`: the BW Promos scan is a 38 KB crop missing from
`artbox-clip.npz`, so CLIP never joined them. Ninja Spinner Tauros
`067/083` (`v756082`) is the same Satoshi Ito painting as Chaos Rising
`069/086` (`780020`): CLIP had cached the English leftover as Chinese
CSM2d `746620`, so pin those two only — do not recluster the Tauros
name. Base Set Hitmonchan `7/102` (`v222308`) is Ken Sugimori’s boxing
stance with Base Set 2, shadowless, Evolutions, JP Expansion Pack /
20th, and Best of Game; CLIP missed the unlimited TCGPlayer leftover.
Sword & Shield / Classic are Shigenori Negishi. Remaining listed Base
Set singletons after the unlimited TCGPlayer leftover (Nidoking,
Poliwrath, Venusaur, Beedrill, Raticate, Squirtle, Pokédex, Oak, Bill)
pin the same way; Classic Bill stays HGSS, Wizards Venusaur 13 stays
the open-mouth Sugimori. Same-set regular and
secret collectors (`080/084` vs `111/084`)
are never one `pokoin_version_sets` row for Pokémon / illustrated supporters
— CLIP still groups Misty-at-a-pool trainer arts; `split_secret_regular_arts`
separates them. Item trainers skip that split. JP/EN reprints of each
painting stay together.


---

## What not to show

- Every catalog row with the English name of a Pokémon (peer2 Espurr is ~35 cards). Item and trainer names are the exception: same name is the reprint.
- Same-set species mates that are not a rarity pair (Cottonee 009 vs 010)
- Union-find of JP/EN/CN into one western desk id
- Searchbar `artcut/` files on `CardTile` / the versions grid (full leftover
  scan, 63:88)
- CardTrader’s mixed tab (JP regular + JP IR + EN regular + EN IR as one list)

Prior chats: [Version work documentation](4cb496e2-2d89-4bb2-856f-03407393ab8e)
(Cacturne / illustration groups), [Current version zip file](49d5df89-6f9d-4b74-9cd3-035d1383ad1a)
(PCG-P 112 has an EN printing of that artwork).


### Manaphy promo artwork correction (18 October 2026)

SWSH275 (`473078`) and Japanese 286/S-P (`477518`) are the same NC Empire
painting. They are pinned together as `v473078` with source `artbox-pin`.
SWSH275 had incorrectly joined `v254856`, the four Shining Legends / GX Ultra
Shiny / CSMPlC printings with different artwork. The targeted, idempotent writer
correction is `scripts/sql/20261018_manaphy_espathra.sql`. The ordinary CLIP
pipeline protects `artbox-pin` membership; do not undo this with a broad
Manaphy name re-cluster that ignores protected cards.


### Wrong-artwork audit (19 October 2026)

Giuseppe's report: Pikachu BW54 (`v221412`) listed BREAKthrough 48/162, a
different painting (forest, Kouki Saitou), next to BW54 and its JP BW-P 163
Work Book stamp (Thunder art). Cause: the 2026-09-30 `artcut` pass joined
48/162 to BW54 by CLIP unique-nearest (0.909). Its true nearest (0.945, another
Pikachu) was vetoed by pixels, and the 0.40 pixel veto let 0.614 through: two
yellow Pikachu in the same spot of a green card score 0.6 on equalized 64×64
pixels. BW-P 163 then joined BW54 at pixels 0.925. The group also copied
Kouki Saitou onto BW-P 163 as a `same_artwork` illustrator.

`tools/version-artwork-audit` (Rust, own workspace) re-checks every version set
with two or more singles:

1. `features`: each member's leftover JPEG (15T replica), normalised to 63:88
   at 108×151 gray. JPEGs are decoded with `jpeg-decoder`: `image`/zune-jpeg
   decodes the 2026-10-19 HD leftovers as noise.
2. `score`: every pair inside a group is aligned over the clustering window
   (0.16 / 0.155 / 0.84 / 0.50) with a scale ±8% and shift search, then scored
   `0.5 × (median NCC of 4×3 tiles + gradient NCC)`. A stamp or holo pattern
   spoils a few tiles; another painting spoils most. Single-linkage at 0.45
   splits a group into paintings. Calibrated on 200k same-group pairs against
   39.7k medoid pairs of *different* groups of the same name (98.6% of those
   score under 0.5; a few are real reprints the clusterer left split).
3. `sheet`: contact sheets, main painting (gold frame, up to 4 cards) next to
   every other component (red frame).
4. `match`: for each card to move, the best printing of the same name in any
   other version set, so a wrong card joins its real painting (CSM2D Chinese
   prints are mostly Sun & Moon reprints).
5. `sql`: reviewed `decisions.tsv` → guarded, idempotent migration + revert.

Run 2026-10-19 (`review/2026-10-19/`): 18,702 groups, 281 flagged. Every sheet
was looked at: **208 wrong groups**, 55 false alarms (rainbow / gold / shiny
recolours of one full art, Jumbo prints, small M-P photo scans, WotC holo vs
non-holo, LEGEND 30th reprints), 8 held (Air Balloon and Drifblim pins,
placeholder leftovers, blank misprints, Pikachu Lv.14 DP-P photo backgrounds,
Nitro Energy). Ten basic-energy mass groups (14–126 printings: Fire, Water,
Grass ×2, Fighting, Psychic ×2, Lightning, Metal, DCE) were not reviewed:
energy designs need their own pass.

`scripts/sql/20261019_version_artwork_splits.sql` moves 365 printings: 99
paintings join their verified existing group (target sheets reviewed too), the
rest get their own key. Every key that receives a moved painting becomes
`artbox-pin`, so `cluster-name-version-sets.py --all` keeps the fix. When the
moved painting is the key's namesake (48/162 is `v221412`), it keeps the key and
the rest moves to `v{lowest remaining id}` (BW54 + BW-P 163 → `v222054`).
167 `same_artwork` illustrator copies that crossed a split are deleted and
`marketplace_copy_same_art_artists` refills them from the right painting.
Version page snapshots of the touched keys are deleted (the route answers live
until `build-lists-versions` rebuilds them). Backups:
`version_artwork_split_20261019`, `_sets`, `_artists`; revert with
`scripts/sql/20261019_version_artwork_splits.revert.sql`.

```bash
# nezopt writer only
docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d pokoin_marketplace \
  -v ON_ERROR_STOP=1 < scripts/sql/20261019_version_artwork_splits.sql
```

Re-run the audit after a full `--all` pass:

```bash
cd tools/version-artwork-audit && cargo build --release
B=target/release/version-artwork-audit O=/home/nez/mnt/mybook/pokoin-pi-card-images/objects
$B features --members members.tsv --objects $O --out feats.bin
$B score --members members.tsv --feats feats.bin --out-dir run --cross 10
$B sheet --groups run/flagged.tsv --members members.tsv --objects $O --out-dir sheets --rows 6
```

`members.tsv` is `version, source, card_id, ct_id, name, expansion_name,
card_number, rarity, artist, image_url, item_kind, product_type` for every
version with two or more members: `tools/version-artwork-audit/export-members.sql`.


### Classic deck joins (20 October 2026)

Giuseppe's report: on the artist album, Ponyta Astral Radiance 021/189 and Pokémon TCG
Classic Charizard & Ho-Oh ex 004/034 were two tiles of one painting. The English Classic
printing (`538522`) was a singleton key; CLIP missed it on the decks' textured foil scan.
Its Japanese twin 004/032 already sat in `v425492`.

`version-artwork-audit match` scored all 204 printings of the six Classic expansions (EN and
JP Charizard & Ho-Oh ex, Blastoise & Suicune ex, Venusaur & Lugia ex) against every
printing of the same name, then every flagged name was checked on contact sheets. The miss
is wider than Classic: the WotC paintings those decks reprint were split over Base Set,
Base Set 2, Evolutions + JP 20th Anniversary, JP Expansion Pack, 25th Anniversary,
Celebrations and Pokémon Card★web keys, and each Classic card had joined one fragment
(Base Set Charizard was eight keys). `scripts/sql/20261020_classic_deck_version_joins.sql`
folds every fragment of each painting into one key: 31 paintings, 64 keys emptied, 116
printings moved. The receiving key is the existing `artbox-pin`, else a key with an art
layout and the most members. Receiving keys become `artbox-pin`; emptied keys keep their
row with `member_count` 0. Kept apart, as different paintings: Charmander Intense Fight
UR 90/092, the 25th Anniversary / Celebrations forest Pikachu (`v322298`), and the CSM2D
Double Colorless Energy (Sun & Moon design). Review files:
`tools/version-artwork-audit/review/2026-10-20-classic/`. Backups:
`version_artwork_join_20261020`, `_sets`, `_artists`; revert with the `.revert.sql`
alongside.

```bash
# nezopt writer only
docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d pokoin_marketplace \
  -v ON_ERROR_STOP=1 < scripts/sql/20261020_classic_deck_version_joins.sql
```

To look for missed joins of other cards the same way, export the same-name pool
(`review/2026-10-20-classic/export-pool.sql`), run `features` on it, then
`match --cards ids.txt --pool pool.tsv --feats feats.bin --out match.tsv --top 6`: a card
whose best score sits in another key (≥ 0.85 here) is a candidate for a sheet.

### Reverse-holo pattern joins (22 October 2026)

Giuseppe's report: Gem Pack Vol.6 (CBB6C) looked missing from versions. Lileep itself was
fine (the six reverse holos 09-01..06/07 sit with Stellar Crown 005/142 in `v587906`, the
SIR 09-07/07 with the Stellar Crown IR 145/142 in `v590098`), but across the catalogue the
reverse-holo pattern blueprints CardTrader lists next to a card were often split from it:
Black Bolt 049/086 vs its Poké Ball / Master Ball Reverse Holo, CSV9C 002/208 vs
`CSV9C | Poké Ball Reverse | 002/208`, Ascended Heroes / MEGA Dream ex Energy and Ball &
Rocket reverses, and Gem Pack slots whose six reverse holos landed on 3–4 keys (13 slots of
Gem Pack Vol.5). The foil overlay drops CLIP under its thresholds.

`scripts/sql/20261022_reverse_pattern_version_joins.sql` adds
`marketplace_join_reverse_pattern_versions(p_apply)`. Same name + same set family (set
name before ` - ` / `:`) + same printed n/m, with at least one reverse label, is one card;
so are a Gem Pack slot's variants 01..06 (07 is the IR/SIR, another painting). It
union-finds the version keys of those printings and folds them into one: pinned sources
first, then the larger set; a singleton receiver becomes `reverse-pattern`. A key or chain
that would add a second illustrator is skipped (D000095): CardTrader shipped the CSV10C
Master Ball Reverse Porygon 172/222 with the Porygon2 173 scan, so CLIP filed it with
Porygon2. First run: 178 receiving keys, 302 keys emptied, 466 printings moved.

`scripts/match-imported-version-sets.sh` and the leftover ingest run it after every CLIP
match, because re-clustering a name bucket resets those printings. A full
`version-sets-pipeline.sh` pass does not yet; run the apply after it:

```bash
# nezopt writer only
docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d pokoin_marketplace \
  -v ON_ERROR_STOP=1 < scripts/sql/20261022_reverse_pattern_version_joins.sql
docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d pokoin_marketplace \
  -c "SELECT * FROM public.marketplace_join_reverse_pattern_versions();"      # plan
docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace -d pokoin_marketplace \
  -c "SELECT * FROM public.marketplace_join_reverse_pattern_versions(true);"  # apply
```

Backups of the first run: `version_reverse_pattern_join_20261022` (card_id, old version)
and `version_reverse_pattern_join_20261022_sets` (version-set rows before the run).

Not fixed by this, because the CardTrader scan itself is another card: Gem Pack Vol.6
Clobbopus 22-01..07 shows Munkidori 27, Cufant 23-01..07 shows Fezandipiti 28, Castform
Sunny Form SIR 10-07 is the Lileep SIR file, Appletun SIR 21-07 shows Okidogi 26-07. Their
reverse holos now share one key per slot; they cannot join the real painting until the
scan is right.
