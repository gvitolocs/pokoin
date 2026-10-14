use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

pub async fn pool(url: &str, max: u32) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(max.max(1))
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect(url)
        .await
}

/// Per-pool cap for one satellite game database (`pokoin_magic`, …).
pub const GAME_POOL_MAX_ENV: &str = "POKOIN_RUST_GAME_DB_POOL_MAX";
/// Seconds an idle satellite connection is kept before it is closed.
pub const GAME_POOL_IDLE_ENV: &str = "POKOIN_RUST_GAME_DB_IDLE_SECS";

/// How many connections a process may hold per satellite game database.
///
/// All ~24 satellite databases live on the one nezopt writer
/// (`max_connections` 120), shared with the Pi, every overflow pod and the
/// batch jobs. Satellite traffic is light and bursty, so each process keeps
/// one small pool per game and lets idle connections go quickly; see
/// docs/RUST_RUNTIME.md "Postgres connection budget".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SatelliteBudget {
    pub max_connections: u32,
    pub idle_timeout: Duration,
}

impl SatelliteBudget {
    pub const DEFAULT_MAX: u32 = 2;
    /// Ceiling for an env override: a satellite never needs a big pool.
    pub const MAX_CAP: u32 = 4;
    pub const DEFAULT_IDLE: Duration = Duration::from_secs(45);
    pub const IDLE_RANGE_SECS: (u64, u64) = (5, 300);
    /// Recycle long-lived connections so a pool never pins a backend forever.
    pub const MAX_LIFETIME: Duration = Duration::from_secs(30 * 60);
    pub const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(3);

    pub fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Unparseable values fall back to the defaults; numbers are clamped.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        let max_connections = get(GAME_POOL_MAX_ENV)
            .and_then(|value| value.trim().parse::<u32>().ok())
            .unwrap_or(Self::DEFAULT_MAX)
            .clamp(1, Self::MAX_CAP);
        let (low, high) = Self::IDLE_RANGE_SECS;
        let idle_timeout = get(GAME_POOL_IDLE_ENV)
            .and_then(|value| value.trim().parse::<u64>().ok())
            .map(|secs| Duration::from_secs(secs.clamp(low, high)))
            .unwrap_or(Self::DEFAULT_IDLE);
        Self { max_connections, idle_timeout }
    }

    pub fn options(self) -> PgPoolOptions {
        PgPoolOptions::new()
            .max_connections(self.max_connections)
            .min_connections(0)
            .idle_timeout(Some(self.idle_timeout))
            .max_lifetime(Some(Self::MAX_LIFETIME))
            .acquire_timeout(Self::ACQUIRE_TIMEOUT)
    }
}

static BUDGET: LazyLock<SatelliteBudget> = LazyLock::new(SatelliteBudget::from_env);
static SATELLITES: LazyLock<Mutex<HashMap<String, PgPool>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The process-wide budget, read once from the environment.
pub fn satellite_budget() -> SatelliteBudget {
    *BUDGET
}

/// The one lazy pool for a satellite game database URL, shared by every crate
/// in the process so the per-game cap holds for the whole process rather than
/// once per route crate. Never dials until first use.
pub fn satellite_pool(url: &str) -> Result<PgPool, sqlx::Error> {
    let mut pools = SATELLITES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(pool) = pools.get(url) {
        if !pool.is_closed() {
            return Ok(pool.clone());
        }
    }
    let pool = satellite_budget().options().connect_lazy(url)?;
    pools.insert(url.to_owned(), pool.clone());
    Ok(pool)
}

/// Close and forget a satellite pool (batch jobs walking game by game).
pub async fn close_satellite(url: &str) {
    let pool = SATELLITES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(url);
    if let Some(pool) = pool {
        pool.close().await;
    }
}

/// `(pools, open connections, idle connections)` over every satellite pool.
pub fn satellite_stats() -> (usize, u32, u32) {
    let pools = SATELLITES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    pools.values().fold((pools.len(), 0, 0), |(count, size, idle), pool| {
        (count, size + pool.size(), idle + pool.num_idle() as u32)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| value.to_string())
    }

    #[test]
    fn defaults_are_two_connections_and_45s_idle() {
        let budget = SatelliteBudget::from_lookup(lookup(&[]));
        assert_eq!(budget, SatelliteBudget { max_connections: 2, idle_timeout: Duration::from_secs(45) });
    }

    #[test]
    fn env_overrides_are_clamped() {
        let one = SatelliteBudget::from_lookup(lookup(&[(GAME_POOL_MAX_ENV, "1"), (GAME_POOL_IDLE_ENV, "30")]));
        assert_eq!(one, SatelliteBudget { max_connections: 1, idle_timeout: Duration::from_secs(30) });
        let wild = SatelliteBudget::from_lookup(lookup(&[(GAME_POOL_MAX_ENV, "16"), (GAME_POOL_IDLE_ENV, "86400")]));
        assert_eq!(wild, SatelliteBudget { max_connections: 4, idle_timeout: Duration::from_secs(300) });
        let zero = SatelliteBudget::from_lookup(lookup(&[(GAME_POOL_MAX_ENV, "0"), (GAME_POOL_IDLE_ENV, "0")]));
        assert_eq!(zero, SatelliteBudget { max_connections: 1, idle_timeout: Duration::from_secs(5) });
        let junk = SatelliteBudget::from_lookup(lookup(&[(GAME_POOL_MAX_ENV, "lots"), (GAME_POOL_IDLE_ENV, "")]));
        assert_eq!(junk, SatelliteBudget::from_lookup(lookup(&[])));
    }

    #[test]
    fn options_release_idle_connections() {
        let options = SatelliteBudget { max_connections: 2, idle_timeout: Duration::from_secs(45) }.options();
        assert_eq!(options.get_max_connections(), 2);
        assert_eq!(options.get_min_connections(), 0);
        assert_eq!(options.get_idle_timeout(), Some(Duration::from_secs(45)));
        assert_eq!(options.get_max_lifetime(), Some(SatelliteBudget::MAX_LIFETIME));
        assert_eq!(options.get_acquire_timeout(), SatelliteBudget::ACQUIRE_TIMEOUT);
    }

    #[tokio::test]
    async fn one_shared_pool_per_url_until_closed() {
        let magic = "postgres://u@127.0.0.1:1/pokoin_test_magic";
        let yugioh = "postgres://u@127.0.0.1:1/pokoin_test_yugioh";
        let first = satellite_pool(magic).expect("lazy pool");
        let again = satellite_pool(magic).expect("lazy pool");
        let other = satellite_pool(yugioh).expect("lazy pool");
        // Clones of one pool share its options and its connection count.
        assert_eq!(first.options().get_max_connections(), satellite_budget().max_connections);
        assert_eq!(first.size(), 0, "lazy: never dials");
        first.close().await;
        assert!(again.is_closed(), "same URL must be the same pool");
        assert!(!other.is_closed());
        // A closed pool is replaced, not handed out again.
        assert!(!satellite_pool(magic).expect("fresh pool").is_closed());
        close_satellite(yugioh).await;
        assert!(other.is_closed());
        close_satellite(magic).await;
    }
}
