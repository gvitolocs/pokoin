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
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use pokoin_api_common::compact::Wanted;
use serde_json::{json, Value};
use sqlx::Row;

use super::seller::{book_cache_get, book_cache_put, build_book, seller_activity_stamp, Seller};
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

/// What of the seller is written into every row of a book: when it changes,
/// the stored book is stale even if no listing moved.
pub fn profile_of(seller: &Seller) -> String {
    format!("{}|{}|{}", seller.username, seller.display_name, seller.accepts_pkn)
}

fn seller_json(seller: &Seller) -> Value {
    json!({
        "uid": seller.uid,
        "username": seller.username,
        "displayName": seller.display_name,
        "acceptsPkn": seller.accepts_pkn,
    })
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

const SAVE_SQL: &str = "insert into public.marketplace_seller_books \
     (seller_uid, game, stamp, profile, seller, body, listings, built_at, requested_at) \
     values ($1, $2, $3, $4, $5, $6, $7, now(), now()) \
     on conflict (seller_uid, game) do update set stamp = excluded.stamp, profile = excluded.profile, \
     seller = excluded.seller, body = excluded.body, listings = excluded.listings, built_at = now()";

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
    let saved = sqlx::query(SAVE_SQL)
        .bind(&seller.uid)
        .bind(game)
        .bind(stamp)
        .bind(profile_of(seller))
        .bind(seller_json(seller))
        .bind(body)
        .bind(listings as i32)
        .execute(state.write_db())
        .await;
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
    let Some(pools) = state.game_pools(game).await else {
        return Ok(false);
    };
    let stamp = seller_activity_stamp(&pools.read, &seller.uid)
        .await
        .map_err(|error| crate::game::catalog_error(game, error))?;
    let stored = sqlx::query("select stamp, profile from public.marketplace_seller_books where seller_uid = $1 and game = $2")
        .bind(&seller.uid)
        .bind(game)
        .fetch_optional(&mut *tx)
        .await;
    let stored = match stored {
        Ok(row) => row,
        Err(error) => return missing(error),
    };
    if let Some(row) = &stored {
        let (stored_stamp, stored_profile): (String, String) = (row.try_get("stamp")?, row.try_get("profile")?);
        if is_current(&stored_stamp, &stored_profile, &stamp, &profile_of(seller)) {
            return Ok(false);
        }
    }
    let (built_stamp, body, listings) = build_book(state, seller, game, compact()).await?;
    let saved = sqlx::query(SAVE_SQL)
        .bind(&seller.uid)
        .bind(game)
        .bind(&built_stamp)
        .bind(profile_of(seller))
        .bind(seller_json(seller))
        .bind(&body)
        .bind(listings as i32)
        .execute(&mut *tx)
        .await;
    if let Err(error) = saved {
        return missing(error);
    }
    tx.commit().await?;
    book_cache_put(memory_key(seller, game, &built_stamp), Arc::new(body));
    Ok(true)
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
        let Some(pools) = state.game_pools(&game).await else {
            continue;
        };
        let Ok(stamp) = seller_activity_stamp(&pools.read, &seller.uid).await else {
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
        let back = seller_from(&seller_json(&seller)).unwrap();
        assert_eq!(profile_of(&back), profile_of(&seller));
        assert_eq!(back.uid, "u1");
        assert!(seller_from(&json!({"username": "alice"})).is_none(), "no uid, no seller");
        assert!(compact().templates());
    }
}
