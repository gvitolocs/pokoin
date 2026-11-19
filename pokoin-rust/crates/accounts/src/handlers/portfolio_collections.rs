//! `GET|POST /api/marketplace-portfolio-collections` — the seller's own named card
//! lists, and the value series of each one.
//!
//! The lists are stored in Firestore and the maths happens in
//! [`crate::domain::portfolio_collections`]; this module is the HTTP hop, the
//! catalog resolution that turns a stored `card_id` into a priceable blueprint,
//! and the one sold price book every list is valued out of.
//!
//! A card's blueprint is resolved **here**, never taken from the client: the price
//! of a slice is found by blueprint alone, so a caller that named one could price
//! its graph from a card it does not hold. A Pokémon card is resolved by the Pokémon
//! catalog; every other game by its *own* database, through the same
//! [`price_other_games`] the main series uses, with its caps and its timeouts.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use serde_json::Value as Json;

use crate::domain::portfolio_collections::{
    answer_body, apply_save, collection_days, delete_body_id, delete_collection, last_day,
    list_collections, set_blueprint, Book, Collection, Rows, Save,
};
use crate::domain::portfolio_history::{sold_price_book, utc_day_key_ms, SOLD_BY_BLUEPRINT_SQL};
use crate::domain::portfolio_segments::{game_of, POKEMON};
use crate::error::ApiError;
use crate::sql::{row_text, SqlParam};
use crate::state::DomainState;

use super::portfolio::{numeric_id, price_other_games, BoxFuture};
use super::{json_cached, method_not_allowed, parse_body, require_claims};

/// `ApiError` is wide, so the refusals of this route travel boxed, as
/// [`crate::domain::portfolio_collections`]'s do, and [`collections_error`] answers
/// from the unboxed error.
type Result<T> = std::result::Result<T, Box<ApiError>>;

/// The CardTrader blueprint of each Pokémon public card id — the one table that
/// says which printing a `card_id` is, and the reason a client's card id is never
/// trusted as a blueprint. `marketplace_card_versions.card_id` is unique, so a card
/// answers at most one row, and a card the catalog does not know answers none.
pub const POKEMON_BLUEPRINTS_SQL: &str = "\
  select card_id::text as card_id, coalesce(blueprint_id::text, '') as blueprint_id \
  from public.marketplace_card_versions \
  where card_id = any($1::bigint[])";

/// How long both Pokémon reads of one request may take **together** — the catalog that
/// names each printing and the sold book that prices it. The other games are bounded by
/// their own window inside [`price_other_games`] and are asked *beside* these two, never
/// between them, so the whole market read of a request costs at most these eight seconds
/// plus a Firestore round trip, whatever any card server is doing. A read that runs out
/// leaves its cards held and unpriced and the answer saying so, never a request that
/// waits forever.
const POKEMON_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// A `?action=` that is not one of the two writes, or a write attempted with the
/// wrong method: the contract has no third verb.
fn unknown_action_error() -> Box<ApiError> {
    Box::new(
        ApiError::bad_request(
            "Collections are written by POST with ?action=save or ?action=delete.",
        )
        .with_code("unknown_action"),
    )
}

/// The body of a write, read strictly. [`super::parse_body`] is the lenient
/// `req.body || {}` of the Node handlers, which turns a body that cannot be read into
/// an empty one — so `{"name":` answered `collection_name_required` and a delete
/// answered 404, both claiming to have understood a request that said nothing. The
/// rest of this API refuses that input with the runtime's own words before a route
/// ever runs, and a path that is not body-validated refuses it here.
///
/// An absent body — blank bytes, or the whitespace the runtime trims to nothing — is
/// not malformed input: it is the empty object, which each write refuses for what it
/// then is, a save with no name and a delete that names no list.
fn write_body(body: &Bytes) -> Result<Json> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(parse_body(body));
    }
    let parsed: Json = serde_json::from_slice(body).map_err(|_| Box::new(invalid_body_error()))?;
    if !parsed.is_object() {
        return Err(Box::new(invalid_body_error()));
    }
    Ok(parsed)
}

/// The 400 every other hop of this API answers an unreadable body with, in the same
/// body: no `code`, because the request died before this route had an opinion about
/// collections.
fn invalid_body_error() -> ApiError {
    ApiError::bad_request("Invalid JSON request body.")
}

/// The identity a list belongs to. A verified token without a `uid` addresses no
/// seller, and storing a list under the empty string would hand it to the next such
/// token to find.
fn owner_uid(uid: &str) -> Result<&str> {
    if uid.is_empty() {
        return Err(Box::new(ApiError::unauthorized("Your account has no id.")));
    }
    Ok(uid)
}

/// `card_id → blueprint_id` as the Pokémon catalog answered [`POKEMON_BLUEPRINTS_SQL`].
fn pokemon_blueprints(found: &[Json]) -> HashMap<String, String> {
    found
        .iter()
        .map(|row| (row_text(row, "card_id"), row_text(row, "blueprint_id")))
        .collect()
}

/// Write each Pokémon row's resolved blueprint onto it. A card the catalog does not
/// know — or a lookup that failed, which leaves an empty map — keeps an empty
/// blueprint, and a row with no blueprint is held and unpriced rather than priced
/// off another card's sales.
///
/// Only Pokémon rows are touched: a card of another game keeps the empty blueprint
/// it was built with until its own database confirms one, so it can never borrow a
/// Pokémon price through a colliding public id.
fn apply_pokemon_blueprints(rows: &mut [Json], by_card: &HashMap<String, String>) {
    for row in rows.iter_mut() {
        if game_of(row) != POKEMON {
            continue;
        }
        let blueprint = by_card
            .get(&row_text(row, "card_id"))
            .map(String::as_str)
            .unwrap_or("");
        set_blueprint(row, blueprint);
    }
}

/// The public card ids to ask the Pokémon catalog about: one pass for every row of
/// that game, whether or not several collections hold the same card.
fn pokemon_card_ids(rows: &[Json]) -> Vec<i64> {
    rows.iter()
        .filter(|row| game_of(row) == POKEMON)
        .filter_map(|row| numeric_id(&row_text(row, "card_id")))
        .collect::<BTreeSet<i64>>()
        .into_iter()
        .collect()
}

/// The market this route prices from: the two Pokémon reads, and beside them every
/// other game's own database.
///
/// The seam exists for the same reason [`super::portfolio::GamePriceSource`] does —
/// see [`price_other_games`] — but it buys something here that no socket could:
/// whether one game's slowness spends the Pokémon window is a fact about *this*
/// schedule, and a test that waits on real seconds cannot tell it apart from a loaded
/// machine. The market of a test spends virtual seconds on a paused clock and the
/// window is measured exactly.
pub(crate) trait Market: Send + Sync {
    /// Is there a marketplace database to price Pokémon from at all? A deployment
    /// without one has no price read to attempt, which the answer reports as
    /// [`SERIES_ERROR`] rather than as a graph of nothing.
    fn is_configured(&self) -> bool;

    /// `card_id → blueprint_id` for these Pokémon public ids.
    fn pokemon_blueprints(
        &self,
        card_ids: Vec<i64>,
    ) -> BoxFuture<'_, std::result::Result<HashMap<String, String>, String>>;

    /// The sold rows of these Pokémon blueprints.
    fn pokemon_sold(
        &self,
        blueprints: Vec<i64>,
    ) -> BoxFuture<'_, std::result::Result<Vec<Json>, String>>;

    /// Every game but Pokémon, out of its own database: its catalog corrects its
    /// rows' blueprints in place and its sold medians are added to `sold`. There is
    /// no error to report — a game that did not answer leaves its cards held and
    /// unpriced, which is what [`price_other_games`] already does for the main
    /// series, on its own window.
    fn other_games<'a>(
        &'a self,
        rows: &'a mut Vec<Json>,
        sold: &'a mut Vec<Json>,
    ) -> BoxFuture<'a, ()>;
}

/// The real market: the marketplace pool of this state for Pokémon, the per-game
/// pools for the rest.
struct DatabaseMarket<'a> {
    state: &'a DomainState,
}

impl DatabaseMarket<'_> {
    /// The pool, or the reason this deployment has none, as the market's own error.
    fn pool(&self) -> std::result::Result<crate::sql::MarketplaceDb, String> {
        self.state
            .marketplace_db()
            .map_err(|error| error.message().to_string())
    }
}

impl Market for DatabaseMarket<'_> {
    fn is_configured(&self) -> bool {
        self.state.marketplace_db().is_ok()
    }

    fn pokemon_blueprints(
        &self,
        card_ids: Vec<i64>,
    ) -> BoxFuture<'_, std::result::Result<HashMap<String, String>, String>> {
        Box::pin(async move {
            let found = self
                .pool()?
                .query_json(POKEMON_BLUEPRINTS_SQL, &[SqlParam::IntArray(card_ids)])
                .await
                .map_err(|error| error.to_string())?;
            Ok(pokemon_blueprints(&found))
        })
    }

    fn pokemon_sold(
        &self,
        blueprints: Vec<i64>,
    ) -> BoxFuture<'_, std::result::Result<Vec<Json>, String>> {
        Box::pin(async move {
            self.pool()?
                .query_json(SOLD_BY_BLUEPRINT_SQL, &[SqlParam::IntArray(blueprints)])
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn other_games<'a>(
        &'a self,
        rows: &'a mut Vec<Json>,
        sold: &'a mut Vec<Json>,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move { price_other_games(self.state, rows, sold).await })
    }
}

/// The sold rows of this seller's cards, and the blueprints its rows are now priced
/// by.
///
/// This is the whole market read of a request: the Pokémon catalog pass and the sold
/// book that prices it, with every other game's own database through
/// [`price_other_games`] beside both — the same three steps as the main series, run
/// against each other. [`POKEMON_READ_TIMEOUT`] bounds the two Pokémon queries
/// together and the other games share their own window, so the wait this route can
/// add to a request is eight seconds whatever the market is doing. The rows are
/// returned as they were read: dropping the outliers and keying them into a book is
/// arithmetic over everything the seller sold, and the answer does it on the blocking
/// pool with the series.
///
/// A read that fails leaves its cards **held and unpriced** rather than failing the
/// request: the lists themselves are Firestore data, and a graph that cannot price a
/// card still shows the card. What it cannot do is pretend the series it then draws
/// is the seller's worth, so a failed read is reported to the answer as well as the
/// log.
async fn read_collection_book(market: &impl Market, rows: &mut Rows) -> PriceRead {
    if rows.rows().is_empty() {
        return PriceRead::complete(Vec::new());
    }
    if !market.is_configured() {
        tracing::warn!("portfolio collections have no marketplace database to price from");
        return PriceRead::unavailable();
    }
    let deadline = tokio::time::Instant::now() + POKEMON_READ_TIMEOUT;
    let mut sold: Vec<Json> = Vec::new();

    // The two Pokémon reads back to back on one window, and the other games beside
    // them on their own. The halves share nothing to write: the sold query is asked
    // for the blueprints this window's own catalog named, and a game corrects only the
    // rows of its own game. Asked in sequence instead — or with the second Pokémon
    // read waiting on the games the way a join that finishes both does — a game that
    // spent its whole window took part of the Pokémon one with it and expired a market
    // that had answered in time.
    let ids = pokemon_card_ids(rows.rows());
    let pokemon = async {
        let by_card = match tokio::time::timeout_at(deadline, market.pokemon_blueprints(ids)).await
        {
            Ok(Ok(found)) => found,
            Ok(Err(error)) => {
                tracing::warn!(
                    %error,
                    "collection blueprints are unavailable; those cards stay unpriced"
                );
                return (HashMap::new(), Vec::new(), true);
            }
            Err(_elapsed) => {
                tracing::warn!("collection blueprints timed out; those cards stay unpriced");
                return (HashMap::new(), Vec::new(), true);
            }
        };
        // The blueprints the catalog named, not the ones the rows will carry once the
        // games have had them: a Riftbound blueprint id has no business in a Pokémon
        // sold query.
        let blueprints = by_card
            .values()
            .filter_map(|blueprint| numeric_id(blueprint))
            .collect::<BTreeSet<i64>>();
        let read = if blueprints.is_empty() {
            Ok(Ok(Vec::new()))
        } else {
            tokio::time::timeout_at(
                deadline,
                market.pokemon_sold(blueprints.into_iter().collect()),
            )
            .await
        };
        match read {
            Ok(Ok(found)) => (by_card, found, false),
            Ok(Err(error)) => {
                tracing::warn!(
                    %error,
                    "collection sold prices are unavailable; those cards stay unpriced"
                );
                (by_card, Vec::new(), true)
            }
            Err(_elapsed) => {
                tracing::warn!("collection sold prices timed out; those cards stay unpriced");
                (by_card, Vec::new(), true)
            }
        }
    };
    let ((by_card, pokemon_sold, unavailable), ()) =
        tokio::join!(pokemon, market.other_games(rows.rows_mut(), &mut sold));
    apply_pokemon_blueprints(rows.rows_mut(), &by_card);
    sold.extend(pokemon_sold);
    PriceRead { sold, unavailable }
}

/// The sold rows this answer is priced out of, and whether all of the market read
/// arrived. The rows are handed over unfiltered on purpose: the outlier filter and
/// the book are the first thing the blocking hop does with them, so a seller with
/// hundreds of sales is not the reason an I/O thread is busy.
pub struct PriceRead {
    pub sold: Vec<Json>,
    /// A read this answer needed did not happen — no market database, a query that
    /// failed, or one that ran out its window. There is then no series to draw *and*
    /// no price to show, whatever part of the market did answer: [`price_body`] is
    /// what makes that true, and the answer carries [`SERIES_ERROR`] beside the lists.
    pub unavailable: bool,
}

impl PriceRead {
    fn complete(sold: Vec<Json>) -> Self {
        Self {
            sold,
            unavailable: false,
        }
    }

    fn unavailable() -> Self {
        Self {
            sold: Vec::new(),
            unavailable: true,
        }
    }
}

/// The `seriesError` value of an answer whose price reads did not happen. The request
/// is still a 200: the seller's lists are Firestore data, and a market outage is not a
/// reason to tell them their collection is gone.
pub const SERIES_ERROR: &str = "prices_unavailable";

/// The body of an answer, from the rows the read left behind and what it brought back.
///
/// A market that did not answer prices **nothing**, not the part of it that did. The
/// other games fill their own sold rows beside a Pokémon read that failed, and a book
/// out of those would give a Riftbound card its `pricePkn` while the answer says there
/// is no series to draw: a number beside `seriesError` is a number the client is
/// simultaneously told not to trust. So the book is empty too, every item comes back
/// unpriced, and the one thing the answer is confident about is the seller's own lists.
fn price_body(
    rows: &Rows,
    sold: &[Json],
    collections: &[Collection],
    today: &str,
    unavailable: bool,
    saved: Option<&str>,
) -> Json {
    let book = if unavailable {
        Book::new()
    } else {
        sold_price_book(sold)
    };
    let days = if unavailable {
        Vec::new()
    } else {
        collection_days(rows, &book, today)
    };
    let day = last_day(&days, today);
    let mut body = answer_body(collections, rows, &book, &days, &day, saved);
    if unavailable {
        body["seriesError"] = Json::from(SERIES_ERROR);
    }
    body
}

/// Everything the answer's maths needs, shared rather than moved: the blocking task
/// and the request that handed the work over both need to read it, and a seller's sold
/// rows are the largest thing in this body — neither of them copies them.
#[derive(Clone)]
struct Priced {
    rows: Arc<Rows>,
    sold: Arc<Vec<Json>>,
    collections: Arc<Vec<Collection>>,
    saved: Arc<Option<String>>,
    today: Arc<String>,
    unavailable: bool,
}

impl Priced {
    fn body(&self) -> Json {
        price_body(
            &self.rows,
            &self.sold,
            &self.collections,
            &self.today,
            self.unavailable,
            self.saved.as_deref(),
        )
    }

    /// The same answer with no market behind it: the seller's lists, nothing priced.
    /// This is what a read that did not happen answers with, and what an answer whose
    /// own arithmetic died falls back to, because those two are the same failure as
    /// far as the seller is concerned.
    fn without_prices(&self) -> Self {
        Self {
            sold: Arc::new(Vec::new()),
            unavailable: true,
            ..self.clone()
        }
    }
}

/// `maths` on the blocking pool, and `fallback` on this thread when the task never
/// answered.
///
/// A panic there is arithmetic dying over data this request already holds, and the
/// seller's lists *are* that data: what is lost is the series, which is exactly what a
/// market that did not answer loses. So the answer is the same one — 200, the lists, no
/// series, the reason beside them — and never a 500 that would tell a seller their save
/// had failed after it had already committed. The `JoinError` is still logged as an
/// error: this is a bug in this crate, not an outage, and it has to be findable.
async fn on_blocking(
    maths: impl FnOnce() -> Json + Send + 'static,
    fallback: impl FnOnce() -> Json,
) -> Json {
    match tokio::task::spawn_blocking(maths).await {
        Ok(body) => body,
        Err(error) => {
            tracing::error!(
                %error,
                "the portfolio collections series could not be computed; the lists answer without it"
            );
            fallback()
        }
    }
}

/// The answer of every method of this route: the seller's lists, each card priced
/// as of the last day of its series, and the series of every list. The lists are the
/// ones the caller read — or, after a write, the ones its own transaction read with
/// the write applied — because a store that fails after a committed write must not
/// turn a 200 into an error.
///
/// The maths — the price book out of the sold rows, then every list against every day
/// of the window — is parked on the blocking pool: it is pure arithmetic over data
/// already in hand, and a seller with the full allowance of lists and cards would
/// otherwise hold an I/O thread through it. That hop cannot fail the request either,
/// which is why this returns a response rather than a [`Result`]: everything it needs
/// to answer is already in hand, and the only thing left to lose is the series.
async fn answer(state: &DomainState, collections: &[Collection], saved: Option<&str>) -> Response {
    let mut rows = Rows::new(collections);
    let read = read_collection_book(&DatabaseMarket { state }, &mut rows).await;
    let priced = Priced {
        rows: Arc::new(rows),
        sold: Arc::new(read.sold),
        collections: Arc::new(collections.to_vec()),
        saved: Arc::new(saved.map(str::to_string)),
        today: Arc::new(utc_day_key_ms(state.clock().now().timestamp_millis())),
        unavailable: read.unavailable,
    };
    let task = priced.clone();
    let body = on_blocking(move || task.body(), move || priced.without_prices().body()).await;
    json_cached(StatusCode::OK, body, "private, no-store")
}

async fn collections_inner(
    state: &DomainState,
    method: &Method,
    query: &HashMap<String, String>,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    let claims = require_claims(state, headers).await?;
    let uid = owner_uid(&claims.uid)?;
    let firestore = state.firestore()?;
    let action = query.get("action").map(String::as_str).unwrap_or("");
    // Only a POST writes, and only these two actions do; a read — HEAD included,
    // which axum routes to the GET handler as the history route does — carries no
    // action at all. A write answers from the state its transaction read, so the
    // list the seller just stored is in the answer without a second read of the
    // store after the commit.
    let (collections, saved) = match (method.as_str(), action) {
        ("GET" | "HEAD", "") => (list_collections(&firestore, uid).await?, None),
        ("POST", "save") => {
            let save = Save::from_body(&write_body(body)?)?;
            let (collections, id) = apply_save(
                &firestore,
                uid,
                &save,
                state.clock().now().timestamp_millis(),
            )
            .await?;
            (collections, Some(id))
        }
        ("POST", "delete") => {
            let id = delete_body_id(&write_body(body)?)?;
            (delete_collection(&firestore, uid, &id).await?, None)
        }
        _ => return Err(unknown_action_error()),
    };
    Ok(answer(state, &collections, saved.as_deref()).await)
}

/// `GET /api/marketplace-portfolio-collections` reads; `POST ?action=save` and
/// `POST ?action=delete` write. All three answer the same body.
pub async fn marketplace_portfolio_collections(
    State(state): State<DomainState>,
    method: Method,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    match collections_inner(&state, &method, &query, &headers, &body).await {
        Ok(response) => response,
        Err(error) => collections_error(*error),
    }
}

/// The `{ error, code }` body of the crate, `private, no-store` like every other
/// answer of this route: these are the seller's own lists and their worth.
fn collections_error(error: ApiError) -> Response {
    let reported = error.status();
    if reported.is_server_error() {
        tracing::error!(%error, "marketplace-portfolio-collections failed");
    }
    let status = if reported.is_client_error() || reported.is_server_error() {
        reported
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    json_cached(status, error.body(), "private, no-store")
}

/// `Allow: GET, POST` — what every other method of this path gets, `OPTIONS`
/// included, the way the history route answers its own fallback.
pub async fn portfolio_collections_other() -> Response {
    let mut response = method_not_allowed("GET, POST");
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::portfolio_collections::{collections_json, Collection, Item};
    use crate::domain::portfolio_history::holding_slices;
    use serde_json::json;

    fn item(value: Json) -> Item {
        Item::from_input(&value, 0).unwrap()
    }

    /// The rows of one collection holding a Pokémon card and a Riftbound card of
    /// the same public card id — the collision the games' catalogs are read apart.
    fn two_games_one_id_each() -> Vec<Json> {
        Rows::new(&[Collection {
            id: "a1".into(),
            name: "Vault".into(),
            items: vec![
                item(json!({ "cardId": "11" })),
                item(json!({ "cardId": "11", "game": "riftbound" })),
            ],
            created_at: String::new(),
            updated_at: String::new(),
        }])
        .rows()
        .to_vec()
    }

    #[test]
    fn a_blueprint_is_written_only_on_the_game_it_came_from() {
        let mut item_rows = two_games_one_id_each();
        let by_card = pokemon_blueprints(&[json!({ "card_id": "11", "blueprint_id": "500" })]);
        apply_pokemon_blueprints(&mut item_rows, &by_card);
        assert_eq!(item_rows[0]["blueprint_id"], json!("500"));
        assert_eq!(
            item_rows[1]["blueprint_id"],
            json!(""),
            "a Riftbound card never takes the Pokémon blueprint of its id"
        );
        assert_eq!(
            pokemon_card_ids(&item_rows),
            vec![11],
            "the catalog is asked once per card, not once per row"
        );
    }

    #[test]
    fn an_unresolved_card_is_held_under_a_key_that_prices_nothing() {
        // An empty map is what a failed or empty catalog read leaves behind. Every
        // row is still a holding — under a key no sold price can be filed for it
        // with, which is how it comes back held and unpriced rather than missing.
        let mut item_rows = two_games_one_id_each();
        apply_pokemon_blueprints(&mut item_rows, &HashMap::new());
        let keys: Vec<String> = holding_slices(&item_rows)
            .into_iter()
            .map(|holding| holding.key)
            .collect();
        assert_eq!(keys.len(), 2, "both cards are still held");
        for key in keys {
            assert!(
                key.starts_with("unpriced|"),
                "a card with no blueprint files no price: {key}"
            );
        }
    }

    /// The resolution of point 17's weak test, run through the function the route
    /// actually calls: the catalog answered one card of this list and not the other,
    /// and the Riftbound card of a resolved public id is not in its answer at all.
    /// What the three cards then do — in the series and in the list — is the claim
    /// that used to be made by a test that wrote the blueprints out by hand.
    #[test]
    fn the_catalogs_answer_prices_the_series_and_nothing_else() {
        let collections = vec![Collection {
            id: "a1".into(),
            name: "Vault".into(),
            items: vec![
                item(json!({ "cardId": "11" })),
                item(json!({ "cardId": "12" })),
                item(json!({ "cardId": "11", "game": "riftbound" })),
            ],
            created_at: String::new(),
            updated_at: String::new(),
        }];
        let mut rows = Rows::new(&collections);
        let by_card = pokemon_blueprints(&[json!({ "card_id": "11", "blueprint_id": "500" })]);
        apply_pokemon_blueprints(rows.rows_mut(), &by_card);
        let book = sold_price_book(&[json!({
            "game": "pokemon",
            "card_id": "11",
            "blueprint_id": "500",
            "condition": "NM",
            "language": "en",
            "reverse": false,
            "first_edition": false,
            "graded": false,
            "observed_day": "2026-10-04",
            "median_pkn": 30.0,
        })]);

        let days = collection_days(&rows, &book, "2026-10-05");
        assert_eq!(
            days[0]["segments"]["collection:a1"],
            json!([30, 1, 3]),
            "the two cards no catalog named are held beside the one that prices: {days:?}"
        );

        let answered = collections_json(&collections, &rows, &book, "2026-10-05");
        let items = answered[0]["items"].as_array().cloned().unwrap_or_default();
        assert_eq!(items.len(), 3, "{answered:?}");
        assert_eq!(items[0]["pricePkn"], json!(30));
        assert_eq!(
            items[1]["pricePkn"],
            Json::Null,
            "a card the catalog does not know is unpriced, not free"
        );
        assert_eq!(
            items[2]["pricePkn"],
            Json::Null,
            "and a Riftbound card never takes the Pokémon price of its colliding id"
        );
        assert_eq!(
            pokemon_card_ids(rows.rows()),
            vec![11, 12],
            "the Pokémon catalog is asked for both of its cards and not for the third"
        );
    }

    /// A market that spends virtual time and answers what the test says, so a window
    /// is measured exactly instead of bounded from two sides. `None` is a read that
    /// fails; the durations are what each of its three parts costs.
    struct FakeMarket {
        /// Is there a marketplace database to price Pokémon from at all?
        configured: bool,
        blueprints: std::time::Duration,
        found: Option<HashMap<String, String>>,
        sold: std::time::Duration,
        sold_rows: Option<Vec<Json>>,
        /// What the other games take between them, which is the work of their own
        /// window and none of this route's.
        games: std::time::Duration,
    }

    impl Market for FakeMarket {
        fn is_configured(&self) -> bool {
            self.configured
        }

        fn pokemon_blueprints(
            &self,
            _card_ids: Vec<i64>,
        ) -> BoxFuture<'_, std::result::Result<HashMap<String, String>, String>> {
            let (spent, found) = (self.blueprints, self.found.clone());
            Box::pin(async move {
                tokio::time::sleep(spent).await;
                found.ok_or_else(|| "the catalog did not answer".to_string())
            })
        }

        fn pokemon_sold(
            &self,
            _blueprints: Vec<i64>,
        ) -> BoxFuture<'_, std::result::Result<Vec<Json>, String>> {
            let (spent, rows) = (self.sold, self.sold_rows.clone());
            Box::pin(async move {
                tokio::time::sleep(spent).await;
                rows.ok_or_else(|| "the sold book did not answer".to_string())
            })
        }

        /// Every non-Pokémon row of these rows names one blueprint of its own and
        /// brings one sale with it, which is what the real games' catalogs answer.
        fn other_games<'a>(
            &'a self,
            rows: &'a mut Vec<Json>,
            sold: &'a mut Vec<Json>,
        ) -> BoxFuture<'a, ()> {
            let spent = self.games;
            Box::pin(async move {
                tokio::time::sleep(spent).await;
                for row in rows.iter_mut() {
                    if game_of(row) != POKEMON {
                        set_blueprint(row, "1777");
                    }
                }
                sold.push(json!({
                    "game": "riftbound",
                    "blueprint_id": "1777",
                    "condition": "NM",
                    "language": "en",
                    "reverse": false,
                    "first_edition": false,
                    "graded": false,
                    "observed_day": "2026-10-04",
                    "median_pkn": 40.0,
                }));
            })
        }
    }

    /// One list holding a Pokémon card and a Riftbound card of the same public id.
    fn a_pokemon_and_a_riftbound() -> Vec<Collection> {
        vec![Collection {
            id: "a1".into(),
            name: "Vault".into(),
            items: vec![
                item(json!({ "cardId": "11" })),
                item(json!({ "cardId": "11", "game": "riftbound" })),
            ],
            created_at: String::new(),
            updated_at: String::new(),
        }]
    }

    /// The catalog that says card 11 is blueprint 500.
    fn catalog_naming_11() -> Option<HashMap<String, String>> {
        Some(
            [("11".to_string(), "500".to_string())]
                .into_iter()
                .collect(),
        )
    }

    /// One sold print of a blueprint, in the shape of the sold query's answer.
    fn sold_row(blueprint: &str, median: f64) -> Json {
        json!({
            "game": "pokemon", "card_id": "11", "blueprint_id": blueprint,
            "condition": "NM", "language": "en", "reverse": false,
            "first_edition": false, "graded": false,
            "observed_day": "2026-10-04", "median_pkn": median,
        })
    }

    #[tokio::test(start_paused = true)]
    async fn a_game_that_spends_its_window_leaves_the_pokemon_window_whole() {
        // The scheduling finding, tested rather than argued. Asked *between* the two
        // Pokémon reads, a game that used all four of its seconds spent four of the
        // Pokémon eight as well, and a market that answered both its queries in three
        // seconds each was reported as one that had failed. Asked beside them it
        // costs the Pokémon reads nothing they had not already been given.
        let market = FakeMarket {
            configured: true,
            blueprints: std::time::Duration::from_secs(3),
            found: catalog_naming_11(),
            sold: std::time::Duration::from_secs(3),
            sold_rows: Some(vec![sold_row("500", 30.0)]),
            games: std::time::Duration::from_secs(4),
        };
        let collections = a_pokemon_and_a_riftbound();
        let mut rows = Rows::new(&collections);
        let started = tokio::time::Instant::now();
        let read = read_collection_book(&market, &mut rows).await;

        assert_eq!(
            started.elapsed(),
            std::time::Duration::from_secs(6),
            "the other games ran between the two Pokémon reads instead of beside them"
        );
        assert!(
            !read.unavailable,
            "a market that answered both its reads is reported as one that failed"
        );
        assert_eq!(rows.rows()[0]["blueprint_id"], json!("500"), "{rows:?}");
        assert_eq!(rows.rows()[1]["blueprint_id"], json!("1777"), "{rows:?}");
        assert_eq!(read.sold.len(), 2, "{:?}", read.sold);
    }

    #[tokio::test(start_paused = true)]
    async fn both_pokemon_reads_share_the_one_window() {
        // Five seconds each is ten seconds of a market that never failed, and the
        // window this route gives a request is eight: the second read is cut at the
        // deadline rather than carrying the request past it. The other games spend
        // their whole four seconds beside that, so the worst case of the read — which
        // was twelve when they ran between the two queries — is the window itself.
        let market = FakeMarket {
            configured: true,
            blueprints: std::time::Duration::from_secs(5),
            found: catalog_naming_11(),
            sold: std::time::Duration::from_secs(5),
            sold_rows: Some(vec![sold_row("500", 30.0)]),
            games: std::time::Duration::from_secs(4),
        };
        let collections = a_pokemon_and_a_riftbound();
        let mut rows = Rows::new(&collections);
        let started = tokio::time::Instant::now();
        let read = read_collection_book(&market, &mut rows).await;

        assert_eq!(
            started.elapsed(),
            POKEMON_READ_TIMEOUT,
            "the read outlived the window it was given"
        );
        assert!(
            read.unavailable,
            "a read cut at its deadline answered as though it had completed"
        );
        // The games still answered on their own: their rows are corrected and their
        // sales are in the read, which is why the answer must not price from a book
        // whose Pokémon half never arrived.
        assert_eq!(rows.rows()[1]["blueprint_id"], json!("1777"), "{rows:?}");
        assert_eq!(read.sold.len(), 1, "{:?}", read.sold);
    }

    #[tokio::test(start_paused = true)]
    async fn a_deployment_without_a_market_is_said_so_before_anything_is_asked() {
        let market = FakeMarket {
            configured: false,
            blueprints: std::time::Duration::ZERO,
            found: catalog_naming_11(),
            sold: std::time::Duration::ZERO,
            sold_rows: Some(Vec::new()),
            games: std::time::Duration::ZERO,
        };
        let collections = a_pokemon_and_a_riftbound();
        let mut rows = Rows::new(&collections);
        let read = read_collection_book(&market, &mut rows).await;

        assert!(read.unavailable, "no market is a reason to say so");
        assert!(read.sold.is_empty(), "{:?}", read.sold);
        // Nothing was asked of it: the Pokémon row keeps the empty blueprint it was
        // built with, and no game's catalog corrected the other row.
        assert_eq!(rows.rows()[0]["blueprint_id"], json!(""), "{rows:?}");
        assert_eq!(rows.rows()[1]["blueprint_id"], json!(""), "{rows:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_market_that_answered_partly_prices_nothing() {
        // The Pokémon sold book failed while the Riftbound database answered. The rows
        // it brought back do price that card — they are its own game's sales — and an
        // answer that says there is no series to draw may not also offer a number to
        // read beside the sentence.
        let market = FakeMarket {
            configured: true,
            blueprints: std::time::Duration::ZERO,
            found: catalog_naming_11(),
            sold: std::time::Duration::ZERO,
            sold_rows: None,
            games: std::time::Duration::ZERO,
        };
        let collections = a_pokemon_and_a_riftbound();
        let mut rows = Rows::new(&collections);
        let read = read_collection_book(&market, &mut rows).await;

        assert!(
            read.unavailable,
            "a sold book that did not answer was reported as one that did"
        );
        // The games answered, and their sale is in the read: what must not happen is
        // the *answer* pricing from a book that is half of the market.
        assert_eq!(read.sold.len(), 1, "{:?}", read.sold);
        let body = price_body(
            &rows,
            &read.sold,
            &collections,
            "2026-10-05",
            read.unavailable,
            None,
        );
        assert_eq!(body["seriesError"], json!(SERIES_ERROR), "{body}");
        assert_eq!(body["days"], json!([]), "{body}");
        let items = body["collections"][0]["items"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 2, "{body}");
        for item in &items {
            assert_eq!(
                item["pricePkn"],
                Json::Null,
                "a price offered beside a reported seriesError: {item}"
            );
        }

        // The control: this list and these rows are priceable, so the nulls above come
        // from the failed half of the market and not from a fixture that could never
        // have priced anything.
        let market = FakeMarket {
            sold_rows: Some(vec![sold_row("500", 30.0)]),
            ..market
        };
        let mut rows = Rows::new(&collections);
        let read = read_collection_book(&market, &mut rows).await;
        let body = price_body(
            &rows,
            &read.sold,
            &collections,
            "2026-10-05",
            read.unavailable,
            None,
        );
        assert_eq!(body["seriesError"], Json::Null, "{body}");
        let items = body["collections"][0]["items"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items[0]["pricePkn"], json!(30), "{body}");
        assert_eq!(items[1]["pricePkn"], json!(40), "{body}");
        assert!(
            body["days"].as_array().is_some_and(|days| !days.is_empty()),
            "a market that answered draws a series: {body}"
        );
    }

    /// One list of two cards and a market that answered, as the answer's maths holds
    /// them — so a fallback can be read off the same data.
    fn priced_vault() -> Priced {
        let collections = a_pokemon_and_a_riftbound();
        Priced {
            rows: Arc::new(Rows::new(&collections)),
            sold: Arc::new(vec![sold_row("500", 30.0)]),
            collections: Arc::new(collections),
            saved: Arc::new(Some("a1".to_string())),
            today: Arc::new("2026-10-05".to_string()),
            unavailable: false,
        }
    }

    #[test]
    fn an_answer_that_lost_its_arithmetic_keeps_the_lists_and_loses_the_prices() {
        // What a `JoinError` falls back to. The first assertion is the control: this
        // very data priced a card and drew a series, so what the fallback took away is
        // the market and not a fixture that could never have priced anything.
        let priced = priced_vault();
        let body = priced.body();
        assert_ne!(
            body["days"],
            json!([]),
            "this fixture prices nothing: {body}"
        );
        assert_eq!(body["seriesError"], Json::Null, "{body}");

        let lost = priced.without_prices().body();
        assert_eq!(lost["seriesError"], json!(SERIES_ERROR), "{lost}");
        assert_eq!(lost["days"], json!([]), "{lost}");
        assert_eq!(
            lost["saved"],
            json!("a1"),
            "a save that committed still reports its own id: {lost}"
        );
        assert_eq!(lost["collections"][0]["name"], json!("Vault"), "{lost}");
        let items = lost["collections"][0]["items"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 2, "{lost}");
        for item in &items {
            assert_eq!(
                item["pricePkn"],
                Json::Null,
                "a price offered beside a reported seriesError: {item}"
            );
        }
    }

    #[tokio::test]
    async fn a_blocking_task_that_dies_answers_the_fallback_and_not_an_error() {
        // The hop, with its maths failing: the request is still answered, out of the
        // same data, by the fallback the caller kept a handle to.
        let body = on_blocking(
            || panic!("the series arithmetic died"),
            || json!({ "answered": "without prices" }),
        )
        .await;
        assert_eq!(body, json!({ "answered": "without prices" }));
    }

    #[tokio::test]
    async fn every_other_method_is_the_routes_own_405() {
        // A preflight lands here too, exactly as on the history route: `OPTIONS` is
        // not one of the two methods the contract has.
        let response = portfolio_collections_other().await;
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            response
                .headers()
                .get(header::ALLOW)
                .map(|value| value.as_bytes()),
            Some("GET, POST".as_bytes())
        );
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .map(|value| value.as_bytes()),
            Some("private, no-store".as_bytes())
        );
    }

    #[test]
    fn an_answer_of_the_route_is_never_cacheable() {
        let response = collections_error(*unknown_action_error());
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .map(|value| value.as_bytes()),
            Some("private, no-store".as_bytes()),
            "a failed read of someone's collections is not cacheable either"
        );

        // A token whose subject is absent addresses nobody, so no list is stored
        // under the empty uid for the next such token to find.
        assert_eq!(
            owner_uid("").unwrap_err().status(),
            StatusCode::UNAUTHORIZED,
            "a uid-less token is not a seller"
        );
        assert_eq!(owner_uid("user-1").unwrap(), "user-1");
    }

    #[test]
    fn a_body_that_cannot_be_read_is_not_treated_as_an_empty_one() {
        // The lenient `req.body || {}` of the Node handlers turned `{"name":` into a
        // save with no name and a garbage delete into a list that does not exist, so
        // the route answered as if it had understood a request that said nothing.
        for raw in [
            r#"{"name":"#,
            "null",
            r#"[{ "name": "Vault" }]"#,
            "not json",
        ] {
            let error = write_body(&Bytes::from(raw.to_string())).unwrap_err();
            assert_eq!(error.status(), StatusCode::BAD_REQUEST, "body={raw}");
            assert_eq!(
                error.body(),
                json!({ "error": "Invalid JSON request body." }),
                "a malformed body is the runtime's own 400, with no code: body={raw}"
            );
        }

        // An absent body is not malformed input: it is the empty object, which each
        // write then refuses for what it is — a save with no name, a delete with no id.
        // Blank bytes are the same thing, because that is what the runtime trims them to.
        assert_eq!(write_body(&Bytes::new()).unwrap(), json!({}));
        assert_eq!(write_body(&Bytes::from("  \n")).unwrap(), json!({}));
        assert_eq!(
            write_body(&Bytes::from(r#"{"id":"a1"}"#)).unwrap(),
            json!({ "id": "a1" })
        );
    }

    #[test]
    fn the_blueprint_query_reads_the_catalog_by_card_id() {
        assert!(
            POKEMON_BLUEPRINTS_SQL.contains("where card_id = any($1::bigint[])"),
            "{POKEMON_BLUEPRINTS_SQL}"
        );
        assert!(
            POKEMON_BLUEPRINTS_SQL.contains("blueprint_id::text"),
            "a bigint column arrives as the text a row is keyed by: {POKEMON_BLUEPRINTS_SQL}"
        );
    }
}
