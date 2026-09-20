## Worktree isolation (Paseo) — required, not optional

### Ownership (do not confuse)

| Piece | Where | Notes |
| --- | --- | --- |
| Website / React SPA | **this repo** (`market/`, `home/`) | Deploy: `scripts/deploy-web.sh` |
| CardVault app | `gvitolocs/cardvault` | Flutter Android/iOS — **not** the shared API |
| Shared Pokoin API | Pi `api.pokoin.com`; **new work** in `server/pokoin-api/` / `server/api/` | Both Web and CardVault call it. Deploy: `scripts/deploy-*-api.sh`. Legacy handlers may still exist under CardVault’s `pokemon_card_vault/api` on the Pi image — transitional only. |

`/home/nez/Projects/pokoin-web` is the canonical integration/deployment
checkout. It is **not** a development workspace:

- Every code change happens in an isolated Paseo/git worktree — one agent,
  one workstream, one worktree. An agent that starts in the canonical
  checkout MUST create or open its own Paseo workspace **before editing any
  source file** (`scripts/paseo-workspace.sh <slug>`, or
  `paseo run --new-workspace worktree`).
- Never run long-lived dev servers from the canonical checkout. Run them in
  your worktree on the Paseo-assigned port; check `scripts/dev-servers.sh`
  first and never kill another workspace's server.
- The canonical checkout must normally stay clean. Never leave uncommitted
  feature work, generated artifacts, or scratch files there.
- In shared/integration checkouts, never stage broadly (`git add .`,
  `git add -A`, `git add -u`, …). Always inspect `git status --porcelain`
  first, treat every entry you did not create as another agent's WIP, and
  stage only your explicitly owned paths.
- Never discard, stash, reset, clean, overwrite, or commit another agent's
  WIP. When in doubt, leave it alone and say so.
- Production deploys run `scripts/deploy-web.sh` against the exact,
  already-pushed `origin/main` commit — never from a dirty working tree or
  a feature branch. Do not push or deploy unless explicitly instructed.
- Worktree isolation is a correctness requirement, not a recommendation:
  un-isolated edits have repeatedly collided with concurrent agents in this
  repository and nearly shipped half-finished work. Commits made directly
  in the canonical checkout are rejected by `.githooks/pre-commit` unless
  `POKOIN_ALLOW_CANONICAL_COMMIT=1` is set for an intentional integration
  or maintenance operation.

While operating inside a Paseo workspace:

- Do not push or deploy unless explicitly instructed.
- Treat the current checkout as an isolated worktree, not the canonical checkout.
- Use the Paseo-provided dynamic service port and do not reuse another workspace's dev server.
- Do not kill processes belonging to another workspace or modify host-level Paseo configuration.
- Run the relevant tests before declaring work complete.

<!-- codevira:begin (auto-generated; do not edit) -->

## Codevira-tracked project memory: pokoin-web

> **Codevira** — cross-IDE persistent memory. Read it with the codevira MCP tools (`get_session_context`, `search_decisions`); do **not** open `.codevira/*.jsonl` directly — those files are large and token-heavy.

### Locked decisions (do_not_revert)

- **D000003** New CardTrader printings: Oracle delta --apply of raw blueprints only, then targeted projection and Pi leftover JPEGs. …  ·  `docs/GAMES.md`  ·  _cardtrader, import, leftover, oracle, projection_
- **D00000A** Production Meili is getmeili/meilisearch:v1.53.1 only. Installer pins, A1 bootstrap, and Pi Docker recreate script all …  ·  `scripts/install-pokoin-meili-docker.sh`  ·  _docker, meili, pi, version_
- **D00000C** TCG era headings are gold links to /marketplace/eras/:id, a setlist of JP/EN/CN expansions in that block.  ·  `market/src/pages/Era.jsx`  ·  _era, sets, spa, versions_
- **D00000E** Listed-median snapshot rolls are asks, not CardTrader sales; never ingest listed-median-day source_item_ids into sold_d…  ·  `scripts/sql/sanitize-listed-median-sales.sql`  ·  _cardtrader, digest, postgres, sold_
- **D00000F** Empty CardTrader pokemon_language is the expansion print language, not EN. Explicit CT en on JP/CN stays.  ·  `scripts/sql/sanitize-lazy-en-and-sep11-cutover.sql`  ·  _cardtrader, language, sanitize, sold_
- **D00000G** 11 Sep inferred_sale is the complete-book cutover vs the Pi clone, not that day's market. Keep quantity_decreased.  ·  `scripts/sql/sanitize-lazy-en-and-sep11-cutover.sql`  ·  _cardtrader, cutover, inferred_sale, sold_
- **D00000H** Card nicknames (Moonbreon, ADP, …) live on Meili `nicknames` and typeahead search-on; expansion short codes stay on `ex…  ·  `api/_meili_marketplace.js`  ·  _aliases, meili, nicknames, search_
- **D00000I** inferred_sale is not a sale while that listing_id is still in the live snapshot book.  ·  `scripts/sql/sanitize-still-listed-inferred-sales.sql`  ·  _cardtrader, cheap-25, inferred_sale, sold_
- **D00000K** Homepage New cards is a curated Storm Emeralda list matched by set + collector number + name, preserving duplicate Poké…  ·  `scripts/sync-marketplace-rails.py`  ·  _curated, homepage, rails, storm-emeralda_
- **D00000O** /marketplace/eras/ex is the 2003–2007 EX block only; never match because the title contains ex.  ·  `market/src/tcg-eras.js`  ·  _era, ex, sets, spa_
- **D00000P** Homepage Featured is 30 random 30th Anniversary singles (EN/JP/First Partner), shuffled once per UTC day. UI title 30th…  ·  `scripts/sync-marketplace-rails.py`  ·  _30th-anniversary, featured, homepage, rails_
- **D00000Q** Pokemon item_kind follows CardTrader category_id on ingest; Qwen-VL leftovers fill only missing or unknown categories.  ·  `scripts/sql/060_cardtrader_category_kind.sql`  ·  _cardtrader, ingest, item-kind, qwen_
- **D00000R** 12 Sep inferred_sale is the complete-book remainder after 11 Sep, not that day's market. Keep quantity_decreased.  ·  `scripts/sql/sanitize-sep12-complete-book-cutover.sql`  ·  _cardtrader, cutover, inferred_sale, sold_
- **D00000S** English-named leftover expansions whose scans are Japanese starter/gym/construction products are nationality japanese (…  ·  `docs/PRINT_FLAGS.md`  ·  _expansions, japanese, print-flags_
- **D00000T** Korean-only expansions use the Taegeukgi (ko.svg), not the JP+KO split. Japanese print stays jpko.  ·  `market/src/locale.js`  ·  _korean, ocr, print-flags_
- **D00000V** nezopt 7900 XTX ROCm is the LoRA venv torch 2.9.1+rocm6.4 plus ~/bin/rocm-smi; missing /opt/rocm does not mean no GPU.  ·  `/home/nez/.config/rocm-env.sh`  ·  _gpu, nezopt, rocm_
- **D00000W** Listed Base Set leftovers are unlimited TCGPlayer product photos, not pokemontcg.io base1 hires (those are 1st Edition/…  ·  `cardvault/pokemon_card_vault/scripts/import-base-set-unlimited-tcgplayer.js`  ·  _base-set, card-art, leftover, tcgplayer, unlimited_
- **D00000X** Western leftover GPU OCR uses official PP-OCRv5 ONNX (mobile det + English rec) on the 7900 XTX via onnxruntime-rocm RO…  ·  `scripts/western-gpu-ocr.py`  ·  _ocr, onnx, ppocrv5, rocm_
- **D00000Y** Web searchbar ranking is a new name-pool probability scorer in suggest-rank.js, not Flutter marketplace-autocomplete or…  ·  `market/src/suggest-rank.js`  ·  _meili, ranking, search, suggest_
- **D00000Z** Cheap-25 inferred_sale through 10 Sep is leftover stacks that left the 25-wide window, not sold units. Keep quantity_de…  ·  `scripts/sql/sanitize-cheap25-inferred-sales.sql`  ·  _cardtrader, cheap-25, inferred_sale, sold_
- **D000010** Display names are tall card_name_languages, rarity_languages, and expansion_languages keyed by English identity plus ti…  ·  `/home/nez/Projects/pokoin-web/scripts/sql/062_catalog_languages.sql`  ·  _catalog, display, languages, postgres, tcgdex_
- **D000011** Typeahead set+name queries (hgss energy) peel the expansion-code token in suggest-rank.js and hydrate printings from th…  ·  `market/src/suggest-rank.js`  ·  _hgss, meili, search, suggest_
- **D000013** Listed Base Set TCGPlayer leftovers are cover-fit to 1260x1760 without millimetre sanitize; cache-bust bsu2.  ·  `cardvault/pokemon_card_vault/scripts/import-base-set-unlimited-tcgplayer.js`  ·  _base-set, card-art, leftover, tcgplayer, unlimited_
- **D000014** PKN prices show as digits only: 2642 PKN, never 2,642.  ·  `market/src/pkn.js`  ·  _format, pkn, spa_
- **D000015** When marketplace card_number is a 4+ digit catalog id, recover printed n/m from the CardTrader/leftover image basename,…  ·  `scripts/sql/063_collector_from_blueprint_image.sql`  ·  _cardtrader, collector, postgres, set-desk_
- **D000016** Typeahead always fills toward 20 printings from the ranked name pool; set-name typos are peeled client-side and Meili i…  ·  `market/src/suggest-rank.js`  ·  _meili, ranking, search, suggest_
- **D000018** Promo desk first paint keeps the Pokémon name from the URL; emoji and artist hydrate from marketplace-card-page and per…  ·  `market/src/card-stub.js`  ·  _desk, first-paint, identity, spa_
- **D000019** Typeahead scores the whole compact query against unique blueprint names from marketplace_card_names; do not peel EX/rar…  ·  `market/src/suggest-rank.js`  ·  _blueprint, meili, ranking, search, suggest_
- **D00001A** Artist card grids stamp listed cheapest PKN with the same cheapest_homepage_cache_blueprint overlay as search and set d…  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/api/marketplace-artist-cards.js`  ·  _artist, cheapest, pkn, spa_
- **D00001B** Bare n/m marketplace card_number gets CardTrader fixed_properties.pokemon_rarity prefixed (Rare | 119/214); Common/Unco…  ·  `/home/nez/Projects/pokoin-web/scripts/sql/064_pokemon_rarity_into_card_number.sql`  ·  _cardtrader, catalog, postgres, rarity_
- **D00001C** Artist desk first paint title-cases the URL slug so refresh shows Tomokazu Komiya, not tomokazu-komiya; the API name ma…  ·  `/home/nez/Projects/pokoin-web/market/src/pages/Artist.jsx`  ·  _artist, desk, first-paint, spa_
- **D00001D** Typeahead peels illustration/full-art shorthands (il, ir, sir, fa, illustrazione) after the blueprint name; Meili stays…  ·  `/home/nez/Projects/pokoin-web/market/src/suggest-rank.js`  ·  _languages, meili, rarity, suggest_
- **D00001E** Missing set catalog wordmarks come from Serebii /card/logo/{compact}.png onto Pi leftover CDN expansions/logos/{slug}.p…  ·  `scripts/import-serebii-expansion-logos.py`  ·  _cdn, expansions, logos, serebii_
- **D00001F** /marketplace/eras/platinum is the 2008–2009 Platinum block only; never match because the title contains Arceus. CSM* co…  ·  `/home/nez/Projects/pokoin-web/market/src/tcg-eras.js`  ·  _arceus, era, platinum, sets, spa_
- **D00001G** Sets and Era catalog tiles show the print flag left of the set name.  ·  `market/src/components/SetGuideGrid.jsx`  ·  _era, print-flags, sets, spa_
- **D00001H** One English-identity Meili index serves every title language; localized_name/set/rarity overlay from catalog language t…  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/api/_catalog_title_language.js`  ·  _languages, meili, search, suggest_
- **D00001I** 30th-ch First Partner Illustration Collection is Simplified Chinese print; do not regex first partner.  ·  `scripts/sql/065_cn_30th_ch_first_partner.sql`  ·  _chinese, expansions, print-flags_
- **D00001J** Sets index Japanese chip uses TCG era headings; Chinese chip uses catalog year ranges newest first.  ·  `/home/nez/Projects/pokoin-web/market/src/set-logos.js`  ·  _chinese, era, japanese, sets, spa_
- **D00001K** Japanese SVM Generations Start Decks is Scarlet & Violet, not XY; exact alias beats catalog prefix Generations.  ·  `market/src/tcg-eras.js`  ·  _era, generations, sets, spa, svm_
- **D00001L** Set-index and era pages list western expansions first inside a mixed TCG group.  ·  `/home/nez/Projects/pokoin-web/market/src/set-logos.js`  ·  _japanese, sets, spa, western_
- **D00001M** Typeahead peels collector n / n/m so 061 shieldon ranks Shieldon printings; Meili is queried for the name, not every 06…  ·  `/home/nez/Projects/pokoin-web/market/src/suggest-rank.js`  ·  _collector, meili, ranking, search, suggest_
- **D00001N** Japanese Tag Team GX card titles sanitize to the western GX name, then CLIP matches those printings as artwork versions.  ·  `/home/nez/Projects/pokoin-web/scripts/sql/067_tag_team_gx_name.sql`  ·  _cardtrader, names, tag-team, versions_
- **D00001O** [supersedes D000017: Giuseppe asked to remove fake artists. Unmatched flavor tokens (reverberates, nests, predicting) w…  ·  `market/src/ocr-artists.js`  ·  _artists, flavor, ocr, pokemontcg.io_
- **D00001P** After leftover ingest of new CardTrader printings, CLIP version-sets for those name buckets on nezopt 15T. Do not leave…  ·  `scripts/ingest-missing-product-images.py`  ·  _cardtrader, clip, import, leftover, versions_
- **D00001Q** Unknown catalog artist slugs (no illustrator, zero cards) render EmptyDesk, not a title-cased fake artist.  ·  `market/src/pages/Artist.jsx`  ·  _artist, desk, flavor, spa_
- **D00001R** Artist card rarity joins CardTrader blueprints and tcg_metadata on leftover versions.ct_id, never public card_id.  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/api/marketplace-artist-cards.js`  ·  _artist, cardtrader, leftover, rarity_
- **D00001T** [supersedes D00001S: Giuseppe prefers CardTrader: keep English names everywhere, show the translation only as a second …  ·  `/home/nez/Projects/pokoin-web/market/src/identity.js`  ·  _languages, spa, suggest, title-language_
- **D00001U** Promo expansions have no Rarity Lineup; ADV-P / Black Star / *Promos* cards are unique numbers, not regular↔IR of the s…  ·  `market/src/card-versions.js`  ·  _promo, spa, versions_
- **D00001V** CLIP same-artwork groups copy a unique illustrator onto empty sibling printings; never overwrite an existing artist row…  ·  `/home/nez/Projects/pokoin-web/scripts/sql/068_same_art_copy_artists.sql`  ·  _artist, clip, same-artwork, versions_
- **D00001W** Japanese Master Deck Build Box EX is Black & White (Sep 2012), not XY.  ·  `/home/nez/Projects/pokoin-web/market/src/tcg-eras.js`  ·  _black-white, era, sets, spa, xy_
- **D00001X** Pokemon header typeahead prefetches Meili from the first character with no popup, then paints instantly at three compac…  ·  `market/src/components/Chrome.jsx`  ·  _search, spa, suggest, typeahead_
- **D00001Y** Search popup preloads _homepage.webp thumbs into a 128 LRU (4 in flight, visible rows first); hover leftover JPEGs are …  ·  `/home/nez/Projects/pokoin-web/market/src/suggest-images.js`  ·  _images, search, spa, suggest_
- **D000020** Typeahead ranks a local catalog of ~10k names plus artists and set titles (typos included); expansions/rarities/numbers…  ·  `/home/nez/Projects/pokoin-web/market/src/suggest-catalog.js`  ·  _artists, search, sets, suggest, typeahead_
- **D000021** Listing POST writes marketplace_user_listings to nezopt 15T via MARKETPLACE_WRITER_DATABASE_URL; Firebase is only the s…  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/api/marketplace-listings.js`  ·  _firebase, listings, nezopt, pi, postgres_
- **D000022** Ninja Spinner Tauros 067/083 and Chaos Rising 069/086 join as artbox-pin v756082 only; never recluster the Tauros name …  ·  `/home/nez/Projects/pokemon-card-extension/scripts/cluster-name-version-sets.py`  ·  _artbox-pin, clip, tauros, versions_
- **D000024** [supersedes D000023: Giuseppe still wanted the top 20 from the bunch, including name typos, with western print weighted…  ·  `/home/nez/Projects/pokoin-web/market/src/suggest-rank.js`  ·  _collector, meili, print-flags, search, suggest, typeahead_
- **D000025** Typeahead peels 2–4 word set titles with typos (call of legendsd) and ranks the leftover name (Flareon), not sealed pro…  ·  `/home/nez/Projects/pokoin-web/market/src/suggest-rank.js`  ·  _search, sets, suggest, typeahead_
- **D000026** Pokemon typeahead ranks the name pool once per keystroke on the main thread (memoized); Chrome does not re-run liveSugg…  ·  `/home/nez/Projects/pokoin-web/market/src/components/Chrome.jsx`  ·  _perf, search, suggest, typeahead_
- **D000027** Base Set Hitmonchan 7/102 joins Base Set 2, shadowless, Evolutions, JP Expansion Pack/20th, and Best of Game as artbox-…  ·  `/home/nez/Projects/pokemon-card-extension/scripts/cluster-name-version-sets.py`  ·  _artbox-pin, base-set, clip, hitmonchan, versions_
- **D000029** Remaining listed Base Set / shadowless / Evolutions WotC reprint misses after bsu2 join as artbox-pins of the visually …  ·  `/home/nez/Projects/pokemon-card-extension/scripts/cluster-name-version-sets.py`  ·  _artbox-pin, base-set, clip, versions_
- **D00002A** GET /api/marketplace-card-page includes the CLIP pokoin_version_sets key as version and card.version on desk load.  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/api/marketplace-card-page.js`  ·  _api, card-page, clip, spa, versions_
- **D00002B** [supersedes D000028: 428× Pikachu prior still dominated even after the gx keyword penalty; Giuseppe asked for 2 popular…  ·  `/home/nez/Projects/pokoin-web/market/src/suggest-rank.js`  ·  _gx, ranking, search, suggest, typeahead_
- **D00002C** Missing expansion symbols are saved as SVI-style dark plates on the Pi CDN; desk circles never paint yellow letters on …  ·  `/home/nez/Projects/pokoin-web/scripts/export-expansion-code-marks.py`  ·  _cdn, expansions, spa, symbols_
- **D00002D** Artist desk and illustrator index tiles CSS-crop leftover JPEG illustration windows; home, search, set, and versions Ca…  ·  `/home/nez/Projects/pokoin-web/market/src/pages/Artist.jsx`  ·  _art-cut, artist, card-art, spa_
- **D00002G** Typeahead peels an exact prefix of a multi-word set title (call of → Call of Legends) and ranks the leftover name (palk…  ·  `/home/nez/Projects/pokoin-web/market/src/suggest-rank.js`  ·  _search, sets, suggest, typeahead_
- **D00002I** Pokemon search is three tabs — Singles, Product, Users — on the typeahead popup and /marketplace/search. Default is Sin…  ·  `/home/nez/Projects/pokoin-web/market/src/search-kind.js`  ·  _search, spa, suggest, typeahead_
- **D00002J** POKEMON_ART_CUT is left 0.08, top 0.125, width 0.84, height 0.36 so artist album tiles and search suggest show more of …  ·  `/home/nez/Projects/pokoin-web/market/src/art-cut.js`  ·  _art-cut, artist, card-art, spa_
- **D00002K** Artist desk default sort is National Pokédex order from a local 1–1025 species table; trainer and energy cards go last.  ·  `/home/nez/Projects/pokoin-web/market/src/pages/Artist.jsx`  ·  _artist, pokedex, sort, spa_
- **D00002L** TCG fossil items (Old Amber, Dome/Helix/Root/Claw fossils, …) sort as trainers even when a Pokémon name is appended.  ·  `/home/nez/Projects/pokoin-web/market/src/pokedex.js`  ·  _artist, fossil, pokedex, spa, trainer_
- **D00002M** Typeahead takes the top 20 real ranked printings: hgss energy is HeartGold elemental energies, sl peels Call of Legends…  ·  `/home/nez/Projects/pokoin-web/market/src/suggest-rank.js`  ·  _call-of-legends, hgss, jumbo, search, suggest, typeahead_
- **D00002N** Artist/suggest illustration crop is per TCG layout family; same Pokémon printings sort oldest era then oldest expansion.  ·  `/home/nez/Projects/pokoin-web/market/src/art-cut.js`  ·  _art-cut, artist, era, pokedex, spa_
- **D00002O** Typeahead peels legen/legend/legends as Call of Legends and always fills 20 singles from that name pool; Jumbo Oversize…  ·  `/home/nez/Projects/pokoin-web/market/src/suggest-rank.js`  ·  _call-of-legends, jumbo, search, singles, suggest, typeahead_
- **D00002P** WCD 2012-2016 and 30th JP XY EX leftovers that CardTrader named ex join the matching XY EX artwork pin (STAMP_EX_PINS);…  ·  `/home/nez/Projects/pokemon-card-extension/scripts/cluster-name-version-sets.py`  ·  _artbox-pin, clip, ex, versions, wcd_
- **D00002Q** Sold comps key a listing stack by seller + blueprint + condition + language + reverse/1st/graded, never CardTrader prod…  ·  `/home/nez/Projects/pokoin-web/docs/MARKET.md`  ·  _cardtrader, cheap-25, inferred_sale, listing-id, seller-stack, sold_
- **D00002S** Complete-book inferred_sale is an accurate seller-stack vanish (seller + language + condition + foil facets); product i…  ·  `/home/nez/Projects/pokoin-web/docs/MARKET.md`  ·  _cardtrader, inferred_sale, seller-stack, sold_
- **D00002T** Unbroken Bonds leftover 130794 and CLIP siblings Night Unison / CSM2c Gardevoir & Sylveon GX stay Atsuko Nishida; that …  ·  `/home/nez/Projects/pokoin-web/scripts/sql/069_revert_nishida_gx_arita.sql`  ·  _artist, gx, nishida_
- **D00002U** [supersedes D00002E: Ids-only localStorage made the cached rail wait on marketplace-card-tiles after the page had alrea…  ·  `/home/nez/Projects/pokoin-web/market/src/recents.js`  ·  _first-paint, localstorage, postgres, recents, spa_
- **D00002V** Card-desk sold-graph filters stay one nowrap row on desktop; phone ≤720px keeps that row and tightens the chips/selects.  ·  `/home/nez/Projects/pokoin-web/market/src/styles.css`  ·  _graph, mobile, sold, spa_
- **D00002W** 312×437 leftover thumbs (SV Magnemite 241905 cohort) ingest CardTrader full when CT is larger; Cynthia 270625 stays bec…  ·  `/home/nez/Projects/pokoin-web/scripts/ingest-missing-product-images.py`  ·  _cardtrader, cdn, ingest, leftover_
- **D00002X** Empty leftover artists fill from western OCR Illus. plus pokemontcg.io when that credit exists; Perfect Order / SV-era …  ·  `/home/nez/Projects/pokoin-web/scripts/fill-missing-artists-from-ocr-io.js`  ·  _artists, ocr, pokemontcg.io, tcgdex_
- **D00002Z** [supersedes D00002H: Giuseppe: LEGEND suggest images are upside down. Leftovers store the name bar on the left of the 6…  ·  `/home/nez/Projects/pokoin-web/market/src/styles.css`  ·  _art-cut, break, card-art, legend, spa, suggest_
- **D000030** GET /api/marketplace-search-page with productType=card still ranks through Meili, then keeps product_type=card rows.  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/api/marketplace-cards.js`  ·  _meili, search, spa_
- **D000031** Neo and Southern Islands album/suggest crops use ART_CUT_LAYOUTS.neo (0.082, 0.152, 0.836, 0.358), not Original wotc go…  ·  `/home/nez/Projects/pokoin-web/market/src/art-cut.js`  ·  _art-cut, era, neo, southern-islands, spa_
- **D000032** Artist album tiles show HGSS LEGEND and XY BREAK leftovers as the full card rotated +90deg (.tile-album.is-landscape), …  ·  `/home/nez/Projects/pokoin-web/market/src/components/CardTile.jsx`  ·  _art-cut, artist, break, legend, spa_
- **D000035** GET /api/marketplace-card-page rarities is same English name + expansion for the desk rarity select; CLIP versions stay…  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/api/marketplace-card-page.js`  ·  _api, card-page, rarity, spa, versions_
- **D000036** Typeahead hydrates Meili from the typed name in parallel with ranking; rank workers fall back to the main thread after …  ·  `/home/nez/Projects/pokoin-web/market/src/suggest-rank.js`  ·  _legend, search, spa, suggest, typeahead_
- **D000037** Catalogue removals for CardTrader-gone blueprints use scripts/remove-catalogue-card.py: dry-run by default, --apply del…  ·  `scripts/remove-catalogue-card.py`  ·  _cardtrader, catalogue, meili, nezopt, postgres_
- **D000038** [supersedes D00000J: Equal quantity and a new successor id were too strict. Sellers split one stack across many CardTra…  ·  `/home/nez/Projects/pokoin-web/scripts/sql/sanitize-same-stack-still-listed-inferred-sales.sql`  ·  _cardtrader, inferred_sale, listing-id, seller-stack, sold_
- **D000039** [supersedes D00000N: The old persist required a new successor id and same qty, so split stacks became inferred_sale (Co…  ·  `/home/nez/Projects/pokoin-web/scripts/sql/cardtrader-listing-qty-diff.sql`  ·  _cardtrader, inferred_sale, listing-id, sold_
- **D00003A** CardTrader multi-game re-import keeps Oracle pokoin-marketplace as the GET ingest hop; it sends JSON and scan bytes to …  ·  `/home/nez/Projects/pokoin-web/docs/MULTIGAME_REIMPORT.md`  ·  _15t, cardtrader, images, ingest, multigame, nezopt, oracle_
- **D00003B** Each non-Pokemon CardTrader game has its own Oracle ingest API under /api/ingest/{game} that writes an isolated 15T dat…  ·  `/home/nez/Projects/pokoin-web/docs/MULTIGAME_REIMPORT.md`  ·  _15t, api, cardtrader, ingest, multigame, oracle, pokemon_
- **D00003D** Artist album tiles write the printing line on the photo over a short masked bottom blur (.tile-art::after), not a frost…  ·  `/home/nez/Projects/pokoin-web/market/src/styles.css`  ·  _artist, card-art, spa, tile-album_
- **D00003F** Platinum Arceus set desk uses the official PL4 PDF checklist (1/99 then AR then SH). Letter-prefix collectors sort afte…  ·  `/home/nez/Projects/pokoin-web/market/src/set-official-lists.js`  ·  _arceus, collector, sets, spa_
- **D00003G** [supersedes D000034: Giuseppe wanted a two-row cut of the artwork, not the full card with HP and attacks.] Artist album…  ·  `/home/nez/Projects/pokoin-web/market/src/art-cut.js`  ·  _album, art-cut, artist, card-art, spa_
- **D00003H** Desk artist is denormalized onto marketplace_search_candidates by public card_id; OCR/CLIP still write marketplace_blue…  ·  `/home/nez/Projects/pokoin-web/scripts/sql/073_candidates_artist.sql`  ·  _artist, card-id, card-page, postgres, spa_
- **D00003I** Artist Pokédex sort groups CLIP same-artwork reprints together after species; each painting sits at its oldest expansio…  ·  `/home/nez/Projects/pokoin-web/market/src/search-filters.js`  ·  _artist, clip, pokedex, sort, spa, versions_
- **D00003J** Artist Pokédex/same-artwork order is stored on marketplace_search_candidates and updated in the CardTrader/CLIP pipelin…  ·  `/home/nez/Projects/pokoin-web/scripts/sql/074_pokedex_sort.sql`  ·  _artist, clip, pipeline, pokedex, postgres, sort_
- **D00003K** Artist writers stay leftover-keyed; CLIP copy and home overlay join artists.card_id (public leftover×2). Never leftover…  ·  `/home/nez/Projects/pokoin-web/docs/ARTISTS.md`  ·  _artist, card-id, docs, pipeline, postgres_
- **D00003N** Canonical SEO is one marketplace card URL per printing plus Pokémon/set/era/artist/rarity/language hubs with crawlable …  ·  `/home/nez/Projects/pokoin-web/docs/SEO.md`  ·  _googlebot, hubs, seo, sitemaps, spa_
- **D00003O** [supersedes D00003L: Giuseppe: Scizor SIR was zoomed for no reason; the two-row tile can fit more artwork.] Artist albu…  ·  `/home/nez/Projects/pokoin-web/market/src/styles.css`  ·  _album, art-cut, artist, card-art, spa_
- **D00003Q** Desk ‹ › always walk expansion neighbors; the gold select is the only rarity switch.  ·  `/home/nez/Projects/pokoin-web/market/src/pages/Card.jsx`  ·  _desk, expansion, spa, versions_
- **D00003S** Typeahead Singles treats named sealed SKUs (theme/battle/WCD decks, binders, chests, packs, kits, special sets, posters…  ·  `/home/nez/Projects/pokoin-web/market/src/identity.js`  ·  _product, search, singles, suggest, typeahead_
- **D00003U** 13 Sep inferred_sale is not a sold-out: CardTrader GET by blueprint_id still has those listing ids. Sold graphs must no…  ·  `/home/nez/Projects/pokoin-web/docs/MARKET.md`  ·  _cardtrader, inferred_sale, sold_
- **D00003V** SEO catalog extras stay in Chrome Catalog and card More in the catalog disclosures. Visible desk keeps related tiles pl…  ·  `/home/nez/Projects/pokoin-web/docs/SEO.md`  ·  _catalog, seo, spa, ui_
- **D00003W** Seller on vacation is not a sale: keep cardtrader_seller_vacation, freeze snapshots, archive_reason seller_on_vacation.…  ·  `/home/nez/Projects/pokoin-web/scripts/sql/075_seller_vacation.sql`  ·  _cardtrader, inferred_sale, sold, vacation_
- **D00003X** Typeahead Singles classifies from name + group title + sealed * Products expansions; Collections plurals, League Battle…  ·  `/home/nez/Projects/pokoin-web/market/src/identity.js`  ·  _meili, product, search, singles, suggest, typeahead_
- **D00003Y** XY Gold Secret Mega EX with a Mega rule bar is album window; Hidden Fates SV86 Shiny Vault is full-art bleed. Artwork-l…  ·  `/home/nez/Projects/pokoin-web/scripts/artwork-layout.py`  ·  _art-cut, artist, clip, layout, spa_
- **D00003Z** [supersedes D00003T: Giuseppe: SV86 is a full art; Gold Secret Mega X 108/106 still has Mega rule + attacks so it is no…  ·  `/home/nez/Projects/pokoin-web/market/src/art-layout.js`  ·  _art-cut, artist, clip, layout, spa_
- **D000040** Side-panel iframe keeps /profile and seller pages: never read Firebase user fields bare, and pokoin-origin frames those…  ·  `/home/nez/Projects/pokoin-web/market/src/pages/Profile.jsx`  ·  _extension, profile, sidepanel, spa_
- **D000041** Expansion dumps never archiveMissing as sold. inferred_sale only from by-blueprint complete fetches. Listing ids still …  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/api/_cardtrader_daily_listings_refresh.js`  ·  _cardtrader, dump-miss, inferred_sale, sold_
- **D000042** [supersedes D00003E: CLIP geometry:no_chrome stamped Boundaries Crossed Squirtle 29/149 bleed because the cyan XY rules…  ·  `/home/nez/Projects/pokoin-web/scripts/artwork-layout.py`  ·  _art-cut, artist, layout, ocr, spa_
- **D000043** pokoin-origin frames only card desks, seller pages, and account routes — not every /marketplace/* URL. The credentialle…  ·  `/home/nez/Projects/pokoin-web/workers/pokoin-origin.js`  ·  _bot-fight, extension, sidepanel, spa, tiles_
- **D000044** Album window vs bleed is a framed illustration box versus painting to the edges. Full-art leftovers still have HP and a…  ·  `/home/nez/Projects/pokoin-web/scripts/artwork-layout.py`  ·  _art-cut, artist, layout, spa_
- **D000045** Related desk tiles show listed cheapest PKN from cheapest_homepage_cache_blueprint: card-page stamps neighbors and rari…  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/api/marketplace-card-page.js`  ·  _cheapest, desk, related, spa, tiles_
- **D000047** Team Up Charizard leftover 397269 uses CardTrader's official scan, not the pokemontcg.io digital of the 129552 duplicat…  ·  `/home/nez/Projects/pokoin-web/market/src/image-urls.js`  ·  _cardtrader, cdn, leftover, rarity, team-up_
- **D00004C** Empty leftover illustrators fill from pkmncards.com artist pages by name+set+collector; CLIP same_artwork may be correc…  ·  `/home/nez/Projects/pokoin-web/scripts/fill-missing-artists-from-pkmncards.js`  ·  _artists, clip, pkmncards, southern-islands_
- **D00004E** [supersedes D000049: Giuseppe still wants the top 20 from the local pool after the prefix peel, not a 4-row Plasma-only…  ·  `/home/nez/Projects/pokoin-web/market/src/suggest-rank.js`  ·  _expansions, search, suggest, typeahead_
- **D00004F** Artist album window cells are 88:63 — a Pokémon card rotated — same box as BREAK/LEGEND; suggest keeps the illustration…  ·  `/home/nez/Projects/pokoin-web/market/src/styles.css`  ·  _album, art-cut, artist, break, spa_
- **D00004H** Grey CardTrader 186×260 leftover backs are rewritten to the Pokoin missing-card JPEG (630×880); CLIP skips those files …  ·  `/home/nez/Projects/pokoin-web/scripts/replace-cardtrader-placeholder-leftovers.py`  ·  _card-art, cardtrader, cdn, clip, placeholder_
- **D00004K** [supersedes D00004G: Giuseppe 2026-09-14: .page.home overflow-x:clip alone still left a document horizontal scrollbar o…  ·  `/home/nez/Projects/pokoin-web/market/src/styles.css`  ·  _homepage, overflow, scroll, spa_
- **D00004L** Album SIR/window crops start nearer the top of the leftover so the cell is painting, not shade; a short top-edge blur s…  ·  `/home/nez/Projects/pokoin-web/market/src/styles.css`  ·  _album, art-cut, artist, spa_
- **D00004M** A bare expansion-title token of 8+ letters that is not an exact NAME_POOL compact (expedition) browses that set and fil…  ·  `/home/nez/Projects/pokoin-web/market/src/suggest-rank.js`  ·  _expedition, search, sets, suggest, typeahead_
- **D00004N** CLIP same-artwork does not copy an illustrator onto energy leftovers (name ending in Energy); only OCR / pokemontcg.io …  ·  `/home/nez/Projects/pokoin-web/scripts/sql/068_same_art_copy_artists.sql`  ·  _artist, clip, energy, same-artwork_
- **D00004P** Rotom Phone / Dex / Catalog / Bike sort as trainers in artist Pokédex order, not at Rotom #479.  ·  `/home/nez/Projects/pokoin-web/market/src/pokedex.js`  ·  _artist, item, pokedex, rotom, spa_
- **D00004T** Artist album leftover crops keep the img layout box inside the 88:63 cell with object-view-box + object-fit cover; do n…  ·  `market/src/styles.css`  ·  _album, art-cut, artist, overflow, spa_
- **D00004V** Album tile top/bottom crop blur tints with leftover art_shade (--album-shade), not rgb(8 10 16).  ·  `/home/nez/Projects/pokoin-web/market/src/styles.css`  ·  _album, art-shade, artist, card-art, spa_
- **D00004W** Pre-Black & White TCG eras have no Full Art; artist album stays a one-row era window except energy/item tiles.  ·  `market/src/art-layout.js`  ·  _album, art-cut, era, full-art, spa_
- **D00004X** Regular GX is album bleed (full artwork). Framed SV ex including Stamp n/m stays window. Tall tiles crop ART_CUT_BLEED,…  ·  `/home/nez/Projects/pokoin-web/market/src/art-layout.js`  ·  _album, art-cut, gx, layout, spa_
- **D00004Z** SM gold trainer/energy leftovers (SM/GR/FL/UP/TEU n/m secrets) are named Gold Secret Rare with leftover art_layout blee…  ·  `/home/nez/Projects/pokoin-web/scripts/sql/078_sm_gold_secret_rare.sql`  ·  _cardtrader, catalog, gold-secret, layout, rarity, spa_
- **D000050** Typed mechanic (keldeo ex) fills matching printings toward 20 and does not rank rival GX/V into that list; suggest flag…  ·  `market/src/suggest-rank.js`  ·  _print-flags, search, spa, suggest, typeahead_
- **D000051** [supersedes D00004U: Giuseppe still saw window tiles zoomed: object-fit cover height-fit the 88:63 cell and clipped the…  ·  `/home/nez/Projects/pokoin-web/market/src/styles.css`  ·  _album, art-cut, artist, card-art, spa_
- **D000052** [supersedes D00003P: Giuseppe: Base Set has no full art except energies. Potion/Super Potion as full leftover looked li…  ·  `/home/nez/Projects/pokoin-web/market/src/art-layout.js`  ·  _album, art-cut, base-set, energy, item, spa_
- **D000053** [supersedes D00004Y: Giuseppe: Base Set has no full art except energies. Doll as tile-item was the same leftover mini-c…  ·  `/home/nez/Projects/pokoin-web/market/src/pokedex.js`  ·  _album, artist, doll, item, pokedex, spa_
- **D000054** [supersedes D00004R: Giuseppe 2026-09-14: vmax are only full artwork. D00004R kept prize-pack VMAX as a framed window.]…  ·  `market/src/art-layout.js`  ·  _art-cut, artist, layout, spa, vmax_
- **D000055** [supersedes D00003R: Firebase-first username lookup made the seller desk 1.5s; listings already have the handle.] Shop …  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/api/marketplace-listings.js`  ·  _listings, perf, seller, spa_
- **D000056** [supersedes D00001Z: Giuseppe: put the Indonesia flag as a button and put Indonesia cards there; do not load thousands …  ·  `/home/nez/Projects/pokoin-web/market/src/pages/Artist.jsx`  ·  _artist, indonesia, print-flags, spa_
- **D000058** Sword & Shield Amazing Rare leftovers are artist-album halfart (one-row illustration box), not Illustration Rare bleed.  ·  `/home/nez/Projects/pokoin-web/market/src/art-layout.js`  ·  _album, amazing-rare, art-cut, artist, layout, spa_
- **D000059** XY Secret Rare EX printings with collector n greater than the set size are album bleed two-row tiles; Gold Secret Mega …  ·  `/home/nez/Projects/pokoin-web/market/src/art-layout.js`  ·  _album, art-cut, ex, layout, spa_
- **D00005B** [supersedes D00005A: Giuseppe: all the tag team, they are not that many, do it manually — not every name with &.] Artis…  ·  `/home/nez/Projects/pokoin-web/market/src/tag-team-partners.js`  ·  _artist, pokedex, spa, tag-team_
- **D00005C** Browser back restores window scroll and artist album shown count for that history entry; PUSH still starts at the top.  ·  `/home/nez/Projects/pokoin-web/market/src/scroll-restore.js`  ·  _artist, first-paint, scroll, spa_
- **D00005E** [supersedes D00005D: Giuseppe: Morty was full art and you halved it. Visual-test before and after.] Morty's Conviction …  ·  `/home/nez/Projects/pokoin-web/market/src/art-layout.js`  ·  _album, art-cut, artist, layout, spa, trainer_
- **D00005F** Desk Related cards shows at most 12 tiles.  ·  `/home/nez/Projects/pokoin-web/market/src/components/RelatedCards.jsx`  ·  _desk, related, spa, tiles_
- **D00005G** Trainer Ultra Rare / SWSH-SV Secret Rare supporters are album bleed two-row full-art even when leftover art_layout is w…  ·  `/home/nez/Projects/pokoin-web/market/src/art-layout.js`  ·  _album, art-cut, artist, layout, spa, trainer_
- **D00005H** [supersedes D00004I: Giuseppe: Komayama Hidden Fates / Shining Fates Pokémon Shiny Rares were wrongly full-art two-row …  ·  `/home/nez/Projects/pokoin-web/market/src/art-layout.js`  ·  _album, art-cut, layout, shiny-rare, spa_
- **D00005I** [supersedes D00002R: Giuseppe asked to move Postgres onto NVMe as well; D00002R already listed that as the re-examine c…  ·  `/home/nez/Projects/pokoin-web/docs/GAMES.md`  ·  _api, cardtrader, dump, nezopt, nvme, pi, postgres_
- **D00005J** [supersedes D000007: Writer PGDATA moved off 15T mybook onto NVMe; tunnel and GET hop unchanged.] CardTrader expansion …  ·  `/home/nez/Projects/pokoin-web/docs/MARKET.md`  ·  _cardtrader, dump, nezopt, nvme, oracle, postgres_
- **D00005K** [supersedes D000008: Writer is NVMe, not 15T mybook; replica hop is unchanged.] Public api.pokoin.com stays on pi-home …  ·  `/home/nez/Projects/pokoin-web/docs/GAMES.md`  ·  _nezopt, nvme, oracle, pi, pokoin, postgres, topology_
- **D00005L** Japanese 30th Celebration leftovers get illustrators from English GPU Illus. OCR plus leftover-scan for IR chrome the r…  ·  `market/src/ocr-artists.js`  ·  _30th, artists, japanese, ocr_
- **D00005N** Typeahead never peels an exact blueprint name as a fuzzy set title: `eevee i` keeps the Eevee name pool instead of peel…  ·  `market/src/suggest-rank.js`  ·  _search, set-peel, suggest, typeahead_
- **D00005O** Scan Connect pairing: 4-digit PIN is only a 120 s single-use selector; the credential is a 256-bit phone token (sha256 …  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/api/_scan_store.js`  ·  _pairing, qr, scan-connect, security_
- **D00005P** Scan batch defaults snapshot at capture time (phone capturedAt + server clock offset → defaults_history entry), consecu…  ·  `/home/nez/Projects/pokoin-web/docs/SCAN_LISTING_WORKFLOW.md`  ·  _inventory, realtime, scan-connect_
- **D00005R** Seller /inventory only lists active or paused rows with quantity_available > 0; cancelled inactive and sold_out stay in…  ·  `/home/nez/Projects/pokoin-web/market/src/pages/Inventory.jsx`  ·  _inventory, listings, seller, spa_
- **D00005T** [supersedes D00005S: Giuseppe: we were not using PowerTools shortcut scoping; replicate candyext single-card Qty-focuse…  ·  `market/src/scan-shortcuts.js`  ·  _powertools, scan-connect, shortcuts, spa_
- **D00005U** Scan Connect Open in Chrome puts googlechromes:// (iOS) or Chrome intent (Android) on the button href so Camera mini-br…  ·  `/home/nez/Projects/BattleScan/web/static/scan-connect.js`  ·  _camera, chrome, phone, scan-connect_
- **D00005V** BattleScan Milo identify stays on the Oracle→nezopt SSH tunnel and loads ROCMExecutionProvider from CARDSCAN_ORT_PATH b…  ·  `/home/nez/Projects/BattleScan/server/app.py`  ·  _battlescan, milo, nezopt, rocm, tunnel_
- **D00005W** Scan Add card useLiveSuggest aborts in-flight Meili on every keystroke/print change (same as Chrome) and passes real pr…  ·  `/home/nez/Projects/pokoin-web/market/src/use-live-suggest.js`  ·  _perf, powertools, scan-connect, search, spa, suggest_
- **D00005Y** [supersedes D00005X: Giuseppe: western only when bulk language is western; JP bulk prefers JP/KO; Chinese bulk prefers …  ·  `/home/nez/Projects/pokoin-web/market/src/scan-artwork-versions.js`  ·  _powertools, scan-connect, spa, versions, western_
- **D000061** [supersedes D00005Z: same decision, re-recorded with its file path so get_node/get_impact on scan-connect.js surfaces i…  ·  `/home/nez/Projects/BattleScan/web/static/scan-connect.js`  ·  _phone, regression, scan-connect, session_
- **D000062** [supersedes D000060: same decision, re-recorded with its file path so get_node/get_impact on deploy-web.sh surfaces it]…  ·  `/home/nez/Projects/pokoin-web/scripts/deploy-web.sh`  ·  _deploy, pokoin-web, process, vercel_
- **D000064** Scan queue LANG options follow the printing nationality: western prints list western langs only; Japanese prints are JP…  ·  `/home/nez/Projects/pokoin-web/market/src/scan-artwork-versions.js`  ·  _artwork, languages, scan-connect, spa_
- **D000065** Manual Add-card draft: selecting JP/KO/ID/TH/VI remaps the printing to a CLIP japanese|korean sibling; ZH/ZHT leave the…  ·  `/home/nez/Projects/pokoin-web/market/src/pages/ScanDesk.jsx`  ·  _artwork, languages, powertools, scan-connect, spa_
- **D000066** Scan Connect identify uses Pokoin milo_cnn (MobileNetV2 student) with cdn_cnn_v22 galleries, not CollectorVision milo.o…  ·  `/home/nez/Projects/BattleScan/server/app.py`  ·  _battlescan, flutter, milo, scan-connect, spa_
- **D000067** BattleScan YOLO detect letterboxes to 640 like Flutter (no stretch). Pokemon overlay snaps the lock rectangle to 63:88 …  ·  `/home/nez/Projects/BattleScan/server/app.py`  ·  _battlescan, overlay, scan-connect, yolo_
- **D000068** [supersedes D000063: Giuseppe: Connection lost showed · 22 scans while the table had only 2 cards.] Scan desk status ch…  ·  `/home/nez/Projects/pokoin-web/market/src/pages/ScanDesk.jsx`  ·  _regression, scan-connect, spa, ui_
- **D000069** Scan batch submit accepts intent list|collection at POST /api/scan-batch?action=submit (default list). Both intents wri…  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/api/_scan_store.js`  ·  _collection, firestore, listings, scan-connect, spa_
- **D00006A** Scan list submit inserts marketplace_user_listings as status=inactive (non-purchasable); activates to active only in th…  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/api/_scan_store.js`  ·  _firestore, idempotency, listings, scan-connect_
- **D00006B** Production web build emits landing.html (not dist-web/index.html); apex / rewrites to landing.html and dashboard.pokoin…  ·  `/home/nez/Projects/pokoin-web/scripts/build-web.sh`  ·  _dashboard, deploy, landing, seller-home, spa, vercel_
- **D00006D** Canonical web collection ownership reads are authenticated BFFs: GET /api/marketplace-collection-summary (Portfolio tot…  ·  `/home/nez/Projects/pokoin-web/market/src/pages/Collection.jsx`  ·  _auth, bff, collection, firestore, spa_
- **D00006E** [supersedes D00006C: Apex /collection also failed: no Firestore allow rule for user_card_collections. Correcting the ea…  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/api/marketplace-collection.js`  ·  _auth, bff, collection, dashboard, firestore, spa_
- **D00006F** /product/graded lists cards with active native graded=true listings via marketplace-card-versions productCategory=grade…  ·  `/home/nez/Projects/pokoin-web/market/src/pages/Products.jsx`  ·  _graded, products, search, spa_
- **D00006G** Seller dashboard Portfolio metrics use ownership first (cards owned, listed qty, physical/NFT qty); listed PKN is label…  ·  `/home/nez/Projects/pokoin-web/market/src/components/SellerDashboardView.jsx`  ·  _dashboard, portfolio, seller-home, spa_
- **D00006H** Abyss Eye 079/081 Fossil Excavation Site is renamed Fossil Quarry and artbox-pinned with Pitch Black 076/084 (v798844) …  ·  `/home/nez/Projects/pokoin-web/scripts/sql/079_fossil_quarry_abyss_eye.sql`  ·  _artbox-pin, clip, names, scan-connect, versions_
- **D00006I** Scan Connect desk QR uses local encodeQr ECC H with a centered Pokoin logo on a white pad (~20%/28% of the module field…  ·  `/home/nez/Projects/pokoin-web/market/src/pages/ScanDesk.jsx`  ·  _branding, qr, scan-connect, spa_
- **D00006J** Scan Connect disconnects the phone after 10 minutes with no accepted scan (last_scan_at ?? phone_connected_at); heartbe…  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/api/_scan_store.js`  ·  _idle, phone, scan-connect, session, spa_
- **D00006K** Standing instruction from Giuseppe (2026-09-18), Pokoin production deployment semantics: 'deploy', 'deploy it', 'deploy…  ·  `/home/nez/Projects/pokoin-web/scripts/deploy-web.sh`  ·  _deploy, origin-main, paseo, pokoin-web, process, production_
- **D00006L** test.pokoin.com review surfaces are Test boards, never stray static pages: every internal review/visual-inspection surf…  ·  `/home/nez/Projects/pokoin-web/market/src/pages/TestsDashboard.jsx`  ·  _pokoin-web, process, review, test-boards, test-pokoin_
- **D00006M** Jumbo Oversized is its own Pokémon product type: product_type 'jumbo', item_kind stays 'single'. CardTrader category 78…  ·  `/home/nez/Projects/cardvault/pokemon_card_vault/oracle-postgres/schema/083_jumbo_product_type.sql`  ·  _cardvault, catalog, ingest, jumbo, pokoin-web, product-type_

### Active conventions

_+8 more decision(s) — full log in `.codevira/decisions.jsonl`._


For the full decision log, use `search_decisions` / `list_decisions` (or the `codevira` CLI) — don't read `.codevira/*.jsonl` directly.

<!-- codevira:end -->
