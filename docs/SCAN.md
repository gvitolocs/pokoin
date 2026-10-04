# Scan (`/scan` and cardscan catalogs)

Live identify is **BattleScan** (`cardscan.pokoin.com` / `scan.pokoin.com`), not
the marketplace Postgres catalog. The React desk only opens a **public card
id**. Chrome: [CHROME.md](CHROME.md). Identity: [MARKET.md](MARKET.md).
Card art on the desk is leftover JPEG: [CARD_ART.md](CARD_ART.md).
Catalog build and worker: BattleScan
[`docs/leftover-jpeg-singles.md`](/home/nez/Projects/BattleScan/docs/leftover-jpeg-singles.md).

## Two identify worlds (do not mix)

| `?catalog=` | `identity` | `hit.id` | Desk |
| --- | --- | --- | --- |
| omitted (API default) | `tcgplayer` | TCGPlayer product id | **Not a Pokoin URL.** Example `632917` is odd; public ids are even (`ct_id × 2`). |
| `pokemon_*` / `one_piece_*` / `riftbound_*` | `public_id` | Pokoin public card id | Open `/marketplace/{lang}/cards/{id}`. Also send leftover `ct_id` and `pokoin_url`. |

SPA `identifyScan` **must** set `catalog`. Live `POST /identify` with no catalog
still searches the 27,027-entry TCGPlayer index.

## SPA catalog (`market/src/scan-id.js`)

`scanCatalogId(hostname, printLang)`:

| Path | Print language | Catalog |
| --- | --- | --- |
| `pokoin.com` | all / western | **`pokemon_generic`** |
| `pokoin.com` | japanese | `pokemon_japanese` |
| `pokoin.com` | chinese | `pokemon_chinese` |
| `pokoin.com/one-piece` | all / english | **`one_piece_singles`** |
| `pokoin.com/one-piece` | japanese | `one_piece_japanese` |
| `pokoin.com/riftbound` | any | `riftbound_western` |
| `pokoin.com/{other game}` | any | **`{game}_all`** (e.g. `magic_all`, `yugioh_all`); a game without a catalog gets the API's 422, never a Pokémon match |

`pokemon_generic` and `one_piece_singles` are leftover-**JPEG** galleries (old
Milo behaviour): cardboard scans, not official product renders / png/webp
product shots. Language catalogs (`pokemon_western`, `one_piece_english`, …)
stay available on [scan.pokoin.com](https://scan.pokoin.com/) as EN/JP/CN.

`publicIdFromScanHit`: prefer `public_id` / `pokoin_url`; else leftover `ct_id`
× 2; **never** double a TCGPlayer `id`.

## Phone scanner UI (`scan.pokoin.com`)

HTML is static on Oracle **peer1** (`/opt/pokoin-cardscan/web`). Identify is
the nezopt worker (`battlescan-fast`, `127.0.0.1:8099`). Extra language
buttons:

| Button | Game | Catalog |
| --- | --- | --- |
| **GS** | Pokémon | `pokemon_generic` |
| **SG** | One Piece | `one_piece_singles` |

URL keeps `?catalog=`. Default camera rail is still EN (`pokemon_western` /
`one_piece_english`) until GS/SG is pressed. Marketplace `/scan` does **not**
use that EN default; it posts generic/singles as in the table above.

## Live catalogs (`GET /catalogs`, worker `nezopt`, 2026-10-04)

Built by pokoin-scanner (`src/build_catalogs.py`, `src/build_all_games.py`) from the
current DB singles (`item_kind='single' AND product_type='card'`) and one `milo_cnn`
vector per current leftover image. Root:
`/home/nez/data/pokoin-scan-catalogs/catalogs-cnn-v22-allgames-20261004` (Pi: same
files under `/srv/pokoin/scan/catalogs`). Per-catalog `embedder_sha256` in the manifest.

| id | count | Detector | Notes |
| --- | ---: | --- | --- |
| `pokemon_western` / `_japanese` / `_chinese` | 26,051 / 25,938 / 11,227 | yolo | split by `pokoin_pokemon_expansions.milo_gallery` |
| `pokemon_generic` | 63,216 | yolo | leftover JPEG W+JP+CN, no products |
| `one_piece_english` / `_japanese` / `_singles` | 7,316 / 456 / 5,684 | card-quad | re-embedded 2026-10-04 (were teacher-space vectors) |
| `riftbound_western` | 1,640 | card-quad | re-embedded 2026-10-04 |
| `magic_all` | 113,801 | card-quad | all languages; language is a listing attribute |
| `yugioh_all` | 46,294 | card-quad | |
| `vanguard_all` | 25,782 | card-quad | |
| `dragon_ball_super_all` / `flesh_and_blood_all` / `digimon_all` | 13,769 / 13,212 / 9,369 | card-quad | |
| `star_wars_all` / `union_arena_all` / `lorcana_all` | 8,392 / 6,946 / 3,694 | card-quad | |
| `gundam_all` / `sorcery_all` / `cyberpunk_all` / `palworld_all` | 2,018 / 1,762 / 436 / 289 | card-quad | |

Synthetic-capture accuracy per catalog (exact printing / same card name) and the
evaluation scripts: pokoin-scanner `bench/results/eval-allgames.json`, `docs/06-RUN-2026-10-04.md`.

Album path in the API is `ALBUM_CATALOG = pokemon_generic` (leftover JPEG,
same as marketplace `/scan`). Live `POST /identify-album` is routed on peer1
Caddy. Camera `/identify` without `catalog` is still TCGPlayer.

Do **not** load raw combined `cdn_milo` (~74k): that mix includes product
renders.

## Files

| Path | Role |
| --- | --- |
| `market/src/scan-id.js` | Catalog pick + desk id from a hit |
| `market/src/scan-id.test.js` | Catalog + identity tests |
| `market/src/api.js` `identifyScan` | `POST /cardscan/identify?catalog=` |
| `market/src/pages/Scan.jsx` | `/scan` UI |
| `vercel.json` | `/cardscan/identify` → `cardscan.pokoin.com` |

BattleScan (not this repo): `scripts/export_singles_catalogs.py`,
`server/catalogs.py` (`cache_limit` 8), `web/index.html` (GS/SG).
