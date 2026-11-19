//! The price collector's daily per-condition file, and what the loader makes of
//! it: `<state-dir>/daily/daily-minimums-YYYY-MM-DD.jsonl`, JSON Lines, one
//! object per `(day, idProduct, language, condition, finish, firstEdition,
//! sellerType)` facet the collector's pages showed on that day, loaded into
//! `public.cardmarket_offer_daily` (migration 145).
//!
//! The file is another repository's output and this module treats it that way:
//! every unusable line is a counted skip, never a fatal error, because one line
//! the collector got wrong must not cost the day the forty thousand it got
//! right. The two things the loader refuses outright are the ones it cannot
//! recover from and cannot guess its way past: a file name that carries no day,
//! and a file with nothing loadable in it.
//!
//! Three contract rules shape the row:
//!
//!   * `condition` is a *floor* — an `NM` line is the cheapest offer at NM or
//!     better — so it is stored as the collector spelled it and never read as an
//!     exact grade (same six values as [`crate::cm_offers`], so the daily series
//!     and the latest-value table join);
//!   * `*` is a facet, not a wildcard: a `*` line and a specific line of the same
//!     product are two different questions Cardmarket answered, and adding them
//!     double-counts;
//!   * absence is not "no offers": a facet with no line that day was not walked,
//!     so the loader never writes a placeholder and never carries a value over.
//!
//! `minCents: null` is the collector's own "held with no price", which is an
//! answer to re-ask and not a price, so it is skipped like `cardmarket_offer_minimums`
//! skips it. `asked` is stored as given: it is the only thing that says whether
//! the day's walk aimed at this facet or merely passed it by.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde_json::Value;

use crate::cm_offers;

/// How long one load may run before Postgres stops it. A day's file is narrow
/// rows written in one transaction; a minute that does not finish is a wrong
/// file, not a slow database.
pub const STATEMENT_TIMEOUT_SECS: u64 = 60;

/// The contract's ok value, and the only `status` that means a price.
pub const OK_STATUS: &str = "ok";

/// The length of the `YYYY-MM-DD` a file name and every line carry.
const DAY_LEN: usize = "2026-11-12".len();

/// One line of the day's file, usable as a row.
#[derive(Clone, Debug, PartialEq)]
pub struct DailyOffer {
    pub id_product: i64,
    /// `YYYY-MM-DD`: the day of the file, which the line was required to agree to.
    pub day: String,
    /// Pokoin's key of Cardmarket's language facet, or `*`.
    pub language: String,
    /// `NM`, `SP`, `MP`, `PL`, `Poor` or `*`: a floor, see the module header.
    pub condition: String,
    /// `pro` or `private`.
    pub seller_type: String,
    /// `Y`, `N` or `*`: Pokémon reverse holo.
    pub finish: String,
    pub first_edition: String,
    /// EUR cents, always above zero.
    pub min_cents: i64,
    /// Offers behind the minimum; `None` when the collector could not count them.
    pub offer_count: Option<i64>,
    /// `Some(false)` when an offer page was truncated, so the minimum is the
    /// cheapest seen and the count is a lower bound.
    pub counts_complete: Option<bool>,
    /// True when the collector fetched this facet's own page and it came back ok.
    pub asked: bool,
    /// RFC 3339 UTC, as the collector wrote it.
    pub observed_at: String,
}

/// The facet one line describes: the seven columns the table is primary-keyed
/// on, in that order.
pub fn facet_key(offer: &DailyOffer) -> String {
    [
        offer.id_product.to_string(),
        offer.day.clone(),
        offer.language.clone(),
        offer.condition.clone(),
        offer.seller_type.clone(),
        offer.finish.clone(),
        offer.first_edition.clone(),
    ]
    .join("|")
}

/// Why a line did not become a row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Skip {
    NotJson,
    NotOk,
    MissingField,
    BadDay,
    DayMismatch,
    BadProduct,
    BadLanguage,
    BadCondition,
    BadSellerType,
    BadFinish,
    BadFirstEdition,
    BadPrice,
    BadObservedAt,
    BadAsked,
    Duplicate,
}

impl Skip {
    /// The reason as the dry run prints it: what the collector has to fix, in
    /// the words a person reading a mail at 03:00 needs.
    pub fn label(self) -> &'static str {
        match self {
            Skip::NotJson => "line is not a JSON object",
            Skip::NotOk => "status is not ok",
            Skip::MissingField => "a field the contract puts on the line is absent",
            Skip::BadDay => "day is not a YYYY-MM-DD date",
            Skip::DayMismatch => "day is another day than the file's",
            Skip::BadProduct => "idProduct is not a Cardmarket product id",
            Skip::BadLanguage => "language is not one of Cardmarket's facet codes",
            Skip::BadCondition => "condition is not NM, SP, MP, PL, Poor or *",
            Skip::BadSellerType => "sellerType is neither pro nor private",
            Skip::BadFinish => "finish is neither Y, N nor *",
            Skip::BadFirstEdition => "firstEdition is neither Y, N nor *",
            Skip::BadPrice => "minCents is not a positive whole number of cents",
            Skip::BadObservedAt => "observedAt is not an RFC 3339 time",
            Skip::BadAsked => "asked is not true or false",
            Skip::Duplicate => "the facet was on the file twice; the newer line won",
        }
    }
}

/// One day's file as read: the counts a dry run prints and the rows a load
/// writes.
#[derive(Debug)]
pub struct DailyFile {
    pub day: String,
    /// Non-empty lines seen, whatever became of them.
    pub lines: usize,
    /// One row per facet: a facet seen twice keeps its newest observation.
    pub offers: Vec<DailyOffer>,
    pub skipped: BTreeMap<Skip, usize>,
}

impl DailyFile {
    /// Lines that reached the table's shape: what `--apply` writes.
    pub fn valid(&self) -> usize {
        self.offers.len()
    }

    pub fn skipped_total(&self) -> usize {
        self.skipped.values().sum()
    }

    /// Products the day touched — the figure the collector's own `--status`
    /// reports, so the two sides of the feed count the same thing.
    pub fn products(&self) -> usize {
        let mut ids: Vec<i64> = self.offers.iter().map(|offer| offer.id_product).collect();
        ids.sort_unstable();
        ids.dedup();
        ids.len()
    }

    fn skip(&mut self, reason: Skip) {
        *self.skipped.entry(reason).or_insert(0) += 1;
    }

    /// Take one validated line, newest wins. Every facet must reach Postgres
    /// exactly once: the staging table is keyed the same way, so a second row of
    /// one facet would abort the load of the whole day instead.
    fn keep(&mut self, index: &mut HashMap<String, usize>, offer: DailyOffer) {
        let key = facet_key(&offer);
        match index.get(&key).copied() {
            None => {
                index.insert(key, self.offers.len());
                self.offers.push(offer);
            }
            Some(at) => {
                if self.offers[at].observed_at < offer.observed_at {
                    self.offers[at] = offer;
                }
                self.skip(Skip::Duplicate);
            }
        }
    }

    /// The counts of one read. This is the whole output of a dry run, and the
    /// head of a real load: lines, rows, every reason a line was not a row,
    /// products and the day.
    pub fn summary(&self) -> String {
        let width = self
            .skipped
            .keys()
            .map(|reason| reason.label().len())
            .max()
            .unwrap_or(0);
        let mut out = format!(
            "day {}: {} lines, {} rows, {} lines skipped, {} products\n",
            self.day,
            self.lines,
            self.valid(),
            self.skipped_total(),
            self.products(),
        );
        for (reason, count) in &self.skipped {
            out.push_str(&format!(
                "{:<width$}  {:>6}\n",
                reason.label(),
                count,
                width = width
            ));
        }
        out
    }
}

/// `YYYY-MM-DD`, and only that: a real calendar day, whole, no time on it. The
/// shape is checked before `chrono` is asked, because `parse_from_str` reads
/// `-2026-11-1` as a date (a negative year) — and that is exactly the ten
/// characters a file name like `daily-minimums-2026-11-12.jsonl` shows before
/// its real day.
fn is_day(text: &str) -> bool {
    if text.len() != DAY_LEN {
        return false;
    }
    let bytes = text.as_bytes();
    for at in [0, 1, 2, 3, 5, 6, 8, 9] {
        if !bytes[at].is_ascii_digit() {
            return false;
        }
    }
    bytes[4] == b'-'
        && bytes[7] == b'-'
        && chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").is_ok()
}

/// The day a daily file's name carries — the first `YYYY-MM-DD` in it, which is
/// the collector's `daily-minimums-2026-11-12.jsonl`. `None` when the name says
/// no day: a loader that has to be *told* which day it is loading is a loader
/// that will one day load it into the wrong one, and a day written under another
/// day cannot be told apart from a real observation afterwards.
pub fn file_day(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy();
    name.as_bytes().windows(DAY_LEN).find_map(|window| {
        let text = std::str::from_utf8(window).ok()?;
        is_day(text).then(|| text.to_string())
    })
}

fn present(value: &Value, key: &str) -> bool {
    !matches!(value.get(key), None | Some(Value::Null))
}

fn code(
    value: &Value,
    key: &str,
    wrong: Skip,
    map: impl Fn(&str) -> Option<String>,
) -> Result<String, Skip> {
    match value.get(key) {
        None | Some(Value::Null) => Err(Skip::MissingField),
        Some(Value::String(raw)) => map(raw.trim()).ok_or(wrong),
        Some(_) => Err(wrong),
    }
}

fn flag(value: &Value, key: &str, wrong: Skip) -> Result<String, Skip> {
    code(value, key, wrong, |raw| {
        let upper = raw.to_ascii_uppercase();
        cm_offers::FLAGS
            .iter()
            .find(|flag| **flag == upper.as_str())
            .map(|flag| (*flag).to_string())
    })
}

/// One line of the day's file, or the one reason it is not a row. `day` is the
/// day of the *file*: a line about another day is a skip whatever it claims.
fn offer(value: &Value, day: &str) -> Result<DailyOffer, Skip> {
    // The status first: a line that is not an ok observation is not a price, and
    // saying so is worth more than reporting its empty fields one by one.
    match value.get("status") {
        None | Some(Value::Null) => return Err(Skip::MissingField),
        Some(Value::String(status)) if status.trim().eq_ignore_ascii_case(OK_STATUS) => {}
        Some(_) => return Err(Skip::NotOk),
    }
    match value.get("day") {
        None | Some(Value::Null) => return Err(Skip::MissingField),
        Some(Value::String(line_day)) if is_day(line_day.trim()) => {
            if line_day.trim() != day {
                return Err(Skip::DayMismatch);
            }
        }
        Some(_) => return Err(Skip::BadDay),
    }
    let id_product = if present(value, "idProduct") {
        cm_offers::product_id(value).ok_or(Skip::BadProduct)?
    } else {
        return Err(Skip::MissingField);
    };
    let language = code(
        value,
        "language",
        Skip::BadLanguage,
        cm_offers::language_key,
    )?;
    let condition = code(
        value,
        "condition",
        Skip::BadCondition,
        cm_offers::condition_key,
    )?;
    let seller_type = code(value, "sellerType", Skip::BadSellerType, |raw| {
        let lower = raw.to_ascii_lowercase();
        cm_offers::SELLER_TYPES
            .iter()
            .find(|seller| **seller == lower.as_str())
            .map(|seller| (*seller).to_string())
    })?;
    let finish = flag(value, "finish", Skip::BadFinish)?;
    let first_edition = flag(value, "firstEdition", Skip::BadFirstEdition)?;
    // A price is a whole positive number of cents, and its absence is the same
    // answer as its null: no price, nothing for the series to hold.
    let min_cents = match value.get("minCents") {
        Some(Value::Number(number)) => number
            .as_i64()
            .filter(|cents| *cents > 0)
            .ok_or(Skip::BadPrice)?,
        _ => return Err(Skip::BadPrice),
    };
    let observed_at = match value.get("observedAt") {
        None | Some(Value::Null) => return Err(Skip::MissingField),
        Some(Value::String(raw)) => {
            let raw = raw.trim();
            if chrono::DateTime::parse_from_rfc3339(raw).is_ok() {
                raw.to_string()
            } else {
                return Err(Skip::BadObservedAt);
            }
        }
        Some(_) => return Err(Skip::BadObservedAt),
    };
    let asked = match value.get("asked") {
        None | Some(Value::Null) => return Err(Skip::MissingField),
        Some(Value::Bool(asked)) => *asked,
        Some(_) => return Err(Skip::BadAsked),
    };
    Ok(DailyOffer {
        id_product,
        day: day.to_string(),
        language,
        condition,
        seller_type,
        finish,
        first_edition,
        min_cents,
        // The two attributes of the facet, both nullable in the table: a count
        // the collector did not settle stays null rather than becoming a zero.
        offer_count: value
            .get("count")
            .and_then(Value::as_i64)
            .filter(|count| *count >= 0),
        counts_complete: value.get("countsComplete").and_then(Value::as_bool),
        asked,
        observed_at,
    })
}

/// Read one day's file. The day comes from the file name, so a line written on
/// 13 November that arrived in the 12 November file is skipped and counted rather
/// than loaded into a day it does not belong to.
pub fn parse(text: &str, day: &str) -> DailyFile {
    let mut file = DailyFile {
        day: day.to_string(),
        lines: 0,
        offers: Vec::new(),
        skipped: BTreeMap::new(),
    };
    let mut index: HashMap<String, usize> = HashMap::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        file.lines += 1;
        let value = match serde_json::from_str::<Value>(line) {
            Ok(value @ Value::Object(_)) => value,
            _ => {
                file.skip(Skip::NotJson);
                continue;
            }
        };
        match offer(&value, day) {
            Err(reason) => file.skip(reason),
            Ok(offer) => file.keep(&mut index, offer),
        }
    }
    file
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DAY: &str = "2026-11-12";

    /// Dialga (Call of Legends CL3, idProduct 279646) as a day of the collector's
    /// walk records it: the facet it asked for, and the ones that only rode along
    /// on the page that came back.
    fn line(over: Value) -> Value {
        let mut base = json!({"day": DAY, "idProduct": 279646, "language": "IT",
                             "condition": "NM", "finish": "*", "firstEdition": "*",
                             "sellerType": "private", "minCents": 1000, "count": 2,
                             "countsComplete": true,
                             "observedAt": "2026-11-12T13:09:30.235Z", "status": "ok",
                             "asked": true});
        let map = base.as_object_mut().expect("object");
        for (key, value) in over.as_object().expect("overrides") {
            map.insert(key.clone(), value.clone());
        }
        base
    }

    fn without(value: Value, key: &str) -> Value {
        let mut map = value.as_object().expect("object").clone();
        map.remove(key);
        Value::Object(map)
    }

    fn one(value: Value) -> DailyFile {
        parse(&value.to_string(), DAY)
    }

    /// The one reason a one-line file did not load, with its count in the message.
    fn sole_skip(file: &DailyFile) -> Skip {
        assert_eq!(file.valid(), 0, "the line loaded as {:?}", file.offers);
        assert_eq!(file.skipped_total(), 1, "counts were {}", file.summary());
        *file.skipped.keys().next().expect("one skip reason")
    }

    #[test]
    fn a_day_file_loads_every_facet_it_recorded() {
        let text = [
            line(json!({"condition": "NM", "asked": true})),
            line(json!({"condition": "Poor", "sellerType": "pro", "minCents": 300})),
            line(json!({"language": "*", "condition": "*", "minCents": 250, "asked": false})),
            line(json!({"language": "ZH-TW", "count": null, "countsComplete": false})),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
        let file = parse(&text, DAY);
        assert_eq!((file.lines, file.valid(), file.skipped_total()), (4, 4, 0));
        // One product, however many facets of it the pages showed.
        assert_eq!(file.products(), 1);
        let carried = file
            .offers
            .iter()
            .find(|offer| offer.language == "*" && offer.condition == "*")
            .expect("the unfiltered facet");
        assert!(
            !carried.asked,
            "a price that rode along on a wider page is not asked"
        );
        let traditional = file
            .offers
            .iter()
            .find(|offer| offer.language == "ZHT")
            .expect("Cardmarket's own Traditional Chinese code");
        assert_eq!(traditional.min_cents, 1000);
        assert_eq!(
            (traditional.offer_count, traditional.counts_complete),
            (None, Some(false))
        );
    }

    #[test]
    fn every_facet_code_is_the_engine_spelling_not_a_guess() {
        for (over, key, want) in [
            (json!({"condition": "poor"}), "condition", "Poor"),
            (json!({"condition": "*"}), "condition", "*"),
            (json!({"language": "zh-tw"}), "language", "ZHT"),
            (json!({"language": "ru"}), "language", "RU"),
            (json!({"sellerType": "Pro"}), "seller_type", "pro"),
            (json!({"finish": "y"}), "finish", "Y"),
            (json!({"firstEdition": "n"}), "first_edition", "N"),
        ] {
            let file = one(line(over.clone()));
            assert_eq!(
                file.valid(),
                1,
                "{} {} skipped as {:?}",
                key,
                want,
                file.skipped
            );
            let field = match key {
                "condition" => &file.offers[0].condition,
                "language" => &file.offers[0].language,
                "seller_type" => &file.offers[0].seller_type,
                "finish" => &file.offers[0].finish,
                _ => &file.offers[0].first_edition,
            };
            assert_eq!(field, want, "{over}");
        }
    }

    /// One rule, one bad line, one counted skip: nothing here is fatal, and
    /// nothing here is guessed into a row. A missing field is proved by
    /// *removing* it with `without`: an override passed through `line` would be
    /// re-added by `line` itself, and such a case would quietly test nothing.
    #[test]
    fn each_rule_skips_its_own_line_and_counts_it() {
        for (value, want) in [
            (line(json!({"status": "deferred"})), Skip::NotOk),
            (line(json!({"status": null})), Skip::MissingField),
            (line(json!({"day": "2026-11-13"})), Skip::DayMismatch),
            (line(json!({"day": "12.11.2026"})), Skip::BadDay),
            (line(json!({"day": "2026-02-30"})), Skip::BadDay),
            (without(line(json!({})), "day"), Skip::MissingField),
            (line(json!({"idProduct": 0})), Skip::BadProduct),
            (line(json!({"idProduct": "27964x"})), Skip::BadProduct),
            (without(line(json!({})), "idProduct"), Skip::MissingField),
            (line(json!({"language": "KR"})), Skip::BadLanguage),
            // A desk language, not one of Cardmarket's facet codes: report §2.3.
            (line(json!({"language": "ID"})), Skip::BadLanguage),
            (line(json!({"language": 12})), Skip::BadLanguage),
            (line(json!({"condition": "Mint"})), Skip::BadCondition),
            (
                line(json!({"sellerType": "powerseller"})),
                Skip::BadSellerType,
            ),
            (line(json!({"finish": "true"})), Skip::BadFinish),
            (line(json!({"firstEdition": "yes"})), Skip::BadFirstEdition),
            (line(json!({"minCents": null})), Skip::BadPrice),
            (line(json!({"minCents": -5})), Skip::BadPrice),
            (line(json!({"minCents": 19.99})), Skip::BadPrice),
            (line(json!({"minCents": "20,00"})), Skip::BadPrice),
            (without(line(json!({})), "minCents"), Skip::BadPrice),
            (
                line(json!({"observedAt": "yesterday"})),
                Skip::BadObservedAt,
            ),
            (without(line(json!({})), "observedAt"), Skip::MissingField),
            (line(json!({"asked": "yes"})), Skip::BadAsked),
            (without(line(json!({})), "asked"), Skip::MissingField),
        ] {
            let file = one(value.clone());
            assert_eq!(sole_skip(&file), want, "{value}");
            assert_eq!(file.lines, 1);
        }
        // A line that is not JSON at all is the same kind of skip, and no more
        // fatal than any other.
        let file = parse("{\"idProduct\": broken\n", DAY);
        assert_eq!((file.lines, file.valid()), (1, 0));
        assert_eq!(sole_skip(&file), Skip::NotJson);
        // The same facet twice: the newer observation is the row, the other a skip.
        let file = parse(
            &[
                line(json!({"minCents": 1850, "observedAt": "2026-11-12T18:00:00Z"})),
                line(json!({"minCents": 2000, "observedAt": "2026-11-12T09:00:00Z"})),
            ]
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
            DAY,
        );
        assert_eq!((file.lines, file.valid()), (2, 1));
        assert_eq!(
            file.offers[0].min_cents, 1850,
            "the newest line is the day's answer"
        );
        assert_eq!(file.skipped.get(&Skip::Duplicate), Some(&1));
    }

    #[test]
    fn an_empty_file_and_a_blank_line_are_no_rows_and_no_error() {
        let file = parse(&format!("\n\n{}\n\n", line(json!({}))), DAY);
        assert_eq!((file.lines, file.valid(), file.skipped_total()), (1, 1, 0));
        let empty = parse("", DAY);
        assert_eq!((empty.lines, empty.valid()), (0, 0));
        assert_eq!(empty.products(), 0);
    }

    #[test]
    fn the_day_is_the_one_the_file_name_carries() {
        for (name, want) in [
            ("daily-minimums-2026-11-12.jsonl", Some("2026-11-12")),
            ("daily-minimums-2026-01-05.json", Some("2026-01-05")),
            ("2026-11-12.jsonl", Some("2026-11-12")),
            ("minimums.jsonl", None),
            ("daily-minimums-.jsonl", None),
            ("daily-minimums-2026-11-2.jsonl", None),
            ("latest.json", None),
        ] {
            assert_eq!(file_day(Path::new(name)).as_deref(), want, "{name}");
        }
        // A day in a directory name is not a day in the file's name: the file the
        // loader opens is the file whose day it trusts.
        assert_eq!(
            file_day(Path::new("/state/daily/2026-11-12/minimums.jsonl")),
            None,
            "a path whose directory carries the day"
        );
    }

    #[test]
    fn the_counts_a_dry_run_prints_add_up_and_name_every_reason() {
        let text = [
            line(json!({})),
            line(json!({"idProduct": 279259, "condition": "SP"})),
            line(json!({"status": "error"})),
            line(json!({"day": "2026-11-11"})),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<String>>()
        .join("\n");
        let file = parse(&text, DAY);
        assert_eq!(
            file.lines,
            file.valid() + file.skipped_total(),
            "the bookkeeping"
        );
        assert_eq!(
            (file.valid(), file.products(), file.skipped_total()),
            (2, 2, 2)
        );
        let summary = file.summary();
        assert!(
            summary.starts_with("day 2026-11-12: 4 lines, 2 rows, 2 lines skipped, 2 products"),
            "{summary}"
        );
        assert!(summary.contains(Skip::NotOk.label()), "{summary}");
        assert!(summary.contains(Skip::DayMismatch.label()), "{summary}");
        assert!(
            !summary.contains(Skip::BadPrice.label()),
            "a reason with no line is not printed"
        );
        // Nothing loadable is its own answer: zero rows, and the count that says so.
        assert_eq!(parse("not json at all\n", DAY).valid(), 0);
    }
}
