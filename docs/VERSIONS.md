# Versions tab (rarities vs same artwork)

Desk **More versions...** and `{canonicalPath}/versions` are **not**
CardTrader’s dump. CardTrader’s Espurr Nihil Zero IR tab is four products:
JP regular, JP illustration rare, EN regular, EN illustration rare. Pokoin
splits that:

| Section | What | Not |
| --- | --- | --- |
| **Rarity Lineup** | Other **rarities** of this card in **this set** (regular ↔ illustration rare ↔ reverse / poké ball of the same collector). Secret numbers (`087/080`) pair with the in-set card (`032/080`). FA / SIR / gold secrets of the same name join that same lineup (Storm Emeralda Mega Rayquaza 058 / 095 / 110 / 113). | Language. Two different arts of the same species in the set (Cottonee **009** and **010**). |
| **Era grids** | CLIP printings of this name/illustration, grouped by TCG block. Same-era full-art / gold is still that era, not a reprint. JP/EN/CN stay in the same block. Full EN/JP/CN expansion lists: [TCG_ERAS.md](TCG_ERAS.md). | |
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

- Every catalog row with the English name (peer2 Espurr is ~35 cards)
- Same-set species mates that are not a rarity pair (Cottonee 009 vs 010)
- Union-find of JP/EN/CN into one western desk id
- Searchbar `artcut/` files on `CardTile` / the versions grid (full leftover
  scan, 63:88)
- CardTrader’s mixed tab (JP regular + JP IR + EN regular + EN IR as one list)

Prior chats: [Version work documentation](4cb496e2-2d89-4bb2-856f-03407393ab8e)
(Cacturne / illustration groups), [Current version zip file](49d5df89-6f9d-4b74-9cd3-035d1383ad1a)
(PCG-P 112 has an EN printing of that artwork).
