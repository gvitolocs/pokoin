//! The `sources` block of a price-check comp: CardTrader sold, Pokoin's own
//! sold, Cardmarket's price guide and TCGplayer quotes — one independent feed
//! each, all games, all three comp builders (`read_prices`, `game_comp`,
//! `store_game_comp`).
//!
//! ```jsonc
//! "sources": {
//!   "cardtrader": { "sold": { "<key>": { "grossPkn": 123.4, "pkn": 110.2 } } },
//!   "pokoin":     { "sold": { "<key>": { "grossPkn": 300, "pkn": 300, "sales": 4 } } },
//!   "cardmarket": { "asOf": "2026-11-06",
//!                   "trend": { "<key>": { "eur": 1.23, "grossPkn": 246, "pkn": 246 } },
//!                   "low": { … }, "avg1": { … }, "avg7": { … }, "avg30": { … } },
//!   "tcgplayer":  { "asOf": "2026-11-06", "rateDay": "2026-11-06", "usdPerEur": 1.0812,
//!                   "market": { "<key>": { "usd": 1.5, "grossPkn": 277.47, "pkn": 277.47 } },
//!                   "low": { … }, "mid": { … } }
//! }
//! ```
//!
//! `<key>` is `Match::key()` (`C`, `L`, `F`, `E` in that order, `""` = any
//! copy) restricted to the letters the source honours: CardTrader sold all
//! 16, Pokoin sold `C`/`L`, Cardmarket `F`, TCGplayer `F`/`E`. Only keys with
//! a value are present; a source with no value at all is omitted and its
//! `sourceStatus` is `empty`. A one-of-a-kind item (graded/signed/altered)
//! gets only the `""` key in every source.
//!
//! Every feed is independent: a query error, a missing table, a missing env
//! var or stale data never fails the price check — the source is omitted with
//! status `unavailable` (or `unconfigured` when not configured). All queries
//! are bulk, one per feed per page, run concurrently with the existing ones.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::ct_fees::Channel;
use crate::db::DbPools;
use crate::pokoin_sold::PokoinSale;
use crate::price_check::{Match, PriceItem};
use crate::tcgcsv::{self, TcgRow};

/// Round to 2 decimals, half away from zero. Exact decimal halves (1.005,
/// stored as 1.00499…) are nudged away from zero first, so they round up.
pub fn round2(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let scaled = value * 100.0;
    let nudge = scaled.abs().max(1.0) * 1e-9;
    (scaled + value.signum() * nudge).round() / 100.0
}

/// `percentile_cont(0.5)` semantics: sort; odd count → the middle value,
/// even → the mean of the two middle values.
pub fn percentile_median(values: &[f64]) -> Option<f64> {
    let mut sorted: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    if sorted.is_empty() {
        return None;
    }
    sorted.sort_by(|a, b| a.total_cmp(b));
    let n = sorted.len();
    if n % 2 == 1 {
        Some(sorted[n / 2])
    } else {
        Some((sorted[n / 2 - 1] + sorted[n / 2]) / 2.0)
    }
}

fn int(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(n) => n.as_i64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn float(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|n| n.is_finite())
}

fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// The item's finish facet: Pokémon's only finish is reverse; the other
/// games' is foil (the sold job stores a game's foil in `reverse`).
pub fn item_finish(item: &PriceItem, game: &str) -> bool {
    if game == "pokemon" { item.reverse } else { item.foil || item.reverse }
}

// ---------------------------------------------------------------- CardTrader

/// One rows query over the last 30 days of `cardtrader_sold_daily` (every
/// CardTrader game database has the table), replacing the old aggregate.
pub const CT_SOLD_SQL: &str = "select blueprint_id, condition, language, reverse, first_edition, graded, \
       median_pkn::float8 as median_pkn \
     from public.cardtrader_sold_daily \
     where blueprint_id = any($1::bigint[]) and observed_day >= current_date - 30 \
       and sold_qty > 0 and median_pkn > 0";

/// One decoded row of [`CT_SOLD_SQL`].
#[derive(Clone, Debug, PartialEq)]
pub struct CtSoldRow {
    pub blueprint_id: i64,
    pub condition: String,
    pub language: String,
    pub reverse: bool,
    pub first_edition: bool,
    pub graded: bool,
    pub median_pkn: f64,
}

pub fn ct_sold_row(value: &Value) -> Option<CtSoldRow> {
    Some(CtSoldRow {
        blueprint_id: int(value.get("blueprint_id"))?,
        condition: text(value.get("condition")).trim().to_uppercase(),
        language: text(value.get("language")).trim().to_uppercase(),
        reverse: value.get("reverse") == Some(&Value::Bool(true)),
        first_edition: value.get("first_edition") == Some(&Value::Bool(true)),
        graded: value.get("graded") == Some(&Value::Bool(true)),
        median_pkn: float(value.get("median_pkn"))?,
    })
}

/// The page's sold rows of one game, or `None` when the query failed (the
/// source is then `unavailable`; a missing table included).
pub async fn fetch_ct_sold(db: &DbPools, game: &str, ct_ids: &[i64]) -> Option<Vec<CtSoldRow>> {
    if ct_ids.is_empty() {
        return Some(Vec::new());
    }
    match db.query(game, CT_SOLD_SQL, &[json!(ct_ids)]).await {
        Ok(rows) => Some(rows.iter().filter_map(ct_sold_row).collect()),
        Err(error) => {
            if error.is_table_missing() {
                tracing::warn!(game, "cardtrader_sold_daily is not migrated in this game; sold source unavailable");
            } else {
                tracing::warn!(game, error = %error, "cardtrader sold query failed; sold source unavailable");
            }
            None
        }
    }
}

/// Does an ungraded sold row share the attributes `m` asks for with the item?
/// Pokémon matches its condition exactly; the other games match that
/// condition or a better one (NM > SP > MP > PL > Poor, as the offers side
/// does). An attribute the item does not state matches any row.
fn ct_row_matches(row: &CtSoldRow, item: &PriceItem, game: &str, m: Match) -> bool {
    if m.condition && !item.condition.is_empty() {
        if game == "pokemon" {
            if row.condition != item.condition {
                return false;
            }
        } else {
            match (
                crate::price_book::condition_index(&row.condition),
                crate::price_book::condition_index(&item.condition),
            ) {
                (Some(row_index), Some(item_index)) if row_index <= item_index => {}
                _ => return false,
            }
        }
    }
    if m.language && !item.language.is_empty() && row.language != item.language {
        return false;
    }
    if m.finish && row.reverse != item_finish(item, game) {
        return false;
    }
    if m.first_edition && row.first_edition != item.first_edition {
        return false;
    }
    true
}

/// The `sources.cardtrader.sold` map of one item: every `Match` key (all 16).
/// `""` is the median over ALL the blueprint's rows (graded included) — the
/// value that also feeds `soldMedianGrossPkn`; every other key uses only
/// ungraded rows. `pkn` is net of CardTrader's fees at `channel`.
pub fn ct_sold_map(rows: &[CtSoldRow], blueprint_id: i64, item: &PriceItem, game: &str, channel: Channel) -> Map<String, Value> {
    let rule = crate::ct_fees::rule();
    let of_card: Vec<&CtSoldRow> = rows.iter().filter(|row| row.blueprint_id == blueprint_id).collect();
    let mut map = Map::new();
    for m in Match::all() {
        if m != Match::ANY && item.one_of_a_kind() {
            continue;
        }
        let values: Vec<f64> = of_card
            .iter()
            .filter(|row| m == Match::ANY || (!row.graded && ct_row_matches(row, item, game, m)))
            .map(|row| row.median_pkn)
            .collect();
        let Some(median) = percentile_median(&values).filter(|v| *v > 0.0) else { continue };
        let gross = round2(median);
        let pkn = rule.net_pkn(gross, channel).map(round2);
        map.insert(m.key(), json!({ "grossPkn": gross, "pkn": pkn }));
    }
    map
}

/// The `""` median over all the blueprint's rows (graded included): today's
/// `soldMedianGrossPkn`, computed in Rust from the rows query.
pub fn sold_median_of(rows: &[CtSoldRow], blueprint_id: i64) -> Option<f64> {
    let values: Vec<f64> = rows
        .iter()
        .filter(|row| row.blueprint_id == blueprint_id)
        .map(|row| row.median_pkn)
        .collect();
    percentile_median(&values).filter(|v| *v > 0.0)
}

// ------------------------------------------------------------------- Pokoin

/// Does a Pokoin sale share the attributes `m` asks for with the item? Exact
/// equality for condition and language; an attribute the item does not state
/// matches any sale.
fn sale_matches(sale: &PokoinSale, item: &PriceItem, m: Match) -> bool {
    if m.condition && !item.condition.is_empty() && sale.condition != item.condition {
        return false;
    }
    if m.language && !item.language.is_empty() && sale.language != item.language {
        return false;
    }
    true
}

/// The `sources.pokoin.sold` map of one item: keys over `C`/`L` only
/// (`""`, `C`, `L`, `CL`), the median price of the matching sales and their
/// count. `pkn == grossPkn` (no CardTrader fee on Pokoin's own sales).
pub fn pokoin_sold_map(sales: &[PokoinSale], item: &PriceItem) -> Map<String, Value> {
    let of_card: Vec<&PokoinSale> = sales.iter().filter(|sale| sale.card_id == item.card_id).collect();
    let mut map = Map::new();
    for m in Match::all() {
        if m.finish || m.first_edition {
            continue; // Pokoin sold honours C and L only
        }
        if m != Match::ANY && item.one_of_a_kind() {
            continue;
        }
        let matching: Vec<&PokoinSale> = of_card.iter().copied().filter(|sale| sale_matches(sale, item, m)).collect();
        if matching.is_empty() {
            continue;
        }
        let Some(gross) = percentile_median(&matching.iter().map(|sale| sale.price_pkn).collect::<Vec<_>>())
            .filter(|v| *v > 0.0)
            .map(round2)
        else {
            continue;
        };
        map.insert(m.key(), json!({ "grossPkn": gross, "pkn": gross, "sales": matching.len() }));
    }
    map
}

// --------------------------------------------------------------- Cardmarket

/// The game's last price-guide run, fresh only while its day is within 4 days
/// of today; `asOf` of the source. Runs in the `"pokemon"` pool.
pub const CM_RUN_SQL: &str =
    "select max(day)::text as day from public.cardmarket_price_guide_runs where game = $1 and day >= current_date - 4";

/// The blueprint's Cardmarket products (`card_market_ids`, a jsonb array of
/// numeric strings) from the game's catalog table, in the game's own pool.
pub fn cm_products_sql(table: &str) -> String {
    format!(
        "select b.id as blueprint_id, cm.id as id_product from {table} b \
         cross join lateral jsonb_array_elements_text(\
             case when jsonb_typeof(b.card_market_ids) = 'array' \
                  then b.card_market_ids else '[]'::jsonb end\
           ) cm(id) where b.id = any($1::bigint[])"
    )
}

/// The newest guide row per product (change-only history: the newest row of a
/// product is its current guide), numeric columns as float8. Runs in the
/// `"pokemon"` pool.
pub const CM_GUIDE_SQL: &str = "select g.id_product, g.day::text as day, \
       g.avg::float8 as avg, g.low::float8 as low, g.trend::float8 as trend, \
       g.avg1::float8 as avg1, g.avg7::float8 as avg7, g.avg30::float8 as avg30, \
       g.avg_foil::float8 as avg_foil, g.low_foil::float8 as low_foil, g.trend_foil::float8 as trend_foil, \
       g.avg1_foil::float8 as avg1_foil, g.avg7_foil::float8 as avg7_foil, g.avg30_foil::float8 as avg30_foil \
     from unnest($2::bigint[]) p(id) \
     cross join lateral (\
       select * from public.cardmarket_price_guide g \
       where g.game = $1 and g.id_product = p.id order by g.day desc limit 1\
     ) g";

/// The guide bases, `(name, regular column, foil column)`.
pub const CM_BASES: [(&str, &str, &str); 5] = [
    ("trend", "trend", "trend_foil"),
    ("low", "low", "low_foil"),
    ("avg1", "avg1", "avg1_foil"),
    ("avg7", "avg7", "avg7_foil"),
    ("avg30", "avg30", "avg30_foil"),
];

/// One product's newest guide row.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GuideRow {
    pub day: String,
    pub trend: Option<f64>,
    pub trend_foil: Option<f64>,
    pub low: Option<f64>,
    pub low_foil: Option<f64>,
    pub avg1: Option<f64>,
    pub avg1_foil: Option<f64>,
    pub avg7: Option<f64>,
    pub avg7_foil: Option<f64>,
    pub avg30: Option<f64>,
    pub avg30_foil: Option<f64>,
}

impl GuideRow {
    /// `(regular, foil)` of one basis.
    pub fn basis(&self, name: &str) -> (Option<f64>, Option<f64>) {
        match name {
            "trend" => (self.trend, self.trend_foil),
            "low" => (self.low, self.low_foil),
            "avg1" => (self.avg1, self.avg1_foil),
            "avg7" => (self.avg7, self.avg7_foil),
            "avg30" => (self.avg30, self.avg30_foil),
            _ => (None, None),
        }
    }
}

pub fn guide_row(value: &Value) -> Option<GuideRow> {
    Some(GuideRow {
        day: text(value.get("day")),
        trend: float(value.get("trend")),
        trend_foil: float(value.get("trend_foil")),
        low: float(value.get("low")),
        low_foil: float(value.get("low_foil")),
        avg1: float(value.get("avg1")),
        avg1_foil: float(value.get("avg1_foil")),
        avg7: float(value.get("avg7")),
        avg7_foil: float(value.get("avg7_foil")),
        avg30: float(value.get("avg30")),
        avg30_foil: float(value.get("avg30_foil")),
    })
}

/// The Cardmarket feed of one page.
#[derive(Debug, Default)]
pub struct CardmarketFeed {
    /// The run's day (`asOf`).
    pub as_of: String,
    pub products_by_blueprint: HashMap<i64, Vec<i64>>,
    pub guide_by_product: HashMap<i64, GuideRow>,
}

/// Cardmarket's state for a page: a feed, or `Unavailable` (query error,
/// missing table, or a run older than 4 days).
pub enum CardmarketOutcome {
    Feed(CardmarketFeed),
    Unavailable,
}

/// The game's last fresh guide run day, or `None` (stale, missing or error).
pub async fn fetch_cm_run(db: &DbPools, game: &str) -> Option<String> {
    match db.query("pokemon", CM_RUN_SQL, &[json!(game)]).await {
        Ok(rows) => match rows.first().and_then(|row| row.get("day")).and_then(Value::as_str) {
            Some(day) if !day.is_empty() => Some(day.to_string()),
            _ => {
                tracing::warn!(game, "cardmarket price guide run is stale or missing; source unavailable");
                None
            }
        },
        Err(error) => {
            if error.is_table_missing() {
                tracing::warn!("cardmarket_price_guide_runs is not migrated; cardmarket source unavailable");
            } else {
                tracing::warn!(game, error = %error, "cardmarket run query failed; source unavailable");
            }
            None
        }
    }
}

/// Blueprint → Cardmarket products of the page, in the game's own pool.
pub async fn fetch_cm_products(db: &DbPools, game: &str, table: &str, ct_ids: &[i64]) -> Option<HashMap<i64, Vec<i64>>> {
    if ct_ids.is_empty() {
        return Some(HashMap::new());
    }
    match db.query(game, &cm_products_sql(table), &[json!(ct_ids)]).await {
        Ok(rows) => {
            let mut map: HashMap<i64, Vec<i64>> = HashMap::new();
            for row in &rows {
                if let (Some(blueprint), Some(product)) = (int(row.get("blueprint_id")), int(row.get("id_product"))) {
                    let entry = map.entry(blueprint).or_default();
                    if !entry.contains(&product) {
                        entry.push(product);
                    }
                }
            }
            Some(map)
        }
        Err(error) => {
            if error.is_table_missing() {
                tracing::warn!(game, "the catalog table is missing; cardmarket products unavailable");
            } else {
                tracing::warn!(game, error = %error, "cardmarket products query failed; source unavailable");
            }
            None
        }
    }
}

/// The newest guide row per product, in the `"pokemon"` pool.
pub async fn fetch_cm_guide(db: &DbPools, game: &str, product_ids: &[i64]) -> Option<HashMap<i64, GuideRow>> {
    if product_ids.is_empty() {
        return Some(HashMap::new());
    }
    match db.query("pokemon", CM_GUIDE_SQL, &[json!(game), json!(product_ids)]).await {
        Ok(rows) => Some(
            rows.iter()
                .filter_map(|row| Some((int(row.get("id_product"))?, guide_row(row)?)))
                .collect(),
        ),
        Err(error) => {
            if error.is_table_missing() {
                tracing::warn!("cardmarket_price_guide is not migrated; cardmarket source unavailable");
            } else {
                tracing::warn!(game, error = %error, "cardmarket guide query failed; source unavailable");
            }
            None
        }
    }
}

/// The `sources.cardmarket` value of one item, or `None` (status `empty`).
/// Per basis: `regular` = min positive value over the card's products, `foil`
/// = min positive foil value; key `"F"` is the foil value for a foil item,
/// else the regular one; key `""` = min of what exists. `grossPkn = eur × 200`.
pub fn cardmarket_source(feed: &CardmarketFeed, blueprint_id: Option<i64>, item: &PriceItem, game: &str) -> Option<Value> {
    let products = feed.products_by_blueprint.get(&blueprint_id?)?;
    let rows: Vec<&GuideRow> = products.iter().filter_map(|p| feed.guide_by_product.get(p)).collect();
    if rows.is_empty() {
        return None;
    }
    let foil_item = item_finish(item, game);
    let mut out = Map::new();
    out.insert("asOf".into(), json!(feed.as_of));
    for (name, _, _) in CM_BASES {
        let regular = rows
            .iter()
            .filter_map(|row| row.basis(name).0)
            .filter(|v| *v > 0.0)
            .fold(f64::INFINITY, f64::min);
        let foil = rows
            .iter()
            .filter_map(|row| row.basis(name).1)
            .filter(|v| *v > 0.0)
            .fold(f64::INFINITY, f64::min);
        let mut map = Map::new();
        if !item.one_of_a_kind() {
            let finish_value = if foil_item { foil } else { regular };
            if finish_value.is_finite() {
                let eur = finish_value;
                let gross = round2(eur * 200.0);
                map.insert("F".into(), json!({ "eur": eur, "grossPkn": gross, "pkn": gross }));
            }
        }
        let any = [regular, foil].into_iter().filter(|v| v.is_finite()).fold(f64::INFINITY, f64::min);
        if any.is_finite() {
            let eur = any;
            let gross = round2(eur * 200.0);
            map.insert(String::new(), json!({ "eur": eur, "grossPkn": gross, "pkn": gross }));
        }
        if !map.is_empty() {
            out.insert(name.into(), Value::Object(map));
        }
    }
    if out.len() <= 1 {
        return None; // only asOf: no basis had a value
    }
    Some(Value::Object(out))
}

// ----------------------------------------------------------------- TCGplayer

/// The newest EUR→USD reference rate, fresh only within 10 days. Runs in the
/// `"pokemon"` pool.
pub const FX_SQL: &str = "select day::text as day, rate::float8 as rate from public.fx_rates_daily \
     where base = 'EUR' and quote = 'USD' and day >= current_date - 10 order by day desc limit 1";

/// The TCGplayer feed of one page.
#[derive(Debug)]
pub struct TcgFeed {
    pub rows_by_card: HashMap<i64, Vec<TcgRow>>,
    pub rate: f64,
    pub rate_day: String,
    /// The newest snapshot day of the page's rows.
    pub as_of: String,
}

/// TCGplayer's state for a page.
pub enum TcgOutcome {
    Feed(TcgFeed),
    Unavailable,
    Unconfigured,
}

/// The page's TCGplayer rows plus the FX rate: the FX query and the TCGCSV
/// query are independent, so they run together.
pub async fn fetch_tcg(db: &DbPools, game: &str, card_ids: &[i64]) -> TcgOutcome {
    if tcgcsv::pool().is_none() {
        return TcgOutcome::Unconfigured;
    }
    let fx = db.query("pokemon", FX_SQL, &[]).await;
    let (rate_day, rate) = match fx {
        Ok(rows) => match rows.first().and_then(|row| {
            Some((
                text(row.get("day")),
                float(row.get("rate")).filter(|r| *r > 0.0)?,
            ))
        }) {
            Some((day, rate)) if !day.is_empty() => (day, rate),
            _ => {
                tracing::warn!("no fresh EUR→USD fx rate; tcgplayer source unavailable");
                return TcgOutcome::Unavailable;
            }
        },
        Err(error) => {
            if error.is_table_missing() {
                tracing::warn!("fx_rates_daily is not migrated; tcgplayer source unavailable");
            } else {
                tracing::warn!(error = %error, "fx rate query failed; tcgplayer source unavailable");
            }
            return TcgOutcome::Unavailable;
        }
    };
    if card_ids.is_empty() {
        return TcgOutcome::Feed(TcgFeed {
            rows_by_card: HashMap::new(),
            rate,
            rate_day,
            as_of: String::new(),
        });
    }
    match tcgcsv::fetch(game, card_ids).await {
        Ok(rows) => {
            let mut rows_by_card: HashMap<i64, Vec<TcgRow>> = HashMap::new();
            let mut as_of = String::new();
            for row in rows {
                if row.as_of > as_of {
                    as_of = row.as_of.clone();
                }
                rows_by_card.entry(row.card_id).or_default().push(row);
            }
            TcgOutcome::Feed(TcgFeed { rows_by_card, rate, rate_day, as_of })
        }
        Err(error) => {
            tracing::warn!(game, error = %error, "tcgcsv query failed; tcgplayer source unavailable");
            TcgOutcome::Unavailable
        }
    }
}

/// Does a TCGplayer row share the attributes `m` asks for with the item?
/// Pokémon matches on `reverse` only (a "Holofoil" is the base printing of a
/// holo card); the other games match on `foil`.
fn tcg_row_matches(row: &TcgRow, item: &PriceItem, game: &str, m: Match) -> bool {
    let subtype = tcgcsv::classify_subtype(&row.subtype);
    if m.finish {
        let row_finish = if game == "pokemon" { subtype.reverse } else { subtype.foil };
        if row_finish != item_finish(item, game) {
            return false;
        }
    }
    if m.first_edition && subtype.first_edition != item.first_edition {
        return false;
    }
    true
}

/// The raw quote of one row, for the comp's existing `"tcgplayer"` array.
pub fn tcg_quote(row: &TcgRow) -> Value {
    json!({
        "productId": row.product_id,
        "categoryId": row.category_id,
        "subtype": row.subtype,
        "marketUsd": row.market,
        "lowUsd": row.low,
        "midUsd": row.mid,
        "asOf": row.as_of,
    })
}

/// The `sources.tcgplayer` bases (`market`, `low`, `mid`) of one item: per
/// basis, per key (`""`, `F`, `E`, `FE`), the min positive USD over the
/// matching rows of all the card's products; `grossPkn = usd / rate × 200`.
pub fn tcg_bases(feed: &TcgFeed, rows: &[TcgRow], item: &PriceItem, game: &str) -> Map<String, Value> {
    let mut out = Map::new();
    for basis in ["market", "low", "mid"] {
        let mut map = Map::new();
        for m in Match::all() {
            if m.condition || m.language {
                continue; // TCGplayer honours F and E only
            }
            if m != Match::ANY && item.one_of_a_kind() {
                continue;
            }
            let usd = rows
                .iter()
                .filter(|row| tcg_row_matches(row, item, game, m))
                .filter_map(|row| row.price(basis))
                .filter(|v| *v > 0.0)
                .fold(f64::INFINITY, f64::min);
            if usd.is_finite() {
                let gross = round2(usd / feed.rate * 200.0);
                map.insert(m.key(), json!({ "usd": usd, "grossPkn": gross, "pkn": gross }));
            }
        }
        if !map.is_empty() {
            out.insert(basis.into(), Value::Object(map));
        }
    }
    out
}

// ------------------------------------------------------------------ assembly

/// Everything the per-item comp builders need, fetched once per page.
pub struct PageSources<'a> {
    pub game: String,
    /// Public card id → CardTrader blueprint id (via the game's own
    /// `marketplace_search_candidates`).
    pub blueprint_by_card: HashMap<String, i64>,
    pub ct_sold: Option<Vec<CtSoldRow>>,
    pub pokoin_sales: Option<&'a [PokoinSale]>,
    pub cardmarket: CardmarketOutcome,
    pub tcg: TcgOutcome,
}

impl<'a> PageSources<'a> {
    /// A page with no feeds at all (every status `unavailable`/`unconfigured`).
    pub fn empty(game: &str) -> Self {
        PageSources {
            game: game.to_string(),
            blueprint_by_card: HashMap::new(),
            ct_sold: None,
            pokoin_sales: None,
            cardmarket: CardmarketOutcome::Unavailable,
            tcg: TcgOutcome::Unconfigured,
        }
    }
}

/// Attach `sources` and `sourceStatus` to one comp (and the existing
/// `"tcgplayer"` array / `"tcgplayerStatus"`). Never fails; a feed that
/// cannot answer is omitted with its status.
pub fn attach(comp: &mut Value, item: &PriceItem, channel: Channel, src: &PageSources) {
    let game = src.game.as_str();
    let blueprint_id = src.blueprint_by_card.get(&item.card_id).copied();
    let mut sources = Map::new();
    let mut status = Map::new();

    // CardTrader sold.
    let ct_status = match &src.ct_sold {
        None => "unavailable",
        Some(rows) => {
            let map = match blueprint_id {
                Some(id) => ct_sold_map(rows, id, item, game, channel),
                None => Map::new(),
            };
            if map.is_empty() {
                "empty"
            } else {
                sources.insert("cardtrader".into(), json!({ "sold": Value::Object(map) }));
                "available"
            }
        }
    };
    status.insert("cardtraderSold".into(), json!(ct_status));

    // Pokoin's own sold.
    let pokoin_status = match src.pokoin_sales {
        None => "unavailable",
        Some(sales) => {
            let map = pokoin_sold_map(sales, item);
            if map.is_empty() {
                "empty"
            } else {
                sources.insert("pokoin".into(), json!({ "sold": Value::Object(map) }));
                "available"
            }
        }
    };
    status.insert("pokoinSold".into(), json!(pokoin_status));

    // Cardmarket price guide.
    let cm_status = match &src.cardmarket {
        CardmarketOutcome::Unavailable => "unavailable",
        CardmarketOutcome::Feed(feed) => match cardmarket_source(feed, blueprint_id, item, game) {
            Some(value) => {
                sources.insert("cardmarket".into(), value);
                "available"
            }
            None => "empty",
        },
    };
    status.insert("cardmarket".into(), json!(cm_status));

    // TCGplayer. The raw quotes array and the status are always set (the
    // array empty when the feed cannot answer).
    let card_id: Option<i64> = item.card_id.parse().ok();
    let (tcg_status, tcg_source, quotes) = match &src.tcg {
        TcgOutcome::Unconfigured => ("unconfigured", None, Vec::new()),
        TcgOutcome::Unavailable => ("unavailable", None, Vec::new()),
        TcgOutcome::Feed(feed) => {
            let rows = card_id.and_then(|id| feed.rows_by_card.get(&id)).map(Vec::as_slice).unwrap_or(&[]);
            let quotes: Vec<Value> = rows.iter().map(tcg_quote).collect();
            let bases = tcg_bases(feed, rows, item, game);
            if bases.is_empty() {
                ("empty", None, quotes)
            } else {
                let mut value = Map::new();
                value.insert("asOf".into(), json!(feed.as_of));
                value.insert("rateDay".into(), json!(feed.rate_day));
                value.insert("usdPerEur".into(), json!(feed.rate));
                for (basis, map) in bases {
                    value.insert(basis, map);
                }
                ("available", Some(Value::Object(value)), quotes)
            }
        }
    };
    comp["tcgplayer"] = json!(quotes);
    comp["tcgplayerStatus"] = json!(tcg_status);
    if let Some(value) = tcg_source {
        sources.insert("tcgplayer".into(), value);
    }
    status.insert("tcgplayer".into(), json!(tcg_status));

    // Always present on a new answer (even empty), so it is never read as an
    // answer from before the block (`pricing::strategy_comp`).
    comp["sources"] = Value::Object(sources);
    comp["sourceStatus"] = Value::Object(status);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pokoin_sold::PokoinSale;
    use crate::price_check::parse_items;
    use serde_json::json;

    fn row(blueprint_id: i64, condition: &str, language: &str, reverse: bool, first_edition: bool, graded: bool, median_pkn: f64) -> CtSoldRow {
        CtSoldRow {
            blueprint_id,
            condition: condition.to_string(),
            language: language.to_string(),
            reverse,
            first_edition,
            graded,
            median_pkn,
        }
    }

    #[test]
    fn percentile_median_is_the_postgres_semantics() {
        assert_eq!(percentile_median(&[]), None);
        assert_eq!(percentile_median(&[5.0]), Some(5.0));
        assert_eq!(percentile_median(&[3.0, 1.0, 2.0]), Some(2.0), "odd: the middle after sorting");
        assert_eq!(percentile_median(&[4.0, 1.0, 3.0, 2.0]), Some(2.5), "even: mean of the two middle");
        assert_eq!(percentile_median(&[10.0, 2.0]), Some(6.0));
        assert_eq!(percentile_median(&[1.0, f64::NAN, 3.0]), Some(2.0), "non-finite values are dropped");
    }

    #[test]
    fn round2_rounds_half_away_from_zero() {
        assert_eq!(round2(123.455), 123.46);
        assert_eq!(round2(-123.455), -123.46);
        assert_eq!(round2(1.005), 1.01);
        assert_eq!(round2(246.0), 246.0);
        assert_eq!(round2(277.465), 277.47);
    }

    #[test]
    fn ct_sold_keys_select_by_condition_language_finish_and_edition() {
        // Pokémon blueprint 100: NM EN plain 100, NM EN reverse 200, SP IT plain 50,
        // NM EN graded 999, MP EN plain 80.
        let rows = vec![
            row(100, "NM", "EN", false, false, false, 100.0),
            row(100, "NM", "EN", true, false, false, 200.0),
            row(100, "SP", "IT", false, false, false, 50.0),
            row(100, "NM", "EN", false, false, true, 999.0),
            row(100, "MP", "EN", false, false, false, 80.0),
            row(101, "NM", "EN", false, false, false, 1.0),
        ];
        let item = parse_items("200:NM:EN")[0].clone(); // card 200 → blueprint 100
        let map = ct_sold_map(&rows, 100, &item, "pokemon", Channel::Direct);
        assert_eq!(map.len(), 16, "every key of a raw copy");
        // "" is over ALL rows (graded included) and equals soldMedianGrossPkn.
        assert_eq!(map[""]["grossPkn"], json!(100.0), "median of 50,80,100,200,999");
        assert_eq!(sold_median_of(&rows, 100), Some(100.0));
        // C: exact condition for Pokémon, graded excluded.
        assert_eq!(map["C"]["grossPkn"], json!(150.0), "median of NM rows 100,200");
        // L: exact language, graded excluded.
        assert_eq!(map["L"]["grossPkn"], json!(100.0), "median of EN rows 100,200,80");
        // F: the rows with the item's finish (a plain item never prices the reverse row).
        assert_eq!(map["F"]["grossPkn"], json!(80.0), "median of the plain rows 100, 50, 80");
        // CLFE: the exact copy.
        assert_eq!(map["CLFE"]["grossPkn"], json!(100.0));
        assert_eq!(map["CLF"]["grossPkn"], json!(100.0));
        // pkn is net of the Direct fee.
        let rule = crate::ct_fees::rule();
        assert_eq!(map["CLFE"]["pkn"], json!(rule.net_pkn(100.0, Channel::Direct).map(round2)));
        // A reverse item prices the reverse rows.
        let rev = parse_items("200:NM:EN:R")[0].clone();
        let rev_map = ct_sold_map(&rows, 100, &rev, "pokemon", Channel::Direct);
        assert_eq!(rev_map["CLFE"]["grossPkn"], json!(200.0));
        assert_eq!(rev_map["F"]["grossPkn"], json!(200.0));
        // An item with no condition/language matches any row on C/L (ungraded).
        let any = parse_items("200:::")[0].clone();
        let any_map = ct_sold_map(&rows, 100, &any, "pokemon", Channel::Direct);
        assert_eq!(any_map["C"]["grossPkn"], json!(90.0), "no condition: median of ungraded 50,80,100,200");
        assert_eq!(any_map["L"]["grossPkn"], json!(90.0));
        // A one-of-a-kind item gets only "".
        let graded = parse_items("200:NM:EN:G")[0].clone();
        let graded_map = ct_sold_map(&rows, 100, &graded, "pokemon", Channel::Direct);
        assert_eq!(graded_map.len(), 1);
        assert!(graded_map.contains_key(""));
        // Another blueprint is untouched.
        assert_eq!(ct_sold_map(&rows, 101, &item, "pokemon", Channel::Direct)["CLFE"]["grossPkn"], json!(1.0));
    }

    #[test]
    fn other_games_match_condition_or_better_and_foil_in_reverse() {
        // Magic blueprint 5: NM EN 100, SP EN 90, MP EN 80, PL EN 70, Poor EN 60,
        // NM EN foil(reverse col) 500.
        let rows = vec![
            row(5, "NM", "EN", false, false, false, 100.0),
            row(5, "SP", "EN", false, false, false, 90.0),
            row(5, "MP", "EN", false, false, false, 80.0),
            row(5, "PL", "EN", false, false, false, 70.0),
            row(5, "Poor", "EN", false, false, false, 60.0),
            row(5, "NM", "EN", true, false, false, 500.0),
        ];
        // MP item: condition or better → NM, SP, MP rows.
        let mp = parse_items("10:MP:EN")[0].clone();
        let map = ct_sold_map(&rows, 5, &mp, "magic", Channel::Zero);
        assert_eq!(map["C"]["grossPkn"], json!(95.0), "median of NM 100, SP 90, MP 80 and the NM foil 500 (C ignores finish)");
        // NM item: only NM rows (the foil one is a different finish, but C ignores finish).
        let nm = parse_items("10:NM:EN")[0].clone();
        let nm_map = ct_sold_map(&rows, 5, &nm, "magic", Channel::Zero);
        assert_eq!(nm_map["C"]["grossPkn"], json!(300.0), "median of NM 100 and NM foil 500");
        // Poor item: every condition is better (the foil row's NM is better too).
        let poor = parse_items("10:Poor:EN")[0].clone();
        let poor_map = ct_sold_map(&rows, 5, &poor, "magic", Channel::Zero);
        assert_eq!(poor_map["C"]["grossPkn"], json!(85.0), "median of 60,70,80,90,100,500");
        // A foil item (H flag) matches the foil rows (stored in `reverse`).
        let foil = parse_items("10:NM:EN:H")[0].clone();
        let foil_map = ct_sold_map(&rows, 5, &foil, "magic", Channel::Zero);
        assert_eq!(foil_map["F"]["grossPkn"], json!(500.0));
        assert_eq!(foil_map["CLFE"]["grossPkn"], json!(500.0));
        assert_eq!(nm_map["F"]["grossPkn"], json!(80.0), "a plain item never prices the foil rows: median of 60..100");
        // pkn nets the Zero fee.
        let rule = crate::ct_fees::rule();
        assert_eq!(foil_map["F"]["pkn"], json!(rule.net_pkn(500.0, Channel::Zero).map(round2)));
    }

    #[test]
    fn pokoin_sold_keys_are_c_and_l_with_sales_count() {
        let sales = vec![
            PokoinSale { card_id: "200".into(), condition: "NM".into(), language: "EN".into(), price_pkn: 300.0 },
            PokoinSale { card_id: "200".into(), condition: "NM".into(), language: "EN".into(), price_pkn: 100.0 },
            PokoinSale { card_id: "200".into(), condition: "SP".into(), language: "EN".into(), price_pkn: 50.0 },
            PokoinSale { card_id: "200".into(), condition: "NM".into(), language: "IT".into(), price_pkn: 400.0 },
            PokoinSale { card_id: "999".into(), condition: "NM".into(), language: "EN".into(), price_pkn: 1.0 },
        ];
        let item = parse_items("200:NM:EN")[0].clone();
        let map = pokoin_sold_map(&sales, &item);
        assert_eq!(map.len(), 4, "\"\", C, L, CL only");
        assert_eq!(map[""]["sales"], json!(4));
        assert_eq!(map[""]["grossPkn"], json!(200.0), "median of 50,100,300,400");
        assert_eq!(map[""]["pkn"], json!(200.0), "no fee on Pokoin's own sales");
        assert_eq!(map["C"]["sales"], json!(3));
        assert_eq!(map["C"]["grossPkn"], json!(300.0), "median of 100,300,400");
        assert_eq!(map["L"]["sales"], json!(3));
        assert_eq!(map["L"]["grossPkn"], json!(100.0), "median of 50,100,300");
        assert_eq!(map["CL"]["sales"], json!(2));
        assert_eq!(map["CL"]["grossPkn"], json!(200.0), "median of 100,300");
        // No finish/edition keys, and a one-of-a-kind item gets only "".
        assert!(!map.contains_key("F") && !map.contains_key("CLFE"));
        let graded = parse_items("200:NM:EN:G")[0].clone();
        let graded_map = pokoin_sold_map(&sales, &graded);
        assert_eq!(graded_map.len(), 1);
        assert_eq!(graded_map[""]["sales"], json!(4));
        // Another card has nothing.
        assert!(pokoin_sold_map(&sales, &parse_items("201:NM:EN")[0]).is_empty());
    }

    fn guide(id_product: i64, trend: Option<f64>, trend_foil: Option<f64>, low: Option<f64>) -> (i64, GuideRow) {
        (
            id_product,
            GuideRow {
                day: "2026-11-06".into(),
                trend,
                trend_foil,
                low,
                ..Default::default()
            },
        )
    }

    #[test]
    fn cardmarket_picks_regular_foil_and_any_over_two_products() {
        let feed = CardmarketFeed {
            as_of: "2026-11-06".into(),
            products_by_blueprint: HashMap::from([(100, vec![11, 12])]),
            guide_by_product: HashMap::from([
                guide(11, Some(1.23), Some(5.0), Some(1.0)),
                // product 12: trend 2.0, foil low 0.5 (no regular low)
                (12, GuideRow { day: "2026-11-06".into(), trend: Some(2.0), low_foil: Some(0.5), ..Default::default() }),
            ]),
        };
        // A plain Pokémon item: F = regular, "" = min(regular, foil).
        let item = parse_items("200:NM:EN")[0].clone();
        let value = cardmarket_source(&feed, Some(100), &item, "pokemon").unwrap();
        assert_eq!(value["asOf"], json!("2026-11-06"));
        assert_eq!(value["trend"]["F"]["eur"], json!(1.23), "regular: min over products");
        assert_eq!(value["trend"]["F"]["grossPkn"], json!(246.0), "eur × 200");
        assert_eq!(value["trend"]["F"]["pkn"], json!(246.0));
        assert_eq!(value["trend"][""]["eur"], json!(1.23), "min(regular 1.23, foil 5.0)");
        assert_eq!(value["low"][""]["eur"], json!(0.5));
        assert_eq!(value["low"]["F"]["eur"], json!(1.0));
        // A foil item: F = foil.
        let foil = parse_items("200:NM:EN:R")[0].clone();
        let value = cardmarket_source(&feed, Some(100), &foil, "pokemon").unwrap();
        assert_eq!(value["trend"]["F"]["eur"], json!(5.0));
        assert_eq!(value["trend"][""]["eur"], json!(1.23), "\"\" is still min of what exists");
        // A one-of-a-kind item gets only "".
        let graded = parse_items("200:NM:EN:G")[0].clone();
        let value = cardmarket_source(&feed, Some(100), &graded, "pokemon").unwrap();
        assert!(value["trend"].get("F").is_none());
        assert_eq!(value["trend"][""]["eur"], json!(1.23));
        // No products, or no guide rows: no source.
        assert!(cardmarket_source(&feed, Some(101), &item, "pokemon").is_none());
        let empty = CardmarketFeed { as_of: "2026-11-06".into(), products_by_blueprint: HashMap::from([(100, vec![13])]), guide_by_product: HashMap::new() };
        assert!(cardmarket_source(&empty, Some(100), &item, "pokemon").is_none());
        // A product with only zero/negative values contributes nothing.
        let zero = CardmarketFeed {
            as_of: "2026-11-06".into(),
            products_by_blueprint: HashMap::from([(100, vec![11])]),
            guide_by_product: HashMap::from([guide(11, Some(0.0), Some(-1.0), None)]),
        };
        assert!(cardmarket_source(&zero, Some(100), &item, "pokemon").is_none());
    }

    fn tcg(card_id: i64, product_id: i64, subtype: &str, market: Option<f64>, low: Option<f64>, mid: Option<f64>) -> TcgRow {
        TcgRow {
            card_id,
            product_id,
            category_id: 3,
            subtype: subtype.to_string(),
            market,
            low,
            mid,
            as_of: "2026-11-06".into(),
        }
    }

    #[test]
    fn tcgplayer_keys_for_a_pokemon_reverse_item_and_a_magic_foil_item() {
        let feed = TcgFeed {
            rows_by_card: HashMap::from([(
                200,
                vec![
                    tcg(200, 1, "Normal", Some(1.5), Some(1.0), Some(1.2)),
                    tcg(200, 2, "Holofoil", Some(3.0), Some(2.5), Some(2.8)),
                    tcg(200, 3, "Reverse Holofoil", Some(4.0), Some(3.5), Some(3.8)),
                    tcg(200, 4, "1st Edition Holofoil", Some(9.0), Some(8.0), Some(8.5)),
                ],
            )]),
            rate: 1.0812,
            rate_day: "2026-11-06".into(),
            as_of: "2026-11-06".into(),
        };
        // Pokémon reverse item: F matches Reverse Holofoil only (Holofoil is the base printing).
        let rev = parse_items("200:NM:EN:R")[0].clone();
        let bases = tcg_bases(&feed, feed.rows_by_card[&200].as_slice(), &rev, "pokemon");
        assert_eq!(bases["market"]["F"]["usd"], json!(4.0));
        assert_eq!(bases["market"]["F"]["grossPkn"], json!(round2(4.0 / 1.0812 * 200.0)));
        assert_eq!(bases["market"]["F"]["pkn"], bases["market"]["F"]["grossPkn"]);
        assert_eq!(bases["market"][""]["usd"], json!(1.5), "\"\" is the min over all rows");
        assert_eq!(bases["low"]["F"]["usd"], json!(3.5));
        assert_eq!(bases["mid"]["F"]["usd"], json!(3.8));
        // E: the rows with the item's edition (not 1st → the non-1st rows).
        assert_eq!(bases["market"]["E"]["usd"], json!(1.5), "min of Normal, Holofoil, Reverse Holofoil");
        assert_eq!(bases["market"]["FE"]["usd"], json!(4.0), "reverse and not 1st: Reverse Holofoil");
        // A plain Pokémon item: F matches Normal.
        let plain = parse_items("200:NM:EN")[0].clone();
        let bases = tcg_bases(&feed, feed.rows_by_card[&200].as_slice(), &plain, "pokemon");
        assert_eq!(bases["market"]["F"]["usd"], json!(1.5));
        // A first-edition Pokémon item: E matches the 1st edition row.
        let first = parse_items("200:NM:EN:F")[0].clone();
        let bases = tcg_bases(&feed, feed.rows_by_card[&200].as_slice(), &first, "pokemon");
        assert_eq!(bases["market"]["E"]["usd"], json!(9.0));
        assert_eq!(bases["market"]["F"]["usd"], json!(1.5), "F is finish only");

        // Magic foil item: foil matches Holofoil/Reverse/Foil rows (foil facet), not Normal.
        let magic_rows = vec![
            tcg(10, 5, "Normal", Some(2.0), Some(1.0), Some(1.5)),
            tcg(10, 6, "Foil", Some(6.0), Some(5.0), Some(5.5)),
            tcg(10, 7, "Cold Foil", Some(7.0), Some(6.0), Some(6.5)),
            tcg(10, 8, "1st Edition", Some(12.0), Some(11.0), Some(11.5)),
        ];
        let magic_feed = TcgFeed {
            rows_by_card: HashMap::from([(10, magic_rows.clone())]),
            rate: 1.0812,
            rate_day: "2026-11-06".into(),
            as_of: "2026-11-06".into(),
        };
        let foil = parse_items("10:NM:EN:H")[0].clone();
        let bases = tcg_bases(&magic_feed, &magic_rows, &foil, "magic");
        assert_eq!(bases["market"]["F"]["usd"], json!(6.0), "min positive foil: Foil 6.0, Cold Foil 7.0");
        assert_eq!(bases["market"][""]["usd"], json!(2.0));
        // E for a non-1st-edition item matches only non-1st rows.
        assert_eq!(bases["market"]["E"]["usd"], json!(2.0));
        let first = parse_items("10:NM:EN:F")[0].clone();
        let bases = tcg_bases(&magic_feed, &magic_rows, &first, "magic");
        assert_eq!(bases["market"]["E"]["usd"], json!(12.0));
        assert_eq!(bases["market"]["FE"]["usd"], json!(12.0), "foil off, 1st on: the 1st Edition row is not foil");
        // One-of-a-kind: only "".
        let graded = parse_items("10:NM:EN:G")[0].clone();
        let bases = tcg_bases(&magic_feed, &magic_rows, &graded, "magic");
        let market = bases["market"].as_object().unwrap();
        assert_eq!(market.len(), 1);
        assert!(market.contains_key(""));
    }

    #[test]
    fn usd_to_pkn_conversion_and_rounding() {
        let feed = TcgFeed {
            rows_by_card: HashMap::from([(1, vec![tcg(1, 1, "Normal", Some(1.5), None, None)])]),
            rate: 1.0812,
            rate_day: "2026-11-06".into(),
            as_of: "2026-11-06".into(),
        };
        let item = parse_items("1:NM:EN")[0].clone();
        let bases = tcg_bases(&feed, feed.rows_by_card[&1].as_slice(), &item, "pokemon");
        // 1.5 USD / 1.0812 USD-per-EUR = 1.3873 EUR × 200 = 277.47 PKN.
        assert_eq!(bases["market"][""]["usd"], json!(1.5));
        assert_eq!(bases["market"][""]["grossPkn"], json!(277.47));
        assert_eq!(bases["market"][""]["pkn"], json!(277.47));
        assert!(bases.get("low").is_none(), "no positive low price: the basis is omitted");
    }

    #[test]
    fn a_missing_feed_leaves_the_rest_of_the_comp_unchanged() {
        let item = parse_items("200:NM:EN")[0].clone();
        let mut comp = json!({
            "pokoinCheapestPkn": 30.0,
            "ctBasis": "zero",
            "ctCheapestGrossPkn": 100.0,
            "ctMatchedGrossPkn": 240.0,
            "ctMatch": { "CLFE": { "grossPkn": 240.0, "pkn": 219.5 } },
            "soldMedianGrossPkn": 150.0,
            "soldMedianPkn": 138.0,
        });
        let before = comp.clone();
        attach(&mut comp, &item, Channel::Zero, &PageSources::empty("magic"));
        assert_eq!(comp["pokoinCheapestPkn"], before["pokoinCheapestPkn"]);
        assert_eq!(comp["ctMatch"], before["ctMatch"]);
        assert_eq!(comp["soldMedianGrossPkn"], before["soldMedianGrossPkn"]);
        assert_eq!(comp["sources"], json!({}), "no source had a value: an empty block, still a new answer");
        assert_eq!(
            comp["sourceStatus"],
            json!({ "cardtraderSold": "unavailable", "pokoinSold": "unavailable", "cardmarket": "unavailable", "tcgplayer": "unconfigured" })
        );
        assert_eq!(comp["tcgplayer"], json!([]));
        assert_eq!(comp["tcgplayerStatus"], json!("unconfigured"));
    }

    #[test]
    fn attach_builds_the_full_sources_block() {
        let rows = vec![
            row(100, "NM", "EN", false, false, false, 123.4),
            row(100, "NM", "EN", true, false, false, 200.0),
        ];
        let sales = vec![PokoinSale { card_id: "200".into(), condition: "NM".into(), language: "EN".into(), price_pkn: 300.0 }];
        let feed = CardmarketFeed {
            as_of: "2026-11-06".into(),
            products_by_blueprint: HashMap::from([(100, vec![11])]),
            guide_by_product: HashMap::from([guide(11, Some(1.23), Some(5.0), Some(1.0))]),
        };
        let tcg_feed = TcgFeed {
            rows_by_card: HashMap::from([(200, vec![tcg(200, 1, "Normal", Some(1.5), Some(1.0), Some(1.2))])]),
            rate: 1.0812,
            rate_day: "2026-11-06".into(),
            as_of: "2026-11-06".into(),
        };
        let src = PageSources {
            game: "pokemon".into(),
            blueprint_by_card: HashMap::from([("200".to_string(), 100)]),
            ct_sold: Some(rows),
            pokoin_sales: Some(&sales),
            cardmarket: CardmarketOutcome::Feed(feed),
            tcg: TcgOutcome::Feed(tcg_feed),
        };
        let item = parse_items("200:NM:EN")[0].clone();
        let mut comp = json!({});
        attach(&mut comp, &item, Channel::Direct, &src);
        let sources = comp["sources"].as_object().unwrap();
        assert_eq!(sources.len(), 4);
        assert_eq!(sources["cardtrader"]["sold"]["CLFE"]["grossPkn"], json!(123.4));
        assert_eq!(sources["cardtrader"]["sold"]["F"]["grossPkn"], json!(123.4), "plain item: the non-reverse row");
        assert_eq!(sources["pokoin"]["sold"]["CL"]["sales"], json!(1));
        assert_eq!(sources["pokoin"]["sold"]["CL"]["grossPkn"], json!(300.0));
        assert_eq!(sources["cardmarket"]["asOf"], json!("2026-11-06"));
        assert_eq!(sources["cardmarket"]["trend"]["F"]["eur"], json!(1.23));
        assert_eq!(sources["cardmarket"]["trend"]["F"]["grossPkn"], json!(246.0));
        assert_eq!(sources["tcgplayer"]["usdPerEur"], json!(1.0812));
        assert_eq!(sources["tcgplayer"]["rateDay"], json!("2026-11-06"));
        assert_eq!(sources["tcgplayer"]["market"][""]["grossPkn"], json!(277.47));
        assert_eq!(comp["tcgplayer"][0]["productId"], json!(1));
        assert_eq!(comp["tcgplayerStatus"], json!("available"));
        assert_eq!(
            comp["sourceStatus"],
            json!({ "cardtraderSold": "available", "pokoinSold": "available", "cardmarket": "available", "tcgplayer": "available" })
        );
    }
}
