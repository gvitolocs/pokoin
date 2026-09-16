# Print flags (JP / CN)

React is live. **Flutter must copy this**, not invent a second mapping.

Source of truth: `pokoin_pokemon_expansions.nationality` on Oracle
(`pokoin-marketplace`). Do **not** regex the English set name in the client.
Flutter already has `_regionForExpansion()` in
`lib/screens/collection_screen.dart` (name heuristics). That helper misses
English-named Japanese sets such as **World Champions Pack**. Flags and the
Occidental / Japanese / Chinese chips should read `expansion.nationality`
once the field is on the model. Leftover Japanese **products** that were
stored western (City Gym / Quick Construction / Intro Pack / Battle Starter /
Pokémon Jungle `jun` / Mystery of the Fossils `myf` / Holon Phantoms `hof`)
are `japanese` (jpko). English Jungle `ju`, Fossil `fo`, and EX Holon Phantoms
`hp` stay western. Pin: `scripts/pin-jp-leftover-products.py`.

---

## Values

| `nationality` | Flag | Asset | Surfaces |
| --- | --- | --- | --- |
| `japanese` | Japan + Korea | `/flags/jpko.svg` | suggest + set title; versions text `JP` |
| `chinese` | China | `/flags/zh.svg` | suggest + set title; versions text `CN` |
| `western` | US + EU | `/flags/euus.svg` (`euus.png` raster) | suggest + set title; versions text `EN` |
| `european` / `eu` | Europe | `/flags/eu.png` (`eu.svg` source) | EU-exclusive prints |
| `american` / `us` | United States | `/flags/us.svg` (`us.png` raster) | US-exclusive prints |
| `korean` | South Korea | `/flags/ko.svg` (`ko.png` raster) | suggest + set title; versions text `KO` |
| `indonesian` | Indonesia | `/flags/id.svg` | leftover Indonesian body text (Kelemahan / Mundur) |
| `thai` | Thailand | `/flags/th.svg` | leftover Thai body text |
| `idth` | Indonesia + Thailand | `/flags/idth.svg` | mixed ID+TH leftover dump |
| `french` / `fr` | France | `/flags/fr.svg` | French-exclusive leftovers |
| `german` / `de` | Germany | `/flags/de.svg` | German-exclusive leftovers |
| `american` / `us` | United States | `/flags/us.svg` (`us.png` raster) | US-exclusive leftovers |
| `product` | none | — | — |
| `unknown` / empty | none | — | — |

One flag per set. Never JP and CN together. Circle-flags SVGs in
`market/public/flags/` (`jp.svg`, `zh.svg`, `eu.svg`, `us.svg`, `ko.svg`).
Western expansions use the **US/EU split** (`euus.svg`). Japanese and
Korean expansions use the **JP/KO split** (`jpko.svg`), not the hinomaru
or Taegeukgi alone. `flagSrc` in `market/src/locale.js` (`jp`/`zh`/`euus`/
`jpko` SVG, `eu` PNG). Helper: `printFlagFromNationality(nationality)` →
`{ code, label }` or `null`. `jp.svg` remains the **title-language** chip.
Korean print uses `ko.svg` (Taegeukgi), not the JP/KO split.

### Western split (`euus`)

Diagonal circle: United States (top-left) + European Union (bottom-right).
That is the mark for English-language sets such as Celebrations — EN prints
sold in both the US and Europe.

| File | What |
| --- | --- |
| `euus.svg` | Vector (HatScripts US + EU halves, same 512 circle as `jp.svg`) |
| `euus.png` | Lossless circular raster of the supplied US/EU art (transparent corners) |
| `eu.svg` / `eu.png` | EU disc only — keep for Europe-exclusive cards |
| `us.svg` / `us.png` | US disc only — keep for US-exclusive cards |
| `idth.svg` | Vector (HatScripts ID + TH halves, same 512 circle as `euus.svg`) |
| `jp.svg` | Japan disc only — title language, not the Japanese print mark |
| `ko.svg` / `ko.png` | South Korea disc — Korean print (`nationality=korean`) |

Do not point western set titles at `eu.png`. SPA `img` src for western is
`euus.svg` (`flagSrc('euus')`).

### Japanese / Korean split (`jpko`)

Diagonal circle: Japan (top-left) + South Korea (bottom-right). Same layout
as `euus`. **Japanese** expansions use this mark. Korean-only expansions
(Scarlet & Violet Korean Promos) use the Taegeukgi (`ko.svg`), not `jpko`.

SPA `img` src for `nationality=japanese` is `jpko.svg` (`flagSrc('jpko')`).
`nationality=korean` is `ko.svg` (`flagSrc('ko')`). Versions text badges
stay `JP` / `KO`. The search print-language pill has Western / Japanese /
Korean / Chinese.

Versions **same-artwork** tiles add a **text** `JP` / `EN` / `CN` / `KO` badge (`.espurr-flag`), not
the circle SVG and not `printFlagFromNationality` on `CardTile`. Rarity-version
tiles in the same set skip the flag.

---

## Classifier (why World Champions Pack was western)

World Champions Pack is a **Japanese exclusive** (2007-07-05, 108 cards,
TCGDex `PCG10`, ワールドチャンピオンズパック). CardTrader `code` is `wcp`.

Live row **before** `030_tcgdex_ja_nationality.sql`:

- `official_id=PCG10`, `official_name=ワールドチャンピオンズパック`,
  `official_source=tcgdex-ja`, `kind=official`, `listed=true`
- `nationality=western`, `milo_gallery=western` ← wrong
- 108 blueprints, **zero** `pokemon_language` votes (no jp, no en)

`pokoin_refresh_expansion_nationality()` then fell through to
`pokoin_expansion_nationality('wcp', 'World Champions Pack')` → `western`
because the English name looks like the western **World Championship Decks**
(`wcd2004`…; those stay western).

Same miss (all `official_source=tcgdex-ja` but stored western):

| code | name | official_id |
| --- | --- | --- |
| `wcp` | World Champions Pack | PCG10 |
| `cbs` | Clash of the Blue Sky | PCG2 |
| `cfm` | Cry from the Mysterious | PCG7 |
| `hrt` | Holon Research Tower | PCG6 |
| `mic` | Miracle Crystal | PCG8 |
| `uns` | Undone Seal | ADV5 |

Schema `cardvault/pokemon_card_vault/oracle-postgres/schema/030_tcgdex_ja_nationality.sql` pins
`official_source=tcgdex-ja` → `japanese` (and `tcgdex-zh-cn` → `chinese`)
**before** the language vote, and lists those codes in
`pokoin_expansion_nationality()`. Do not pin `wcd*`.

A second miss: Japanese **Neo** sets whose CardTrader name is the English
translation of the JP title, aliased to the western pokemontcg.io id
(`neo1`/`neo2`/`neo3`). Zero `pokemon_language` votes → western EU flag on
Japanese scans. English Neo Genesis / Discovery / Revelation stay `n1`/`n2`/`n3`.

Same miss for **Rocket Gang** (`rog`, ロケット団, 64 cards): `official_id=base4`
(Base Set 2). English **Team Rocket** is `tr` / `base5` (83 cards) and stays
western. Schema `034_jp_rocket_gang.sql` pins `rog`. Do not pin `tr`.

| code | Japanese set | Not this western set |
| --- | --- | --- |
| `awl` | Awakening Legends (めざめる伝説, 57) | `n3` Neo Revelation (66) |
| `ctr` | Crossing the Ruins... | `n2` Neo Discovery |
| `gstnw` | Gold, Silver, to a New World... | `n1` Neo Genesis |
| `awlpf` / `neojp` / `n1pf` | matching JP premium files | — |

Schema `031_jp_neo_english_names.sql` pins those codes (and the English JP
titles) as `japanese`. `del` Darkness, and to Light... was already japanese.
`034_jp_rocket_gang.sql` pins `rog` / `^rocket gang`.

Same miss for Japanese **Deck Kit** / **Half Deck** products (シルバーデッキキット,
ロケット団ハーフデッキW -black-). CardTrader's English name is "Silver Deck Kit" /
"Black Deck Kit"; zero language votes → western EU flag.

Do **not** regex `deck kit` or `half deck`. English **Trainer Kits** (EX / DP /
HS / BW / XY / SM) are also Half Deck products, released in English and
European languages. Schema `039_jp_deck_kit.sql` pins the Japanese products
**by exact name** (leftover face + Bulbapedia). English Trainer Kits stay
western. Latias **ex** Half Deck is the JP Gift Box (ヒトカゲ 001/018), not the
English EX Trainer Kit Latias half.

| name | Japanese product |
| --- | --- |
| Silver Deck Kit | シルバーデッキキット |
| Black Deck Kit | ロケット団ハーフデッキW -black- |
| Aqua / Magma Deck Kit | アクア団 / マグマ団ハーフデッキW |
| Magmortar vs Electivire Deck Kit | マグモットVSエレキブル |
| Ash vs Team Rocket Deck Kit | サトシVSロケット団 |

Same miss for **L-P Promo** (`l-ppromo`): Japanese LEGEND-era L-P Promotional
cards (メガニウム 001/L-P). English HGSS Black Star Promos stay western.
Schema `040_jp_l_p_promo.sql` pins `l-ppromo` / `L-P Promo`. Do not regex
`Promo`.

Same miss for CardTrader **CS*** letter suffixes. `025` already said CS* is
mainland Chinese, but `pokoin_expansion_nationality()` only matched
`cs[mv0-9]` / `csv` / `csm` / `cbb`. Codes like `csdc` (Pikachu Legendary
Celebration, leftover 皮卡丘 CSDC 001/024) and `csf` (Return of the Dragon)
had zero language votes → western EUUS flag on Simplified Chinese scans.

Schema `041_cn_cs_codes.sql` widens the pin to `^(cs|cbb)`. Gem Pack / CS1a
stay chinese. Do not regex the English set name in the SPA.

| code | Chinese set |
| --- | --- |
| `csdc` | Pikachu Legendary Celebration |
| `csf` | Return of the Dragon |
| `csb` | Primordial Arts Deck Building Gift Box |
| `csgc` / `csuc` | Display Set Gift Box Eevee / Gengar |
| `csh` | Eevee GX Gift Box |
| `csi` | Sword & Shield Trainer Collection Gift Box |

Same miss for CardTrader **`30th-ch`**: 30th Anniversary Celebration: First
Partner Illustration Collection. Classifier pinned `30thc` (30th Celebration
Simplified Chinese) but not `30th-ch`. Zero `pokemon_language` votes → western
EUUS flag on Simplified Chinese scans. Schema
`scripts/sql/065_cn_30th_ch_first_partner.sql` pins `30th-ch`. English
**First Partner Pack** (`1stpp`) stays western. Do not regex `first partner`.

| code | Chinese set | Not this western set |
| --- | --- | --- |
| `30th-ch` | 30th Anniversary Celebration: First Partner Illustration Collection | `1stpp` First Partner Pack |
| `30thc` | 30th Celebration Simplified Chinese | `30c` 30th Celebration |

Same miss for **Megalo Cannon** (`bw9`): Japanese BW9 メガロキャノン. Sanitize
aliased it to tcgdex-en Plasma Freeze. Zero `pokemon_language` votes → western
EUUS flag on Japanese scans. English **Plasma Freeze** stays `plf`. Schema
`043_jp_megalo_cannon.sql` pins `bw9` / `Megalo Cannon`. Do not pin `plf`.

| code | Japanese set | Not this western set |
| --- | --- | --- |
| `bw9` | Megalo Cannon (メガロキャノン) | `plf` Plasma Freeze |

Same miss for **Gym Booster 1 Leaders' Stadium** (`gls`, リーダーズスタジアム)
and **Gym Booster 2: Challenge from the Darkness** (`gcd`, 闇からの挑戦).
Sanitize aliased them to pokemontcg.io `gym1` / `gym2`. Zero
`pokemon_language` votes → western EUUS flag on Japanese scans. English
**Gym Heroes** stays `g1`. English **Gym Challenge** stays `g2`. Schema
`049_jp_gym_booster.sql` pins `gcd` / `gls` and names matching `gym booster`.
Do not pin `g1` / `g2` / `gym1` / `gym2`.

| code | Japanese set | Not this western set |
| --- | --- | --- |
| `gls` | Gym Booster 1 Leaders' Stadium (リーダーズスタジアム) | `g1` Gym Heroes |
| `gcd` | Gym Booster 2: Challenge from the Darkness (闇からの挑戦) | `g2` Gym Challenge |

Same miss for **Eevee GX Starter Sets** (`sml`): Japanese SM exclusive
スターターセット「炎のブースターGX」「水のシャワーズGX」「雷のサンダースGX」
(TCGDex `SMI`, 2018-11-23). CardTrader English name, zero
`pokemon_language` votes → western EUUS flag on Japanese scans. Schema
`050_jp_eevee_gx_starter.sql` pins `sml` / `Eevee GX Starter Sets`. Do **not**
regex `starter set` — English **XY Kalos Starter Set** (`kss`) stays western.
Do not pin Chinese Eevee GX gift boxes (`csh` / `csmy`).

| code | Japanese set | Not this set |
| --- | --- | --- |
| `sml` | Eevee GX Starter Sets (スターターセット 炎のブースターGX / 水のシャワーズGX / 雷のサンダースGX) | `kss` XY Kalos Starter Set |

### Ampersand set desks

JS `slugify` turns `&` into ` and ` (`Scarlet & Violet` →
`scarlet-and-violet`). SQL `regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')`
turns `&` into a hyphen, so `readExpansionBySlug` misses
`pokoin_pokemon_expansions` and falls through to
`marketplace_set_card_counts` with **empty nationality**. Every `&` set desk
(Marnie starter, Scarlet & Violet, Black & White, …) then has no title flag
even when the index row is already `japanese` / `western`. Use
`replace(name, '&', ' and ')` before the regexp (API
`expansionSlugSql`). Do not regex set names in the SPA.

### SEA leftovers (visual)

`pokoin_expansion_nationality()` used to map any Thailand / Indonesia name
to `unknown` (no flag). Leftover faces:

| Expansion | Leftover | Pin |
| --- | --- | --- |
| Scarlet & Violet Indonesian Promos | Eevee 074/SV-P Indonesian body (`Kelemahan`, `Mundur`); Fanfare Perayaan | `indonesian` → `id.svg` |
| Thailand & Indonesia Products | Eevee 228/SV-P Indonesian **and** Eevee 225/SV-P Thai (`อีวุย`) | `idth` → `idth.svg` (ID top-left, TH bottom-right) |

McDonald’s leftover faces: English Collection / Match Battle / Dragon Discovery
are US English (`american` → `us.svg`). `McDonald's Collection 2013 French` and
`2018 French` are French (`Évoli`, `Nounourson`) → `french` / `fr.svg`.
`Trick or Trade` leftover is English Halloween (`Zubat` 089/163) → `american`.
No German-exclusive expansion is in the catalog (no leftover to pin).
Japanese `McDonald's Pokémon-e Minimum Pack` stays `japanese`.

Schema `046_exclusive_print_flags.sql`. Do not mark Indonesian leftovers
`western` / EUUS.

---

## APIs

Both payloads now include `expansion.nationality` (lowercase string, may be
`""`).

| Client | Endpoint | Notes |
| --- | --- | --- |
| React set desk | `GET /api/marketplace-expansion-page?slug=` | `readExpansionBySlug` + `rowsForExpansions` |
| React set index | same handler with no slug | `expansions[].nationality` |
| Search suggest | `GET /api/marketplace-suggest?q=` | `printing.nationality` via CardVault API `_expansion_nationality.js`. Popup 20-cap: western **tie-break** on equal Meili points (CardVault API `_suggest_western_priority.js`), not a weight change. Empty leftover nationality falls back to the expansion row (`SET_POOL` / `expansion.nationality`) so HeartGold Collection still shows jpko. |
| Flutter collection | `GET /api/marketplace-expansions?slug=&includeCards=1` | `snapshotForExpansion` uses `rowsForExpansions` — same field. Prefer expansion-page long-term. |

Do not derive flags from `expansion.code` or `official_name` in the SPA.

---

## React surfaces (done)

| Surface | File | Placement | Class |
| --- | --- | --- | --- |
| Search suggest | `Chrome.jsx` | Desktop: left of `.suggest-art`. Phone `≤720px`: overlay on the crop. Flag still shows if leftover art is missing. | `.suggest-print-flag` |
| Set desk title | `Expansion.jsx` → `PageHead` | Left of `h1.page-title` only. Yellow SET kicker stays above. Gray “N cards” lede stays below. | `.page-print-flag` |
| Sets / Era tiles | `SetGuideGrid.jsx` | Left of the set name. Not on the wordmark and not on the circular ExpansionMark fallback. | `.set-guide-print-flag` |

**Not** on `CardTile` / home rails / cart / wallet / forum.
Cart and other `PageHead`s omit `printFlag`.

Look: circular **2.4rem** suggest / **2.7rem** set-title / **1.7rem** set-tile flag (2× the old 1.2–1.35rem on suggest and desk), `border-radius: 50%`, `alt=""` + `.sr-only`
label (`Japanese print` / `Chinese print` / `Western print` / `Korean print`). Western is the
US/EU split (`euus.svg`). Japanese is the JP/KO split (`jpko.svg`). Korean-only
sets are the Taegeukgi (`ko.svg`).

Set-page lists cache (`fetchExpansionFromLists`) often has tiles but no
`nationality`. Promo slugs (`set:storm-emeralda` …) can fill that rail.
The set desk still walks expansion-page in 48-row chunks, but **does not
paint** until `hasMore === false`. Title flag can land from expansion
metadata while skeletons show. [MARKET.md](MARKET.md#set-desk-first-paint).
`fetchExpansion` still starts expansion-page in parallel and merges
`expansion.nationality` on that metadata hop. Do not await a stalled Oracle
BFF before the walk (Mega Evolution 30s timeout).

---

## Flutter port (CardVault)

Do this in `gvitolocs/cardvault`, not this repo. Public pokoin.com stays React.

### 1. Model

`lib/services/card_service.dart` `MarketplaceExpansion`:

```dart
final String nationality; // 'japanese' | 'chinese' | 'western' | …

factory MarketplaceExpansion.fromJson(Map<String, dynamic> json) {
  return MarketplaceExpansion(
    // existing fields…
    nationality: '${json['nationality'] ?? ''}'.trim().toLowerCase(),
  );
}
```

### 2. Mapping (copy React)

```dart
({String code, String label})? printFlagFromNationality(String nationality) {
  switch (nationality) {
    case 'japanese':
      return (code: 'jpko', label: 'Japanese print');
    case 'chinese':
      return (code: 'zh', label: 'Chinese print');
    case 'korean':
      return (code: 'ko', label: 'Korean print');
    case 'western':
      return (code: 'euus', label: 'Western print');
    case 'european':
    case 'eu':
      return (code: 'eu', label: 'European print');
    case 'american':
    case 'us':
      return (code: 'us', label: 'English print');
    default:
      return null;
  }
}
```

Assets: vendor `jpko.svg` (Japanese print), `ko.svg` (Korean print), `zh.svg`, `euus.svg`
(western), `jp.svg` (title language), `eu.png` / `eu.svg` (EU-only),
`us.svg` / `us.png` (US-only) from `market/public/flags/`. Circle crop, ~40px.
Western `flagSrc` is `euus.svg`. Japanese print `flagSrc` is `jpko.svg`.
Korean print `flagSrc` is `ko.svg`.

### 3. Set desk header

`lib/screens/collection_screen.dart`

- Screen: `CollectionExpansionScreen`
- Header widget: `_SelectedExpansionHeader` (back + `'$name · $count cards'`)
- Put the circular flag **left of the set name**, same visual slot as React
  `h1.page-title`.
- Pass `snapshot.expansion.nationality`. Do not call `_regionForExpansion(name)`.

### 4. Search suggest

When Flutter grows a CardTrader-style suggest row, put the same flag **left
of the illustration crop** on desktop (React `.suggest-art`). On phone, overlay
it on that crop. Not on the mini full-card thumb. Printing field:
`nationality` on `GET /api/marketplace-suggest`.

### 5. Region chips

`_regionForExpansion(String expansion)` classifies from the name. World
Champions Pack currently becomes `_ExpansionRegion.occidental`. Switch the
Occidental / Japanese / Chinese filter to `expansion.nationality`:

- `japanese` → Japanese
- `chinese` → Chinese
- `korean` → Korean
- else → Occidental (western / product / empty)

Keep the name regex only as a fallback if `nationality` is empty.

### 6. Verify

| Set | slug | flag |
| --- | --- | --- |
| World Champions Pack | `world-champions-pack` | JPKO |
| Gem Pack Vol.1 | `gem-pack-vol-1` | CN |
| Pikachu Legendary Celebration | `csdc-pikachu-legendary-celebration` | CN |
| Return of the Dragon | `csf-return-of-the-dragon` | CN |
| Storm Emeralda | `storm-emeralda` | JPKO |
| Rocket Gang | `rocket-gang` | JPKO |
| Gym Booster 1 Leaders' Stadium | `gym-booster-1-leaders-stadium` | JPKO |
| Gym Booster 2: Challenge from the Darkness | `gym-booster-2-challenge-from-the-darkness` | JPKO |
| Gym Heroes | `gym-heroes` | EUUS |
| Gym Challenge | `gym-challenge` | EUUS |
| Silver Deck Kit | `silver-deck-kit` | JPKO |
| Black Deck Kit | `black-deck-kit` | JPKO |
| L-P Promo | `l-p-promo` | JPKO |
| EX Trainer Kit 2 (Minun) | `ex-trainer-kit-2-minun` | EUUS |
| Team Rocket | `team-rocket` | EUUS |
| Phantasmal Flames | `phantasmal-flames` | EUUS |
| Celebrations | `celebrations` | EUUS |
| Scarlet & Violet Korean Promos | `scarlet-and-violet-korean-promos` | KO |
| World Championship Decks 2018 | (if listed) | EUUS |

---

## Audit 5 Sep 2026 — do not flip these

Leftover faces checked after WCP. **Nationality is already right** on
the remaining “weird stamp” rows. Do not map `official_source` to the
flag by itself.

| Bucket | Count | Face language | Flag | What is wrong |
| --- | --- | --- | --- | --- |
| `tcgdex-ja` not japanese | 0 | — | — | WCP + 5 PCG/ADV pins already applied |
| `pokemontcg.io` + japanese | 5 | Japanese (Beginning Set Serperior, Darkness Venonat, Best of XY Oddish, …) | JP | `official_id` is the English counterpart (HGSS Black Star Promos, Neo Destiny, XY, Skyridge, Stormfront) |
| `tcgdex-zh-tw` + japanese | 21 listed | Japanese (Zacian V sJ, Nest Ball SVB, Pineco sv1V, Ponyta svHK, …) | JP | Taiwan TCGDex id stamped on a JP product |
| `tcgdex-en` + japanese listed | 2 | Japanese (Glory of Team Rocket ロケット団のニャース) | JP | English TCGDex id is the western counterpart (Destined Rivals). Keep JP. |
| Gem Pack / CS1a | controls | Simplified Chinese | CN | Correct |

UI: flags on suggest (left of art-cut), set-desk title, and Sets / Era
catalog tiles (left of the set name). Artist desks use four print chips
left of the searchbar (`euus` / `jpko` / `zh` / `id`); default is western.
Korean print sits on jpko there. Indonesian leftovers (`nationality=indonesian`
and mixed `idth`) sit on the Indonesia chip, not western. Home `CardTile`s
have **no** print flags. The album mounts 24 tiles and loads more as you
scroll.
