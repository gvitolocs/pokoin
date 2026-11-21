//! `mail-config-check`: install-time proof that this host can mail. It reads the same
//! files and the same keys as the real mail path (env::default_files, mail.rs) and
//! reports only key names and file paths, never a value.

use crate::{env, mail};
use anyhow::{anyhow, Result};
use std::path::PathBuf;

#[derive(Debug, PartialEq)]
enum State {
    Missing,
    Empty,
    Set,
}

fn state(key: &str) -> State {
    match std::env::var(key) {
        Err(_) => State::Missing,
        Ok(v) if v.trim().is_empty() => State::Empty,
        Ok(_) => State::Set,
    }
}

/// One line per problem; no values.
fn problems(looked_in: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut report = |key: &str, st: State| match st {
        State::Missing => out.push(format!("missing: {key} (looked in: {looked_in})")),
        State::Empty => out.push(format!("empty: {key} (looked in: {looked_in})")),
        State::Set => {}
    };
    report(mail::FROM_KEY, state(mail::FROM_KEY));
    let (a, b) = (state(mail::TO_KEY), state(mail::TO_FALLBACK_KEY));
    if a != State::Set && b != State::Set {
        report(mail::TO_KEY, if a == State::Empty || b == State::Empty { State::Empty } else { State::Missing });
    }
    out
}

/// `env_files` empty: the host's default files, already loaded by main.
pub fn run(env_files: &[PathBuf]) -> Result<()> {
    let files = if env_files.is_empty() { env::default_files() } else { env_files.to_vec() };
    let looked_in = files.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ");
    let found = problems(&looked_in);
    if found.is_empty() {
        println!("mail config ok");
        return Ok(());
    }
    for line in &found {
        println!("{line}");
    }
    Err(anyhow!("mail config incomplete"))
}
