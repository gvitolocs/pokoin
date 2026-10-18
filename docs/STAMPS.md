# Stamped printings and their expansion chip

A deck printing that carries a mascot stamp (Battle Academy Mewtwo, Trainer
Kit Bisharp, Everyone's Exciting Battle Virizion, …) shows that stamp as its
expansion symbol on the desk version row, search suggest and set tiles,
instead of the deck's code plate. `market/src/expansion-stamps.js` picks it:

1. `CARD_STAMPS` (`market/src/data/card-stamps.js`): card_id → stamp, for
   printings whose catalog number names no stamp. Read off the scans (below).
2. `PRINTING_STAMPS`: the stamp named in `card_number`
   ("089/214 | Mewtwo Stamp", "109 | Pikachu 28", CardTrader typos included).
3. `SET_STAMPS`: products where every card carries the same mark (half-deck
   Trainer Kits, Battle Theme Deck Victini, Trick or Trade Pumpkaboo, Play!
   Pokémon Prize Packs).

`ExpansionMark` tries the stamp plate, then the set mark, then the letter code.

## Plates

`tools/expansion-stamps` (Rust) draws `expansions/stamps/{key}.png`: 192 px
square D00002C plates (dark `rgb(35 31 32)`, light `#bec0c2` glyph).
Pokémon stamps are silhouettes of the PokeAPI official artwork (HOME render for
Greninja and Cinderace); the Poké Ball and snowflake are drawn; letter-mark
logos (Team Rocket R, Team Aqua A, Team Magma M, Play!) are DejaVu Sans Bold,
the D00002C code-plate face. `stamps.tsv` lists every key and its source.

Publish to both CDN origins (nezopt mirror + Pi) with
`bash scripts/publish-expansion-stamps.sh --apply`; bump `STAMP_CACHE` when a
plate is redrawn.

## Survey (2026-10-18)

`tools/stamp-survey sheet` rendered one sample scan per expansion (829
expansions, 901 samples: a second card where the catalog mentions a stamp),
whole card plus a lower-right zoom; every sheet was reviewed by eye.
`tools/stamp-survey/survey.tsv` records expansion → sample card → stamp seen.

`tools/stamp-survey match` handles decks where most numbers name no stamp: it
locates the stamp box from same-card copies with different stamps, models each
stamp as ink colour + mask, and proposes a stamp per printing on a review
sheet. Every proposal was checked by eye before going into `CARD_STAMPS`;
Energy cards with no stamp in the box stay unmapped.

Seen on scans but not turned into chips (event/logo overprints, not deck
mascots): 1st Edition, Pokémon League / Championships / Professor Program /
Pokémon Center / GYM / prerelease set-logo stamps, McDonald's, Build-A-Bear,
GameStop, Pizza Hut, movie logos, World Championship Deck signatures,
Gem Pack and 25th/30th anniversary logos, jumbo "Oversized" marks.

Open questions are in the PR (gvitolocs/pokoin#452) and in `survey.tsv`
(`UNCLEAR`).
