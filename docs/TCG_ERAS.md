# Pokémon TCG eras (EN / JP / CN)

Source of truth for versions grids (`tcgEra` in
[`market/src/tcg-eras.js`](../market/src/tcg-eras.js)) and set-index headings on
`/marketplace/sets`. **JP/EN/CN of the same generation stay together** on
`/versions`. The sets index **Japanese** chip uses the same TCG era headings as
western (Mega Evolution → Original). **Chinese** uses the catalog year ranges
(`2025–present`, `2023–2025`, …) newest first, not Scarlet & Violet labels.
Western era chips include Japanese of that block and exclude Chinese. `/marketplace/eras/japanese`
stays a nationality bucket.

Do **not** invent a Japanese equivalent for English reprint products. Japanese
sets often split or merge when they become international expansions — keep
each product on its real era, not a fake 1:1 slug map.

Classifier order: **Chinese set code → dated product (WCD / McDonald’s / POP / Trick or Trade) → exact alias → official name → Other**.
Do not add every CardTrader spelling as an official expansion. Display order
(newest first) is `TCG_ERA_ORDER`. Mixed-era **expansions** stay **Other** on
`/marketplace/sets` (League Promos, CoroCoro, Prize Pack Series, Products,
Yu Nagaba SWSH+SV, W Promos Original–Neo). On `/versions`, those **printings**
inherit the CLIP same-art set’s era (`inheritEraFromArtwork`) instead of an
Other grid. P / T stamp series are e-Card. Southeast Asia Gym Promos are
Scarlet & Violet. Thailand & Indonesia Products are Sun & Moon. Pokémon
Misprints is Original.

---

## Aliases

CardTrader English titles and Simplified Chinese codes. Code wins over title.

### XY
- Premium Champion Pack
- Premium Champion Pack EX×M×BREAK

### Sword & Shield
- Explosive Walker
- Explosive Flame Walker
- Matchless Fighters
- Peerless Fighters
- Shocking Volt Tackle
- Amazing Volt Tackle
- Towering Perfection
- Skyscraping Perfection
- 25th Anniversary Edition
- 25th Anniversary Golden Box

Chinese codes (CSV is Scarlet & Violet — do not use a bare `CS*` rule):
- `CSV*` → Scarlet & Violet (includes CSVE / CSVH / CSVL / CSVNC)
- `ME1` / `ME-P` / `MEP` → Mega Evolution (not `MEGA…` product names)
- `CS1*`–`CS6*` · `CSF` / `CSFC` · `CSDC` · `CSGC` · `CSUC` · `CSH` / `CSHC` → Sword & Shield
- `CSM*` stays Sun & Moon (including CSMA). Do not put CSMA gift boxes on
  `/marketplace/eras/platinum` because the title contains Arceus.

Title backups if the code is missing: Primordial Martial Arts = Primordial Arts;
Nine Colors Gathering; Brave Enchanting Stars = Brave Stars; Azure Shadow =
Shadow of the Blue Sea; Return of the Dragon = Dragon Resurgence; Brilliant
Fantasy ≈ Brilliant Illusions.

### Scarlet & Violet
- Hot Wind Arena
- Heat Wave Arena
- Transformation Mask
- Mask of Change
- Collection Sheet Journey Partners
- Generations Start Decks — Japanese SV start-deck line (`svm`). Longer alias
  so `generations-start-decks` does not prefix-match XY catalog **Generations**.
  Keep official EN Generations / Generations Promos on XY. Do not regex
  `generations` or `start deck`.

### Mega Evolution
- MEGA Start Deck 100 Battle Collection
- MEGA Start Deck 100 Battle Collection CoroCoro / Corociao Version
- Premium Trainer Box MEGA
- 30th Anniversary Celebration: First Partner Illustration Collection — explicit
  catalog-era override (30th-P promos, not an `ME*` match)

### Dated products
- World Championship Decks: 2004–2007 EX · 2008 DP · 2009–2010 HGSS · 2011–2013 BW · 2014–2016 XY · 2017–2019 SM · 2022–2023 SWSH · 2024–2025 SV. Yokohama 2023 Pikachu deck is **Scarlet & Violet**, not SWSH.
- McDonald’s Collection: 2011–2013 BW · 2014–2016 XY · 2017–2019 SM. 25th Anniversary SWSH. Dragon Discovery SV. Match Battle 2022 SWSH / 2023 SV. Pokémon-e Minimum Pack e-Card.
- POP Series 1–5 EX · 6–8 DP · 9 Platinum
- Trick or Trade 2022 SWSH · 2023 / 2024 SV

Decks, gym kits, movie packs, and single-era promo lines are aliases in
`TCG_ERA_ALIASES` (L-P Promo → HGSS, PCG Promos → EX, P / T Promos → e-Card,
Start Deck 100 → SWSH, …). `PPP Promos` stays Diamond & Pearl (longer needle
than `P Promos`).

---

## Mega Evolution — 2025–present

- **EN:** Mega Evolution · Phantasmal Flames · Ascended Heroes · Perfect Order · Chaos Rising · Pitch Black · 30th Celebration (16 Sep 2026) · Delta Reign (upcoming)
- **JP:** Mega Brave · Mega Symphonia · Inferno X · MEGA Dream ex · Nihil Zero · Ninja Spinner · Abyss Eye · Storm Emeralda · 30th Celebration (16 Sep 2026) · Aura Seeker (announced)
- **CN:** M-P promotional cards. 30th Celebration is global Simplified Chinese on 16 Sep 2026. No mainland MEGA catch-up block yet (as of 11 Sep 2026).

---

## Scarlet & Violet — 2023–2025

- **EN:** Scarlet & Violet · Paldea Evolved · Obsidian Flames · 151 · Paradox Rift · Paldean Fates · Temporal Forces · Twilight Masquerade · Shrouded Fable · Stellar Crown · Surging Sparks · Prismatic Evolutions · Journey Together · Destined Rivals · Black Bolt · White Flare
- **JP main:** Scarlet ex · Violet ex · Snow Hazard · Clay Burst · Ruler of the Black Flame · Ancient Roar · Future Flash · Wild Force · Cyber Judge · Transformation Mask · Stellar Miracle · Super Electric Breaker · Battle Partners · Glory of the Rocket Gang · Black Bolt · White Flare
- **JP enhanced:** Triplet Beat · Pokémon Card 151 · Raging Surf · Crimson Haze · Night Wanderer · Paradise Dragona · Hot Wind Arena · Shiny Treasure ex · Terastal Fest ex
- **CN:** Gem Pack Vol. 1 · Ancient Times, Future Progress · Collection 151: Journey · Miracle Journey · Collection 151: Hope · Fearless Terastal · Gem Pack Vol. 2 · Journey Theme Pack · Bonus Round · Collection 151: Scare · Ardent Obsidian · Gem Pack Vol. 3 · Collection 151: Gather · Arcane Truth · Travel Theme Pack · Blade Awakening · Gem Pack Vol. 4 · Sparkling Fable · Gem Pack Vol. 5 · Stellar Crystal · Kitakami Theme Pack · Terastal Gathering · Together in Pursuit of Glory · Gem Pack Vol. 6

Mainland CN is catch-up: Blade Awakening mixes Japanese Wild Force, Cyber Judge, and Crimson Haze. Do not treat those as English Paldea translations.

---

## Sword & Shield — 2019/2020–2023

- **EN:** Sword & Shield · Rebel Clash · Darkness Ablaze · Champion’s Path · Vivid Voltage · Shining Fates · Battle Styles · Chilling Reign · Evolving Skies · Celebrations · Fusion Strike · Brilliant Stars · Astral Radiance · Pokémon GO · Lost Origin · Silver Tempest · Crown Zenith
- **JP main:** Sword · Shield · Rebellion Crash · Infinity Zone · Amazing Volt Tackle · Single Strike Master · Rapid Strike Master · Silver Lance · Jet-Black Spirit · Skyscraping Perfection · Blue Sky Stream · Fusion Arts · Star Birth · Time Gazer · Space Juggler · Lost Abyss · Paradigm Trigger
- **JP enhanced:** VMAX Rising · Explosive Walker · Legendary Heartbeat · Peerless Fighters · Eevee Heroes · 25th Anniversary Collection · Battle Region · Dark Phantasma · Pokémon GO · Incandescent Arcana · Shiny Star V · VMAX Climax · VSTAR Universe
- **CN:** Dynamax Clash: Thunder / Flame · Dynamax Tactics · Vivid Portrayals: Obsidian / Indigo · Brilliant Counterattack · Primordial Arts: Overgrow / Torrent · Scorching Skies · Polychromatic Gathering: Friends / Origin · Flame Dance of the End · Gallant Galaxy: Charm / Brave · Overshadowed Radiance · Marine Shadow: Roar / Banish · Victory Lodestar

**Hidden Fates is Sun & Moon, not Sword & Shield.** Shining Fates is SWSH.
Chinese SWSH (Dynamax Clash, …) is its own release family — still this TCG
block on `/versions`, never Scarlet & Violet.

---

## Sun & Moon — 2016/2017–2019

- **EN:** Sun & Moon · Guardians Rising · Burning Shadows · Shining Legends · Crimson Invasion · Ultra Prism · Forbidden Light · Celestial Storm · Dragon Majesty · Lost Thunder · Team Up · Detective Pikachu · Unbroken Bonds · Unified Minds · Hidden Fates · Cosmic Eclipse
- **JP main:** Collection Sun · Collection Moon · Islands Await You · Alolan Moonlight · To Have Seen the Battle Rainbow · Darkness that Consumes Light · Awakened Heroes · Ultradimensional Beasts · Ultra Sun · Ultra Moon · Forbidden Light · Sky-Splitting Charisma · Super-Burst Impact · Tag Bolt · Double Blaze · Miracle Twin · Alter Genesis
- **JP enhanced:** Sun & Moon · Facing a New Trial · Shining Legends · Ultra Force · Dragon Storm · Champion Road · Thunderclap Spark · Fairy Rise · Dark Order · Night Unison · Full Metal Wall · GG End · Sky Legend · Remix Bout · Dream League · GX Battle Boost · GX Ultra Shiny · TAG TEAM GX: Tag All Stars · Great Detective Pikachu
- **CN:** Storming Emergence: Radiant / Verdant / Abundant · Battle Elite · Shining Synergy: Shower / Supreme / Summon · Striking Competition · Golden Energy

Chinese SM sets combine material that first appeared across multiple Japanese SM releases.

---

## XY — 2013–2016

- **EN:** Kalos Starter Set · XY · Flashfire · Furious Fists · Phantom Forces · Primal Clash · Double Crisis · Roaring Skies · Ancient Origins · BREAKthrough · BREAKpoint · Generations · Fates Collide · Steam Siege · Evolutions
- **JP main:** Collection X · Collection Y · Wild Blaze · Rising Fist · Phantom Gate · Gaia Volcano · Tidal Storm · Emerald Break · Bandit Ring
- **JP BREAK:** Blue Shock · Red Flash · Rage of the Broken Heavens · Awakening Psychic King · Fever-Burst Fighter · Cruel Traitor
- **JP special:** Magma Gang VS Aqua Gang: Double Crisis · Legendary Shine Collection · PokéKyun Collection · Premium Champion Pack EX×M×BREAK · Mythical & Legendary Dream Shine Collection · Expansion Pack 20th Anniversary · THE BEST OF XY
- **CN:** —

Evolutions ↔ Japan 20th Anniversary. Generations uses PokéKyun Collection (and more). Not a reprint bucket.

---

## Black & White — 2010/2011–2013

- **EN:** Black & White · Emerging Powers · Noble Victories · Next Destinies · Dark Explorers · Dragons Exalted · Dragon Vault · Boundaries Crossed · Plasma Storm · Plasma Freeze · Plasma Blast · Legendary Treasures
- **JP:** Black Collection · White Collection · Red Collection · Psycho Drive · Hail Blizzard · Dark Rush · Dragon Selection · Dragon Blast · Dragon Blade · Freeze Bolt · Cold Flare · Plasma Gale · Spiral Force · Thunder Knuckle · Megalo Cannon · Shiny Collection · EX Battle Boost
- **CN:** —

Dragon Selection → Dragon Vault. Shiny Collection + EX Battle Boost → Legendary Treasures. **EX Battle Boost is BW, not the EX era.** Japanese **Master Deck Build Box EX** (Sep 2012, MDB) is this block, not XY. Keep **M** Master Deck Build Box Power/Speed Style on XY.

---

## Call of Legends — 2011

- **EN:** Call of Legends
- **JP:** no standalone Japanese Call of Legends set
- **CN:** —

Keep this as an English era. Do not invent a JP equivalent. Lost Link stays
**HeartGold & SoulSilver** (its cards later appear across HGSS and this
English set).

---

## HeartGold & SoulSilver — 2009/2010

- **EN:** HeartGold & SoulSilver · Unleashed · Undaunted · Triumphant
- **JP:** HeartGold Collection · SoulSilver Collection · Reviving Legends · Clash at the Summit · Lost Link
- **CN:** —

Lost Link is a Japanese subset, not Call of Legends.

---

## Platinum — 2008/2009

- **EN:** Platinum · Rising Rivals · Supreme Victors · Arceus
- **JP:** Galactic’s Conquest · Bonds to the End of Time · Beat of the Frontier · Advent of Arceus
- **CN:** —

Not Diamond & Pearl. Do not fold Platinum into DP on `/versions`.

---

## Diamond & Pearl — 2006/2007–2008

- **EN:** Diamond & Pearl · Mysterious Treasures · Secret Wonders · Great Encounters · Majestic Dawn · Legends Awakened · Stormfront
- **JP:** Space-Time Creation: Diamond Collection · Pearl Collection · Secret of the Lakes · Shining Darkness · Moonlit Pursuit · Dawn Dash · Cry from the Mysterious · Temple of Anger · Intense Fight in the Destroyed Sky
- **CN:** —

Japanese often shipped as paired expansions that international sets rearranged.

---

## EX — 2003–2007

- **EN:** EX Ruby & Sapphire · EX Sandstorm · EX Dragon · EX Team Magma vs Team Aqua · EX Hidden Legends · EX FireRed & LeafGreen · EX Team Rocket Returns · EX Deoxys · EX Emerald · EX Unseen Forces · EX Delta Species · EX Legend Maker · EX Holon Phantoms · EX Crystal Guardians · EX Dragon Frontiers · EX Power Keepers
- **JP – ADV:** ADV Expansion Pack · Miracle of the Desert · Rulers of the Heavens · Magma VS Aqua: Two Ambitions · Undone Seal
- **JP – PCG:** Flight of Legends · Clash of the Blue Sky · Rocket Gang Strikes Back · Golden Sky, Silvery Ocean · Mirage Forest · Holon Research Tower · Holon Phantom · Miracle Crystal · Offense and Defense of the Furthest Ends · World Champions Pack
- **CN:** —

Japanese ADV + PCG together are the Western EX era. EX Ruby & Sapphire is
**EX**, never Original / Legacy.

`/marketplace/eras/ex` is this block only. **Do not** put a set here because
the title contains `ex` / `EX`. Stay off this page:

- Scarlet & Violet-era Pokémon ex (Scarlet ex, Shiny Treasure ex, Terastal
  Festival ex, Paldea `ex Starter Set` / Battle Master Deck / TCG Classic)
- Mega Evolution-era Mega Pokémon ex (MEGA Dream ex, MEGA Starter Set)
- XY-era Pokémon-EX (Mega Battle Deck, Zygarde EX, M Master Deck Build Box)
- Black & White-era Pokémon-EX (Reshiram/Zekrom/Kyurem EX Battle Strength;
  EX Battle Boost is BW; Master Deck Build Box EX is the 2012 JP gift)
- modern ex decks/products; expansions whose title merely contains EX
- POP Series 6–8 Diamond & Pearl · POP Series 9 Platinum (1–5 stay EX)
- e-Card Expedition / Aquapolis / Skyridge

ADV constructed decks that are actually this era (`Earth's Groudon ex`,
`Latias ex Half Deck`, EX Trainer Kit, 2004 EX Battle Stadium) stay.

---

## e-Card — 2001/2002–2003

- **EN:** Expedition Base Set · Aquapolis · Skyridge
- **JP:** Base Expansion Pack · The Town on No Map · Wind from the Sea · Split Earth · Mysterious Mountains
- **CN:** —

Aquapolis combines The Town on No Map + Wind from the Sea. Skyridge uses
Split Earth + Mysterious Mountains. Do not store those as one shared slug.

---

## Legendary Collection — 2002

- **EN:** Legendary Collection
- **JP:** no direct equivalent
- **CN:** —

English reprint product. **Do not map Pokémon Card★web (or ★VS) to this era.**

---

## VS / web — 2001–2002

JP contemporaries of the Legendary Collection window, kept as their own block:

- **JP:** Pokémon Card★VS · Pokémon Card★web

---

## Neo — 2000–2002

- **EN:** Neo Genesis · Neo Discovery · Southern Islands · Neo Revelation · Neo Destiny
- **JP:** Gold, Silver, to a New World… · Crossing the Ruins… · Awakening Legends · Darkness, and to Light… · Southern Islands
- **CN:** —

The four main Japanese Neo sets map cleanly to the four main English Neo expansions. Southern Islands exists in both languages.

---

## Original — 1996 / 1999–2000

Was **Legacy** / **Classic** on versions (everything before EX). Split.

- **EN:** Base Set · Jungle · Fossil · Base Set 2 · Team Rocket · Gym Heroes · Gym Challenge
- **JP:** Expansion Pack · Pokémon Jungle · Mystery of the Fossils · Rocket Gang · Leaders’ Stadium · Challenge from the Darkness
  (CardTrader: Gym Booster 1 Leaders' Stadium / Gym Booster 2: Challenge from the Darkness)
- **CN:** no Simplified Chinese release

Base Set 2 is a Western reprint compilation — no Japanese equivalent. Bare
Japanese **Expansion Pack** is this era; **Base Expansion Pack** is e-Card;
**ADV Expansion Pack** is EX; **Expansion Pack 20th Anniversary** is XY.

---

## What this drives

| Surface | Behavior |
| --- | --- |
| `{canonicalPath}/versions` era grids | `tcgEra()` — these headings. Same-era full-art stays in that era. Gold names link to `/marketplace/eras/{id}`. |
| `/marketplace/eras/:id` | Setlist for that TCG block (JP/EN/CN together). Hub `/marketplace/eras`. |
| `/marketplace/sets` | Japanese rows use the same TCG era headings as western. Chinese rows use catalog year ranges, newest first. Mixed groups list western tiles first, then Japanese. Western era chips include Japanese of that block and exclude Chinese. Classic chip still means pre–Black & White (Original through HGSS + Call of Legends). Gold headings link to the era setlist (year ranges map back to the block). |
| Promo / starter / prize-pack codes | Extra needles + fallback regex in `tcg-eras.js` (MEP, SV-P, SM#, SWSH S1–S12, Play! Prize Pack totals). |
| Chinese catch-up | `CSV*` / `CS1`–`CS6` / `CSF`… in `tcg-eras.js`. Code before translated title. |

Related: [VERSIONS.md](VERSIONS.md), [MARKET.md](MARKET.md), [PRINT_FLAGS.md](PRINT_FLAGS.md).
