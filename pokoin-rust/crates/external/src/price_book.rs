//! CardTrader asks of the games other than Pokémon, from the CardRails PKP3
//! price files (`GET {origin}/v1/prices/{game}`, built nightly on nezopt by
//! pokoin-scanner `native/price_book`): the file the Pokoin extension's side
//! panel prices from.
//!
//! The satellite game databases keep only one cheapest offer per blueprint
//! (`cardtrader_blueprint_listing_cache`), so they cannot price a listing by
//! its facets. The PKP3 file's source 7 is the cheapest CardTrader Zero / hub
//! (or "1 day ready") ask per (language, condition, finish), with graded,
//! signed and altered copies left out. Pokémon keeps the professional-seller
//! floor of `price_check::pro_floor_sql`.
//!
//! The rule is the extension's (`rust-c1/crates/pokoin-c1/src/pricebook.rs`,
//! `grid`): the cheapest copy in the listing's condition or a better one
//! (NM > SP > MP > PL > PO), never a worse one, of the same language and
//! finish (foil). The file does not split first edition from unlimited.
//!
//! Layout: 24-byte header (magic `PKP3`, version u16, game u16, generated_at
//! u64, rows u32, reserved u32), then 12-byte rows sorted by card id:
//! card_id u32, source u8, variant u8, n u16, cents u32, little-endian.
//! Variant = `lang + 16 * condition + 128 * finish`.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

pub const MAGIC: &[u8; 4] = b"PKP3";
pub const HEADER: usize = 24;
pub const ROW: usize = 12;
/// Cheapest CardTrader Zero ask per (language, condition, finish).
pub const SOURCE_CT_ASK: u8 = 7;

/// Language codes of the file (code = index + 1).
pub const LANGS: [&str; 16] = [
    "EN", "IT", "FR", "DE", "ES", "PT", "JP", "ZH", "KO", "ID", "NL", "PL", "RU", "ZHT", "TH", "VI",
];

/// The files are rebuilt twice a day; an hour keeps the API near them.
const MAX_AGE: Duration = Duration::from_secs(60 * 60);
/// A failed download is retried after this, not on every request.
const RETRY_AFTER: Duration = Duration::from_secs(5 * 60);
const DEFAULT_ORIGIN: &str = "https://cardrails-api.pokoin.com";

/// One source-7 row: the cheapest Zero ask of a card in one facet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ask {
    pub card_id: u32,
    pub variant: u8,
    pub cents: u32,
}

/// The source-7 rows of one game's file, sorted by card id.
#[derive(Debug, Default)]
pub struct CtAsks {
    rows: Vec<Ask>,
}

impl CtAsks {
    /// Keep only source 7 (Magic's whole file is 36 MB; its asks are a part).
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < HEADER || &bytes[..4] != MAGIC {
            return Err("not a PKP3 price file".into());
        }
        let rows = u32::from_le_bytes(bytes[16..20].try_into().unwrap()) as usize;
        if bytes.len() < HEADER + rows * ROW {
            return Err(format!("truncated PKP3: {rows} rows need {} bytes", HEADER + rows * ROW));
        }
        let mut out: Vec<Ask> = bytes[HEADER..HEADER + rows * ROW]
            .chunks_exact(ROW)
            .filter(|b| b[4] == SOURCE_CT_ASK)
            .map(|b| Ask {
                card_id: u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
                variant: b[5],
                cents: u32::from_le_bytes([b[8], b[9], b[10], b[11]]),
            })
            .collect();
        // The file is sorted already; sorting again keeps lookups right if not.
        out.sort_by_key(|ask| ask.card_id);
        out.shrink_to_fit();
        Ok(Self { rows: out })
    }

    /// Every ask of one card.
    pub fn card(&self, card_id: u32) -> &[Ask] {
        let start = self.rows.partition_point(|ask| ask.card_id < card_id);
        let end = self.rows.partition_point(|ask| ask.card_id <= card_id);
        &self.rows[start..end]
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
}

/// (lang 1..=16, condition 0..=4, finish) of a variant.
pub fn split_variant(variant: u8) -> Option<(u8, u8, bool)> {
    let base = variant & 127;
    if base == 0 || base > 80 {
        return None;
    }
    Some(((base - 1) % 16 + 1, (base - 1) / 16, variant & 128 != 0))
}

/// Language code (1..=16) of a listing language (`EN`, `JP`, `ZHT`, …).
pub fn lang_code(raw: &str) -> Option<u8> {
    let key = raw.trim().to_ascii_uppercase().replace('_', "-");
    let code = match key.as_str() {
        "JA" | "JPN" | "JAPANESE" => "JP",
        "ZH-CN" | "ZHS" | "CN" | "CHINESE" => "ZH",
        "ZH-TW" | "TW" => "ZHT",
        "KR" | "KOREAN" => "KO",
        other => other,
    };
    LANGS.iter().position(|lang| *lang == code).map(|i| i as u8 + 1)
}

/// Condition index (0 NM … 4 PO) of a `price_check::condition_key`.
pub fn condition_index(key: &str) -> Option<u8> {
    match key {
        "" | "NM" => Some(0),
        "SP" => Some(1),
        "MP" => Some(2),
        "PL" => Some(3),
        "Poor" | "PO" => Some(4),
        _ => None,
    }
}

/// `(cheapest ask overall, cheapest ask of this facet)` in EUR cents. The
/// facet price is the cheapest copy of the same language and finish in this
/// condition or a better one; a worse copy never prices a better condition.
pub fn facet_cents(asks: &[Ask], language: &str, condition: &str, finish: bool) -> (Option<u32>, Option<u32>) {
    let cheapest = asks.iter().map(|ask| ask.cents).filter(|cents| *cents > 0).min();
    let (Some(lang), Some(cond)) = (lang_code(language), condition_index(condition)) else {
        return (cheapest, None);
    };
    let matched = asks
        .iter()
        .filter(|ask| ask.cents > 0)
        .filter(|ask| {
            split_variant(ask.variant)
                .is_some_and(|(l, c, f)| l == lang && c <= cond && f == finish)
        })
        .map(|ask| ask.cents)
        .min();
    (cheapest, matched)
}

/// EUR cents → PKN (1 PKN = €0.005).
pub fn pkn_from_cents(cents: u32) -> f64 {
    f64::from(cents) * 2.0
}

fn origin() -> String {
    std::env::var("POKOIN_PRICE_FILE_ORIGIN")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_ORIGIN.to_string())
}

struct Slot {
    asks: Option<Arc<CtAsks>>,
    at: Instant,
}

type Slots = HashMap<String, Arc<Mutex<Option<Slot>>>>;

fn slots() -> &'static std::sync::Mutex<Slots> {
    static SLOTS: OnceLock<std::sync::Mutex<Slots>> = OnceLock::new();
    SLOTS.get_or_init(Default::default)
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .user_agent("pokoin-api-price-check/1.0")
            .build()
            .unwrap_or_default()
    })
}

async fn download(game: &str) -> Result<CtAsks, String> {
    let url = format!("{}/v1/prices/{}", origin(), game);
    let response = http().get(&url).send().await.map_err(|error| format!("{url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("{url}: HTTP {}", response.status().as_u16()));
    }
    let bytes = response.bytes().await.map_err(|error| format!("{url}: {error}"))?;
    // Parsing Magic's file is millions of rows: off the async workers.
    tokio::task::spawn_blocking(move || CtAsks::parse(&bytes))
        .await
        .map_err(|error| error.to_string())?
}

/// One game's CardTrader asks: cached for an hour, one download at a time per
/// game. `None` when the file cannot be read (the comp is then empty, never
/// an error for the whole price check).
pub async fn ct_asks(game: &str) -> Option<Arc<CtAsks>> {
    let slot = slots()
        .lock()
        .ok()?
        .entry(game.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone();
    let mut guard = slot.lock().await;
    if let Some(cached) = guard.as_ref() {
        let fresh = match cached.asks {
            Some(_) => cached.at.elapsed() < MAX_AGE,
            None => cached.at.elapsed() < RETRY_AFTER,
        };
        if fresh {
            return cached.asks.clone();
        }
    }
    let asks = match download(game).await {
        Ok(asks) => Some(Arc::new(asks)),
        Err(error) => {
            tracing::warn!(game, %error, "price file unavailable");
            // Keep serving the last good file while the new one fails.
            guard.as_ref().and_then(|cached| cached.asks.clone())
        }
    };
    *guard = Some(Slot { asks: asks.clone(), at: Instant::now() });
    asks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variant(lang: u8, cond: u8, finish: bool) -> u8 {
        lang + 16 * cond + if finish { 128 } else { 0 }
    }

    fn file(rows: &[(u32, u8, u8, u32)]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&6u16.to_le_bytes());
        bytes.extend_from_slice(&1_700_000_000u64.to_le_bytes());
        bytes.extend_from_slice(&(rows.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        for (card, source, variant, cents) in rows {
            bytes.extend_from_slice(&card.to_le_bytes());
            bytes.push(*source);
            bytes.push(*variant);
            bytes.extend_from_slice(&1u16.to_le_bytes());
            bytes.extend_from_slice(&cents.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn keeps_only_cardtrader_asks_and_finds_a_card() {
        let bytes = file(&[
            (10, 2, 0, 1),                       // Pokoin cheapest: not a CardTrader ask
            (10, 7, variant(1, 0, false), 300),
            (12, 3, 1, 900),                     // sold median: not an ask
            (12, 7, variant(1, 1, false), 150),
            (12, 7, variant(2, 0, true), 500),
            (14, 7, variant(1, 0, false), 80),
        ]);
        let asks = CtAsks::parse(&bytes).unwrap();
        assert_eq!(asks.len(), 4);
        assert_eq!(asks.card(12).len(), 2);
        assert_eq!(asks.card(10)[0].cents, 300);
        assert!(asks.card(11).is_empty());
        assert!(asks.card(99).is_empty());
        assert!(CtAsks::parse(b"nope").is_err());
        let mut short = file(&[(1, 7, 1, 1)]);
        short.truncate(HEADER + 4);
        assert!(CtAsks::parse(&short).is_err());
    }

    #[test]
    fn a_better_condition_prices_a_worse_one_never_the_reverse() {
        // EN NM 5.00, EN SP 2.00, EN MP 3.00 (the extension's grid test).
        let asks = [
            Ask { card_id: 1, variant: variant(1, 0, false), cents: 500 },
            Ask { card_id: 1, variant: variant(1, 1, false), cents: 200 },
            Ask { card_id: 1, variant: variant(1, 2, false), cents: 300 },
        ];
        assert_eq!(facet_cents(&asks, "EN", "NM", false), (Some(200), Some(500)));
        assert_eq!(facet_cents(&asks, "EN", "SP", false).1, Some(200));
        assert_eq!(facet_cents(&asks, "EN", "MP", false).1, Some(200));
        assert_eq!(facet_cents(&asks, "EN", "Poor", false).1, Some(200));
    }

    #[test]
    fn language_and_finish_must_match() {
        let asks = [
            Ask { card_id: 1, variant: variant(1, 0, false), cents: 100 }, // EN NM
            Ask { card_id: 1, variant: variant(7, 0, false), cents: 40 },  // JP NM
            Ask { card_id: 1, variant: variant(1, 0, true), cents: 900 },  // EN NM foil
        ];
        assert_eq!(facet_cents(&asks, "EN", "NM", false), (Some(40), Some(100)));
        assert_eq!(facet_cents(&asks, "EN", "NM", true).1, Some(900));
        assert_eq!(facet_cents(&asks, "JP", "NM", false).1, Some(40));
        assert_eq!(facet_cents(&asks, "ja", "NM", false).1, Some(40));
        // No IT copy: no price, never another language's.
        assert_eq!(facet_cents(&asks, "IT", "NM", false), (Some(40), None));
        assert_eq!(facet_cents(&asks, "JP", "NM", true).1, None);
        // Unknown language or condition: nothing to match.
        assert_eq!(facet_cents(&asks, "", "NM", false).1, None);
        assert_eq!(facet_cents(&asks, "EN", "Graded 10", false).1, None);
        assert_eq!(facet_cents(&[], "EN", "NM", false), (None, None));
    }

    #[test]
    fn codes_match_the_price_file() {
        assert_eq!(lang_code("EN"), Some(1));
        assert_eq!(lang_code("zht"), Some(14));
        assert_eq!(lang_code("ZH_TW"), Some(14));
        assert_eq!(lang_code("VI"), Some(16));
        assert_eq!(lang_code("XX"), None);
        assert_eq!(split_variant(variant(16, 4, true)), Some((16, 4, true)));
        assert_eq!(split_variant(0), None);
        assert_eq!(split_variant(81), None);
        assert_eq!(pkn_from_cents(150), 300.0);
    }
}
