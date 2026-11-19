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

use super::portfolio::{numeric_id, price_other_games};
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
/// their own window inside [`price_other_games`], so this route cannot be held open
/// longer than these two windows plus a Firestore round trip, whatever the market
/// database is doing. A read that runs out leaves its cards held and unpriced and the
/// answer saying so, never a request that waits forever.
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

/// One sold price book for every collection of this seller, and the blueprints its
/// rows are now priced by.
///
/// This is the whole market read of a request: the Pokémon catalog pass, every other
/// game's own database through [`price_other_games`], then one sold query for the
/// blueprints both confirmed — the same three steps, in the same order, as the main
/// series. Both Pokémon reads share [`POKEMON_READ_TIMEOUT`], and the other games
/// share theirs, so the wait this route can add to a request is bounded whatever the
/// market is doing.
///
/// A read that fails leaves its cards **held and unpriced** rather than failing the
/// request: the lists themselves are Firestore data, and a graph that cannot price a
/// card still shows the card. What it cannot do is pretend the series it then draws
/// is the seller's worth, so a failed read is reported to the answer as well as the
/// log.
async fn read_collection_book(state: &DomainState, rows: &mut Rows) -> PriceRead {
    if rows.rows().is_empty() {
        return PriceRead::complete(Book::new());
    }
    let Ok(db) = state.marketplace_db() else {
        tracing::warn!("portfolio collections have no marketplace database to price from");
        return PriceRead::unavailable();
    };
    let deadline = tokio::time::Instant::now() + POKEMON_READ_TIMEOUT;
    let mut unavailable = false;

    let ids = pokemon_card_ids(rows.rows());
    let mut by_card = HashMap::new();
    if !ids.is_empty() {
        let read = tokio::time::timeout_at(
            deadline,
            db.query_json(POKEMON_BLUEPRINTS_SQL, &[SqlParam::IntArray(ids)]),
        )
        .await;
        match read {
            Ok(Ok(found)) => by_card = pokemon_blueprints(&found),
            Ok(Err(error)) => {
                tracing::warn!(
                    %error,
                    "collection blueprints are unavailable; those cards stay unpriced"
                );
                unavailable = true;
            }
            Err(_elapsed) => {
                tracing::warn!(
                    "collection blueprints timed out; those cards stay unpriced"
                );
                unavailable = true;
            }
        }
    }
    apply_pokemon_blueprints(rows.rows_mut(), &by_card);

    // The other games next: their rows are only priceable once their own catalog
    // has confirmed a blueprint, and the sold query below reads Pokémon's.
    let mut sold: Vec<Json> = Vec::new();
    price_other_games(state, rows.rows_mut(), &mut sold).await;

    let blueprints = rows
        .rows()
        .iter()
        .filter(|row| game_of(row) == POKEMON)
        .filter_map(|row| numeric_id(&row_text(row, "blueprint_id")))
        .collect::<BTreeSet<i64>>();
    if !blueprints.is_empty() {
        let read = tokio::time::timeout_at(
            deadline,
            db.query_json(
                SOLD_BY_BLUEPRINT_SQL,
                &[SqlParam::IntArray(blueprints.into_iter().collect())],
            ),
        )
        .await;
        match read {
            Ok(Ok(found)) => sold.extend(found),
            Ok(Err(error)) => {
                tracing::warn!(
                    %error,
                    "collection sold prices are unavailable; those cards stay unpriced"
                );
                unavailable = true;
            }
            Err(_elapsed) => {
                tracing::warn!("collection sold prices timed out; those cards stay unpriced");
                unavailable = true;
            }
        }
    }
    PriceRead {
        book: sold_price_book(&sold),
        unavailable,
    }
}

/// The market this answer is priced out of, and whether all of it arrived.
pub struct PriceRead {
    pub book: Book,
    /// A read this answer needed did not happen — no market database, a query that
    /// failed, or one that ran out its window. There is then no series to draw at
    /// all: the lists are still the seller's and still answered, with
    /// [`SERIES_ERROR`] beside them.
    pub unavailable: bool,
}

impl PriceRead {
    fn complete(book: Book) -> Self {
        Self {
            book,
            unavailable: false,
        }
    }

    fn unavailable() -> Self {
        Self {
            book: Book::new(),
            unavailable: true,
        }
    }
}

/// The `seriesError` value of an answer whose price reads did not happen. The request
/// is still a 200: the seller's lists are Firestore data, and a market outage is not a
/// reason to tell them their collection is gone.
pub const SERIES_ERROR: &str = "prices_unavailable";

/// The answer of every method of this route: the seller's lists, each card priced
/// as of the last day of its series, and the series of every list. The lists are the
/// ones the caller read — or, after a write, the ones its own transaction read with
/// the write applied — because a store that fails after a committed write must not
/// turn a 200 into an error.
///
/// The maths — every list against every day of the window — is parked on the blocking
/// pool: it is pure arithmetic over data already in hand, and a seller with the full
/// allowance of lists and cards would otherwise hold an I/O thread through it.
async fn answer(
    state: &DomainState,
    collections: &[Collection],
    saved: Option<&str>,
) -> Result<Response> {
    let mut rows = Rows::new(collections);
    let read = read_collection_book(state, &mut rows).await;
    let today = utc_day_key_ms(state.clock().now().timestamp_millis());
    let collections = collections.to_vec();
    let saved = saved.map(str::to_string);
    let body = tokio::task::spawn_blocking(move || {
        let PriceRead {
            book,
            unavailable,
        } = read;
        // A book that was not read prices nothing, and a line drawn beneath cards
        // this request never saw would be a graph of the wrong thing: the series is
        // left empty and the answer says why.
        let days = if unavailable {
            Vec::new()
        } else {
            collection_days(&rows, &book, &today)
        };
        let day = last_day(&days, &today);
        let mut body = answer_body(&collections, &rows, &book, &days, &day, saved.as_deref());
        if unavailable {
            body["seriesError"] = Json::from(SERIES_ERROR);
        }
        body
    })
    .await
    .map_err(|error| {
        tracing::error!(%error, "the portfolio collections series could not be computed");
        Box::new(ApiError::internal(
            "The collection series could not be computed.",
        ))
    })?;
    Ok(json_cached(StatusCode::OK, body, "private, no-store"))
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
    answer(state, &collections, saved.as_deref()).await
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
        let items = answered[0]["items"]
            .as_array()
            .cloned()
            .unwrap_or_default();
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
