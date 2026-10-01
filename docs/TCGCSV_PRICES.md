# TCGplayer daily prices

The lossless all-game store lives on Nezopt's 15 TB disk. Its updater is
`/home/nez/Projects/tcgprices/daily_update.py`; it archives complete TCGCSV
snapshots, imports every price row and refreshes explicit CardTrader TCGplayer
links from all local Pokoin game catalogs. Full operational instructions are
in that project's README.md. Neither CardTrader prices nor public IDs change.

Configure `TCGCSV_DATABASE_URL` for the separate `tcgprices` database using the
restricted `tcgcsv_pokoin_reader` account through the private Nezopt/Pi tunnel.
The mode-600 connection file is on Nezopt at
`/home/nez/mnt/mybook/tcgprices/postgres/pokoin-reader.env`. Do not commit it.
`TCGCSV_DATABASE_SSL=0` is for the localhost SSH-tunnel connection only.

`marketplace-price-check` adds `tcgplayer` (all quotes for mapped products and
variants) and `tcgplayerStatus` to each existing item. Existing fields retain
their previous behavior. USD values remain exact PostgreSQL decimal strings;
there is no conversion to PKN. Condition/language are explicitly unspecified.
Inventory shows the available market-price range and each variant/timestamp.
Failure of this independent feed leaves existing price sources available.

Authenticated `GET /api/marketplace-tcgplayer-history?cardId=248668&from=2024-02-08&to=2026-09-30`
returns all observed days and subtypes for that public card in the request's
game context. Missing days stay missing. Historical coverage is Pokemon EN
from February 8, 2024 and Pokemon JP from December 11, 2024 to September 15,
2026. All games have the September 30 snapshot; September 16–29 are absent.
Other-game history accumulates from future successful daily snapshots.

The initial run created 270,359 explicit links across 25 inspected databases;
16 games have matched quotes. Catalogs without IDs remain unmapped and their
original price rows remain in the separate source store. No fuzzy identity
matching, fabricated condition prices or synthetic sales are introduced.

Validation: six API/helper tests, compiled inventory JSX, real read-only latest
and historical database queries for Mew (2 variants, 1,858 observations), and
rejected reader UPDATE. The deployment script includes the helper and history
handler, and the route manifest declares the new endpoint. Deployment is pending
explicit authorization under AGENTS.md; the live site's button is still disabled.
