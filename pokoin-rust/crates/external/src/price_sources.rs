//! The `sources` block of a price-check comp: CardTrader sold, Pokoin's own
//! sold, Cardmarket's price guide, Cardmarket's scanned seller offers and
//! TCGplayer quotes — one independent feed each, all games, all three comp
//! builders (`read_prices`, `game_comp`, `store_game_comp`).
//!
//! ```jsonc
//! "sources": {
//!   "cardtrader": { "sold": { "<key>": { "grossPkn": 123.4, "pkn": 110.2 } } },
//!   "pokoin":     { "sold": { "<key>": { "grossPkn": 300, "pkn": 300, "sales": 4 } } },
//!   "cardmarket": { "asOf": "2026-11-06",
//!                   "trend": { "<key>": { "eur": 1.23, "grossPkn": 246, "pkn": 246 } },
//!                   "low": { … }, "avg1": { … }, "avg7": { … }, "avg30": { … } },
//!   "cardmarketoffers": { "asOf": "2026-11-10",
//!                   "pro":     { "<key>": { "eur": 20.0, "grossPkn": 4000, "pkn": 4000,
//!                                          "condition": "NM", "language": "IT", … } },
//!                   "private": { "<key>": { … } } },
//!   "tcgplayer":  { "asOf": "2026-11-06", "rateDay": "2026-11-06", "usdPerEur": 1.0812,
//!                   "market": { "<key>": { "usd": 1.5, "grossPkn": 277.47, "pkn": 277.47 } },
//!                   "low": { … }, "mid": { … } }
//! }
//! ```
//!
//! `<key>` is `Match::key()` (`C`, `L`, `F`, `E` in that order, `""` = any
//! copy) restricted to the letters the source honours: CardTrader sold and
//! Cardmarket offers all 16, Pokoin sold `C`/`L`, Cardmarket `F`, TCGplayer
//! `F`/`E`. Only keys with a value are present; a source with no value at all
//! is omitted and its `sourceStatus` is `empty`. A one-of-a-kind item
//! (graded/signed/altered) gets only the `""` key in every source.
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

/// TCGNotify's last fresh run day, or `None`. Independent of the official
/// guide's run: either feed being stale leaves the other in place.
pub const TCGNOTIFY_RUN_SQL: &str =
    "select max(day)::text as day from public.tcgnotify_price_guide_runs where game = $1 and day >= current_date - 4";

/// The newest ask per product (change-only history), in the `"pokemon"` pool.
pub const TCGNOTIFY_LOW_SQL: &str = "select g.id_product, g.min_price::float8 as min_price \
     from unnest($2::bigint[]) p(id) \
     cross join lateral ( \
       select * from public.tcgnotify_price_guide g \
       where g.game = $1 and g.id_product = p.id order by g.day desc limit 1 \
     ) g";

/// TCGNotify's cheapest ask wins the `low` basis; the official guide keeps
/// every other basis and all foil values, which TCGNotify does not publish.
/// A missing table, a stale run or a query error leaves the guide untouched.
/// `asOf` stays the guide's run day — this overrides a basis, not the feed.
pub async fn overlay_tcgnotify_low(
    db: &DbPools,
    game: &str,
    product_ids: &[i64],
    guide: &mut HashMap<i64, GuideRow>,
) {
    if product_ids.is_empty() {
        return;
    }
    let day = match db.query("pokemon", TCGNOTIFY_RUN_SQL, &[json!(game)]).await {
        Ok(rows) => match rows.first().and_then(|row| row.get("day")).and_then(Value::as_str) {
            Some(day) if !day.is_empty() => day.to_string(),
            _ => return,
        },
        Err(error) => {
            if !error.is_table_missing() {
                tracing::warn!(game, error = %error, "tcgnotify run query failed; keeping the official guide");
            }
            return;
        }
    };
    let rows = match db.query("pokemon", TCGNOTIFY_LOW_SQL, &[json!(game), json!(product_ids)]).await {
        Ok(rows) => rows,
        Err(error) => {
            if !error.is_table_missing() {
                tracing::warn!(game, error = %error, "tcgnotify ask query failed; keeping the official guide");
            }
            return;
        }
    };
    for row in &rows {
        let (Some(product), Some(price)) = (int(row.get("id_product")), float(row.get("min_price"))) else {
            continue;
        };
        if price <= 0.0 {
            continue;
        }
        let entry = guide.entry(product).or_default();
        entry.low = Some(price);
        if entry.day.is_empty() {
            entry.day = day.clone();
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

// ------------------------------------------------- Cardmarket scanned offers

/// One facet minimum a CTCMDeals scan read off Cardmarket's listing page
/// (`cardmarket_offer_minimums`, migration 141). A listing page is filtered
/// by worst acceptable condition, language, finish, first edition and seller
/// type, so a facet answers exactly one question — "what is the cheapest
/// offer from this kind of seller that is at least this good" — and is not an
/// answer to any other.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CmFloor {
    /// `pro` (professional or powerseller) or `private`.
    pub seller_type: String,
    /// Cardmarket's `minCondition` facet: `NM`, `SP`, `MP`, `PL`, `Poor` or
    /// `*` (unfiltered, so a mix of grades).
    pub condition: String,
    /// Pokoin's language key, or `*`.
    pub language: String,
    /// `Y`, `N` or `*`: Pokémon reverse holo, the other games' foil.
    pub finish: String,
    pub first_edition: String,
    /// EUR cents at 2 PKN per cent.
    pub min_pkn: f64,
    pub offers: i64,
    /// False when the scan stopped on a full page, so offers it never reached
    /// could be cheaper.
    pub counts_complete: Option<bool>,
    /// The day the scan saw it.
    pub day: String,
}

/// A page's floors and the crosswalk they join through. They live apart from
/// the guide feed because they age per facet, not per daily run: a scan done
/// on Tuesday is not made wrong by a guide download that failed on Wednesday.
#[derive(Debug, Default)]
pub struct CmFloorGroups {
    pub products_by_blueprint: HashMap<i64, Vec<i64>>,
    pub minimums_by_product: HashMap<i64, Vec<CmFloor>>,
}

/// How old a scanned facet may be to still be quoted. Cardmarket's own guide
/// is trusted for 4 days and CardTrader's live listings for 3; these sit
/// between, because a harvest is a walk of real pages, done on demand rather
/// than by a nightly timer.
pub const CM_FLOOR_MAX_AGE_DAYS: i64 = 7;

/// Both seller types: the number the guide's `low` and TCGNotify's ask cannot
/// give, because neither separates who is selling.
pub fn cm_floor_sql() -> String {
    format!(
        "select m.cm_product_id, m.seller_type, m.condition, m.language, m.finish, m.first_edition, \
         m.min_cents::float8 * 2 as min_pkn, coalesce(m.offers, 0)::int as offers, \
         m.counts_complete, m.observed_at::date::text as day \
       from public.cardmarket_offer_minimums m \
       where m.cm_product_id = any($1::bigint[]) \
         and m.observed_at::date >= current_date - {CM_FLOOR_MAX_AGE_DAYS}"
    )
}

/// The newest scanned facet minimum per Cardmarket product, `"pokemon"` pool.
pub async fn fetch_cm_floors(db: &DbPools, game: &str, product_ids: &[i64]) -> Option<HashMap<i64, Vec<CmFloor>>> {
    if product_ids.is_empty() {
        return Some(HashMap::new());
    }
    match db.query("pokemon", &cm_floor_sql(), &[json!(product_ids)]).await {
        Ok(rows) => {
            let mut map: HashMap<i64, Vec<CmFloor>> = HashMap::new();
            for row in &rows {
                let Some(product) = int(row.get("cm_product_id")) else {
                    continue;
                };
                map.entry(product).or_default().push(CmFloor {
                    seller_type: text(row.get("seller_type")),
                    condition: text(row.get("condition")),
                    language: text(row.get("language")),
                    finish: text(row.get("finish")),
                    first_edition: text(row.get("first_edition")),
                    min_pkn: float(row.get("min_pkn")).unwrap_or_default(),
                    offers: int(row.get("offers")).unwrap_or_default() as i64,
                    counts_complete: row.get("counts_complete").and_then(Value::as_bool),
                    day: text(row.get("day")),
                });
            }
            Some(map)
        }
        Err(error) => {
            if error.is_table_missing() {
                tracing::warn!("cardmarket_offer_minimums is not migrated; cardmarket offer floors unavailable");
            } else {
                tracing::warn!(game, error = %error, "cardmarket offer minimums query failed; offer floors unavailable");
            }
            None
        }
    }
}

/// Whether a captured facet answers the question the item asks. An item that
/// does not name a condition or language accepts any facet; one that names it
/// accepts only a facet filtered the same way, since `minCondition` is the
/// *worst* grade acceptable and a `*` facet is a mix of grades.
fn facet_agrees(captured: &str, wanted: Option<&str>) -> bool {
    match wanted {
        None => true,
        Some(want) => captured.eq_ignore_ascii_case(want),
    }
}

/// The same for a yes-or-no facet. A `*` facet mixed both copies, so it
/// answers neither a reverse nor a regular one.
fn flag_agrees(captured: &str, wanted: bool) -> bool {
    captured != "*" && (captured == "Y") == wanted
}

/// One floor as a comp: the price and the facet it was filtered at, so a
/// reader can tell what question the number answers.
fn cm_floor_value(floor: &CmFloor) -> Value {
    json!({
        "eur": round2(floor.min_pkn / 200.0),
        "grossPkn": floor.min_pkn,
        "pkn": floor.min_pkn,
        "offers": floor.offers,
        "countsComplete": floor.counts_complete,
        "condition": floor.condition,
        "language": floor.language,
        "finish": floor.finish,
        "firstEdition": floor.first_edition,
    })
}

/// The cheapest of a set of facets, by PKN.
fn lowest_floor<'a>(rows: impl IntoIterator<Item = &'a CmFloor>) -> Option<&'a CmFloor> {
    rows.into_iter().min_by(|a, b| a.min_pkn.total_cmp(&b.min_pkn))
}

/// Does a captured facet answer `m`'s question about this item? A toggle that
/// is off asks nothing, so a `*` facet answers it; a toggle that is on needs a
/// facet filtered the same way. An item that names no condition or language
/// cannot be contradicted by either.
fn floor_matches(floor: &CmFloor, item: &PriceItem, game: &str, m: Match) -> bool {
    let condition = (!item.condition.is_empty()).then_some(item.condition.as_str());
    let language = (!item.language.is_empty()).then_some(item.language.as_str());
    (!m.condition || facet_agrees(&floor.condition, condition))
        && (!m.language || facet_agrees(&floor.language, language))
        && (!m.finish || flag_agrees(&floor.finish, item_finish(item, game)))
        && (!m.first_edition || flag_agrees(&floor.first_edition, item.first_edition))
}

/// One seller type's map: every `Match` key, each the cheapest fresh facet
/// that answers it. A graded, signed or altered copy is no scanned facet's
/// copy, so like the other sources it gets only `""`.
fn cm_floor_map(floors: &[&CmFloor], item: &PriceItem, game: &str, seller: &str) -> Map<String, Value> {
    let of_seller: Vec<&CmFloor> = floors.iter().copied().filter(|floor| floor.seller_type == seller).collect();
    let mut map = Map::new();
    for m in Match::all() {
        if m != Match::ANY && item.one_of_a_kind() {
            continue;
        }
        let answering = of_seller
            .iter()
            .copied()
            .filter(|floor| m == Match::ANY || floor_matches(floor, item, game, m));
        let Some(best) = lowest_floor(answering) else { continue };
        map.insert(m.key(), cm_floor_value(best));
    }
    map
}

/// The `sources.cardmarketoffers` value of one item, or `None` (status
/// `empty`): nothing fresh was scanned for this card's products. `pro` and
/// `private` are the two seller types Cardmarket separates, each holding every
/// `Match` key: `""` is the cheapest facet scanned at all, `"CLFE"` the
/// cheapest facet agreeing with the item on all four attributes. Every value
/// carries the facet it came from, so a mixed `*` scan is never mistaken for
/// an exact one.
pub fn cm_offers_source(groups: &CmFloorGroups, blueprint_id: Option<i64>, item: &PriceItem, game: &str) -> Option<Value> {
    let products = groups.products_by_blueprint.get(&blueprint_id?)?;
    let floors: Vec<&CmFloor> = products
        .iter()
        .filter_map(|product| groups.minimums_by_product.get(product))
        .flatten()
        .filter(|floor| floor.min_pkn > 0.0)
        .collect();
    if floors.is_empty() {
        return None;
    }
    let mut out = Map::new();
    out.insert(
        "asOf".into(),
        json!(floors.iter().map(|floor| floor.day.as_str()).max().unwrap_or("")),
    );
    for seller in ["pro", "private"] {
        let map = cm_floor_map(&floors, item, game, seller);
        if !map.is_empty() {
            out.insert(seller.into(), Value::Object(map));
        }
    }
    if out.len() <= 1 {
        return None; // only asOf: no facet had a price
    }
    Some(Value::Object(out))
}

// ----------------------------------------------------------------- TCGplayer

/// The newest EUR→USD reference rate, fresh only within 10 days. Runs in the
/// `"pokemon"` pool.
pub const FX_SQL: &str = "select day::text as day, rate::float8 as rate from public.fx_rates_daily \
     where base = 'EUR' and quote = 'USD' and day >= current_date - 10 order by day desc limit 1";

/// The newest EUR→`$1` reference rate for the pricer's display currency
/// (`pricerSettings.currency`), fresh only within 10 days. `"pokemon"` pool.
pub const CURRENCY_RATE_SQL: &str = "select day::text as day, rate::float8 as rate from public.fx_rates_daily \
     where base = 'EUR' and quote = $1 and day >= current_date - 10 order by day desc limit 1";

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
    /// What Cardmarket sellers asked, per facet and seller type, as the
    /// CTCMDeals scans saw it. `None` when that query could not answer.
    pub cm_floors: Option<CmFloorGroups>,
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
            cm_floors: None,
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

    // Cardmarket's scanned offers: what the last walk of the listing page saw
    // professional and private sellers ask. Independent of the guide, which
    // cannot say who is selling.
    let floor_status = match &src.cm_floors {
        None => "unavailable",
        Some(groups) => match cm_offers_source(groups, blueprint_id, item, game) {
            Some(value) => {
                sources.insert("cardmarketoffers".into(), value);
                "available"
            }
            None => "empty",
        },
    };
    status.insert("cardmarketoffers".into(), json!(floor_status));

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
            json!({ "cardtraderSold": "unavailable", "pokoinSold": "unavailable", "cardmarket": "unavailable", "cardmarketoffers": "unavailable", "tcgplayer": "unconfigured" })
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
            cm_floors: None,
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
            json!({ "cardtraderSold": "available", "pokoinSold": "available", "cardmarket": "available", "cardmarketoffers": "unavailable", "tcgplayer": "available" })
        );
    }

    // The scanned Cardmarket offers: the cheapest professional and private
    // offer per facet, as a CTCMDeals walk of the listing pages left it.
    // The fixtures are Dialga (Call of Legends CL3, Cardmarket idProduct
    // 279646) from the live 2026-11-10 scan: the `*` facets are what the run
    // recorded, and the `N`/`Y` ones are the same page's 14 captured offers
    // regrouped (€20.00 mirmex regular, €5.88 JeffPesos-GTCorciano reverse).
    fn floor(condition: &str, language: &str, finish: &str, first_edition: &str, cents: i64) -> CmFloor {
        CmFloor {
            seller_type: "pro".into(),
            condition: condition.into(),
            language: language.into(),
            finish: finish.into(),
            first_edition: first_edition.into(),
            min_pkn: cents as f64 * 2.0,
            offers: 1,
            counts_complete: Some(true),
            day: "2026-11-10".into(),
        }
    }

    fn private_floor(condition: &str, language: &str, finish: &str, first_edition: &str, cents: i64) -> CmFloor {
        CmFloor { seller_type: "private".into(), ..floor(condition, language, finish, first_edition, cents) }
    }

    /// Blueprint 100 = the card, product 279646 = its Cardmarket page.
    fn dialga(floors: Vec<CmFloor>) -> CmFloorGroups {
        CmFloorGroups {
            products_by_blueprint: HashMap::from([(100, vec![279646])]),
            minimums_by_product: HashMap::from([(279646, floors)]),
        }
    }

    fn seller_map(groups: &CmFloorGroups, key: &str, game: &str, seller: &str) -> Value {
        let value = cm_offers_source(groups, Some(100), &parse_items(key)[0], game)
            .unwrap_or_else(|| panic!("{key}: no scanned offer at all"));
        value[seller].clone()
    }

    fn pro(groups: &CmFloorGroups, key: &str, game: &str) -> Value {
        seller_map(groups, key, game, "pro")
    }

    fn private_offers(groups: &CmFloorGroups, key: &str, game: &str) -> Value {
        seller_map(groups, key, game, "private")
    }

    #[test]
    fn a_scanned_facet_prices_the_copy_it_was_filtered_at() {
        let groups = dialga(vec![
            floor("NM", "IT", "N", "N", 2000),
            floor("NM", "IT", "*", "*", 2000),
            floor("SP", "IT", "*", "*", 588),
        ]);
        let value = cm_offers_source(&groups, Some(100), &parse_items("200:NM:IT")[0], "pokemon").unwrap();
        assert_eq!(value["asOf"], json!("2026-11-10"));
        let map = value["pro"].as_object().unwrap();
        assert_eq!(map["CLFE"]["eur"], json!(20.0), "the exact copy");
        assert_eq!(map["CLFE"]["grossPkn"], json!(4000.0), "2 PKN per cent");
        assert_eq!(map["CLFE"]["finish"], json!("N"), "the facet the answer was filtered at is stated");
        assert_eq!(map[""]["eur"], json!(5.88), "any copy: the cheapest facet scanned at all");
        assert_eq!(map[""]["condition"], json!("SP"));
        assert_eq!(map["C"]["eur"], json!(20.0), "condition only: a mixed finish still answers");
    }

    #[test]
    fn a_condition_facet_is_the_worst_grade_accepted_not_the_grade_itself() {
        // The SP facet was Cardmarket's `minCondition=3` page: SP-or-better,
        // so it answers an SP item and is not an answer for an NM one.
        let groups = dialga(vec![floor("SP", "IT", "N", "N", 588), floor("NM", "IT", "N", "N", 2000)]);
        assert_eq!(pro(&groups, "200:SP:IT", "pokemon")["CLFE"]["eur"], json!(5.88));
        assert_eq!(pro(&groups, "200:NM:IT", "pokemon")["CLFE"]["eur"], json!(20.0));
        let poor = pro(&groups, "200:Poor:IT", "pokemon");
        assert!(poor.get("CLFE").is_none(), "no facet was scanned at Poor; the SP one is not an answer to it");
        assert!(poor.get("C").is_none());
        assert_eq!(poor[""]["eur"], json!(5.88), "any copy still takes the cheapest scanned");
    }

    #[test]
    fn a_reverse_holo_floor_never_answers_a_plain_copy_or_the_other_way_round() {
        let groups = dialga(vec![floor("NM", "IT", "N", "N", 2000), floor("NM", "IT", "Y", "N", 2400)]);
        assert_eq!(pro(&groups, "200:NM:IT", "pokemon")["CLFE"]["eur"], json!(20.0));
        assert_eq!(pro(&groups, "200:NM:IT:R", "pokemon")["CLFE"]["eur"], json!(24.0));
        // A scan that did not filter finish mixed both copies: it answers
        // condition and language, but neither finish exactly.
        let mixed = dialga(vec![floor("NM", "IT", "*", "N", 2000)]);
        for key in ["200:NM:IT", "200:NM:IT:R"] {
            let value = pro(&mixed, key, "pokemon");
            assert!(value.get("CLFE").is_none(), "{key}: a mixed finish is not an exact comp");
            assert!(value.get("F").is_none(), "{key}");
            assert_eq!(value["CL"]["eur"], json!(20.0), "{key}: the toggles that are off ask nothing");
            assert_eq!(value[""]["eur"], json!(20.0), "{key}");
        }
    }

    #[test]
    fn a_floor_in_another_language_is_another_answer() {
        let groups = dialga(vec![floor("NM", "IT", "N", "N", 2000), floor("NM", "EN", "N", "N", 1500)]);
        let value = pro(&groups, "200:NM:IT", "pokemon");
        assert_eq!(value["CLFE"]["eur"], json!(20.0));
        assert_eq!(value["CLFE"]["language"], json!("IT"));
        assert_eq!(pro(&groups, "200:NM:EN", "pokemon")["CLFE"]["eur"], json!(15.0));
        // A card only ever scanned in Italian and English gives a French
        // seller nothing exact to compare against, but still the cheapest seen.
        let value = pro(&groups, "200:NM:FR", "pokemon");
        assert!(value.get("CLFE").is_none());
        assert!(value.get("L").is_none());
        assert_eq!(value["C"]["eur"], json!(15.0), "condition only: either language answers");
        assert_eq!(value[""]["eur"], json!(15.0));
    }

    #[test]
    fn the_any_copy_key_takes_the_cheapest_facet_scanned() {
        let groups = dialga(vec![floor("NM", "IT", "N", "N", 2000), floor("SP", "EN", "Y", "N", 588)]);
        // No condition and no language asked, but the item is still a plain
        // non-first-edition copy, so the exact key cannot take the reverse.
        let value = pro(&groups, "200", "pokemon");
        assert_eq!(value[""]["eur"], json!(5.88), "any copy: any facet answers");
        assert_eq!(value["CLFE"]["eur"], json!(20.0));
    }

    #[test]
    fn the_finish_facet_of_other_games_is_foil_not_reverse_holo() {
        // A foil Magic facet answers a foil item; `item_finish` is the switch.
        let groups = dialga(vec![floor("NM", "EN", "Y", "N", 900), floor("NM", "EN", "N", "N", 300)]);
        assert_eq!(pro(&groups, "200:NM:EN:H", "magic")["CLFE"]["eur"], json!(9.0));
        assert_eq!(pro(&groups, "200:NM:EN", "magic")["CLFE"]["eur"], json!(3.0));
        // The same rows in Pokémon read the reverse flag, so `H` alone is
        // still a regular copy there.
        assert_eq!(pro(&groups, "200:NM:EN:H", "pokemon")["CLFE"]["eur"], json!(3.0));
        assert_eq!(pro(&groups, "200:NM:EN:R", "pokemon")["CLFE"]["eur"], json!(9.0));
    }

    #[test]
    fn first_edition_facets_stay_apart() {
        let groups = dialga(vec![floor("NM", "IT", "N", "Y", 3000), floor("NM", "IT", "N", "N", 2000)]);
        assert_eq!(pro(&groups, "200:NM:IT:F", "pokemon")["CLFE"]["eur"], json!(30.0));
        assert_eq!(pro(&groups, "200:NM:IT", "pokemon")["CLFE"]["eur"], json!(20.0));
        assert_eq!(pro(&groups, "200:NM:IT:F", "pokemon")["CLF"]["eur"], json!(20.0), "edition off: either answers");
    }

    #[test]
    fn professional_and_private_offers_are_separate_answers() {
        let groups = dialga(vec![
            floor("NM", "IT", "N", "N", 2000),
            private_floor("NM", "IT", "N", "N", 1200),
            private_floor("SP", "IT", "N", "N", 400),
        ]);
        assert_eq!(pro(&groups, "200:NM:IT", "pokemon")["CLFE"]["eur"], json!(20.0));
        assert_eq!(private_offers(&groups, "200:NM:IT", "pokemon")["CLFE"]["eur"], json!(12.0), "a private ask is not a pro floor");
        assert_eq!(private_offers(&groups, "200:NM:IT", "pokemon")[""]["eur"], json!(4.0));
        assert_eq!(pro(&groups, "200:NM:IT", "pokemon")[""]["eur"], json!(20.0), "the pro side never borrows a private offer");
        // Only one seller type scanned: the other is simply absent, not zero.
        let only_private = dialga(vec![private_floor("NM", "IT", "N", "N", 1200)]);
        let value = cm_offers_source(&only_private, Some(100), &parse_items("200:NM:IT")[0], "pokemon").unwrap();
        assert!(value.get("pro").is_none());
        assert_eq!(value["private"]["CLFE"]["eur"], json!(12.0));
    }

    #[test]
    fn a_graded_signed_or_altered_copy_gets_only_the_any_copy_key() {
        // The scan walks raw copies: Cardmarket's own facets of that page were
        // filtered `isSigned=N`, `isAltered=N`, and a slab is not a comp. Like
        // the other sources, such an item keeps `""` and nothing else.
        let groups = dialga(vec![floor("NM", "IT", "N", "N", 2000), private_floor("NM", "IT", "N", "N", 1200)]);
        for key in ["200:NM:IT:G", "200:NM:IT:S", "200:NM:IT:A", "200:NM:IT:RFHGSA"] {
            for seller in ["pro", "private"] {
                let value = seller_map(&groups, key, "pokemon", seller);
                assert_eq!(value.as_object().unwrap().len(), 1, "{key} {seller}");
                assert!(value.get("CLFE").is_none(), "{key} {seller}");
                assert!(value.get("").is_some(), "{key} {seller}");
            }
        }
    }

    #[test]
    fn a_card_the_scan_never_walked_has_no_offers_at_all() {
        let groups = dialga(vec![floor("NM", "IT", "N", "N", 2000)]);
        let item = parse_items("200:NM:IT")[0].clone();
        assert_eq!(cm_offers_source(&groups, None, &item, "pokemon"), None, "no Cardmarket product for the card");
        let unscanned = CmFloorGroups {
            products_by_blueprint: HashMap::from([(100, vec![424242])]),
            minimums_by_product: groups.minimums_by_product.clone(),
        };
        assert_eq!(cm_offers_source(&unscanned, Some(100), &item, "pokemon"), None, "the product was never scanned");
        assert_eq!(cm_offers_source(&CmFloorGroups::default(), Some(100), &item, "pokemon"), None);
        let no_price = dialga(vec![CmFloor { min_pkn: 0.0, ..floor("NM", "IT", "N", "N", 2000) }]);
        assert_eq!(cm_offers_source(&no_price, Some(100), &item, "pokemon"), None, "a facet with no offer is not a zero");
    }

    #[test]
    fn several_products_of_one_card_give_the_cheapest_floor_and_the_newest_scan() {
        let mut magcargo = floor("NM", "IT", "N", "N", 1000);
        magcargo.day = "2026-11-08".into();
        let groups = CmFloorGroups {
            products_by_blueprint: HashMap::from([(100, vec![279646, 279259])]),
            minimums_by_product: HashMap::from([
                (279646, vec![floor("NM", "IT", "N", "N", 2000)]),
                (279259, vec![magcargo]),
            ]),
        };
        let value = cm_offers_source(&groups, Some(100), &parse_items("200:NM:IT")[0], "pokemon").unwrap();
        assert_eq!(value["pro"]["CLFE"]["eur"], json!(10.0), "the cheapest professional copy of the card");
        assert_eq!(value["asOf"], json!("2026-11-10"), "the newest of the two scans, not the one used");
    }

    #[test]
    fn a_scan_that_stopped_short_says_so() {
        let groups = dialga(vec![CmFloor { counts_complete: Some(false), ..floor("NM", "IT", "N", "N", 2000) }]);
        assert_eq!(pro(&groups, "200:NM:IT", "pokemon")["CLFE"]["countsComplete"], json!(false));
    }

    #[test]
    fn attach_reports_the_scanned_offers_apart_from_the_guide() {
        let src = PageSources {
            game: "pokemon".into(),
            blueprint_by_card: HashMap::from([("200".to_string(), 100)]),
            ct_sold: None,
            pokoin_sales: None,
            cardmarket: CardmarketOutcome::Unavailable,
            cm_floors: Some(dialga(vec![floor("NM", "IT", "N", "N", 2000), private_floor("NM", "IT", "N", "N", 1200)])),
            tcg: TcgOutcome::Unconfigured,
        };
        let mut comp = json!({});
        attach(&mut comp, &parse_items("200:NM:IT")[0], Channel::Direct, &src);
        assert_eq!(comp["sources"]["cardmarketoffers"]["pro"]["CLFE"]["grossPkn"], json!(4000.0));
        assert_eq!(comp["sources"]["cardmarketoffers"]["private"]["CLFE"]["grossPkn"], json!(2400.0));
        assert_eq!(comp["sourceStatus"]["cardmarketoffers"], json!("available"));
        assert_eq!(comp["sources"].as_object().unwrap().len(), 1, "the guide is its own source; a stale download says nothing about a scan");
        assert_eq!(comp["sourceStatus"]["cardmarket"], json!("unavailable"));
        // No table, no rows: unavailable, and never a zero.
        let mut comp = json!({});
        let mut none = PageSources::empty("pokemon");
        none.cm_floors = None;
        attach(&mut comp, &parse_items("200:NM:IT")[0], Channel::Direct, &none);
        assert_eq!(comp["sourceStatus"]["cardmarketoffers"], json!("unavailable"));
        // A card with a blueprint but no scanned product: empty, not a zero.
        let mut comp = json!({});
        let mut unscanned = PageSources::empty("pokemon");
        unscanned.blueprint_by_card = HashMap::from([("200".to_string(), 100)]);
        unscanned.cm_floors = Some(CmFloorGroups::default());
        attach(&mut comp, &parse_items("200:NM:IT")[0], Channel::Direct, &unscanned);
        assert_eq!(comp["sourceStatus"]["cardmarketoffers"], json!("empty"));
        assert!(comp["sources"].get("cardmarketoffers").is_none());
    }
}
