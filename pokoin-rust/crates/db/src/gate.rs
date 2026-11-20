//! A bounded door in front of one pool's database work: `slots` requests run at
//! once, a later one waits a bounded time for a free slot and is then shed
//! without ever touching the pool.
//!
//! Why: the catalogue pool (`state.db`, 16 connections on the Pi) is shared by
//! card-page, card-tiles, search-page and list, and one slow request that holds
//! connections does so at the expense of every other route. Measured on
//! production over one hour on 2026-11-19, 142 of the API's 177 errors were
//! `pool timed out while waiting for an open connection` — the pool's 3 s
//! acquire timeout firing for requests that queued behind slow search pages.
//! A gate bounds how much of the pool a route may take and sheds the overflow in
//! its own wait limit instead of making the pool wait 3 s for a connection.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// [`Gate::run`]'s answer when every slot was still busy when the wait limit ran
/// out. The future was never polled, so nothing it would have done happened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Busy {
    /// How long the request waited for a free slot before it was shed.
    pub waited_ms: u64,
}

/// `slots` futures hold a slot at once; a later caller waits up to `wait_limit`
/// and is shed after that. Counters for `GET /metrics`.
pub struct Gate {
    permits: Arc<Semaphore>,
    wait_limit: Duration,
    slots: u32,
    waited: AtomicU64,
    shed: AtomicU64,
}

impl Gate {
    /// A `slots` of 0 means one: a gate that admits nothing would shed every
    /// request, which is never what a deployment means to ask for.
    pub fn new(slots: u32, wait_limit: Duration) -> Self {
        let slots = slots.max(1);
        Self {
            permits: Arc::new(Semaphore::new(slots as usize)),
            wait_limit,
            slots,
            waited: AtomicU64::new(0),
            shed: AtomicU64::new(0),
        }
    }

    pub const fn slots(&self) -> u32 {
        self.slots
    }

    pub const fn wait_limit(&self) -> Duration {
        self.wait_limit
    }

    /// Requests that found every slot busy and had to wait, whether they then
    /// got in or were shed.
    pub fn waited(&self) -> u64 {
        self.waited.load(Ordering::Relaxed)
    }

    /// Requests that were shed because a slot stayed busy for the whole wait.
    pub fn shed(&self) -> u64 {
        self.shed.load(Ordering::Relaxed)
    }

    /// Run `fut` with a slot to itself, or return [`Busy`] without polling `fut`
    /// once. A free slot is taken immediately and never counted as a wait.
    pub async fn run<F: Future>(&self, fut: F) -> Result<F::Output, Busy> {
        if let Ok(permit) = self.permits.try_acquire() {
            let output = fut.await;
            drop(permit);
            return Ok(output);
        }
        self.waited.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        match tokio::time::timeout(self.wait_limit, self.permits.acquire()).await {
            Ok(Ok(permit)) => {
                let output = fut.await;
                drop(permit);
                Ok(output)
            }
            // The `Ok(Err)` arm is a closed semaphore; a gate is never closed.
            Ok(Err(_)) | Err(_) => {
                self.shed.fetch_add(1, Ordering::Relaxed);
                Err(Busy {
                    waited_ms: started.elapsed().as_millis() as u64,
                })
            }
        }
    }

    /// Take every slot and keep them, so a caller can stand where a full gate
    /// stands. Releasing the guard hands the slots back.
    pub async fn hold(&self) -> Held {
        let mut permits = Vec::with_capacity(self.slots as usize);
        for _ in 0..self.slots {
            match self.permits.clone().acquire_owned().await {
                Ok(permit) => permits.push(permit),
                Err(_closed) => break,
            }
        }
        Held { _permits: permits }
    }
}

/// The slots [`Gate::hold`] took; dropping it gives them back.
pub struct Held {
    _permits: Vec<OwnedSemaphorePermit>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    const SLOT_SLEEP: Duration = Duration::from_millis(200);
    const CALLERS: usize = 50;

    /// One future that records how many callers are inside it at once and how
    /// many ever got inside at all.
    #[derive(Clone)]
    struct Watch {
        inside: Arc<AtomicUsize>,
        high: Arc<AtomicUsize>,
        runs: Arc<AtomicUsize>,
    }

    impl Watch {
        fn new() -> Self {
            Self {
                inside: Arc::new(AtomicUsize::new(0)),
                high: Arc::new(AtomicUsize::new(0)),
                runs: Arc::new(AtomicUsize::new(0)),
            }
        }

        async fn sleep_200ms(self) {
            let now = self.inside.fetch_add(1, Ordering::SeqCst) + 1;
            self.high.fetch_max(now, Ordering::SeqCst);
            self.runs.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(SLOT_SLEEP).await;
            self.inside.fetch_sub(1, Ordering::SeqCst);
        }
    }

    /// 50 concurrent callers, 2 slots, a 200 ms future each: never more inside
    /// at once than there are slots, and the wait limit is long enough that
    /// nothing is shed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_slots_never_let_three_requests_in_at_once() {
        let gate = Arc::new(Gate::new(2, Duration::from_secs(30)));
        let watch = Watch::new();
        let mut tasks = Vec::new();
        for _ in 0..CALLERS {
            let (gate, watch) = (gate.clone(), watch.clone());
            tasks.push(tokio::spawn(async move {
                gate.run(watch.sleep_200ms()).await.is_ok()
            }));
        }
        let mut ok = 0_usize;
        for task in tasks {
            if task.await.unwrap_or(false) {
                ok += 1;
            }
        }
        assert_eq!(ok, CALLERS, "a 30 s wait never sheds");
        assert_eq!(
            watch.runs.load(Ordering::SeqCst),
            CALLERS,
            "every caller ran"
        );
        assert_eq!(
            watch.high.load(Ordering::SeqCst),
            2,
            "two slots, never a third"
        );
        assert_eq!(gate.shed(), 0);
        // The first two came straight in; the rest of a flood that starts
        // together queued. A late poll may still find a free slot, so this is a
        // floor, not an exact count.
        assert!(gate.waited() >= 40, "the flood queued: {}", gate.waited());
    }

    /// The same flood behind a 100 ms wait: what cannot enter returns busy, and
    /// it returns busy without having run.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_full_gate_sheds_the_overflow_without_running_it() {
        let gate = Arc::new(Gate::new(2, Duration::from_millis(100)));
        let watch = Watch::new();
        let mut tasks = Vec::new();
        for _ in 0..CALLERS {
            let (gate, watch) = (gate.clone(), watch.clone());
            tasks.push(tokio::spawn(async move {
                gate.run(watch.sleep_200ms()).await.is_ok()
            }));
        }
        let mut ok = 0_usize;
        let mut busy = 0_usize;
        for task in tasks {
            if task.await.unwrap_or(false) {
                ok += 1;
            } else {
                busy += 1;
            }
        }
        assert!(ok > 0, "free slots still admit requests: {ok}");
        assert!(
            busy > 0,
            "a 100 ms wait behind 2 slots of 200 ms must shed: {busy}"
        );
        assert_eq!(ok + busy, CALLERS);
        assert_eq!(
            watch.runs.load(Ordering::SeqCst),
            ok,
            "a shed request never runs"
        );
        assert!(
            watch.high.load(Ordering::SeqCst) <= 2,
            "never more than the slots"
        );
        assert_eq!(
            gate.shed() as usize,
            busy,
            "the shed counter is what happened"
        );
        // Waited counts the shed ones and any caller that queued and then got in.
        assert!(gate.waited() >= busy as u64, "every shed caller waited");
        assert!(gate.waited() <= CALLERS as u64, "{}", gate.waited());
    }

    /// A held gate is a full gate: the next caller sheds inside its wait limit.
    #[tokio::test]
    async fn holding_every_slot_sheds_the_next_caller() {
        let gate = Gate::new(2, Duration::from_millis(50));
        let held = gate.hold().await;
        let busy = gate.run(std::future::ready(())).await;
        let error = match busy {
            Ok(()) => panic!("a gate with no free slot must not run the future"),
            Err(error) => error,
        };
        assert!(
            (40..600).contains(&error.waited_ms),
            "the request waited its own limit, not the pool's: {}",
            error.waited_ms
        );
        assert_eq!(gate.shed(), 1);
        assert_eq!(gate.waited(), 1);
        drop(held);
        assert!(
            gate.run(std::future::ready(())).await.is_ok(),
            "the slots come back"
        );
    }

    /// A slot count of 0 or a wait of 0 is never a gate that admits nothing.
    #[test]
    fn a_zero_gate_is_one_gate() {
        assert_eq!(Gate::new(0, Duration::ZERO).slots(), 1);
        assert_eq!(Gate::new(2, Duration::ZERO).wait_limit(), Duration::ZERO);
    }

    /// Every slot is free exactly when `hold` — which takes all of them — returns.
    /// Asked with a deadline, so a leaked permit fails the test instead of hanging
    /// it.
    async fn all_free(gate: &Gate) -> bool {
        tokio::time::timeout(Duration::from_millis(2_000), gate.hold())
            .await
            .is_ok()
    }

    /// A request that goes away is not a refused request. The client hanging up
    /// drops `run`'s future wherever it stands — while it waits for a slot, or
    /// mid-work holding one — and both cases must leave the gate as it found it:
    /// the permit is a local of `run`, so its destructor runs on cancellation, and
    /// the shed counter counts only callers that actually timed out. Measured
    /// against a live gate rather than an internal count, because a slot that is
    /// never handed back is invisible from the outside until the route wedges.
    #[tokio::test]
    async fn a_dropped_caller_gives_its_slot_back_and_sheds_nothing() {
        let gate = Arc::new(Gate::new(1, Duration::from_millis(500)));

        // Mid-work: a caller inside its slot, aborted before the future finished.
        let watch = Watch::new();
        let working = {
            let (gate, watch) = (gate.clone(), watch.clone());
            tokio::spawn(async move { gate.run(watch.sleep_200ms()).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            watch.inside.load(Ordering::SeqCst),
            1,
            "the caller is inside its slot"
        );
        working.abort();
        let _ = working.await;
        assert!(all_free(&gate).await, "an aborted holder returns its slot");
        assert_eq!(gate.shed(), 0, "a caller that left was never refused");

        // While waiting: a caller queued behind a held slot, dropped before its
        // wait limit expires.
        let held = gate.hold().await;
        let waiting = {
            let gate = gate.clone();
            tokio::spawn(async move { gate.run(std::future::ready(())).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        waiting.abort();
        let _ = waiting.await;
        assert_eq!(
            gate.waited(),
            1,
            "the queued caller did wait — it was never refused"
        );
        assert_eq!(gate.shed(), 0, "dropping a wait is not a shed");
        drop(held);
        assert!(all_free(&gate).await, "the gate is whole again");
    }
}
