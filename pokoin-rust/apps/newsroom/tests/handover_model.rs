//! Bounded handover protocol model, reusing the port's actual cadence function.
//! Assumptions: Node fully stopped before Rust starts; one shared durable CMS;
//! static deployment projects records by permanent URL. No social sends occur.
//! This is not a proof of the unfinished publisher implementation.
use pokoin_newsroom::{
    cadence::{slot_open, HOUR},
    iso,
};
use serde_json::json;
use stateright::{Checker, Model, Property};

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
struct State {
    now: u8,
    phase: u8,                    // Node -> stopped -> Rust -> failed -> Node rollback
    records: Vec<(u8, u8, bool)>, // story, publish/review tick, in review
    deployed: u8,                 // permanent-URL bitset; retries are a projection
    attempts: Vec<u8>,
    previously_committed: u8,
    duplicate: bool,
}
#[derive(Clone, Debug, PartialEq)]
enum Action {
    Tick,
    Attempt,
    Commit(u8, bool),
    Project,
    StopNode,
    StartRust,
    FailRust,
    Rollback,
}
struct Schedule {
    weekly: bool,
    reset_on_handover: bool,
}
impl Schedule {
    fn game(&self) -> &str {
        if self.weekly {
            "gundam"
        } else {
            "pokemon"
        }
    }
    fn open(&self, s: &State) -> bool {
        let records:Vec<_>=s.records.iter().map(|(id,t,review)|json!({"game":self.game(),"canonicalStoryId":id,
            "status":if *review{"review"}else{"published"},"datePublished":iso(i64::from(*t)*6*HOUR),"revisions":[{"at":iso(i64::from(*t)*6*HOUR)}]})).collect();
        let attempts: Vec<_> = s
            .attempts
            .iter()
            .map(|t| json!({"game":self.game(),"at":iso(i64::from(*t)*6*HOUR)}))
            .collect();
        slot_open(
            self.game(),
            &records,
            &attempts,
            i64::from(s.now) * 6 * HOUR,
        )["open"]
            == true
    }
}
impl Model for Schedule {
    type State = State;
    type Action = Action;
    fn init_states(&self) -> Vec<State> {
        vec![State {
            now: 0,
            phase: 0,
            records: vec![],
            deployed: 0,
            attempts: vec![],
            previously_committed: 0,
            duplicate: false,
        }]
    }
    fn actions(&self, s: &State, a: &mut Vec<Action>) {
        // Sparse time steps cover midnight and the rolling 7-day boundary.
        if s.now < if self.weekly { 29 } else { 5 } {
            a.push(Action::Tick);
        }
        if [0, 2, 4].contains(&s.phase) {
            a.push(Action::Project);
            if s.attempts.len() < 4 && self.open(s) {
                a.push(Action::Attempt);
            }
            if self.open(s) {
                for id in 0..2 {
                    if !s.records.iter().any(|r| r.0 == id) {
                        a.push(Action::Commit(id, false));
                        a.push(Action::Commit(id, true));
                    }
                }
            }
        }
        match s.phase {
            0 => a.push(Action::StopNode),
            1 => a.push(Action::StartRust),
            2 => a.push(Action::FailRust),
            3 => a.push(Action::Rollback),
            _ => {}
        }
    }
    fn next_state(&self, s: &State, a: Action) -> Option<State> {
        let mut n = s.clone();
        match a {
            Action::Tick => {
                n.now = if self.weekly {
                    match s.now {
                        0 => 1,
                        1 => 27,
                        27 => 28,
                        _ => 29,
                    }
                } else {
                    s.now + 1
                }
            }
            Action::Attempt => n.attempts.push(s.now),
            Action::Commit(id, review) => {
                if n.previously_committed & (1 << id) != 0 {
                    n.duplicate = true;
                }
                n.previously_committed |= 1 << id;
                n.records.push((id, s.now, review));
            }
            Action::Project => {
                for (id, _, review) in &s.records {
                    if !review {
                        n.deployed |= 1 << id;
                    }
                }
            }
            Action::StopNode => n.phase = 1,
            Action::StartRust => {
                n.phase = 2;
                if self.reset_on_handover {
                    n.records.clear();
                    n.attempts.clear();
                }
            }
            Action::FailRust => n.phase = 3,
            // Rollback does NOT restore the pre-cutover snapshot: doing so
            // would forget successful Rust commits and permit a duplicate.
            Action::Rollback => n.phase = 4,
        }
        (n != *s).then_some(n)
    }
    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::<Self>::always("canonical story committed once across handover", |_, s| {
                !s.duplicate
            }),
            Property::<Self>::always(
                "public projection is backed by durable published CMS",
                |_, s| {
                    let cms = s
                        .records
                        .iter()
                        .filter(|r| !r.2)
                        .fold(0, |bits, r| bits | (1 << r.0));
                    s.deployed & !cms == 0
                },
            ),
            Property::<Self>::always(
                "published and review cadence cap survives handover",
                |m, s| {
                    let start = if m.weekly {
                        i16::from(s.now) - 28
                    } else {
                        i16::from(s.now / 4 * 4)
                    };
                    let count = s.records.iter().filter(|r| i16::from(r.1) >= start).count();
                    count <= if m.weekly { 1 } else { 2 }
                },
            ),
            Property::<Self>::always("published minimum gap survives handover", |m, s| {
                let published: Vec<_> = s.records.iter().filter(|r| !r.2).collect();
                published
                    .windows(2)
                    .all(|pair| pair[1].1 - pair[0].1 >= if m.weekly { 28 } else { 1 })
            }),
            Property::<Self>::sometimes("Rust publishes after handover", |_, s| {
                s.phase == 2 && s.deployed != 0
            }),
            Property::<Self>::sometimes("rollback preserves publications", |_, s| {
                s.phase == 4 && s.deployed != 0
            }),
        ]
    }
}
#[test]
fn schedule_handover_daily_and_weekly() {
    for weekly in [false, true] {
        let checker = Schedule {
            weekly,
            reset_on_handover: false,
        }
        .checker()
        .spawn_bfs()
        .join();
        checker.assert_properties();
        eprintln!(
            "Stateright {}: {} unique states, all properties hold",
            if weekly { "weekly" } else { "daily" },
            checker.unique_state_count()
        );
    }
}
#[test]
fn reset_mutant_has_duplicate_counterexample() {
    let checker = Schedule {
        weekly: false,
        reset_on_handover: true,
    }
    .checker()
    .spawn_bfs()
    .join();
    assert!(checker
        .discovery("canonical story committed once across handover")
        .is_some());
}
