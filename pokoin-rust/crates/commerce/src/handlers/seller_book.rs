//! Stored seller books: the whole shop of a seller in the compact form, kept
//! in Postgres so it is built once, off the request path, and served by every
//! API instance with one primary-key read.
//!
//! A book is named by the seller's last-change stamp (`max(updated_at)` over
//! their listings). A request whose stamp matches the stored book gets it at
//! once. When the stamp has moved, the request still gets the stored book and
//! a rebuild starts in the background; the page's own freshness check picks
//! the new one up. Rebuilds are also started when a listing changes here
//! (the listing outbox) and by a sweep that notices changes made elsewhere
//! (CardTrader sync, orders).
//!
//! Table: `scripts/sql/116_marketplace_seller_books.sql`. Without it every
//! request builds its own book, as before.
//!
//! Snapshots (`scripts/sql/119_seller_book_snapshots.sql`): the same rows are
//! served public and pre-compressed by `GET /api/marketplace-list?kind=seller`
//! (apps/api `lists.rs`), keyed by `username`, with `version` as the ETag. The
//! brotli-11 copy (`br`) and the shop header (photo, country) are written by
//! [`build_all`], the k3s CronJob `build-lists-sellers` on nezopt; a rebuild in
//! an API instance keeps the stored header and leaves `br` for the next run.
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use pokoin_api_common::compact::Wanted;
use serde_json::{json, Value};
use sqlx::Row;

use super::seller::{
    book_cache_get, book_cache_put, build_book, build_book_with, clean_username, seller_activity_stamp, seller_for_uid,
    stamp_text, Seller, ShopHeader,
};
use crate::error::ApiError;
use crate::state::DomainState;

/// A sweep looks only at books somebody asked for this recently.
const REQUESTED_WITHIN: &str = "2 days";
const SWEEP_EVERY: Duration = Duration::from_secs(30);

/// The form every stored book has.
pub fn compact() -> Wanted {
    Wanted::from_parts(None, "format=c1v2")
}

fn is_missing_table(error: &sqlx::Error) -> bool {
    error.as_database_error().and_then(|e| e.code()).as_deref() == Some("42P01")
}

/// A column of migration 119 the database does not have yet.
fn is_missing_column(error: &sqlx::Error) -> bool {
    error.as_database_error().and_then(|e| e.code()).as_deref() == Some("42703")
}

/// The ETag of a stored book (and the `v=` that names it): a hash of its bytes.
pub fn version_of(body: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(&sha2::Sha256::digest(body)[..8])
}

/// What of the seller is written into every row of a book: when it changes,
/// the stored book is stale even if no listing moved.
pub fn profile_of(seller: &Seller) -> String {
    format!("{}|{}|{}", seller.username, seller.display_name, seller.accepts_pkn)
}

fn seller_json(seller: &Seller, header: &ShopHeader) -> Value {
    json!({
        "uid": seller.uid,
        "username": seller.username,
        "displayName": seller.display_name,
        "acceptsPkn": seller.accepts_pkn,
        "photoUrl": header.photo_url,
        "country": header.country,
    })
}

/// The shop header a stored book was built with.
fn header_from(value: &Value) -> ShopHeader {
    let text = |key: &str| value[key].as_str().filter(|v| !v.is_empty()).map(str::to_owned);
    ShopHeader { photo_url: text("photoUrl"), country: text("country") }
}

fn seller_from(value: &Value) -> Option<Seller> {
    Some(Seller {
        uid: value["uid"].as_str().filter(|uid| !uid.is_empty())?.to_string(),
        username: value["username"].as_str().unwrap_or_default().to_string(),
        display_name: value["displayName"].as_str().unwrap_or_default().to_string(),
        accepts_pkn: value["acceptsPkn"].as_bool().unwrap_or(true),
    })
}

fn memory_key(seller: &Seller, game: &str, stamp: &str) -> String {
    let form = compact();
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        seller.uid, game, stamp, form.c1(), form.templates(), seller.display_name, seller.accepts_pkn
    )
}

struct Stored {
    stamp: String,
    profile: String,
    body: Vec<u8>,
    asked_recently: bool,
}

async fn load(db: &sqlx::PgPool, uid: &str, game: &str) -> Result<Option<Stored>, sqlx::Error> {
    let row = sqlx::query(
        "select stamp, profile, body, requested_at > now() - interval '1 hour' as asked_recently
           from public.marketplace_seller_books where seller_uid = $1 and game = $2",
    )
    .bind(uid)
    .bind(game)
    .fetch_optional(db)
    .await?;
    row.map(|row| {
        Ok(Stored {
            stamp: row.try_get("stamp")?,
            profile: row.try_get("profile")?,
            body: row.try_get("body")?,
            asked_recently: row.try_get("asked_recently")?,
        })
    })
    .transpose()
}

/// Which of the stamps and profiles a stored book carries still describe the shop.
pub fn is_current(stored_stamp: &str, stored_profile: &str, stamp: &str, profile: &str) -> bool {
    stored_stamp == stamp && stored_profile == profile
}

/// Migration 116's statement: kept for a database without 119's columns.
const SAVE_SQL_116: &str = "insert into public.marketplace_seller_books \
     (seller_uid, game, stamp, profile, seller, body, listings, built_at, requested_at) \
     values ($1, $2, $3, $4, $5, $6, $7, now(), now()) \
     on conflict (seller_uid, game) do update set stamp = excluded.stamp, profile = excluded.profile, \
     seller = excluded.seller, body = excluded.body, listings = excluded.listings, built_at = now()";

const SAVE_SQL: &str = "insert into public.marketplace_seller_books \
     (seller_uid, game, stamp, profile, seller, body, listings, username, version, br, built_at, requested_at) \
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now()) \
     on conflict (seller_uid, game) do update set stamp = excluded.stamp, profile = excluded.profile, \
     seller = excluded.seller, body = excluded.body, listings = excluded.listings, username = excluded.username, \
     version = excluded.version, br = excluded.br, built_at = now()";

/// One book to store.
struct Save<'a> {
    seller: &'a Seller,
    header: &'a ShopHeader,
    game: &'a str,
    stamp: &'a str,
    body: &'a [u8],
    listings: usize,
    br: Option<&'a [u8]>,
}

/// Store a book, inside a savepoint so a database without migration 119
/// falls back to the 116 statement within the same transaction.
async fn store(conn: &mut sqlx::PgConnection, save: &Save<'_>) -> Result<(), sqlx::Error> {
    // A transaction inside a transaction is a savepoint.
    let mut savepoint = sqlx::Connection::begin(&mut *conn).await?;
    let full = sqlx::query(SAVE_SQL)
        .bind(&save.seller.uid)
        .bind(save.game)
        .bind(save.stamp)
        .bind(profile_of(save.seller))
        .bind(seller_json(save.seller, save.header))
        .bind(save.body)
        .bind(save.listings as i32)
        .bind(clean_username(&save.seller.username))
        .bind(version_of(save.body))
        .bind(save.br)
        .execute(&mut *savepoint)
        .await;
    match full {
        Ok(_) => savepoint.commit().await,
        Err(error) if is_missing_column(&error) => {
            savepoint.rollback().await?;
            sqlx::query(SAVE_SQL_116)
                .bind(&save.seller.uid)
                .bind(save.game)
                .bind(save.stamp)
                .bind(profile_of(save.seller))
                .bind(seller_json(save.seller, save.header))
                .bind(save.body)
                .bind(save.listings as i32)
                .execute(&mut *conn)
                .await
                .map(|_| ())
        }
        Err(error) => Err(error),
    }
}

/// The seller's book for a request: the one in memory, else the stored one,
/// else built now. A stored book whose stamp has moved is still the answer;
/// its replacement is built behind the request.
pub async fn serve(state: &DomainState, seller: &Seller, game: &str, stamp: &str) -> Result<Arc<Vec<u8>>, ApiError> {
    let key = memory_key(seller, game, stamp);
    if let Some(body) = book_cache_get(&key) {
        return Ok(body);
    }
    match load(state.read_db(), &seller.uid, game).await {
        Ok(Some(stored)) => {
            if !stored.asked_recently {
                touch(state, &seller.uid, game);
            }
            let body = Arc::new(stored.body);
            if is_current(&stored.stamp, &stored.profile, stamp, &profile_of(seller)) {
                book_cache_put(key, body.clone());
            } else {
                kick(state, seller.clone(), game.to_string());
            }
            return Ok(body);
        }
        Ok(None) => {}
        Err(error) if is_missing_table(&error) => {}
        Err(error) => tracing::warn!(%error, "seller book store unreadable; building"),
    }
    // Nobody has asked for this shop yet: build it in this request and keep it.
    let (built_stamp, body, listings) = build_book(state, seller, game, compact()).await?;
    let body = Arc::new(body);
    book_cache_put(memory_key(seller, game, &built_stamp), body.clone());
    save(state, seller, game, &built_stamp, &body, listings).await;
    Ok(body)
}

async fn save(state: &DomainState, seller: &Seller, game: &str, stamp: &str, body: &[u8], listings: usize) {
    let header = ShopHeader::default();
    let save = Save { seller, header: &header, game, stamp, body, listings, br: None };
    let saved = match state.write_db().acquire().await {
        Ok(mut conn) => store(&mut conn, &save).await,
        Err(error) => Err(error),
    };
    match saved {
        Ok(_) => {}
        Err(error) if is_missing_table(&error) => {}
        Err(error) => tracing::warn!(%error, seller = %seller.uid, "seller book not stored"),
    }
}

/// Note that the book is still wanted, at most once an hour per book.
fn touch(state: &DomainState, uid: &str, game: &str) {
    let (state, uid, game) = (state.clone(), uid.to_string(), game.to_string());
    tokio::spawn(async move {
        let _ = sqlx::query(
            "update public.marketplace_seller_books set requested_at = now() where seller_uid = $1 and game = $2",
        )
        .bind(uid)
        .bind(game)
        .execute(state.write_db())
        .await;
    });
}

fn building() -> &'static Mutex<HashSet<String>> {
    static BUILDING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    BUILDING.get_or_init(Default::default)
}

/// Start a rebuild of one book unless this process is already building it.
pub fn kick(state: &DomainState, seller: Seller, game: String) {
    if std::env::var("POKOIN_SELLER_BOOK_WORKER").as_deref() == Ok("0") {
        return;
    }
    let key = format!("{}|{game}", seller.uid);
    {
        let Ok(mut building) = building().lock() else { return };
        if !building.insert(key.clone()) {
            return;
        }
    }
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(error) = rebuild(&state, &seller, &game).await {
            tracing::warn!(error = %error.message, seller = %seller.uid, game, "seller book rebuild failed");
        }
        if let Ok(mut building) = building().lock() {
            building.remove(&key);
        }
    });
}

/// Build and store one book if the stored one no longer describes the shop.
/// One builder at a time across every API instance: the others see the lock
/// taken and leave. Returns whether a book was written.
pub async fn rebuild(state: &DomainState, seller: &Seller, game: &str) -> Result<bool, ApiError> {
    rebuild_with(state, seller, game, &Rebuild::default()).await
}

/// How a rebuild runs: the API's own rebuilds keep the stored header and store
/// no brotli copy; the snapshot builder passes both.
#[derive(Clone, Default)]
pub struct Rebuild {
    /// Brotli 11 (apps/api `lists::brotli11`): the builder's slow, small copy.
    pub compress: Option<fn(&[u8]) -> Vec<u8>>,
    /// The header read from `users/{uid}`; `None` keeps the stored one.
    pub header: Option<ShopHeader>,
    /// Rebuild even a current book (a daily refresh of the header).
    pub force: bool,
}

/// [`rebuild`] with the snapshot builder's options.
pub async fn rebuild_with(state: &DomainState, seller: &Seller, game: &str, how: &Rebuild) -> Result<bool, ApiError> {
    let missing = |error: sqlx::Error| -> Result<bool, ApiError> {
        if is_missing_table(&error) {
            Ok(false)
        } else {
            Err(error.into())
        }
    };
    let mut tx = state.write_db().begin().await?;
    let locked: bool = sqlx::query_scalar("select pg_try_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("seller-book:{}:{game}", seller.uid))
        .fetch_one(&mut *tx)
        .await?;
    if !locked {
        return Ok(false);
    }
    // Listings live on the main marketplace DB. The satellite pool is only the
    // catalog, and a game that is not mounted has nothing to rebuild.
    if state.game_pools(game).await.is_none() {
        return Ok(false);
    }
    let stamp = seller_activity_stamp(state.read_db(), &seller.uid)
        .await
        .map_err(|error| crate::game::catalog_error(game, error))?;
    let stored = sqlx::query("select stamp, profile, seller from public.marketplace_seller_books where seller_uid = $1 and game = $2")
        .bind(&seller.uid)
        .bind(game)
        .fetch_optional(&mut *tx)
        .await;
    let stored = match stored {
        Ok(row) => row,
        Err(error) => return missing(error),
    };
    let mut header = how.header.clone();
    if let Some(row) = &stored {
        let (stored_stamp, stored_profile): (String, String) = (row.try_get("stamp")?, row.try_get("profile")?);
        if !how.force && is_current(&stored_stamp, &stored_profile, &stamp, &profile_of(seller)) {
            return Ok(false);
        }
        if header.is_none() {
            header = Some(header_from(&row.try_get::<Value, _>("seller")?));
        }
    }
    let header = header.unwrap_or_default();
    let (built_stamp, body, listings) = build_book_with(state, seller, &header, game, compact()).await?;
    let br = match how.compress {
        Some(compress) => {
            let bytes = body.clone();
            let compressed = tokio::task::spawn_blocking(move || compress(&bytes))
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
            (!compressed.is_empty()).then_some(compressed)
        }
        None => None,
    };
    let save = Save { seller, header: &header, game, stamp: &built_stamp, body: &body, listings, br: br.as_deref() };
    if let Err(error) = store(&mut tx, &save).await {
        return missing(error);
    }
    tx.commit().await?;
    book_cache_put(memory_key(seller, game, &built_stamp), Arc::new(body));
    Ok(true)
}

/// Who a seller is and what their shop header shows, for the builder.
#[async_trait::async_trait]
pub trait SellerDirectory: Send + Sync {
    /// The shop identity (`None`: no public handle).
    async fn seller(&self, uid: &str, listing_name: &str) -> Result<Option<Seller>, ApiError>;
    /// Photo and country; read only for a book about to be built.
    async fn header(&self, uid: &str) -> ShopHeader;
}

/// Production directory: the cached public profile (what the request path
/// compares) and `users/{uid}` for the header.
pub struct FirestoreDirectory<'a>(pub &'a DomainState);

#[async_trait::async_trait]
impl SellerDirectory for FirestoreDirectory<'_> {
    async fn seller(&self, uid: &str, listing_name: &str) -> Result<Option<Seller>, ApiError> {
        seller_for_uid(self.0, uid, listing_name).await
    }

    async fn header(&self, uid: &str) -> ShopHeader {
        match self.0.firestore() {
            Ok(firestore) => crate::store::read_user(firestore, uid).await.map(|user| ShopHeader::from_user(&user)).unwrap_or_default(),
            Err(_) => ShopHeader::default(),
        }
    }
}

/// What a snapshot builder run did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Built {
    pub sellers: usize,
    pub built: usize,
    pub skipped: usize,
    pub failed: usize,
    pub removed: u64,
}

/// A seller as the builder finds them: their stamp (every game), whether they
/// have an active row in this game, whether they have any row in this game,
/// and their latest listing name (the handle fallback).
struct Shop {
    uid: String,
    stamp: String,
    listed: bool,
    in_game: bool,
    name: String,
}

/// Visit a seller who lists in this game or already has its book. Cleanup keeps
/// a book only when the seller still has a listing row in this game.
fn shop_plan(listed: bool, in_game: bool, stored: bool) -> (bool, bool) {
    (listed || stored, in_game)
}

/// A stored book as the builder compares it.
#[derive(Debug, Default)]
pub struct StoredBook {
    pub stamp: String,
    pub profile: String,
    pub username: String,
    pub compressed: bool,
    /// Built within the last day (the header refresh).
    pub recent: bool,
}

/// Whether the builder has to (re)build a seller's book: none stored, the
/// stamp or profile moved, no brotli copy or handle yet (a book an API
/// instance rebuilt, or one stored before migration 119), or a day old.
pub fn needs_build(stored: Option<&StoredBook>, stamp: &str, profile: &str, username: &str) -> bool {
    !stored.is_some_and(|book| {
        is_current(&book.stamp, &book.profile, stamp, profile) && book.compressed && book.username == username && book.recent
    })
}

/// The snapshot builder (`pokoin-api job build-lists --kind=seller`, k3s
/// CronJob `build-lists-sellers` on nezopt, against the writer) builds one
/// game's books: every seller with an active listing in that game gets a
/// current book, its brotli-11 copy and its shop header. Listings are the
/// main database's `marketplace_user_listings` rows tagged with the game;
/// books are stored there too. A seller whose book is current costs one
/// cached profile read; the stamps of every seller are one grouped index
/// scan. A book whose seller has no listing row left in this game is removed,
/// and that cleanup only touches this game. `only` limits the run to one
/// handle; `dry_run` reports what it would build. No database for the game
/// builds nothing.
pub async fn build_all(
    state: &DomainState,
    directory: &dyn SellerDirectory,
    game: &str,
    compress: fn(&[u8]) -> Vec<u8>,
    only: Option<&str>,
    force: bool,
    dry_run: bool,
) -> Result<Built, ApiError> {
    // Listings and books are the main database. `marketplace_game` tags the
    // row (null or '' is Pokémon). Migrations 116 and 119 are applied by the
    // migrator, never here.
    if state.game_pools(game).await.is_none() {
        return Ok(Built::default());
    }
    let db = state.write_db();
    let rows = sqlx::query_as::<_, (String, Option<chrono::DateTime<chrono::Utc>>, bool, bool, Option<String>)>(
        "select seller_uid, max(updated_at),
                bool_or(coalesce(nullif(marketplace_game, ''), 'pokemon') = $1
                        and status = 'active' and quantity_available > 0),
                bool_or(coalesce(nullif(marketplace_game, ''), 'pokemon') = $1),
                (array_agg(seller_name order by updated_at desc nulls last))[1]
           from public.marketplace_user_listings
          where seller_uid is not null and btrim(seller_uid) <> ''
          group by seller_uid",
    )
    .bind(game)
    .fetch_all(db)
    .await?;
    let shops: Vec<Shop> = rows
        .into_iter()
        .map(|(uid, max, listed, in_game, name)| Shop {
            uid,
            stamp: stamp_text(max),
            listed,
            in_game,
            name: name.unwrap_or_default(),
        })
        .collect();
    let stored: HashMap<String, StoredBook> = sqlx::query_as::<_, (String, String, String, Option<String>, bool, bool)>(
        "select seller_uid, stamp, profile, username, br is not null, built_at > now() - interval '1 day'
           from public.marketplace_seller_books where game = $1",
    )
    .bind(game)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|(uid, stamp, profile, username, compressed, recent)| {
        (uid, StoredBook { stamp, profile, username: username.unwrap_or_default(), compressed, recent })
    })
    .collect();
    let mut done = Built::default();
    for shop in shops.iter().filter(|shop| shop_plan(shop.listed, shop.in_game, stored.contains_key(&shop.uid)).0) {
        done.sellers += 1;
        let seller = match directory.seller(&shop.uid, &shop.name).await {
            Ok(Some(seller)) => seller,
            Ok(None) => {
                tracing::info!(uid = %shop.uid, "seller book: no public handle");
                continue;
            }
            Err(error) => {
                done.failed += 1;
                tracing::warn!(uid = %shop.uid, error = %error.message, "seller book: profile unreadable");
                continue;
            }
        };
        let username = clean_username(&seller.username);
        if only.is_some_and(|handle| handle != username) {
            continue;
        }
        let book = stored.get(&shop.uid);
        if !force && !needs_build(book, &shop.stamp, &profile_of(&seller), &username) {
            done.skipped += 1;
            continue;
        }
        if dry_run {
            tracing::info!(seller = %username, stamp = %shop.stamp, "seller book: would build");
            done.built += 1;
            continue;
        }
        let how = Rebuild { compress: Some(compress), header: Some(directory.header(&shop.uid).await), force: true };
        match rebuild_with(state, &seller, game, &how).await {
            Ok(true) => {
                done.built += 1;
                tracing::info!(seller = %username, stamp = %shop.stamp, "seller book built");
            }
            Ok(false) => done.skipped += 1,
            Err(error) => {
                done.failed += 1;
                tracing::warn!(seller = %username, error = %error.message, "seller book build failed");
            }
        }
    }
    if only.is_none() && !dry_run {
        let uids: Vec<&str> = shops
            .iter()
            .filter(|shop| shop_plan(shop.listed, shop.in_game, stored.contains_key(&shop.uid)).1)
            .map(|shop| shop.uid.as_str())
            .collect();
        done.removed = sqlx::query(
            "delete from public.marketplace_seller_books where game = $2 and not (seller_uid = any($1::text[]))",
        )
        .bind(&uids)
        .bind(game)
        .execute(db)
        .await?
        .rows_affected();
    }
    Ok(done)
}

/// A listing of this seller changed: rebuild the books people ask for.
pub fn kick_seller(state: &DomainState, uid: &str) {
    if uid.trim().is_empty() || std::env::var("POKOIN_SELLER_BOOK_WORKER").as_deref() == Ok("0") {
        return;
    }
    let (state, uid) = (state.clone(), uid.to_string());
    tokio::spawn(async move {
        let rows = sqlx::query(&format!(
            "select game, seller from public.marketplace_seller_books \
             where seller_uid = $1 and requested_at > now() - interval '{REQUESTED_WITHIN}'"
        ))
        .bind(&uid)
        .fetch_all(state.write_db())
        .await
        .unwrap_or_default();
        for row in rows {
            let (Ok(game), Ok(seller)) = (row.try_get::<String, _>("game"), row.try_get::<Value, _>("seller")) else {
                continue;
            };
            if let Some(seller) = seller_from(&seller) {
                kick(&state, seller, game);
            }
        }
    });
}

/// One pass over the wanted books: start a rebuild for each whose shop has
/// changed since it was built. Returns how many were started.
pub async fn sweep_once(state: &DomainState) -> Result<usize, sqlx::Error> {
    let rows = sqlx::query(&format!(
        "select seller_uid, game, stamp, seller from public.marketplace_seller_books \
         where requested_at > now() - interval '{REQUESTED_WITHIN}'"
    ))
    .fetch_all(state.read_db())
    .await?;
    let mut started = 0;
    for row in rows {
        let game: String = row.try_get("game")?;
        let stored: String = row.try_get("stamp")?;
        let Some(seller) = seller_from(&row.try_get::<Value, _>("seller")?) else {
            continue;
        };
        if state.game_pools(&game).await.is_none() {
            continue;
        }
        let Ok(stamp) = seller_activity_stamp(state.read_db(), &seller.uid).await else {
            continue;
        };
        if stamp != stored {
            kick(state, seller, game);
            started += 1;
        }
    }
    Ok(started)
}

static STARTED: AtomicBool = AtomicBool::new(false);

/// The sweep, for changes that never pass through the listing outbox.
pub fn start(state: &DomainState) {
    if cfg!(test)
        || std::env::var("POKOIN_SELLER_BOOK_WORKER").as_deref() == Ok("0")
        || std::env::var("NODE_TEST_CONTEXT").is_ok()
        || STARTED.swap(true, Ordering::AcqRel)
    {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            let idle = match sweep_once(&state).await {
                Ok(_) => SWEEP_EVERY,
                // Migration 116 not applied yet: look again in five minutes.
                Err(error) if is_missing_table(&error) => Duration::from_secs(300),
                Err(error) => {
                    tracing::warn!(%error, "seller book sweep failed");
                    Duration::from_secs(120)
                }
            };
            tokio::time::sleep(idle).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alice() -> Seller {
        Seller { uid: "u1".into(), username: "alice".into(), display_name: "Alice".into(), accepts_pkn: true }
    }

    #[test]
    fn a_book_is_current_only_for_the_same_stamp_and_seller_profile() {
        let seller = alice();
        let profile = profile_of(&seller);
        assert!(is_current("s1", &profile, "s1", &profile));
        assert!(!is_current("s1", &profile, "s2", &profile), "a listing moved");
        let renamed = Seller { display_name: "Alice Cards".into(), ..alice() };
        assert!(!is_current("s1", &profile, "s1", &profile_of(&renamed)), "the name in every row changed");
        let no_pkn = Seller { accepts_pkn: false, ..alice() };
        assert!(!is_current("s1", &profile, "s1", &profile_of(&no_pkn)));
    }

    #[test]
    fn the_stored_seller_round_trips() {
        let seller = alice();
        let header = ShopHeader { photo_url: Some("https://x.test/a.png".into()), country: Some("IT".into()) };
        let back = seller_from(&seller_json(&seller, &header)).unwrap();
        assert_eq!(header_from(&seller_json(&seller, &header)), header, "a rebuild keeps the builder's header");
        assert_eq!(header_from(&seller_json(&seller, &ShopHeader::default())), ShopHeader::default());
        assert_eq!(profile_of(&back), profile_of(&seller));
        assert_eq!(back.uid, "u1");
        assert!(seller_from(&json!({"username": "alice"})).is_none(), "no uid, no seller");
        assert!(compact().templates());
    }

    #[test]
    fn the_builder_rebuilds_only_what_moved_or_lacks_its_snapshot_parts() {
        let profile = profile_of(&alice());
        let book = StoredBook { stamp: "s1".into(), profile: profile.clone(), username: "alice".into(), compressed: true, recent: true };
        assert!(!needs_build(Some(&book), "s1", &profile, "alice"));
        assert!(needs_build(None, "s1", &profile, "alice"), "never built");
        assert!(needs_build(Some(&book), "s2", &profile, "alice"), "a listing moved");
        assert!(needs_build(Some(&book), "s1", "other", "alice"), "the profile moved");
        assert!(needs_build(Some(&StoredBook { compressed: false, ..book_like(&book) }), "s1", &profile, "alice"), "an API rebuild left no brotli copy");
        assert!(needs_build(Some(&StoredBook { username: String::new(), ..book_like(&book) }), "s1", &profile, "alice"), "stored before 119");
        assert!(needs_build(Some(&StoredBook { recent: false, ..book_like(&book) }), "s1", &profile, "alice"), "the daily header refresh");
    }

    fn book_like(book: &StoredBook) -> StoredBook {
        StoredBook { stamp: book.stamp.clone(), profile: book.profile.clone(), username: book.username.clone(), compressed: book.compressed, recent: book.recent }
    }

    #[test]
    fn a_shop_is_visited_when_listed_or_stored_and_kept_only_with_a_row_in_the_game() {
        assert_eq!(shop_plan(true, true, false), (true, true));
        assert_eq!(shop_plan(false, false, true), (true, false), "a stored book with no row in this game is removed");
        assert_eq!(shop_plan(false, true, false), (false, true), "an inactive row is kept and not rebuilt");
        assert_eq!(shop_plan(false, false, false), (false, false));
    }

    #[test]
    fn a_version_names_the_bytes() {
        assert_eq!(version_of(b"abc"), version_of(b"abc"));
        assert_ne!(version_of(b"abc"), version_of(b"abd"));
        assert_eq!(version_of(b"abc").len(), 16);
    }
}
