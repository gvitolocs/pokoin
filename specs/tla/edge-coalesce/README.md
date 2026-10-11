# Edge request coalescing (PR #307)

`Model.tla` models one cache key of the api.pokoin.com edge
(`pokoin-rust/crates/edge/src/edge.rs`): concurrent client requests, the
stale-while-revalidate background refresh, the `flights` map, the watch
channel each leader creates, and every way out of a leader. Keys are
independent (one `flights` entry each), so one key is enough. `Fixed = TRUE`
is origin/main after PR #307; `Fixed = FALSE` is the code before it
(`b472a910^1`): no `FlightGuard`, no timeouts, a 5xx not shared.
Findings: [`../FINDINGS.md`](../FINDINGS.md#edge-request-coalescing-edge-coalesce).

## What is modelled

| Spec | Rust code |
| --- | --- |
| `Lookup` | `serve_cacheable`: cache `get`; fresh → HIT; stale → STALE and, if the key is free, `start_flight` + `tokio::spawn(lead)` (`Bg` processes); empty → miss |
| `Start`, `BecomeLeader` | `start_flight`: `flights.get(key)` → follow a clone of the receiver, else insert a new `watch::channel(Pending)` and lead |
| `Answer` | `lead` after `oneshot`: `cache_policy` 200 → store + `Entry`; not storable → `Uncacheable`; 5xx → `Error` (shared, never stored); unreadable body → `Failed(502)` |
| `LeadTimeout` | `timeout_at(deadline, …)` on head and body → `Failed(504)` (`POKOIN_API_FLIGHT_TIMEOUT_SECS`) |
| `LeaderPanic` | panic in edge code: `FlightGuard::drop` with `thread::panicking()` → `Failed(502)`; the client gets the catch-panic 500 |
| `LeaderHangUp` | the client disconnects, axum drops the handler future: `FlightGuard::drop` → `Abandoned` |
| `Settle` + `Send` | `FlightGuard::settle`: remove the key under the `flights` lock, then `tx.send` (two steps, so a new leader can start in between) |
| `Receive` | `follow` + the loop in `serve_cacheable`: `Abandoned` → `start_flight` again (re-election); `Uncacheable` → `forward_api`; else answer |
| `FollowTimeout` | the follower's own `timeout_at(deadline, rx.wait_for(…))` → 504 |
| `OtherHangUp` | a follower or forwarding client disconnects (only its own request ends) |
| `Age` | time: fresh → stale → expired |

`UpstreamHangs` lets an API handler never answer; `Timeouts` switches the
flight timeout on or off; `hangUps`/`panics` are bounded environment events.

## Properties

| Property | Meaning |
| --- | --- |
| `OneLeader` | at most one leader per key, and it is the one `flights` names |
| `NoOrphanFlight` | the key is never held by someone who is not fetching it |
| `NoStrandedFollower` | no waiter is left pending after its leader ended for any reason |
| `ErrorsNeverStored` | only a cacheable 200 is ever written to the cache |
| `Answered` | a finished request always got an answer (never "the leader left") |
| `LeadsOnce` | a request leads at most once (bounds its wait, see E1) |
| `EveryRequestEnds` (liveness) | every request is answered or its client went away |
| `KeyFreed` (liveness) | the key is eventually free again |

Fairness: weak fairness on each process's own steps (`Step(p)`); panics,
hang-ups and time are environment events with no fairness.

## Configs

| Config | Expectation | Result on nezopt |
| --- | --- | --- |
| `Model.cfg` | PR #307, 4 clients, 2 refreshes, every leader exit, caches empty/fresh/stale: all safety properties | 798,324 distinct states, depth 25, 22 s |
| `liveness.cfg` | as deployed (timeouts on, upstream may hang): every request ends, key freed | 110,286 distinct states, 11 s |
| `liveness-guard.cfg` | no timeouts, upstream answers: the guard alone gives liveness through panics and hang-ups | 20,372 distinct states, 4 s |
| `bugs/hangup-strands-followers.cfg` | before #307: `NoStrandedFollower` violated (leader's client hangs up) | counterexample |
| `bugs/panic-strands-key.cfg` | before #307: `EveryRequestEnds` violated (leader panics; the key is held forever) | counterexample |
| `bugs/no-timeout-hang.cfg` | guard without timeouts and a hanging upstream: `EveryRequestEnds` violated (why the timeout exists) | counterexample |
| `witness/*.cfg` | fixed model reaches re-election, a shared 5xx, a 502 to followers of a panicking leader, a successful stale refresh | violations found |

Run: `specs/tla/run.sh edge-coalesce` (add `--regressions` for the rest).
