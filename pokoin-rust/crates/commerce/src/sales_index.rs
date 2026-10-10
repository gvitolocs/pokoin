//! Which cards have any Sold-on-Pokoin row at all.
//!
//! `/api/marketplace-native-sales` is asked for every card desk, and almost
//! every card has never sold natively, yet each request was one Firestore
//! round trip (200–350 ms). This keeps the set of card ids that appear in
//! `marketplace_sales` in memory: a card outside it is answered `sales: []`
//! without leaving the process; a card inside it runs the same Firestore query
//! as before.
//!
//! The set only grows. It is loaded once in the background, then every
//! [`DELTA_EVERY`] asks Firestore for rows sold after the newest one it has
//! seen (minus [`OVERLAP`]), and every [`FULL_EVERY`] reloads in full. Until
//! the first load finishes, or if the collection is larger than [`MAX_ROWS`],
//! every request takes the Firestore path.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::firestore::{Filter, FilterOp, StructuredQuery};
use crate::state::DomainState;
use crate::store::SALES_COLLECTION;

const DELTA_EVERY: Duration = Duration::from_secs(30);
const FULL_EVERY: Duration = Duration::from_secs(6 * 3600);
/// A sale stamped a little before it became visible is still picked up.
const OVERLAP_SECONDS: i64 = 600;
const MAX_ROWS: usize = 50_000;

#[derive(Default)]
struct Loaded {
    card_ids: HashSet<String>,
    /// Newest `soldAt` seen (ISO-8601, the form every writer stores).
    newest: String,
    full_at: Option<Instant>,
    checked_at: Option<Instant>,
}

fn loaded() -> &'static RwLock<Loaded> {
    static INDEX: OnceLock<RwLock<Loaded>> = OnceLock::new();
    INDEX.get_or_init(|| RwLock::new(Loaded::default()))
}

static REFRESHING: AtomicBool = AtomicBool::new(false);

fn absorb(into: &mut Loaded, rows: &[Value]) {
    for row in rows {
        if let Some(id) = row.get("cardId").and_then(Value::as_str).map(str::trim).filter(|id| !id.is_empty()) {
            into.card_ids.insert(id.to_owned());
        }
        if let Some(sold_at) = row.get("soldAt").and_then(Value::as_str) {
            if sold_at > into.newest.as_str() {
                into.newest = sold_at.to_owned();
            }
        }
    }
}

/// `newest` minus the overlap, still ISO-8601; `newest` itself when unparsable.
fn delta_cursor(newest: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(newest)
        .map(|at| (at - chrono::Duration::seconds(OVERLAP_SECONDS)).to_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|_| newest.to_owned())
}

async fn refresh(state: DomainState) {
    let Ok(firestore) = state.firestore() else { return };
    let (full, cursor) = {
        let index = loaded().read().unwrap_or_else(|e| e.into_inner());
        (index.full_at.is_none_or(|at| at.elapsed() > FULL_EVERY) || index.newest.is_empty(), delta_cursor(&index.newest))
    };
    let query = if full {
        StructuredQuery::collection(SALES_COLLECTION).limit(MAX_ROWS as u32)
    } else {
        StructuredQuery::collection(SALES_COLLECTION)
            .where_filter(Filter::new("soldAt", FilterOp::GreaterThan, json!(cursor)))
            .limit(MAX_ROWS as u32)
    };
    match firestore.run_query(&query).await {
        Ok(rows) => {
            let mut index = loaded().write().unwrap_or_else(|e| e.into_inner());
            if full {
                if rows.len() >= MAX_ROWS {
                    tracing::warn!(rows = rows.len(), "native sales index disabled: collection too large");
                    *index = Loaded::default();
                    return;
                }
                let mut fresh = Loaded::default();
                absorb(&mut fresh, &rows);
                // Never forget a card a delta added while the reload ran.
                fresh.card_ids.extend(index.card_ids.drain());
                fresh.full_at = Some(Instant::now());
                *index = fresh;
                tracing::info!(rows = rows.len(), cards = index.card_ids.len(), "native sales index loaded");
            } else {
                absorb(&mut index, &rows);
            }
            index.checked_at = Some(Instant::now());
        }
        Err(error) => tracing::warn!(%error, full, "native sales index refresh failed"),
    }
}

fn refresh_in_background(state: &DomainState) {
    if REFRESHING.swap(true, Ordering::AcqRel) {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        refresh(state).await;
        REFRESHING.store(false, Ordering::Release);
    });
}

/// `Some(false)`: this card has no native sale, answer empty. `Some(true)`:
/// it has rows, read them. `None`: the index cannot say, read Firestore.
pub fn has_sales(state: &DomainState, card_id: &str) -> Option<bool> {
    let (answer, due) = {
        let index = loaded().read().unwrap_or_else(|e| e.into_inner());
        let ready = index.full_at.is_some();
        let due = index.checked_at.is_none_or(|at| at.elapsed() > DELTA_EVERY);
        // A set that could not be refreshed for a long time is not trusted.
        let trusted = ready && index.checked_at.is_some_and(|at| at.elapsed() < DELTA_EVERY * 20);
        (trusted.then(|| index.card_ids.contains(card_id)), due)
    };
    if due {
        refresh_in_background(state);
    }
    answer
}

/// A sale this process just recorded is visible at once.
pub fn note_sale(card_id: &str) {
    let id = card_id.trim();
    if !id.is_empty() {
        loaded().write().unwrap_or_else(|e| e.into_inner()).card_ids.insert(id.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_add_card_ids_and_advance_the_cursor() {
        let mut index = Loaded::default();
        absorb(&mut index, &[
            json!({"cardId": "722724", "soldAt": "2026-10-08T10:00:00.000Z"}),
            json!({"cardId": " 12 ", "soldAt": "2026-10-09T09:00:00.000Z", "voided": true}),
            json!({"soldAt": "2026-10-01T00:00:00.000Z"}),
        ]);
        assert!(index.card_ids.contains("722724") && index.card_ids.contains("12"));
        assert_eq!(index.card_ids.len(), 2);
        assert_eq!(index.newest, "2026-10-09T09:00:00.000Z");
    }

    #[test]
    fn the_delta_cursor_overlaps() {
        assert_eq!(delta_cursor("2026-10-09T09:00:00.000Z"), "2026-10-09T08:50:00.000Z");
        assert_eq!(delta_cursor("not a date"), "not a date");
    }
}
