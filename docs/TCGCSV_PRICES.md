# TCGplayer daily prices

The source is TCGCSV's daily dump of every TCGplayer category, in USD. TCGCSV
publishes one dump per day at about 20:05 UTC and carries its timestamp in
`last-updated.txt`. It serves only the newest day: its dated archives were
suspended on 2026-09-16, so a day that was never pulled cannot be recovered.

The pull is a system unit on the Oracle host. `tcgcsv-daily.timer`
(`OnCalendar=*-*-* 10..23:40:00 Europe/Copenhagen`, one tick every hour from
10:40 to 23:40 Copenhagen) fires `tcgcsv-daily.service`, which runs
`/home/ubuntu/tcgprices/current/oracle_daily_update.py`. `current` is a symlink
into `/home/ubuntu/tcgprices/releases/`; since 2026-11-19 it points at release
`20261119-publication-gate-2`. The host runs Python 3.10 and a release's tests
are run on the host before the symlink is switched. The source repository is
`tcgprices` on nezopt (`/home/nez/mnt/mybook/Projects/tcgprices`, no remote);
full operational instructions are in that project's README.md.

The downloaded snapshot is copied to nezopt
(`/home/nez/mnt/mybook/tcgprices/tcgcsv/snapshots/`) and imported there into the
`tcgprices` database (container `tcgprices-postgres-15t`). The pipeline
archives complete TCGCSV snapshots, imports every price row and refreshes
explicit CardTrader TCGplayer links from all local Pokoin game catalogs.
Neither CardTrader prices nor public IDs change. The API reads the views
`all_daily_prices` and `latest_prices`
(`pokoin-rust/crates/catalog-api/src/sales/tcgcsv.rs`).

## The gate: when a day's prices appear

Every tick answers `idle`, `probe` or `download`. It is idle while the last
transferred snapshot is younger than 20 hours; after that it probes
`last-updated.txt` once per tick and downloads only when the upstream stamp is
newer than the stamp of the last transferred snapshot. The gate keys on the
publication, not on the previous run.

Publication at about 20:05 UTC is followed by the first tick at 20:40 UTC
(21:40 Copenhagen in winter, 22:40 in summer). Download and import take about
45 minutes, so day D's prices are on the site at about 21:30 UTC on day D.
Before 2026-11-19 the job pulled at most once per 24 hours from the last check,
so the pull drifted an hour later every day — 10:10 to 15:10 Copenhagen in ten
days — and a day's prices appeared the next afternoon.

## When a pull fails

A failed download does not move the gate; it is retried at the next hourly tick,
at most 3 download attempts per publication. A snapshot that was downloaded but
cannot be transferred or imported is retried at most 6 times per stage and then
set aside, so the next publication is still fetched. Corrupt state files are
moved aside as `<name>.corrupt-<stamp>`. The journal
(`journalctl -u tcgcsv-daily.service` on the Oracle host) and
`/home/ubuntu/tcgprices/state/oracle-status.json` carry the failing stage, the
attempt number and the error's type and message.

## Missing days

2026-11-12 and 2026-11-15 are missing. The pulls of 2026-11-13 and 2026-11-16
failed and, under the old gate, the next run fetched the next day instead. The
cause was a race in the downloader: worker threads changed a set's record while
the main thread was writing the manifest (`dictionary changed size during
iteration`). It was fixed on 2026-11-19 — workers return their result and only
the main thread writes the manifest. Those two days cannot be recovered.

## Alerts (not working)

The job's notices go through `notify_flareon.py` on nezopt. Since about
2026-10-21 that notifier cannot deliver: it depended on a container that no
longer exists. 48 notices are queued and undelivered. This is open as finding
PRICE-10.

## Checking freshness by hand

Read-only, in the `tcgprices` database, the newest day is
`select max(day) from all_daily_prices where category_id = 3`. On the Oracle
host, `systemctl list-timers tcgcsv-daily.timer` names the next tick, and
`journalctl -u tcgcsv-daily.service` with
`/home/ubuntu/tcgprices/state/oracle-status.json` show the last runs. The card
page's graph thins long ranges to one point per week, so the last plotted
TCGplayer point can be a few days before the newest day in the table: that is
the graph, not the feed.

## Configuration and readers

Configure `TCGCSV_DATABASE_URL` for the separate `tcgprices` database using the
restricted `tcgcsv_pokoin_reader` account through the private Nezopt/Pi tunnel.
The mode-600 connection file is on Nezopt at
`/home/nez/mnt/mybook/tcgprices/postgres/pokoin-reader.env`. Do not commit it.
`TCGCSV_DATABASE_SSL=0` is for the localhost SSH-tunnel connection only.

`marketplace-price-check` adds `tcgplayer` (all quotes for mapped products and
variants) and `tcgplayerStatus` to each existing item. Existing fields retain
their previous behavior. The `tcgplayer` quotes stay in USD. Since 2026-11-07
the comp's `sources.tcgplayer` block also converts them for the pricer, at
the newest ECB rate (`fx_rates_daily`), and only a strategy whose source the
seller set to TCGplayer uses it (docs/PRICING.md "Price sources").
Condition/language are explicitly unspecified.
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
Pokémon printings CardTrader leaves unlinked are filled by the Rust
set + collector-number + name matcher, tagged `match_source = 'pokoin-matcher'`
(99.9% agreement with CardTrader on a blind holdout); see
[TCGPLAYER_MATCH.md](TCGPLAYER_MATCH.md).

Validation: six API/helper tests, compiled inventory JSX, real read-only latest
and historical database queries for Mew (2 variants, 1,858 observations), and
rejected reader UPDATE. The history handlers are native Rust
(`pokoin-rust/crates/catalog-api/src/sales`; price check in `crates/external`). Deploy the API with `scripts/deploy-pokoin-rust.sh`
and the SPA with `scripts/deploy-web.sh` from the exact pushed `origin/main` commit.

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

`pokoin.days` is Pokoin's own market: the cheapest live native listing at the end
of every UTC day, `{day, lowestAskPkn, listingCount}`, read with one statement
from `marketplace_user_listings_events` through the existing
`marketplace_user_listing_events_card_day_idx`. It is an ask, never a sale, and
joins no sold calculation. A database without that table answers
`pokoin.status = "empty"`, the same degradation the other legs use (PH-02
`table_presence`), with no failed statement.

`?fields=graph` trims the answer to what the desk plots — one number per source
per day, the one TCGplayer series `reverse` picks and the Cardmarket trend of
that same facet — and thins a span over 400 days to one point per ISO week,
marked `"bucket": "week"`. Without the parameter the full shape above is
unchanged.

Deploy through `scripts/deploy-pokoin-rust.sh` from the exact integrated
`origin/main` commit. TCGCSV reader configuration is optional to the CardTrader feed.

The inventory pricer also resolves CardTrader identities through the exact public
candidate mapping. Its listed-ask and sold-median queries use mapped blueprint
IDs, then re-key their outputs by the requested public ID; numeric division and
raw public-ID/blueprint collisions never choose a different printing. Native
listings and TCGplayer links retain their own public-card identities.

The inventory pricer adds `cardtraderListed` for each item: up to 30 observed
UTC days of the existing dump's lowest asks, source refresh timestamp, assigned
dump day and listing/copy/seller counts. One bulk mapped-blueprint query supplies
all requested cards. These are aggregate asks across facets, not a replacement
for condition-matched live offers or sold medians. Missing analytics leave those
existing comps unchanged; automated pricing must never silently use USD quotes
(a TCGplayer strategy is the seller's explicit choice, converted at a dated
ECB rate) or treat aggregate dump asks as condition-specific realized sales.
