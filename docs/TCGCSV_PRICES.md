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
handler, and the route manifest declares the new endpoint. Deploy the API with
`scripts/deploy-price-check-api.sh` and the SPA with `scripts/deploy-web.sh`
from the exact pushed `origin/main` commit.

The existing card desk and its CardTrader inferred-sale graph retain their
layout and source contract from `docs/MARKET.md`. Imported listing asks and
TCGplayer quotes are available separately to Poko and the MyPokoin pricer.
Source variants remain separate and missing daily observations stay missing.
Listing asks never enter the sold-price calculations.

Pi reads the separate price database through the private reader SSH tunnel.
`scripts/nezopt-k3s.sh sync` rewrites that localhost connection to the private
Docker address `172.31.250.11:5432` for overflow pods, preserving the restricted
reader account. Both API paths need a live read-only quote query after deploy.

## Public card-desk price history

`GET /api/marketplace-card-price-history?cardId=824942&from=2024-02-08&to=2026-10-02`
is a public, bounded (maximum 10 years), read-only endpoint for one exact public
printing. It resolves `marketplace_search_candidates.card_id` to `ct_id`; it
never derives an identity with arithmetic or blends same-artwork languages.
Each independent source has `available`, `empty`, `unavailable` or `unconfigured`
status; a TCGCSV outage leaves CardTrader analytics available.

`cardtrader.days` exposes only **lowest listed ask PKN**, with listing/copy/seller
counts, from the existing `cardtrader_blueprint_daily_analytics` dump rollup.
That legacy rollup copies the cheapest cache into all four price columns: its
`median_price_pkn` is not a measured median and must not be displayed as one.
Quote `day` is the actual `refreshed_at` UTC date. `dumpDay` preserves the rollup's
previous-day pipeline bucket, and `sourceTimestamp` preserves its exact refresh.
These are blueprint-wide asks, not condition/language-specific or transactions.
No values are inserted into `marketplace_price_observations` or sold history.
For CT 412471 / public 824942, actual refresh dates September 30, October 1 and
October 2 contain lowest asks 13128, 12128 and 11128 PKN respectively.

`tcgplayer.series` preserves separate product/category/subtype groups and exact
USD decimal strings. It reuses the existing explicit product crosswalk and
`all_daily_prices`; missing days remain missing and one observation stays one
point. Existing `marketplace-card-sales` behavior is unchanged. The authenticated
TCGplayer inventory history route remains available independently.

Deploy through `scripts/deploy-price-check-api.sh` from the exact integrated
`origin/main` commit; it includes both helpers, the public handler, route manifest
and their tests. TCGCSV reader configuration is optional to the CardTrader feed.

The inventory pricer also resolves CardTrader identities through the exact public
candidate mapping. Its listed-ask and sold-median queries use mapped blueprint
IDs, then re-key their outputs by the requested public ID; numeric division and
raw public-ID/blueprint collisions never choose a different printing. Native
listings and TCGplayer links retain their own public-card identities.
