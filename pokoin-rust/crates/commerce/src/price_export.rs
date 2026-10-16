//! Read-only daily bulk export of headline Pokoin prices: the `PKP2` file the
//! CardRails camera dictionary ships.
//!
//! The CardRails iPhone camera shows the Pokoin price of a recognized card in
//! the user's currency from a dictionary it refreshes once a day. This module
//! builds that dictionary from the same two sources, in the same order, the
//! seller connector quotes with (`handlers/seller_api.rs` `sold_prices`), so a
//! camera headline always matches what CardRails auto-prices with:
//!
//! 1. the lowest confirmed sale in `cardtrader_sold_daily` over the last
//!    [`SOLD_WINDOW_DAYS`] days of a raw Near-Mint copy — `graded = false`,
//!    `reverse = false`, `first_edition = false`, `condition = 'NM'` — one
//!    minimum per language;
//! 2. else the cheapest CardTrader listing in
//!    `cheapest_homepage_cache_blueprint` (`provider = 'cardtrader'`; the
//!    cache is per blueprint and carries no language or condition facets, so
//!    it can only fill the language-"any" row);
//! 3. else no row.
//!
//! One row per (card, language) that has a sold price, plus a language-"any"
//! row ([`LANG_ANY`]) holding the cheapest across the card's language rows —
//! what the camera shows until the scan has decided the language. When the
//! card has no sold row at all, the CardTrader listing minimum becomes the
//! "any" row. Prices are EUR cents with the connector's
//! `PKN_PER_EUR_CENT` conversion. Everything here is SELECT-only.
//!
//! Format (little-endian throughout; see `docs/PRICE_EXPORT.md`):
//!
//! ```text
//! header  24 B  "PKP2" | version:u16 | reserved:u16 | row_count:u32
//!              | as_of:u64 (unix seconds) | source_count:u32
//! row     10 B  card_id:u32 | lang:u8 | source:u8 | cents:u32
//! ```
//!
//! Rows are sorted by `(card_id, lang)`; `source_count` counts the distinct
//! card ids the file covers.

use std::collections::HashSet;

use sqlx::PgPool;

use crate::domain::money::PKN_PER_EUR_CENT;

/// The exported price window, the connector's `LAST_SOLD_WINDOW_DAYS`.
pub const SOLD_WINDOW_DAYS: i32 = 30;

/// Language code of the "any" row: the cheapest across languages, used until
/// the scan decides the language.
pub const LANG_ANY: u8 = 0;

/// The fixed language list behind codes 1.. (Scan Connect's language set;
/// `cardtrader_sold_daily.language` stores these normalized uppercase codes).
/// A sale in a language outside this list gets no row of its own and does not
/// feed the "any" row either — the card simply falls through to its
/// CardTrader minimum when these are all absent.
pub const LANGUAGES: [&str; 16] = [
    "EN", "IT", "FR", "DE", "ES", "PT", "JP", "ZH", "KO", "ID", "NL", "PL", "RU", "ZHT", "TH", "VI",
];

/// `source` of a row: the 30-day sold minimum.
pub const SOURCE_SOLD_30D: u8 = 0;
/// `source` of a row: the cheapest CardTrader listing.
pub const SOURCE_CARDTRADER: u8 = 1;

pub const MAGIC: [u8; 4] = *b"PKP2";
pub const FORMAT_VERSION: u16 = 1;
pub const HEADER_BYTES: usize = 24;
pub const ROW_BYTES: usize = 10;

/// One headline price. `(card_id, lang)` is unique; `card_id` is Pokoin's own
/// id (twice the CardTrader blueprint id, the connector's mapping).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct PriceRow {
    pub card_id: u32,
    pub lang: u8,
    pub source: u8,
    pub cents: u32,
}

/// The decoded 24-byte file header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pkp2Header {
    pub version: u16,
    pub reserved: u16,
    pub row_count: u32,
    /// Export time, unix seconds.
    pub as_of: u64,
    /// Distinct card ids covered.
    pub source_count: u32,
}

/// `1` for `"EN"`, [`LANG_ANY`] for anything else. Case-insensitive.
pub fn language_code(language: &str) -> Option<u8> {
    let upper = language.trim().to_ascii_uppercase();
    LANGUAGES.iter().position(|known| *known == upper).map(|index| index as u8 + 1)
}

/// `"EN"` for `1`; [`None`] for anything that is not a code in
/// [`LANGUAGES`] (including [`LANG_ANY`], which has no name).
pub fn language_name(code: u8) -> Option<&'static str> {
    LANGUAGES.get(code.checked_sub(1)? as usize).copied()
}

/// The fixed `(language, code)` list as a SQL `values` clause, so the query
/// and [`LANGUAGES`] cannot drift apart.
fn language_values_sql() -> String {
    LANGUAGES
        .iter()
        .enumerate()
        .map(|(index, language)| format!("('{language}',{})", index + 1))
        .collect::<Vec<_>>()
        .join(",")
}

/// The whole export in one set-based statement: per-language 30-day NM
/// minimums, the cheapest CardTrader listing per blueprint, and the language-
/// "any" row (cheapest sold language, else the CardTrader minimum). No
/// per-card loops; `card_id` is `blueprint_id * 2` as everywhere else.
///
/// Prices under 1 PKN (half a euro-cent) round to 0 cents and are dropped at
/// the source, so a "sold rows exist" card always exports a price.
fn export_sql() -> String {
    format!(
        "with sold as ( \
           select s.blueprint_id, l.code as lang, min(s.min_pkn)::float8 as min_pkn \
             from cardtrader_sold_daily s \
             join (values {langs}) as l(lang, code) on l.lang = s.language \
            where s.graded = false \
              and s.reverse = false \
              and s.first_edition = false \
              and s.condition = 'NM' \
              and s.sold_qty > 0 \
              and s.min_pkn >= 1 \
              and s.blueprint_id > 0 \
              and s.observed_day >= current_date - $1::int \
            group by s.blueprint_id, l.code \
         ), \
         tile as ( \
           select c.blueprint_id, min(c.cheapest_price_pkn)::float8 as min_pkn \
             from cheapest_homepage_cache_blueprint c \
            where c.provider = 'cardtrader' \
              and c.cheapest_price_pkn >= 1 \
              and c.blueprint_id > 0 \
            group by c.blueprint_id \
         ), \
         any_price as ( \
           select s.blueprint_id, min(s.min_pkn) as min_pkn, 0 as source \
             from sold s group by s.blueprint_id \
           union all \
           select t.blueprint_id, t.min_pkn, 1 as source \
             from tile t \
            where not exists (select 1 from sold s where s.blueprint_id = t.blueprint_id) \
         ) \
         select p.card_id, p.lang, p.source, p.min_pkn \
           from ( \
                 select a.blueprint_id * 2 as card_id, 0 as lang, a.source, a.min_pkn \
                   from any_price a \
                 union all \
                 select s.blueprint_id * 2, s.lang, 0 as source, s.min_pkn \
                   from sold s \
                ) p \
          order by p.card_id, p.lang",
        langs = language_values_sql(),
    )
}

/// Read every headline price off the database. Read-only: the one statement
/// this runs is the SELECT above — never a write.
pub async fn collect_price_rows(db: &PgPool) -> Result<Vec<PriceRow>, sqlx::Error> {
    let rows: Vec<(i64, i32, i32, f64)> =
        sqlx::query_as(&export_sql()).bind(SOLD_WINDOW_DAYS).fetch_all(db).await?;
    Ok(rows
        .into_iter()
        .filter_map(|(card_id, lang, source, min_pkn)| {
            // Same conversion as the connector's `sold_prices`: EUR cents at
            // 2 PKN per cent, rounded. Non-finite or non-positive prices are
            // dropped, never clamped.
            if !min_pkn.is_finite() {
                return None;
            }
            let cents = u32::try_from((min_pkn / PKN_PER_EUR_CENT as f64).round() as i64).ok()?;
            (cents > 0).then_some(PriceRow {
                card_id: u32::try_from(card_id).ok()?,
                lang: u8::try_from(lang).ok()?,
                source: u8::try_from(source).ok()?,
                cents,
            })
        })
        .collect())
}

/// Encode the `PKP2` file: the 24-byte header, then the rows sorted by
/// `(card_id, lang)`. `rows` may arrive in any order; the file order is the
/// encoder's job.
pub fn encode(as_of_unix_seconds: u64, rows: &[PriceRow]) -> Vec<u8> {
    let mut sorted: Vec<PriceRow> = rows.to_vec();
    sorted.sort_unstable();
    let source_count = sorted.iter().map(|row| row.card_id).collect::<HashSet<_>>().len() as u32;
    let mut out = Vec::with_capacity(HEADER_BYTES + sorted.len() * ROW_BYTES);
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&(sorted.len() as u32).to_le_bytes());
    out.extend_from_slice(&as_of_unix_seconds.to_le_bytes());
    out.extend_from_slice(&source_count.to_le_bytes());
    for row in sorted {
        out.extend_from_slice(&row.card_id.to_le_bytes());
        out.push(row.lang);
        out.push(row.source);
        out.extend_from_slice(&row.cents.to_le_bytes());
    }
    out
}

/// The reference decoder: exactly what a consumer (CardRails) reads back.
pub fn decode(bytes: &[u8]) -> Result<(Pkp2Header, Vec<PriceRow>), String> {
    if bytes.len() < HEADER_BYTES {
        return Err(format!("truncated: {} bytes is smaller than the {}-byte header", bytes.len(), HEADER_BYTES));
    }
    if bytes[..4] != MAGIC {
        return Err(format!("not a PKP2 file: magic {:02x?}", &bytes[..4]));
    }
    let version = u16::from_le_bytes(bytes[4..6].try_into().unwrap());
    if version != FORMAT_VERSION {
        return Err(format!("unsupported PKP2 version {version}"));
    }
    let header = Pkp2Header {
        version,
        reserved: u16::from_le_bytes(bytes[6..8].try_into().unwrap()),
        row_count: u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
        as_of: u64::from_le_bytes(bytes[12..20].try_into().unwrap()),
        source_count: u32::from_le_bytes(bytes[20..24].try_into().unwrap()),
    };
    let rows_bytes = (header.row_count as usize)
        .checked_mul(ROW_BYTES)
        .ok_or_else(|| format!("row_count {} is absurd", header.row_count))?;
    let expected = HEADER_BYTES + rows_bytes;
    if bytes.len() != expected {
        return Err(format!("length mismatch: {} bytes, header says {expected}", bytes.len()));
    }
    let mut rows = Vec::with_capacity(header.row_count as usize);
    for row in bytes[HEADER_BYTES..].as_chunks::<ROW_BYTES>().0 {
        rows.push(PriceRow {
            card_id: u32::from_le_bytes(row[0..4].try_into().unwrap()),
            lang: row[4],
            source: row[5],
            cents: u32::from_le_bytes(row[6..10].try_into().unwrap()),
        });
    }
    Ok((header, rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(card_id: u32, lang: u8, source: u8, cents: u32) -> PriceRow {
        PriceRow { card_id, lang, source, cents }
    }

    #[test]
    fn language_codes_are_the_documented_fixed_list() {
        assert_eq!(language_code("EN"), Some(1));
        assert_eq!(language_code("it"), Some(2));
        assert_eq!(language_code(" JP "), Some(7));
        assert_eq!(language_code("ID"), Some(10));
        assert_eq!(language_code("VI"), Some(16));
        assert_eq!(language_code("ru"), Some(13));
        // Unknown languages have no code: not "any".
        assert_eq!(language_code("*"), None);
        assert_eq!(language_code("RU-XX"), None);
        assert_eq!(language_code(""), None);
        for (index, name) in LANGUAGES.iter().enumerate() {
            assert_eq!(language_code(name), Some(index as u8 + 1));
            assert_eq!(language_name(index as u8 + 1), Some(*name));
        }
        assert_eq!(language_name(0), None);
        assert_eq!(language_name(17), None);
    }

    #[test]
    fn encode_writes_the_documented_header_and_sorted_rows() {
        let rows = vec![
            row(400, LANG_ANY, SOURCE_SOLD_30D, 10),
            row(200, 2, SOURCE_SOLD_30D, 30),
            row(200, LANG_ANY, SOURCE_SOLD_30D, 25),
            row(200, 1, SOURCE_CARDTRADER, 22),
        ];
        let bytes = encode(1_760_000_000, &rows);
        assert_eq!(bytes.len(), HEADER_BYTES + rows.len() * ROW_BYTES);
        assert_eq!(&bytes[..4], b"PKP2");
        assert_eq!(u16::from_le_bytes(bytes[4..6].try_into().unwrap()), FORMAT_VERSION);
        assert_eq!(u16::from_le_bytes(bytes[6..8].try_into().unwrap()), 0, "reserved");
        assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 4, "row_count");
        assert_eq!(u64::from_le_bytes(bytes[12..20].try_into().unwrap()), 1_760_000_000, "as_of");
        assert_eq!(u32::from_le_bytes(bytes[20..24].try_into().unwrap()), 2, "source_count counts cards");
        // Sorted by (card_id, lang) regardless of the input order; little-endian rows.
        let mut cursor = HEADER_BYTES;
        let read_row = |bytes: &[u8], at: usize| {
            (
                u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()),
                bytes[at + 4],
                bytes[at + 5],
                u32::from_le_bytes(bytes[at + 6..at + 10].try_into().unwrap()),
            )
        };
        assert_eq!(read_row(&bytes, cursor), (200, 0, SOURCE_SOLD_30D, 25));
        cursor += ROW_BYTES;
        assert_eq!(read_row(&bytes, cursor), (200, 1, SOURCE_CARDTRADER, 22));
        cursor += ROW_BYTES;
        assert_eq!(read_row(&bytes, cursor), (200, 2, SOURCE_SOLD_30D, 30));
        cursor += ROW_BYTES;
        assert_eq!(read_row(&bytes, cursor), (400, 0, SOURCE_SOLD_30D, 10));
    }

    #[test]
    fn decode_round_trips_what_encode_writes() {
        let rows = vec![
            row(741_592, LANG_ANY, SOURCE_CARDTRADER, 22),
            row(741_594, 1, SOURCE_SOLD_30D, 1250),
            row(741_594, 7, SOURCE_SOLD_30D, 990),
            row(u32::MAX, u8::MAX, u8::MAX, u32::MAX),
        ];
        let (header, decoded) = decode(&encode(123, &rows)).unwrap();
        assert_eq!(header.version, FORMAT_VERSION);
        assert_eq!(header.reserved, 0);
        assert_eq!(header.row_count, rows.len() as u32);
        assert_eq!(header.as_of, 123);
        assert_eq!(header.source_count, 3);
        assert_eq!(decoded, rows);
    }

    #[test]
    fn decode_refuses_truncated_foreign_and_oversized_files() {
        let bytes = encode(9, &[row(1, 1, 0, 5)]);
        assert!(decode(&bytes).is_ok());
        // Bad magic.
        let mut wrong = bytes.clone();
        wrong[0] = b'X';
        assert!(decode(&wrong).is_err());
        // Future version.
        let mut future = bytes.clone();
        future[4] = 99;
        assert!(decode(&future).is_err());
        // Cut inside the rows.
        assert!(decode(&bytes[..bytes.len() - 3]).is_err());
        // Trailing junk.
        let mut extra = bytes.clone();
        extra.push(0);
        assert!(decode(&extra).is_err());
        // Not even a header.
        assert!(decode(&bytes[..10]).is_err());
    }

    #[test]
    fn an_empty_export_is_a_header_only_file() {
        let (header, rows) = decode(&encode(5, &[])).unwrap();
        assert_eq!(rows, vec![]);
        assert_eq!(header.row_count, 0);
        assert_eq!(header.source_count, 0);
        assert_eq!(header.as_of, 5);
    }

    #[test]
    fn the_export_sql_embeds_the_same_language_list_as_the_code() {
        let sql = export_sql();
        assert_eq!(sql.matches("current_date - $1::int").count(), 1);
        assert!(sql.contains("graded = false"));
        assert!(sql.contains("reverse = false"));
        assert!(sql.contains("first_edition = false"));
        assert!(sql.contains("condition = 'NM'"));
        assert!(sql.contains("provider = 'cardtrader'"));
        for (index, language) in LANGUAGES.iter().enumerate() {
            assert!(sql.contains(&format!("('{language}',{})", index + 1)), "{language} missing");
        }
        // Any-language row sorts before the per-language rows of its card.
        assert!(sql.trim_end().ends_with("order by p.card_id, p.lang"));
    }
}
