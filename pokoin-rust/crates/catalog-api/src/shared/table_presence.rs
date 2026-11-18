//! Does the database behind this pool have that table?
//!
//! Several price-history sources live only in the Pokémon database
//! (`pokoin_marketplace`); a satellite game's catalog database does not have
//! them, and Postgres logs an ERROR for every query that asks for one (PH-02).
//! Readers here ask first with a statement that cannot fail on a missing
//! relation and cache the answer per database and table, so a request normally
//! costs no extra round trip and no error line.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use pokoin_api_common::pg::{self, Bind};
use serde_json::Value;
use sqlx::PgPool;

/// The existence probe: `to_regclass` yields NULL for a missing relation, so
/// the statement never errors, and the qualified name is a bind parameter.
pub const PROBE_SQL: &str = "select to_regclass($1) is not null as present";

/// How long a probed answer is trusted. Tables are created by an explicit
/// migration, never between two requests, so ten minutes costs nothing.
pub const PROBE_TTL: Duration = Duration::from_secs(10 * 60);

/// What the probe said about one table of one database.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presence {
    /// The database has the table: the reader may query it.
    Present,
    /// It does not: answer the source's no-data block and send no query.
    Missing,
    /// The probe itself failed: answer the source's unavailable block.
    ProbeFailed,
}

/// `guarded` runs the reader only when the table is there, so a database
/// without it answers its no-data (`no_data`) or unavailable (`unavailable`)
/// block and never reaches Postgres.
pub async fn guarded<T, Fut, Q, N, U>(presence: Presence, query: Q, no_data: N, unavailable: U) -> T
where
    Fut: Future<Output = T>,
    Q: FnOnce() -> Fut,
    N: FnOnce() -> T,
    U: FnOnce() -> T,
{
    match presence {
        Presence::Present => query().await,
        Presence::Missing => no_data(),
        Presence::ProbeFailed => unavailable(),
    }
}

type Key = (String, String);

/// The answers of every (database, table) pair, each with the moment it was
/// probed.
pub struct PresenceCache {
    ttl: Duration,
    entries: Mutex<HashMap<Key, (Presence, Instant)>>,
}

impl PresenceCache {
    fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// The stored answer of `key`, when it is younger than the cache's TTL.
    fn stored(&self, key: &Key, now: Instant) -> Option<Presence> {
        let entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        let (presence, probed_at) = *entries.get(key)?;
        (now.duration_since(probed_at) < self.ttl).then_some(presence)
    }

    /// Remember `presence` as of `now`. A failed probe says nothing about the
    /// table, so it is not stored.
    fn remember(&self, key: Key, presence: Presence, now: Instant) {
        if presence == Presence::ProbeFailed {
            return;
        }
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key, (presence, now));
    }

    /// The stored answer of `key`, or `probe`'s outcome stored for the TTL.
    async fn resolve<F, Fut>(&self, key: Key, probe: F) -> Presence
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Presence>,
    {
        if let Some(presence) = self.stored(&key, Instant::now()) {
            return presence;
        }
        let presence = probe().await;
        self.remember(key, presence, Instant::now());
        presence
    }
}

fn cache() -> &'static PresenceCache {
    static CACHE: OnceLock<PresenceCache> = OnceLock::new();
    CACHE.get_or_init(|| PresenceCache::new(PROBE_TTL))
}

/// Which database a pool talks to, so two pools of one database share one
/// cached answer and two databases never share the wrong one.
fn database_key(pool: &PgPool) -> String {
    let options = pool.connect_options();
    let server = match options.get_socket() {
        Some(socket) => socket.display().to_string(),
        None => format!("{}:{}", options.get_host(), options.get_port()),
    };
    match options.get_database() {
        Some(database) => format!("{server}/{database}"),
        None => server,
    }
}

/// The one round trip behind `PROBE_SQL`.
async fn probe(pool: &PgPool, table: &str) -> Presence {
    let rows = match pg::pool_rows(pool, PROBE_SQL, &[Bind::Text(table.to_owned())]).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(table, %error, "table presence probe failed");
            return Presence::ProbeFailed;
        }
    };
    match rows
        .first()
        .and_then(|row| row.get("present"))
        .and_then(Value::as_bool)
    {
        Some(true) => Presence::Present,
        Some(false) => Presence::Missing,
        // A probe that answered nothing cannot be trusted either way.
        None => {
            tracing::warn!(table, "table presence probe answered no row");
            Presence::ProbeFailed
        }
    }
}

/// The presence of the qualified `table` (e.g. `public.fx_rates_daily`) in the
/// database behind `pool`, answered from the cache when probed within
/// [`PROBE_TTL`].
pub async fn presence(pool: &PgPool, table: &str) -> Presence {
    cache()
        .resolve(database_key(pool), || probe(pool, table))
        .await
}

/// Fold the answers of several tables into the one a reader acts on: any
/// missing table blocks the query, and a failed probe blocks it as
/// unavailable rather than pretending the table is absent.
fn combine(asked: Presence, next: Presence) -> Presence {
    match (asked, next) {
        (Presence::Missing, _) | (_, Presence::Missing) => Presence::Missing,
        (Presence::ProbeFailed, _) | (_, Presence::ProbeFailed) => Presence::ProbeFailed,
        _ => Presence::Present,
    }
}

/// The presence a reader of a statement that joins `tables` acts on.
pub async fn presence_all(pool: &PgPool, tables: &[&str]) -> Presence {
    let mut outcome = Presence::Present;
    for table in tables {
        outcome = combine(outcome, presence(pool, table).await);
        if outcome == Presence::Missing {
            return outcome;
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn key(database: &str, table: &str) -> Key {
        (database.to_owned(), table.to_owned())
    }

    #[test]
    fn probe_binds_the_qualified_name() {
        assert!(PROBE_SQL.contains("to_regclass($1)"), "{PROBE_SQL}");
        assert_eq!(PROBE_SQL.matches('$').count(), 1, "{PROBE_SQL}");
        assert!(!PROBE_SQL.contains("cardtrader_blueprint_daily_analytics"));
    }

    #[test]
    fn a_stored_answer_lives_until_the_ttl() {
        let cache = PresenceCache::new(PROBE_TTL);
        let start = Instant::now();
        let asked = key("localhost:5432/pokoin_magic", "public.fx_rates_daily");
        cache.remember(asked.clone(), Presence::Missing, start);
        assert_eq!(cache.stored(&asked, start), Some(Presence::Missing));
        assert_eq!(
            cache.stored(&asked, start + PROBE_TTL - Duration::from_millis(1)),
            Some(Presence::Missing)
        );
        // Past ten minutes the answer is gone and the reader probes again.
        assert_eq!(cache.stored(&asked, start + PROBE_TTL), None);
        // Another table and another database of the same server never share it.
        for other in [
            key(
                "localhost:5432/pokoin_magic",
                "public.cardtrader_sold_daily",
            ),
            key("localhost:5432/pokoin_marketplace", "public.fx_rates_daily"),
        ] {
            assert_eq!(cache.stored(&other, start), None, "{other:?}");
        }
    }

    #[tokio::test]
    async fn resolve_probes_once_per_ttl() {
        let cache = PresenceCache::new(PROBE_TTL);
        let asked = key("localhost:5432/pokoin_magic", "public.fx_rates_daily");
        let probes = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&probes);
        let probe = move || {
            let count = Arc::clone(&count);
            async move {
                count.fetch_add(1, Ordering::SeqCst);
                Presence::Missing
            }
        };
        assert_eq!(cache.resolve(asked.clone(), probe).await, Presence::Missing);
        // The second reader of the same table is served from the cache.
        let count = Arc::clone(&probes);
        assert_eq!(
            cache
                .resolve(asked.clone(), move || {
                    let count = Arc::clone(&count);
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        Presence::Present
                    }
                })
                .await,
            Presence::Missing
        );
        assert_eq!(probes.load(Ordering::SeqCst), 1, "probed once per TTL");
    }

    #[tokio::test]
    async fn resolve_probes_again_once_the_answer_is_old() {
        let cache = PresenceCache::new(Duration::ZERO);
        let asked = key("localhost:5432/pokoin_magic", "public.fx_rates_daily");
        let probes = Arc::new(AtomicUsize::new(0));
        for _ in 0..2 {
            let count = Arc::clone(&probes);
            assert_eq!(
                cache
                    .resolve(asked.clone(), move || {
                        let count = Arc::clone(&count);
                        async move {
                            count.fetch_add(1, Ordering::SeqCst);
                            Presence::Missing
                        }
                    })
                    .await,
                Presence::Missing
            );
        }
        assert_eq!(
            probes.load(Ordering::SeqCst),
            2,
            "an expired answer is re-probed"
        );
    }

    #[tokio::test]
    async fn a_failed_probe_is_never_stored() {
        let cache = PresenceCache::new(PROBE_TTL);
        let asked = key("localhost:5432/pokoin_down", "public.fx_rates_daily");
        for expected in [Presence::ProbeFailed, Presence::Present] {
            let count = Arc::new(AtomicUsize::new(0));
            let probes = Arc::clone(&count);
            assert_eq!(
                cache
                    .resolve(asked.clone(), move || {
                        let probes = Arc::clone(&probes);
                        async move {
                            probes.fetch_add(1, Ordering::SeqCst);
                            expected
                        }
                    })
                    .await,
                expected
            );
            assert_eq!(
                count.load(Ordering::SeqCst),
                1,
                "{expected:?} always probes"
            );
        }
    }

    /// A blocked reader must not reach the query at all.
    #[tokio::test]
    async fn guarded_queries_only_a_present_table() {
        for (presence, expected_calls, expected) in [
            (Presence::Present, 1, "queried"),
            (Presence::Missing, 0, "empty"),
            (Presence::ProbeFailed, 0, "unavailable"),
        ] {
            let calls = Arc::new(AtomicUsize::new(0));
            let counted = Arc::clone(&calls);
            let block = guarded(
                presence,
                move || async move {
                    counted.fetch_add(1, Ordering::SeqCst);
                    "queried"
                },
                || "empty",
                || "unavailable",
            )
            .await;
            assert_eq!(block, expected, "{presence:?}");
            assert_eq!(calls.load(Ordering::SeqCst), expected_calls, "{presence:?}");
        }
    }

    #[test]
    fn combine_blocks_on_the_first_absent_table() {
        use Presence::{Missing, Present, ProbeFailed};
        assert_eq!(combine(Present, Present), Present);
        assert_eq!(combine(Present, Missing), Missing);
        assert_eq!(combine(Missing, ProbeFailed), Missing);
        assert_eq!(combine(Present, ProbeFailed), ProbeFailed);
        assert_eq!(combine(ProbeFailed, Missing), Missing);
        assert_eq!(combine(ProbeFailed, Present), ProbeFailed);
    }

    #[tokio::test]
    async fn an_unreachable_database_is_a_failed_probe() {
        // Nothing listens on 127.0.0.1:1, so the probe fails without a
        // connection: PH-02 must read that as "cannot tell", never as "the
        // table is not there" (which would answer no data and hide an outage).
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_millis(50))
            .connect_lazy("postgres://pokoin_test@127.0.0.1:1/postgres")
            .expect("lazy pool");
        assert_eq!(
            presence(&pool, "public.fx_rates_daily").await,
            Presence::ProbeFailed
        );
        assert_eq!(
            presence_all(
                &pool,
                &["public.fx_rates_daily", "public.cardtrader_sold_daily"]
            )
            .await,
            Presence::ProbeFailed
        );
    }
}
