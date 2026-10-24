//! The CardTrader price store: Pokoin's CardTrader reference price per listing
//! facet (game, card, language, condition, finish, first edition), refilled
//! by `pokoin-api job cardtrader-facet-prices` and read with one indexed
//! lookup per page (`scripts/sql/132_cardtrader_facet_prices.sql`,
//! docs/PRICING.md "Price store").
//!
//! - Pokémon (`basis = 'pro'`): the professional-seller floor of
//!   `price_check::pro_floor_sql` over the whole daily book, computed on the
//!   writer in one statement. A listing is priced by its own condition only.
//! - Every other game (`basis = 'zero'`): source 7 of the game's CardRails
//!   PKP3 price file, the cheapest CardTrader Zero ask per language,
//!   condition and finish. A listing is priced by its condition or a better
//!   one (`price_book::facet_cents`).
//!
//! Both rules are the ones the live price check applied before the store; the
//! store only moves the work from the request to the refill.

use std::collections::HashMap;

use serde_json::{json, Value};
use sqlx::PgPool;

use crate::db::DbPools;
use crate::error::{ApiError, ApiResult};
use crate::price_book::{self, Ask, CtAsks, LANGS};
use crate::price_check::{pick_matched_ct, PriceItem};

/// Store conditions, best first: `price_check::condition_key` values.
pub const CONDITIONS: [&str; 5] = ["NM", "SP", "MP", "PL", "Poor"];

/// A store run older than this is not used: the price check then reads the
/// live path, as when the store has never been filled.
pub const MAX_RUN_AGE_DAYS: i64 = 3;

/// A refill that would keep less than this share of a game's rows is refused
/// (a truncated price file or a broken book must not wipe the prices).
pub const MIN_KEEP_RATIO: f64 = 0.5;

/// Rows per insert into the refill's staging table.
pub const BATCH: usize = 20_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Basis {
    /// Same condition only (Pokémon professional floor).
    Pro,
    /// This condition or a better one (CardTrader Zero asks of the price file).
    Zero,
}

impl Basis {
    pub fn as_str(self) -> &'static str {
        match self {
            Basis::Pro => "pro",
            Basis::Zero => "zero",
        }
    }

    /// How the basis's offers sell on CardTrader, for the commission
    /// (`ct_fees`): the professional floor direct and Zero alike, the price
    /// file through CardTrader Zero.
    pub fn channel(self) -> crate::ct_fees::Channel {
        match self {
            Basis::Pro => crate::ct_fees::Channel::Direct,
            Basis::Zero => crate::ct_fees::Channel::Zero,
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "pro" => Some(Basis::Pro),
            "zero" => Some(Basis::Zero),
            _ => None,
        }
    }
}

/// One store row.
#[derive(Clone, Debug, PartialEq)]
pub struct FacetPrice {
    pub card_id: i64,
    pub language: String,
    pub condition: String,
    /// Pokémon reverse holo; foil of the other games.
    pub foil: bool,
    pub first_edition: bool,
    pub min_pkn: f64,
    pub offers: i64,
    pub basis: Basis,
}

/// One store row of a price file, without allocations: Magic's file has
/// about a million asks and the job runs under a 300 MB limit on the Pi.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ZeroRow {
    pub card_id: i64,
    pub language: &'static str,
    pub condition: &'static str,
    pub foil: bool,
    pub min_pkn: f64,
}

impl ZeroRow {
    pub fn to_price(self) -> FacetPrice {
        FacetPrice {
            card_id: self.card_id,
            language: self.language.to_string(),
            condition: self.condition.to_string(),
            foil: self.foil,
            first_edition: false,
            min_pkn: self.min_pkn,
            offers: 0,
            basis: Basis::Zero,
        }
    }
}

/// Store rows of one game's price file: one per source-7 ask whose variant
/// names a known language and condition, the cheapest when a facet repeats.
/// The file is sorted by card, so repeats are neighbours of the same card.
pub fn zero_rows(asks: &CtAsks) -> Vec<ZeroRow> {
    let mut rows: Vec<ZeroRow> = Vec::with_capacity(asks.len());
    for ask in asks.rows() {
        if ask.cents == 0 {
            continue;
        }
        let Some((lang, cond, foil)) = price_book::split_variant(ask.variant) else {
            continue;
        };
        let (Some(language), Some(condition)) =
            (LANGS.get(usize::from(lang) - 1), CONDITIONS.get(usize::from(cond)))
        else {
            continue;
        };
        rows.push(ZeroRow {
            card_id: i64::from(ask.card_id),
            language,
            condition,
            foil,
            min_pkn: price_book::pkn_from_cents(ask.cents),
        });
    }
    rows.sort_by(|a, b| {
        (a.card_id, a.language, a.condition, a.foil)
            .cmp(&(b.card_id, b.language, b.condition, b.foil))
            .then(a.min_pkn.total_cmp(&b.min_pkn))
    });
    // Sorted with the cheapest first inside a facet: keep the first of each.
    rows.dedup_by(|later, first| {
        (later.card_id, later.language, later.condition, later.foil)
            == (first.card_id, first.language, first.condition, first.foil)
    });
    rows
}

/// `(cheapest overall, cheapest of this listing's facets)` in PKN for one
/// card's store rows, by the rule of their basis.
pub fn comp(rows: &[FacetPrice], item: &PriceItem) -> (Option<f64>, Option<f64>) {
    let Some(first) = rows.first() else {
        return (None, None);
    };
    match first.basis {
        Basis::Pro => {
            let groups: Vec<Value> = rows
                .iter()
                .map(|row| {
                    json!({
                        "condition": row.condition,
                        "language": row.language,
                        "reverse": row.foil,
                        "firstEdition": row.first_edition,
                        "minPkn": row.min_pkn,
                        "offers": row.offers,
                    })
                })
                .collect();
            pick_matched_ct(&groups, &item.condition, &item.language, item.reverse, item.first_edition)
        }
        Basis::Zero => {
            let asks: Vec<Ask> = rows.iter().filter_map(zero_ask).collect();
            let (cheapest, matched) =
                price_book::facet_cents(&asks, &item.language, &item.condition, item.foil || item.reverse);
            (cheapest.map(price_book::pkn_from_cents), matched.map(price_book::pkn_from_cents))
        }
    }
}

/// A zero row back as the price file's ask, for `price_book::facet_cents`.
fn zero_ask(row: &FacetPrice) -> Option<Ask> {
    let lang = price_book::lang_code(&row.language)?;
    let cond = CONDITIONS.iter().position(|c| *c == row.condition)? as u8;
    let cents = (row.min_pkn / 2.0).round();
    (cents >= 1.0 && cents <= f64::from(u32::MAX)).then(|| Ask {
        card_id: u32::try_from(row.card_id).unwrap_or(0),
        variant: lang + 16 * cond + if row.foil { 128 } else { 0 },
        cents: cents as u32,
    })
}

/// The store rows of one page, by card id.
#[derive(Debug, Default)]
pub struct StoreHit {
    /// When the game's store was refilled (RFC 3339).
    pub refreshed_at: String,
    by_card: HashMap<i64, Vec<FacetPrice>>,
}

impl StoreHit {
    pub fn from_rows(refreshed_at: String, rows: Vec<FacetPrice>) -> Self {
        let mut by_card: HashMap<i64, Vec<FacetPrice>> = HashMap::new();
        for row in rows {
            by_card.entry(row.card_id).or_default().push(row);
        }
        Self { refreshed_at, by_card }
    }

    /// The basis of an item's card in the store (its game's rule).
    pub fn basis_of(&self, item: &PriceItem) -> Option<Basis> {
        let id = item.card_id.parse::<i64>().ok()?;
        self.by_card.get(&id)?.first().map(|row| row.basis)
    }

    /// `(cheapest, matched)` of one price-check item, in PKN.
    pub fn comp(&self, item: &PriceItem) -> (Option<f64>, Option<f64>) {
        let rows = item
            .card_id
            .parse::<i64>()
            .ok()
            .and_then(|id| self.by_card.get(&id))
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        comp(rows, item)
    }
}

/// A `marketplace_user_listings` row (as JSON) as a price-check item: the
/// same facets the inventory board sends (`market/src/inventory-price.js`).
pub fn item_from_listing(row: &Value) -> PriceItem {
    let text = |key: &str| match row.get(key) {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(Value::Number(value)) => value.to_string(),
        _ => String::new(),
    };
    let flag = |key: &str| row.get(key) == Some(&Value::Bool(true));
    let game = crate::db::normalize_game(&text("marketplace_game"));
    let finish = text("foil_state").to_lowercase();
    PriceItem {
        card_id: text("card_id").trim_start_matches('0').to_string(),
        condition: crate::price_check::condition_key(&text("condition")),
        language: text("language").to_uppercase(),
        reverse: flag("reverse") || finish == "reverse",
        first_edition: flag("first_edition"),
        // Pokémon's only finish facet is reverse; the other games' is foil.
        foil: game != "pokemon" && (finish == "foil" || finish == "holo"),
        graded: flag("graded"),
        signed: flag("signed"),
        altered: flag("altered"),
    }
}

/// The CardTrader reference price of a listing row in whole PKN (prices are
/// digits only, D000014): the matching ask net of CardTrader's commission
/// (`ct_fees`), or `None` without a matching offer or for a graded, signed or
/// altered copy.
pub fn listing_price(hit: &StoreHit, row: &Value, seller: Option<crate::ct_fees::Channel>) -> Option<f64> {
    let item = item_from_listing(row);
    if item.one_of_a_kind() {
        return None;
    }
    let (_, matched) = hit.comp(&item);
    // The seller's own commission when known, else the basis's.
    let channel = seller.or_else(|| hit.basis_of(&item).map(Basis::channel))?;
    matched
        .and_then(|pkn| crate::ct_fees::rule().net_pkn(pkn, channel))
        .map(|pkn| pkn.round().max(1.0))
}

/// One query: the game's last run and the store rows of these cards. A left
/// join, so a run with no row for any of them still answers.
pub const LOOKUP_SQL: &str = "
    select r.refreshed_at > now() - make_interval(days => $3::int) as fresh,
           to_char(r.refreshed_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as refreshed_at,
           p.card_id, p.language, p.condition, p.foil, p.first_edition,
           p.min_pkn::float8 as min_pkn, p.offers, p.basis
    from public.cardtrader_facet_price_runs as r
    left join public.cardtrader_facet_prices as p
      on p.game = r.game and p.card_id = any($2::bigint[])
    where r.game = $1";

/// The store rows of these cards, or `None` when the game's store cannot
/// answer (never filled, older than [`MAX_RUN_AGE_DAYS`], the table not
/// migrated yet): the caller then prices the live way.
pub async fn lookup(db: &DbPools, game: &str, card_ids: &[i64]) -> ApiResult<Option<StoreHit>> {
    let game = crate::db::normalize_game(game);
    let rows = match db
        .query("pokemon", LOOKUP_SQL, &[json!(game), json!(card_ids), json!(MAX_RUN_AGE_DAYS)])
        .await
    {
        Ok(rows) => rows,
        Err(error) if error.is_table_missing() => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(hit_from_rows(&rows))
}

/// [`lookup`]'s decoding, separate for tests.
pub fn hit_from_rows(rows: &[Value]) -> Option<StoreHit> {
    let first = rows.first()?;
    if first.get("fresh") != Some(&Value::Bool(true)) {
        return None;
    }
    let refreshed_at = first.get("refreshed_at").and_then(Value::as_str).unwrap_or("").to_string();
    let prices = rows.iter().filter_map(row_price).collect();
    Some(StoreHit::from_rows(refreshed_at, prices))
}

fn integer(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(n) => n.as_i64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn float(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
    .filter(|n: &f64| n.is_finite())
}

fn row_price(row: &Value) -> Option<FacetPrice> {
    Some(FacetPrice {
        card_id: integer(row.get("card_id"))?,
        language: row.get("language")?.as_str()?.to_string(),
        condition: row.get("condition")?.as_str()?.to_string(),
        foil: row.get("foil") == Some(&Value::Bool(true)),
        first_edition: row.get("first_edition") == Some(&Value::Bool(true)),
        min_pkn: float(row.get("min_pkn")).filter(|pkn| *pkn > 0.0)?,
        offers: integer(row.get("offers")).unwrap_or(0),
        basis: Basis::parse(row.get("basis")?.as_str()?)?,
    })
}

/// What one refill did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RefillReport {
    pub game: String,
    pub rows: i64,
    pub before: i64,
    pub written: i64,
    pub deleted: i64,
    pub dry_run: bool,
}

impl RefillReport {
    pub fn to_json(&self) -> Value {
        json!({
            "game": self.game, "rows": self.rows, "before": self.before,
            "written": self.written, "deleted": self.deleted, "dryRun": self.dry_run,
        })
    }
}

/// Would replacing `before` rows by `rows` drop too much? A first fill, or a
/// game with only a handful of rows, is always allowed.
pub fn refuse_shrink(before: i64, rows: i64) -> bool {
    before >= 1_000 && (rows as f64) < before as f64 * MIN_KEEP_RATIO
}

const STAGE_SQL: &str = "
    create temp table facet_new (
      game text not null, card_id bigint not null, language text not null, condition text not null,
      foil boolean not null, first_edition boolean not null, min_pkn numeric not null,
      offers integer not null, basis text not null
    ) on commit drop";

/// The Pokémon professional floor of the whole book, keyed by public card id.
pub fn pokemon_stage_sql() -> String {
    format!(
        "insert into facet_new (game, card_id, language, condition, foil, first_edition, min_pkn, offers, basis)
         select 'pokemon', card.card_id, floor.language_key, floor.condition_key, floor.reverse,
                floor.first_edition, floor.min_pkn, floor.offers, 'pro'
         from ({}) as floor
         join public.marketplace_search_candidates as card on card.ct_id = floor.ct_id
         where floor.condition_key in ('NM', 'SP', 'MP', 'PL', 'Poor')
           and floor.language_key is not null and floor.min_pkn > 0",
        crate::price_check::pro_floor_all_sql()
    )
}

const STAGE_INDEX_SQL: &str =
    "create index on facet_new (card_id, language, condition, foil, first_edition)";

const ZERO_STAGE_SQL: &str = "
    insert into facet_new (game, card_id, language, condition, foil, first_edition, min_pkn, offers, basis)
    select $1, card_id, language, condition, foil, false, min_pkn, 0, 'zero'
    from unnest($2::bigint[], $3::text[], $4::text[], $5::boolean[], $6::float8[])
      as row(card_id, language, condition, foil, min_pkn)";

/// Only changed rows are written: an unchanged price is no WAL for the replica.
const UPSERT_SQL: &str = "
    insert into public.cardtrader_facet_prices as price
      (game, card_id, language, condition, foil, first_edition, min_pkn, offers, basis, refreshed_at)
    select game, card_id, language, condition, foil, first_edition, min_pkn, offers, basis, now()
    from facet_new
    on conflict (game, card_id, language, condition, foil, first_edition) do update
      set min_pkn = excluded.min_pkn, offers = excluded.offers, basis = excluded.basis,
          refreshed_at = excluded.refreshed_at
      where (price.min_pkn, price.offers, price.basis)
        is distinct from (excluded.min_pkn, excluded.offers, excluded.basis)";

const DELETE_SQL: &str = "
    delete from public.cardtrader_facet_prices as price
    where price.game = $1
      and not exists (
        select 1 from facet_new as fresh
        where fresh.card_id = price.card_id and fresh.language = price.language
          and fresh.condition = price.condition and fresh.foil = price.foil
          and fresh.first_edition = price.first_edition
      )";

const RUN_SQL: &str = "
    insert into public.cardtrader_facet_price_runs (game, refreshed_at, source_at, row_count, written, deleted)
    values ($1, now(), $2, $3, $4, $5)
    on conflict (game) do update
      set refreshed_at = excluded.refreshed_at, source_at = excluded.source_at,
          row_count = excluded.row_count, written = excluded.written, deleted = excluded.deleted";

/// Refill one game in one writer transaction: stage the new rows, refuse a
/// large shrink, write the changed rows, delete the vanished ones, record the
/// run. `dry_run` rolls everything back and only reports.
async fn refill(
    writer: &PgPool,
    game: &str,
    source_at: Option<time::OffsetDateTime>,
    dry_run: bool,
    stage: impl for<'c> FnOnce(&'c mut sqlx::PgConnection) -> futures_util::future::BoxFuture<'c, ApiResult<()>>,
) -> ApiResult<RefillReport> {
    let mut tx = writer.begin().await?;
    sqlx::query("set local statement_timeout = '600s'").execute(&mut *tx).await?;
    sqlx::query(STAGE_SQL).execute(&mut *tx).await?;
    stage(&mut *tx).await?;
    // The vanished-row delete probes facet_new once per stored row: with no
    // index, a first fill (the store's statistics still say empty) planned it
    // as a nested loop, 320k x 320k rows for Pokémon.
    sqlx::query(STAGE_INDEX_SQL).execute(&mut *tx).await?;
    sqlx::query("analyze facet_new").execute(&mut *tx).await?;
    let rows: i64 = sqlx::query_scalar("select count(*) from facet_new").fetch_one(&mut *tx).await?;
    let before: i64 = sqlx::query_scalar("select count(*) from public.cardtrader_facet_prices where game = $1")
        .bind(game)
        .fetch_one(&mut *tx)
        .await?;
    if refuse_shrink(before, rows) {
        return Err(ApiError::new(
            409,
            format!("{game}: the refill has {rows} rows against {before} stored; refusing to drop more than half"),
        ));
    }
    let written = sqlx::query(UPSERT_SQL).execute(&mut *tx).await?.rows_affected() as i64;
    let deleted = sqlx::query(DELETE_SQL).bind(game).execute(&mut *tx).await?.rows_affected() as i64;
    sqlx::query(RUN_SQL)
        .bind(game)
        .bind(source_at)
        .bind(rows.min(i64::from(i32::MAX)) as i32)
        .bind(written.min(i64::from(i32::MAX)) as i32)
        .bind(deleted.min(i64::from(i32::MAX)) as i32)
        .execute(&mut *tx)
        .await?;
    if dry_run {
        tx.rollback().await?;
    } else {
        tx.commit().await?;
    }
    Ok(RefillReport { game: game.to_string(), rows, before, written, deleted, dry_run })
}

/// Pokémon: the professional floor of the current book, computed on the writer.
pub async fn refill_pokemon(writer: &PgPool, dry_run: bool) -> ApiResult<RefillReport> {
    let sql = pokemon_stage_sql();
    refill(writer, "pokemon", None, dry_run, move |conn| {
        Box::pin(async move {
            sqlx::query(&sql).execute(conn).await?;
            Ok(())
        })
    })
    .await
}

/// A game other than Pokémon: the source-7 rows of its price file.
pub async fn refill_zero(writer: &PgPool, game: &str, asks: &CtAsks, dry_run: bool) -> ApiResult<RefillReport> {
    let rows = zero_rows(asks);
    let source_at = i64::try_from(asks.generated_at)
        .ok()
        .filter(|seconds| *seconds > 0)
        .and_then(|seconds| time::OffsetDateTime::from_unix_timestamp(seconds).ok());
    let game_name = game.to_string();
    refill(writer, game, source_at, dry_run, move |conn| {
        Box::pin(async move {
            for chunk in rows.chunks(BATCH) {
                sqlx::query(ZERO_STAGE_SQL)
                    .bind(&game_name)
                    .bind(chunk.iter().map(|row| row.card_id).collect::<Vec<i64>>())
                    .bind(chunk.iter().map(|row| row.language).collect::<Vec<&str>>())
                    .bind(chunk.iter().map(|row| row.condition).collect::<Vec<&str>>())
                    .bind(chunk.iter().map(|row| row.foil).collect::<Vec<bool>>())
                    .bind(chunk.iter().map(|row| row.min_pkn).collect::<Vec<f64>>())
                    .execute(&mut *conn)
                    .await?;
            }
            Ok(())
        })
    })
    .await
}

/// The games a refill covers: Pokémon and every CardTrader game the API knows.
pub fn games() -> Vec<&'static str> {
    std::iter::once("pokemon").chain(crate::db::INGEST_GAMES.iter().map(|(id, _, _)| *id)).collect()
}

/// Is this download error a game without a price file (nothing to refill)?
pub fn missing_file(error: &str) -> bool {
    error.contains("HTTP 404")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::price_check::parse_items;

    fn price_file(rows: &[(u32, u8, u8, u32)]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(price_book::MAGIC);
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&22u16.to_le_bytes());
        bytes.extend_from_slice(&1_760_000_000u64.to_le_bytes());
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

    fn variant(lang: u8, cond: u8, foil: bool) -> u8 {
        lang + 16 * cond + if foil { 128 } else { 0 }
    }

    /// The store must price exactly like the live paths it replaces.
    #[test]
    fn zero_store_prices_like_the_price_file() {
        // Riftbound 801106 Punching Poro: EN NM 1.20, EN SP 0.90, EN NM foil
        // 6.00, FR NM 0.50; card 801108: EN MP 0.30 only.
        let bytes = price_file(&[
            (801106, 7, variant(1, 0, false), 120),
            (801106, 7, variant(1, 1, false), 90),
            (801106, 7, variant(1, 0, true), 600),
            (801106, 7, variant(3, 0, false), 50),
            (801106, 3, variant(1, 0, false), 999), // sold median: not an ask
            (801108, 7, variant(1, 2, false), 30),
        ]);
        let asks = CtAsks::parse(&bytes).unwrap();
        assert_eq!(asks.generated_at, 1_760_000_000);
        let rows = zero_rows(&asks);
        assert_eq!(rows.len(), 5);
        let rows: Vec<FacetPrice> = rows.into_iter().map(ZeroRow::to_price).collect();
        assert!(rows.iter().all(|row| row.basis == Basis::Zero && !row.first_edition));
        let hit = StoreHit::from_rows("2026-10-20T00:00:00Z".into(), rows);
        for raw in [
            "801106:NM:EN", "801106:SP:EN", "801106:MP:EN", "801106:Poor:EN", "801106:NM:EN:H",
            "801106:NM:FR", "801106:NM:IT", "801106:NM:EN:G", "801108:NM:EN", "801108:MP:EN",
            "801108:PL:EN", "801110:NM:EN",
        ] {
            let item = &parse_items(raw)[0];
            let live = crate::price_check::game_comp(item, Some(&asks), None);
            let (cheapest, matched) = hit.comp(item);
            let matched = matched.filter(|_| !item.one_of_a_kind());
            assert_eq!(json!(matched), live["ctMatchedGrossPkn"], "matched {raw}");
            assert_eq!(json!(cheapest), live["ctCheapestGrossPkn"], "cheapest {raw}");
            // And the store comp the price check returns nets the same.
            let stored = crate::price_check::store_game_comp(item, &hit, None);
            assert_eq!(stored["ctMatchedPkn"], live["ctMatchedPkn"], "net {raw}");
        }
        assert_eq!(hit.comp(&parse_items("801106:NM:EN")[0]).1, Some(240.0));
        assert_eq!(hit.comp(&parse_items("801108:PL:EN")[0]).1, Some(60.0));
        assert_eq!(hit.comp(&parse_items("801108:NM:EN")[0]).1, None, "a worse copy never prices a better one");
    }

    #[test]
    fn pro_store_prices_like_the_pro_floor() {
        let groups = [
            ("NM", "EN", false, false, 64.0),
            ("NM", "EN", true, false, 590.0),
            ("SP", "EN", false, false, 40.0),
            ("NM", "IT", false, true, 300.0),
        ];
        let rows: Vec<FacetPrice> = groups
            .iter()
            .map(|(condition, language, reverse, first, pkn)| FacetPrice {
                card_id: 128540,
                language: language.to_string(),
                condition: condition.to_string(),
                foil: *reverse,
                first_edition: *first,
                min_pkn: *pkn,
                offers: 2,
                basis: Basis::Pro,
            })
            .collect();
        let as_groups: Vec<Value> = groups
            .iter()
            .map(|(condition, language, reverse, first, pkn)| {
                json!({"condition": condition, "language": language, "reverse": reverse, "firstEdition": first, "minPkn": pkn})
            })
            .collect();
        let hit = StoreHit::from_rows(String::new(), rows);
        for raw in ["128540:NM:EN", "128540:NM:EN:R", "128540:SP:EN", "128540:MP:EN", "128540:NM:IT", "128540:NM:IT:F", "128540::"] {
            let item = &parse_items(raw)[0];
            assert_eq!(
                hit.comp(item),
                pick_matched_ct(&as_groups, &item.condition, &item.language, item.reverse, item.first_edition),
                "{raw}"
            );
        }
        // Pro is exact: an SP offer never prices an MP listing, the plain copy never a reverse.
        assert_eq!(hit.comp(&parse_items("128540:MP:EN")[0]).1, None);
        assert_eq!(hit.comp(&parse_items("128540:NM:EN:R")[0]).1, Some(590.0));
        assert_eq!(hit.comp(&parse_items("999:NM:EN")[0]), (None, None));
    }

    #[test]
    fn lookup_rows_decode_and_gate_on_a_fresh_run() {
        let rows = vec![
            json!({"fresh": true, "refreshed_at": "2026-10-20T03:00:00Z", "card_id": "801106", "language": "EN",
                   "condition": "NM", "foil": false, "first_edition": false, "min_pkn": "240", "offers": 0, "basis": "zero"}),
            json!({"fresh": true, "refreshed_at": "2026-10-20T03:00:00Z", "card_id": null, "language": null,
                   "condition": null, "foil": null, "first_edition": null, "min_pkn": null, "offers": null, "basis": null}),
        ];
        let hit = hit_from_rows(&rows).unwrap();
        assert_eq!(hit.refreshed_at, "2026-10-20T03:00:00Z");
        assert_eq!(hit.comp(&parse_items("801106:NM:EN")[0]).1, Some(240.0));
        // A run with none of the cards still answers: no CardTrader price.
        let empty = hit_from_rows(&rows[1..]).unwrap();
        assert_eq!(empty.comp(&parse_items("801106:NM:EN")[0]), (None, None));
        // No run, or a stale one: the caller prices the live way.
        assert!(hit_from_rows(&[]).is_none());
        let mut stale = rows[0].clone();
        stale["fresh"] = json!(false);
        assert!(hit_from_rows(&[stale]).is_none());
    }

    #[test]
    fn a_repeated_facet_keeps_its_cheapest_ask() {
        let bytes = price_file(&[
            (5, 7, variant(1, 0, false), 300),
            (5, 7, variant(1, 0, false), 200),
            (5, 7, variant(1, 0, true), 900),
            (5, 7, 0, 10),   // no language: not a facet
            (5, 7, 95, 10),  // condition 5: not a facet
            (6, 7, variant(16, 4, false), 0), // no price
        ]);
        let rows = zero_rows(&CtAsks::parse(&bytes).unwrap());
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].language, rows[0].condition, rows[0].foil, rows[0].min_pkn), ("EN", "NM", false, 400.0));
        assert_eq!((rows[1].foil, rows[1].min_pkn), (true, 1800.0));
    }

    #[test]
    fn a_listing_row_prices_by_its_own_facets() {
        let rows = vec![
            ZeroRow { card_id: 801106, language: "EN", condition: "NM", foil: false, min_pkn: 240.0 }.to_price(),
            ZeroRow { card_id: 801106, language: "EN", condition: "NM", foil: true, min_pkn: 1200.0 }.to_price(),
        ];
        let hit = StoreHit::from_rows(String::new(), rows);
        let listing = json!({"card_id": "801106", "condition": "NM", "language": "EN", "foil_state": "standard",
                             "reverse": false, "first_edition": false, "graded": false, "signed": false,
                             "altered": false, "marketplace_game": "riftbound"});
        // 240 PKN Zero ask nets 219.5 PKN after 7 % + VAT: 220 PKN.
        assert_eq!(listing_price(&hit, &listing, None), Some(220.0));
        let mut foil = listing.clone();
        foil["foil_state"] = json!("foil");
        // 1200 PKN: €6.00 less 42 c × 1.22 = €5.4876 → 1098 PKN.
        assert_eq!(listing_price(&hit, &foil, None), Some(1098.0));
        let mut lp = listing.clone();
        lp["condition"] = json!("LP");
        assert_eq!(listing_price(&hit, &lp, None), Some(220.0), "NM prices LP (SP) under the zero rule");
        let mut signed = listing.clone();
        signed["signed"] = json!(true);
        assert_eq!(listing_price(&hit, &signed, None), None);
        let mut italian = listing;
        italian["language"] = json!("IT");
        assert_eq!(listing_price(&hit, &italian, None), None);
    }

    #[test]
    fn a_refill_never_wipes_a_game() {
        assert!(!refuse_shrink(0, 0), "first fill");
        assert!(!refuse_shrink(500, 0), "tiny games may empty");
        assert!(!refuse_shrink(10_000, 6_000));
        assert!(refuse_shrink(10_000, 4_000));
        assert!(refuse_shrink(320_000, 0));
    }

    #[test]
    fn refill_sql_writes_only_changes_and_covers_every_game() {
        assert!(UPSERT_SQL.contains("is distinct from"));
        assert!(DELETE_SQL.contains("not exists"));
        assert!(STAGE_INDEX_SQL.contains("(card_id, language, condition, foil, first_edition)"), "the delete probes by the full key");
        let sql = pokemon_stage_sql();
        assert!(sql.contains("seller_type = 'pro'"));
        assert!(sql.contains("card.ct_id = floor.ct_id"));
        assert!(!sql.contains("$1"), "the Pokémon refill has no parameters");
        let games = games();
        assert_eq!(games[0], "pokemon");
        assert!(games.contains(&"riftbound") && games.contains(&"magic"));
        assert!(missing_file("https://x/v1/prices/the_spoils: HTTP 404"));
    }
}
