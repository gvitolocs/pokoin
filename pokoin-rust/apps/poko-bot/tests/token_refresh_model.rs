//! Finite abstraction of Youtube::access_token's in-process mutex and atomic save.
//! Covers two refresh callers and a process crash before/after rename. It does not
//! prove filesystem durability, cross-process exclusion, or provider behavior.
use stateright::{Checker, Model, Property};

#[derive(Clone)]
struct Refresh;
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct State {
    owner: Option<usize>,
    stage: [u8; 2],
    disk_access_fresh: bool,
    disk_refresh_present: bool,
    temporary_access_fresh: bool,
    temporary_refresh_present: bool,
    response_kind: u8,
    refresh_count: u8,
    crashed: bool,
}
#[derive(Clone, Debug, PartialEq)]
enum Action {
    Acquire(usize),
    Fetch(usize, u8),
    Write(usize),
    Rename(usize),
    Return(usize),
    Crash,
}
impl Model for Refresh {
    type State = State;
    type Action = Action;
    fn init_states(&self) -> Vec<State> {
        vec![State {
            owner: None,
            stage: [0, 0],
            disk_access_fresh: false,
            disk_refresh_present: true,
            temporary_access_fresh: false,
            temporary_refresh_present: false,
            response_kind: 0,
            refresh_count: 0,
            crashed: false,
        }]
    }
    fn actions(&self, s: &State, a: &mut Vec<Action>) {
        if s.crashed {
            return;
        }
        a.push(Action::Crash);
        for i in 0..2 {
            match s.stage[i] {
                0 if s.owner.is_none() => a.push(Action::Acquire(i)),
                1 => {
                    for response_kind in 0..4 {
                        a.push(Action::Fetch(i, response_kind));
                    }
                }
                2 => a.push(Action::Write(i)),
                3 => a.push(Action::Rename(i)),
                4 => a.push(Action::Return(i)),
                _ => {}
            }
        }
    }
    fn next_state(&self, last: &State, a: Action) -> Option<State> {
        let mut s = last.clone();
        match a {
            Action::Acquire(i) => {
                s.owner = Some(i);
                s.stage[i] = if s.disk_access_fresh { 4 } else { 1 };
            }
            Action::Fetch(i, response_kind) => {
                s.response_kind = response_kind;
                s.refresh_count += 1;
                s.stage[i] = 2;
            }
            Action::Write(i) => {
                let mut response = serde_json::json!({"access_token":"fresh"});
                match s.response_kind {
                    1 => response["refresh_token"] = serde_json::Value::Null,
                    2 => response["refresh_token"] = serde_json::json!(""),
                    3 => response["refresh_token"] = serde_json::json!("replacement"),
                    _ => {}
                }
                let prior = if s.disk_refresh_present {
                    serde_json::json!({"access_token":"old","refresh_token":"original"})
                } else {
                    serde_json::json!({"access_token":"old"})
                };
                let merged = poko_bot::youtube::merge_tokens(&prior, &response).unwrap();
                s.temporary_access_fresh = merged["access_token"] == "fresh";
                s.temporary_refresh_present = merged["refresh_token"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty());
                s.stage[i] = 3;
            }
            Action::Rename(i) => {
                s.disk_access_fresh = s.temporary_access_fresh;
                s.disk_refresh_present = s.temporary_refresh_present;
                s.stage[i] = 4;
            }
            Action::Return(i) => {
                s.stage[i] = 5;
                s.owner = None;
            }
            Action::Crash => {
                s.owner = None;
                s.crashed = true;
            }
        }
        Some(s)
    }
    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::<Self>::always(
                "refresh credential survives provider omission and crash",
                |_, s| s.disk_refresh_present,
            ),
            Property::<Self>::always("only one caller refreshes", |_, s| s.refresh_count <= 1),
            Property::<Self>::always("mutating stages hold mutex", |_, s| {
                s.crashed || (0..2).all(|i| !(1..=3).contains(&s.stage[i]) || s.owner == Some(i))
            }),
            Property::<Self>::always("completed calls have committed access token", |_, s| {
                !s.stage.contains(&5) || s.disk_access_fresh
            }),
            Property::<Self>::sometimes("both callers complete", |_, s| s.stage == [5, 5]),
        ]
    }
}
#[test]
fn model_check_refresh_serialization_and_crash_boundaries() {
    let checker = Refresh.checker().spawn_bfs().join();
    checker.assert_properties();
}
