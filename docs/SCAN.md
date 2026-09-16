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

| Host | Print language | Catalog |
| --- | --- | --- |
| `pokoin.com` | all / western | **`pokemon_generic`** |
| `pokoin.com` | japanese | `pokemon_japanese` |
| `pokoin.com` | chinese | `pokemon_chinese` |
| `onepiece.pokoin.com` | all / english | **`one_piece_singles`** |
| `onepiece.pokoin.com` | japanese | `one_piece_japanese` |
| `riftbound.pokoin.com` | any | `riftbound_western` |

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

## Live catalogs (`GET /catalogs`, worker `nezopt`, 2026-09-05)

| id | language | count | Detector | What it is |
| --- | --- | ---: | --- | --- |
| `pokemon_western` | western | 26,693 | yolo-tflite | Western singles (includes some product-ish rows) |
| `pokemon_japanese` | japanese | 24,067 | yolo-tflite | JP singles |
| `pokemon_chinese` | chinese | 10,956 | yolo-tflite | CN singles |
| `pokemon_generic` | generic | **54,908** | yolo-tflite | JPEG leftovers from W+JP+CN; no booster boxes / ETBs / Battle Arena decks |
| `one_piece_english` | english | 7,218 | card-quad | EN (png/webp product art still present) |
| `one_piece_japanese` | japanese | 448 | card-quad | JP |
| `one_piece_singles` | singles | **5,588** | card-quad | EN+JP **JPEG only**; drop png/webp and Premium Bandai products |
| `riftbound_western` | western | 1,571 | card-quad | All Riftbound in that gallery |

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
