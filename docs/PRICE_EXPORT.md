# Price export (PKP2): the daily headline-price dictionary

The CardRails iPhone camera shows the Pokoin price of a recognized card in the
user's currency from a **local dictionary refreshed daily**. Today prices are
only available per item through the seller connector (`sold_prices`,
`crates/commerce/src/handlers/seller_api.rs`), which needs a seller grant and
caps at 500 items. The export is the bulk, **read-only** version of that same
quote, so a camera headline always matches what CardRails auto-prices with.

## Price rule

Same sources, same order as the connector's `sold_prices`, restricted to the
headline copy the camera prices — **Near Mint, ungraded, non-reverse, per
language**:

1. **Sold 30 days** (`source = 0`): the lowest confirmed sale in
   `cardtrader_sold_daily` over the last 30 days (`observed_day >=
   current_date - 30`) with `graded = false`, `reverse = false`,
   `first_edition = false`, `condition = 'NM'`, `sold_qty > 0` — one minimum
   **per language**.
2. **Cheapest CardTrader listing** (`source = 1`): `min(cheapest_price_pkn)`
   from `cheapest_homepage_cache_blueprint` with `provider = 'cardtrader'`,
   when the card has no qualifying sale at all. The cache is per blueprint and
   carries no language or condition facets, so it can only fill the
   language-"any" row — it never pretends to be a language row.
3. **Else no row.** A card with no qualifying sale and no CardTrader listing
   is absent from the file.

Prices are **EUR cents** at `PKN_PER_EUR_CENT = 2` PKN per cent, rounded — the
connector's exact conversion. Prices under 1 PKN (half a euro-cent) round to 0
and are dropped at the source, so a card that appears in the file always has a
price.

Rows: one per `(card_id, language)` that has a sold price, plus one
language-"any" row (`lang = 0`) per card holding **the cheapest across the
card's language rows** — what the camera shows until the scan decides the
language. A sale in a language outside the fixed list below gets no row of its
own and does not feed the "any" row either.

`card_id` is Pokoin's own id: **twice the CardTrader blueprint id** (the
connector's `blueprint_id_of` = `card_id / 2`).

## Language codes

`lang` is a byte: `0` is the "any" row, `1…16` are the fixed list — Scan
Connect's language set (`crates/external/src/scan_connect.rs` `LANGUAGES`;
`cardtrader_sold_daily.language` stores these normalized uppercase codes).

| code | lang | | code | lang | | code | lang | | code | lang |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | EN | | 6 | PT | | 11 | NL | | 16 | VI |
| 2 | IT | | 7 | JP | | 12 | PL | | | |
| 3 | FR | | 8 | ZH | | 13 | RU | | | |
| 4 | DE | | 9 | KO | | 14 | ZHT | | | |
| 5 | ES | | 10 | ID | | 15 | TH | | | |

## File format — PKP2

Little-endian throughout; a 24-byte header then fixed 10-byte rows sorted by
`(card_id, lang)`:

```text
offset  size  header
0       4     magic "PKP2"
4       2     version (u16, currently 1)
6       2     reserved (u16, 0)
8       4     row_count (u32)
12      8     as_of (u64, unix seconds of the export)
20      4     source_count (u32, distinct card ids the file covers)

offset  size  row (repeated row_count times)
0       4     card_id (u32, = CardTrader blueprint id × 2)
4       1     lang (u8, table above)
5       1     source (u8: 0 = sold 30 days, 1 = cardtrader)
6       4     cents (u32, EUR cents)
```

`decode` in `crates/commerce/src/price_export.rs` is the reference reader;
consumers that reject a wrong magic, version or length are safe against
truncated uploads.

## Running the export

```sh
cd pokoin-rust
MARKETPLACE_DATABASE_URL=postgres://… cargo run --release -p pokoin-commerce --bin price-export /srv/export/headline-prices.pkp2
```

- Reads `MARKETPLACE_DATABASE_URL`, falling back to `DATABASE_URL` — point it
  at the **read replica**, the same pool the API reads with.
- Writes `<path>` and `<path>.sha256` (`sha256sum -c` ready).
- **Read-only**: the only statement it runs is one set-based SELECT (no
  per-card loops), and the connection is opened with
  `default_transaction_read_only = on`, so even a future accidental write
  fails at the session level. No writer pool, no webhook, no side effects.
- A daily cron/candidate schedule is up to the caller; `as_of` in the header
  is the export time the phone can staleness-check against.

## Code

| piece | where |
| --- | --- |
| rule + one-statement SQL + encoder/decoder | `pokoin-rust/crates/commerce/src/price_export.rs` |
| the `price-export` binary | `pokoin-rust/crates/commerce/src/bin/price_export.rs` |
| unit tests (header, round trip, sort, codes) | same module, `cargo test -p pokoin-commerce --lib` |
| SQL flow test on a throwaway Postgres | `pokoin-rust/crates/commerce/tests/price_export_flow.rs` |

Flow test (own container — the test drops and recreates its tables, so keep it
away from the seller-api flow test's container):

```sh
docker run -d --rm --name pokoin-price-export-test-pg -e POSTGRES_PASSWORD=test \
  -p 127.0.0.1:55496:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
cd pokoin-rust && POKOIN_PRICE_EXPORT_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55496/postgres \
  cargo test -p pokoin-commerce --test price_export_flow
```

The test asserts the connector order on real data: a 30-day NM sale wins over
a cheaper CardTrader listing; graded/reverse/first-edition/played/out-of-
window/zero-qty sales and out-of-list languages are ignored; the "any" row is
the cheapest language; the CardTrader minimum takes over only when nothing
sold qualifies.
