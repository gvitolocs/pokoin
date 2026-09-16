# Illustrators (pipeline and ids)

Desk / search / home show an illustrator. That string is a **display cache**.
The authority table is still leftover-keyed. Public `card_id` did **not**
change (`leftover × 2`). `ct_id` stays for CDN filenames and CardTrader.

## Two ids (do not mix)

| Key | Formula | Use |
| --- | --- | --- |
| Leftover **`blueprint_id` / `ct_id`** | CardTrader blueprint | `marketplace_blueprint_artists` PK, leftover JPEG `{ct_id}_*.jpg`, CLIP/OCR jsonl, CardTrader HTTP, `cheapest_homepage_cache_blueprint.blueprint_id` |
| Public **`card_id`** | leftover × 2 | URL `/marketplace/…/cards/{id}`, Meili `en_{id}`, `marketplace_search_candidates.card_id`, generated `artists.card_id`, desk/search/home display |

Never join leftover PK to public `card_id`. Leftover ids overlap the public
id space (Net Ball public `245292` vs another leftover `245292`). Same
collision stamped fake rarities on artist desks until artist rarity joined
`versions.ct_id` ([D00001R](MARKET.md)).

## Tables

**`marketplace_blueprint_artists`** — writers only.

- PK `blueprint_id` = leftover `ct_id`.
- Generated `card_id = blueprint_id * 2`.
- OCR (`scripts/western-gpu-ocr.py` jsonl), pokemontcg.io / TCGdex fill
  (`scripts/fill-missing-artists-from-ocr-io.js`), pkmncards.com illustrator
  pages (`scripts/fill-missing-artists-from-pkmncards.js`), CLIP same-art copy
  (`marketplace_copy_same_art_artists` in `scripts/sql/068_same_art_copy_artists.sql`)
  **insert here**. Never write `candidates.artist` from those jobs.
- Artist desk SQL (CardVault API repo `marketplace-artist-cards.js`) groups by
  `normalized_artist` and leftover `versions.blueprint_id = artist.blueprint_id`.

**`marketplace_search_candidates.artist` / `.illustrator`** — display cache
(`scripts/sql/073_candidates_artist.sql`).

- Keyed by public `card_id`.
- Trigger `marketplace_blueprint_artists_sync_candidate` copies on artist
  insert/update/delete.
- `BEFORE INSERT` on candidates pulls from artists by `card_id`.
- Card-page, search identity, and home missing-row SQL **read `c.artist`**.
  Do not left-join artists on those hot paths. Do not put artist into
  `search_text` or ranking.

Do **not** add artist columns to `cardtrader_pokemon_blueprints` /
`pokoin_pokemon_blueprints`.

## Pipeline after a new printing

Same order as [GAMES.md](GAMES.md) New CardTrader printing, then:

1. Leftover JPEG ingest on nezopt (filenames stay `{ct_id}_*.jpg`).
2. CLIP version-sets on the 7900 XTX → `pokoin_version_sets` on **15T**.
3. Empty leftover rows: `fill-missing-artists-from-ocr-io.js --apply`, then
   `fill-missing-artists-from-pkmncards.js --artist=… --apply` for English
   printings pkmncards.com lists. Missing join is `a.card_id = c.card_id`.
   OCR lookup stays leftover `ct_id`. pkmncards matches name + set +
   collector; it may correct a CLIP `same_artwork` copy when that page
   disagrees (Southern Islands Ledyba vs Skyridge). Never overwrite OCR /
   pokemontcg.io / TCGdex.
4. CLIP siblings with one illustrator and one name:
   `marketplace_copy_same_art_artists()`. Donor join is
   `artist.card_id = c.card_id`. **INSERT PK is leftover `c.ct_id`.**
   Never overwrite an existing artist row. Skip leftovers whose name ends
   in Energy (basic/special energy). CLIP must not stamp Keiji Kinebuchi
   onto later Fighting Energy reprints. OCR / io / pkmncards credits stay.
5. Trigger 073 copies the new row onto `candidates.artist` by public
   `card_id`. Desk / search / home read that column. No leftover join.

Apply SQL on nezopt writer (`pokoin-marketplace-postgres-15t`, NVMe). Replica WAL
carries columns to the Pi. Never write the Pi replica.

## API surfaces

| Surface | Artist source | Id |
| --- | --- | --- |
| `GET /api/marketplace-card-page` | `c.artist` | public `cardId` |
| Search identity / `marketplace-search-page` | `c.artist` | public |
| Home overlay + missing-section hydrate | `c.artist` then `artists.card_id` | public |
| Homepage rails JSON | `TILE_SQL` copies `c.artist` | public |
| `GET /api/marketplace-version-set` | `artist.card_id = candidates.card_id` | public |
| Artist desk / illustrators index | leftover `versions.blueprint_id = artist.blueprint_id` | leftover |
| Cheapest cache | `blueprint_id = ct_id` **or** `pokoin_card_id = card_id::text` | never leftover = public |

Homepage rails (`scripts/sync-marketplace-rails.py`) snapshot those columns
into `marketplace_rails`. Until the next sync, stored rail payloads can still
lack illustrator; card-page and search already read the live column.

SPA first paint: URL stub has no artist ([D000018](MARKET.md)). Search tiles
pass `state={{ card }}` so in-app navigation already has the subtitle.
`pokoin.cardPage.v1.` stores artist by public id after the first card-page hop.

Artist album default sort is National Pokédex order (`pokedex.js` 1–1025).
Trainers, energy, fossils, Rotom Phone/Dex/Catalog/Bike, and dolls go last.
CLIP same-artwork reprints sit together after species at the oldest expansion.
Hand-listed SM **Tag Team GX** leftovers clone once per partner Dex
(`tag-team-partners.js`): triples appear three times. LEGEND pairs, Tate & Liza,
and sealed tins/decks are not cloned. Do not clone every name that contains `&`.

## What did not change

Public identity is still leftover × 2. `ct_id` was **not** removed from
candidates. CDN leftover JPEGs and CardTrader still need it.
`CardTile` on home/search/set/versions is still the full leftover, not an
art-cut ([CARD_ART.md](CARD_ART.md)).
