//! Prebuilt page bodies: `marketplace_page_snapshots (kind, key)`.
//!
//! `pokoin-api job build-lists` stores each desk as a small JSON `head` plus
//! one already-serialised JSON row per card (`rows text[]`). A request is one
//! primary-key read; Postgres cuts the array to the requested window and the
//! body is assembled by joining bytes, never by parsing the rows. The rows are
//! exactly what the live route emitted, so the JSON body is byte-identical.
//!
//! | kind | key | head | rows |
//! | --- | --- | --- | --- |
//! | `set` | set slug | `{"expansion":…,"total":n}` | expansion-page `cards` |
//! | `artist` | artist slug | `{"artist":…,"profile":…}` | artist-cards `cards` (tiles=1) |
//! | `version` | `pokoin_version_sets.version` | `{"version":…,"versionCount":n}` | version-set `printings` |
//! | `set-index` | `all` | `{"game":…}` | expansion-page `expansions` |
//! | `related` | public card id | `{}` | at most 12 related tile rows, best first |
//!
//! A snapshot the builder has not confirmed within the kind's freshness window
//! is ignored and the route answers from its live query, so a stopped CronJob
//! degrades to today's behaviour instead of serving old prices forever.

use pokoin_api_common::stages;
use serde_json::Value;
use sqlx::PgPool;

pub const TABLE: &str = "marketplace_page_snapshots";

pub const DDL: &str = "
create table if not exists public.marketplace_page_snapshots (
  kind text not null,
  key text not null,
  head text not null,
  rows text[] not null,
  c1 bytea,
  version text not null,
  built_at timestamptz not null default now(),
  checked_at timestamptz not null default now(),
  primary key (kind, key)
);
";

pub const SET: &str = "set";
pub const ARTIST: &str = "artist";
pub const VERSION: &str = "version";
pub const SET_INDEX: &str = "set-index";
pub const RELATED: &str = "related";

/// Seconds a snapshot stays servable after the builder last confirmed it.
pub fn max_age(kind: &str) -> i64 {
    match kind {
        // build-lists-sets runs every 15 min.
        SET | SET_INDEX => 2 * 3600,
        // build-lists-artists runs daily (04:30); a missed night still serves.
        ARTIST => 2 * 86_400,
        // build-lists-versions runs hourly.
        VERSION => 6 * 3600,
        // Daily full rebuild; a card's neighbours are catalogue facts.
        _ => 3 * 86_400,
    }
}

/// Sent by the list builder so routes answer from their live query instead of
/// the snapshot the builder is about to replace.
pub const BUILD_HEADER: &str = "x-pokoin-list-build";

/// `[a-z0-9._-]{1,400}`, lowercased: the only keys the builder stores.
pub fn clean_key(raw: &str) -> Option<String> {
    let key = raw.trim().to_ascii_lowercase();
    let ok = !key.is_empty()
        && key.len() <= 400
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    ok.then_some(key)
}

#[derive(Debug, Clone, Default)]
pub struct Page {
    pub head: Value,
    /// The requested window of rows, each one serialised JSON object.
    pub rows: Vec<String>,
    /// Rows in the whole snapshot.
    pub row_count: usize,
    /// Stored `c1` of the whole snapshot body, when the builder kept one.
    pub c1: Option<Vec<u8>>,
}

type Row = (String, Vec<String>, i32, Option<Vec<u8>>);

fn page(row: Row) -> Option<Page> {
    let (head, rows, row_count, c1) = row;
    Some(Page { head: serde_json::from_str(&head).ok()?, rows, row_count: row_count.max(0) as usize, c1 })
}

/// Tables the builder has not created yet (a new game database, a release
/// deployed before its first build) are simply "no snapshot".
fn tolerated<T>(result: Result<Option<T>, sqlx::Error>) -> Option<T> {
    match result {
        Ok(row) => row,
        Err(error) => {
            if !error.as_database_error().is_some_and(|e| e.code().as_deref() == Some("42P01")) {
                tracing::warn!(%error, "page snapshot read failed");
            }
            None
        }
    }
}

/// Rows `[offset, offset + limit)` of one snapshot. `None` when it is missing
/// or stale; the caller then runs its live query.
pub async fn read(pool: &PgPool, kind: &str, key: &str, offset: i64, limit: i64, with_c1: bool) -> Option<Page> {
    let from = offset.max(0) + 1;
    let to = offset.max(0) + limit.max(0);
    let row = stages::timed(
        stages::SQL,
        sqlx::query_as::<_, Row>(
            "select head, rows[$3:$4], coalesce(cardinality(rows), 0), case when $6 then c1 end
             from public.marketplace_page_snapshots
             where kind = $1 and key = $2 and checked_at > now() - make_interval(secs => $5)",
        )
        .bind(kind)
        .bind(key)
        .bind(from as i32)
        .bind(to as i32)
        .bind(max_age(kind) as f64)
        .bind(with_c1)
        .fetch_optional(pool),
    )
    .await;
    let found = page(tolerated(row)?)?;
    stages::source("snapshot");
    Some(found)
}

/// The version-set snapshot of the set a card belongs to, in one statement.
pub async fn read_version_of_card(pool: &PgPool, card_id: i64) -> Option<Page> {
    let row = stages::timed(
        stages::SQL,
        sqlx::query_as::<_, Row>(
            "select s.head, s.rows, coalesce(cardinality(s.rows), 0), null::bytea
             from public.marketplace_search_candidates c
             join public.marketplace_page_snapshots s on s.kind = 'version' and s.key = c.version
             where c.card_id = $1 and s.checked_at > now() - make_interval(secs => $2)",
        )
        .bind(card_id)
        .bind(max_age(VERSION) as f64)
        .fetch_optional(pool),
    )
    .await;
    let found = page(tolerated(row)?)?;
    stages::source("snapshot");
    Some(found)
}

/// Serialise like `serde_json::to_string(&Value)` so assembled bodies match
/// what the live handler writes.
pub fn text(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

/// Incremental body writer: `{"k":<raw>,"cards":[<rows>],…}`.
pub struct Body(Vec<u8>);

impl Body {
    pub fn with_capacity(rows: &[String]) -> Self {
        let mut out = Vec::with_capacity(rows.iter().map(|r| r.len() + 1).sum::<usize>() + 1024);
        out.push(b'{');
        Self(out)
    }

    fn key(&mut self, name: &str) {
        if self.0.len() > 1 {
            self.0.push(b',');
        }
        self.0.push(b'"');
        self.0.extend_from_slice(name.as_bytes());
        self.0.extend_from_slice(b"\":");
    }

    pub fn value(mut self, name: &str, value: &Value) -> Self {
        self.key(name);
        self.0.extend_from_slice(text(value).as_bytes());
        self
    }

    pub fn rows(mut self, name: &str, rows: &[String]) -> Self {
        self.key(name);
        self.0.push(b'[');
        for (i, row) in rows.iter().enumerate() {
            if i > 0 {
                self.0.push(b',');
            }
            self.0.extend_from_slice(row.as_bytes());
        }
        self.0.push(b']');
        self
    }

    pub fn finish(mut self) -> Vec<u8> {
        self.0.push(b'}');
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_are_slugs_only() {
        assert_eq!(clean_key(" Base-Set ").as_deref(), Some("base-set"));
        assert!(clean_key("a/b").is_none());
        assert!(clean_key("").is_none());
    }

    #[test]
    fn an_assembled_body_is_what_serde_writes() {
        let cards = vec![json!({"id": "1", "name": "Pikachu \"ex\"", "price": 3.5}), json!({"id": "2", "name": "Flabébé", "price": null})];
        let rows: Vec<String> = cards.iter().map(text).collect();
        let expansion = json!({"name": "Base Set", "slug": "base-set", "cardCount": 102});
        let assembled = Body::with_capacity(&rows)
            .value("expansion", &expansion)
            .rows("cards", &rows)
            .value("productType", &json!("card"))
            .value("limit", &json!(120))
            .finish();
        let live = json!({"expansion": expansion, "cards": cards, "productType": "card", "limit": 120});
        assert_eq!(String::from_utf8(assembled).unwrap(), live.to_string());
    }

    #[test]
    fn an_empty_window_is_an_empty_array() {
        let body = Body::with_capacity(&[]).rows("cards", &[]).finish();
        assert_eq!(body, b"{\"cards\":[]}");
    }
}
