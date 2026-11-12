# Price dumps: every market feed in one place

Where each price feed comes from, which host runs it, when, where the data lands and how a
failure is reported. Written 2026-11-11 from the live units and status files; the detail for each
feed stays in its own document, linked in the last column.

## Map

| Feed | What it holds | Runs on | Unit | Schedule | Data lands in | Failure alert | Detail |
|---|---|---|---|---|---|---|---|
| CardTrader listings | Raw listing book of every expansion of every live game | nezopt (user unit) | `pokoin-all-cardtrader-daily.timer` | daily 23:00 UTC | `/home/nez/data/pokoin-catalog-refresh/daily/<UTC date>/listing-books/`, then each game's price caches | `pokoin-ops hc-ping` at start and end (drop-in `alerts.conf`) | [CARDTRADER_DAILY_DUMP.md](CARDTRADER_DAILY_DUMP.md) |
| CardTrader market refresh | Listing snapshots and inferred sales in the marketplace writer | Oracle `pokoin-marketplace` (system unit) | `pokoin-cardtrader-daily-market-refresh.timer` | daily 01:00 UTC | `pokoin_marketplace` on nezopt, through the writer tunnel | not read for this document | project `ct-pkn_pricedump` |
| TCGplayer (TCGCSV) | Every product and price row of all TCGplayer categories, USD | Oracle `pokoin-marketplace` downloads; nezopt imports | `tcgcsv-daily.timer` (Oracle), tunnel `tcgcsv-oracle-storage-tunnel.service` (nezopt) | hourly check 10:10–21:10 Europe/Copenhagen, one real pull per 24 h | snapshots in `/home/nez/mnt/mybook/tcgprices/tcgcsv/snapshots/`, database `tcgprices` (container `tcgprices-postgres-15t`, localhost 27432) | `tcgcsv-notify-failure.service` (Flareon Telegram notifier) | [TCGCSV_PRICES.md](TCGCSV_PRICES.md), project `tcgprices` |
| Cardmarket price guide | Cardmarket's public guide: one global low/avg/trend per product, every game | nezopt (user unit) | `pokoin-cardmarket-guides.timer` | daily 02:45 UTC | `pokoin_marketplace.cardmarket_price_guide` | mail, `OnFailure=pokoin-notify@%n.service` | [PRICING.md](PRICING.md) "Price sources" |
| Cardmarket seller prices | Cheapest professional and cheapest private offer per product, language and condition | nezopt (user units) | `pokoin-cm-price-collector.service` (the walk), `pokoin-cm-price-ingest.timer`, `pokoin-cm-price-publish.timer` | walk continuous on a 7-day cycle; load hourly; publish Monday 03:00 UTC | schema `cm_prices` in `pokoin_marketplace`; readers use the view `cm_prices.current_minimums` | mail, `OnFailure=pokoin-notify@%n.service` on all three | project `cm-price-engine` |
| eBay | not built | — | — | — | — | — | [PRICING.md](PRICING.md) lists it as the owner's call |

## State on 2026-11-11

- TCGplayer: last snapshot `2026-11-10T20:05:49Z`, 637,426 rows, import complete
  (`/home/nez/mnt/mybook/tcgprices/tcgcsv/postgres-status.json`).
- CardTrader listings: last run 2026-11-10 23:00 UTC.
- Cardmarket guide: last run 2026-11-11 02:47 UTC.
- Cardmarket seller prices: snapshot 1 published 2026-11-11 from the 2026-11-10 scan (4,095 prices,
  406 products). The walk is installed and NOT started; the owner starts it with
  `systemctl --user enable --now pokoin-cm-price-collector.service` after adding the CTCMDeals fetch
  settings to `~/.config/cm-price-engine/collector.env`. Until then the Monday publish mails that
  nothing new was observed.
- The older table `pokoin_marketplace.cardmarket_offer_minimums` (loaded by
  `pokoin-cardmarket-catalog cm-offers`) is what the pricer reads today. Nothing reads `cm_prices` yet.

## Conventions a new feed should follow

- A `pokoin-*` unit beside the others (`~/.config/systemd/user` on nezopt for user jobs), installed
  under `~/pokoin-deploy/<name>/`, never run from a working checkout that other sessions edit.
- Database logins read at run time (container login or a mode-600 env file); nothing secret in a unit.
- `OnFailure=pokoin-notify@%n.service` for mail, and a `pokoin-ops hc-ping` drop-in when the job must
  also alert on NOT running.
- Raw source data is kept (snapshots, listing books, the walk's `minimums.jsonl`); derived tables are
  rebuilt from it. Missing days stay missing: no value is invented or carried forward.
- Each feed has its own source status in the pricer, so one stale or failed feed never changes
  another feed's price.

## Gaps

- Alerts differ: TCGplayer reports through Telegram, the others through mail or hc-ping.
- The `pokoin-cm-price-*` units are not in `~/.config/pokoin/expected-active.txt`.
- No dashboard reads all feeds; `dumpdashboard` (mybook) was not checked against this list.
