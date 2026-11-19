//! What the gate does to a real pool of four connections.
//!
//! ```text
//! docker run -d --rm --name pokoin-gate-test-pg \
//!   -e POSTGRES_PASSWORD=test -p 127.0.0.1:55478:5432 \
//!   --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55478/postgres \
//!   cargo test -p pokoin-db --test gate_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped; the CI `flow-db` job
//! runs it against a fresh database.
//!
//! Forty search-page-shaped requests (two `pg_sleep(0.5)` statements each) come
//! in at once against `pokoin_db::pool`'s 4 connections and 3 s acquire timeout.
//! Behind a 1-slot gate the overflow is refused by the gate inside its own wait
//! limit, and a card-page read — one `select 1` every 100 ms, the route that
//! must not notice the flood — still answers each of its 20 statements in well
//! under a second, never on `PoolTimedOut`. The same flood with the gate open is
//! the control: it queues behind itself, and that queue is what the production
//! pool turned into `pool timed out while waiting for an open connection`.
//!
//! This binary holds exactly one test: both phases share one database and one
//! pool, and a second test running alongside would be the flood.

use std::sync::Arc;
use std::time::{Duration, Instant};

use pokoin_db::Gate;
use sqlx::{Executor, PgPool};

/// The two statements one search-page request runs at its slowest.
const SLOW_STATEMENTS: u32 = 2;
/// How long each of them holds its connection.
const SLEEP: Duration = Duration::from_millis(500);
const SLEEP_SQL: &str = "select pg_sleep(0.5)";
const FLOOD: usize = 40;
/// One `select 1` every 100 ms, which is roughly how often a card-page request
/// reaches the pool while search pages are coming in.
const PROBE_ROUNDS: usize = 20;
const PROBE_GAP: Duration = Duration::from_millis(100);
/// A connection is "worth waiting for" past a second: the probe's own budget,
/// and less than the pool's 3 s timeout, so the two cases cannot both pass it.
const SLOW_ACQUIRE: Duration = Duration::from_secs(1);

#[derive(Debug)]
struct Flood {
    /// Requests that got a slot and ran their statements.
    ran: usize,
    /// Requests the gate refused.
    busy: usize,
    /// Requests that met the pool's own timeout waiting for a connection.
    pool_timeouts: usize,
    /// Requests that waited over a second to be given a connection.
    slow_acquire: usize,
    max_acquire: Duration,
}

/// `SLOW_STATEMENTS` sleeps, timed from the moment the request asked for a
/// connection. An error is the pool's answer, not this function's.
async fn slow_work(pool: &PgPool) -> Result<Duration, sqlx::Error> {
    let started = Instant::now();
    let mut conn = pool.acquire().await?;
    let acquired = started.elapsed();
    for _ in 0..SLOW_STATEMENTS {
        conn.execute(SLEEP_SQL).await?;
    }
    Ok(acquired)
}

enum Outcome {
    /// Ran its statements; how long the connection took to arrive.
    Ran(Duration),
    /// The gate refused it inside its own wait limit.
    Busy,
    /// The pool refused it on `PoolTimedOut`.
    TimedOut,
}

impl Outcome {
    fn of(acquired: Result<Duration, sqlx::Error>) -> Self {
        match acquired {
            Ok(acquired) => Self::Ran(acquired),
            Err(sqlx::Error::PoolTimedOut) => Self::TimedOut,
            Err(error) => panic!("the flood failed for another reason: {error}"),
        }
    }
}

async fn flood(pool: PgPool, gate: Option<Arc<Gate>>) -> Flood {
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..FLOOD {
        let (pool, gate) = (pool.clone(), gate.clone());
        tasks.spawn(async move {
            match gate {
                Some(gate) => match gate.run(slow_work(&pool)).await {
                    Ok(acquired) => Outcome::of(acquired),
                    Err(_busy) => Outcome::Busy,
                },
                None => Outcome::of(slow_work(&pool).await),
            }
        });
    }
    let mut out = Flood {
        ran: 0,
        busy: 0,
        pool_timeouts: 0,
        slow_acquire: 0,
        max_acquire: Duration::ZERO,
    };
    while let Some(joined) = tasks.join_next().await {
        match joined.expect("a flood task panicked") {
            Outcome::Ran(acquired) => {
                out.ran += 1;
                out.max_acquire = out.max_acquire.max(acquired);
                if acquired > SLOW_ACQUIRE {
                    out.slow_acquire += 1;
                }
            }
            Outcome::TimedOut => out.pool_timeouts += 1,
            Outcome::Busy => out.busy += 1,
        }
    }
    out
}

/// The card-page read: one statement, `rounds` times, spaced out.
async fn card_page(pool: PgPool, rounds: usize) -> (Vec<Duration>, usize) {
    let mut times = Vec::with_capacity(rounds);
    let mut timeouts = 0;
    for _ in 0..rounds {
        let started = Instant::now();
        match pool.fetch_one("select 1").await {
            Ok(_) => times.push(started.elapsed()),
            Err(sqlx::Error::PoolTimedOut) => timeouts += 1,
            Err(error) => panic!("the card-page read failed: {error}"),
        }
        tokio::time::sleep(PROBE_GAP).await;
    }
    (times, timeouts)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_slot_keeps_a_connection_free_for_every_other_route() {
    let Some(url) = std::env::var("POKOIN_TEST_DATABASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    let pool = pokoin_db::pool(&url, 4).await.expect("test pool");
    let gate = Arc::new(Gate::new(1, Duration::from_secs(2)));

    let (gated, probe) = tokio::join!(
        flood(pool.clone(), Some(gate.clone())),
        card_page(pool.clone(), PROBE_ROUNDS),
    );
    assert!(
        gated.ran > 0,
        "a free slot still admits a request: {gated:?}"
    );
    assert!(
        gated.busy > 0,
        "one slot cannot carry {FLOOD} concurrent requests without shedding: {gated:?}"
    );
    assert_eq!(
        gated.pool_timeouts, 0,
        "the gate refused the overflow, never the pool: {gated:?}"
    );
    assert_eq!(
        gated.slow_acquire, 0,
        "no request queued behind another for a connection (slowest {:?}): {gated:?}",
        gated.max_acquire,
    );
    let (times, timeouts) = probe;
    assert_eq!(timeouts, 0, "card-page never hit the pool's 3 s timeout");
    assert_eq!(times.len(), PROBE_ROUNDS);
    for (round, took) in times.iter().enumerate() {
        assert!(
            took < &SLOW_ACQUIRE,
            "card-page read {round} waited {took:?} while the gate held one slot: {times:?}",
        );
    }
    assert!(
        gate.waited() >= gated.busy as u64,
        "every shed caller queued first: {}",
        gate.waited()
    );
    assert_eq!(gate.shed() as usize, gated.busy);

    // The control: the same flood with the door open. Nothing is shed, so the
    // 4 connections carry it and the rest waits — which is the state that made
    // every other route time out on production.
    let control = flood(pool.clone(), None).await;
    assert_eq!(control.busy, 0, "an ungated flood is not refused by a gate");
    assert!(
        control.pool_timeouts > 0 || control.slow_acquire > 0,
        "4 connections carrying {FLOOD} requests of two {SLEEP:?} statements must queue: {control:?}",
    );
    // The numbers the assertions above are made of, for whoever reads the log.
    eprintln!("gated {gated:?}\ncontrol {control:?}");
    drop(pool);
}
