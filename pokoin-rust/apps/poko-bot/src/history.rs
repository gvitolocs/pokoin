use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const MAX_TURNS: usize = 10;
const MAX_KEYS: usize = 2_000;
const MAX_AGE_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Turn {
    pub role: String,
    pub text: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    turns: VecDeque<Turn>,
    used: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Snapshot {
    sessions: Vec<SnapshotSession>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SnapshotSession {
    key: String,
    turns: Vec<Turn>,
    used: u64,
}

pub struct History {
    inner: Mutex<HashMap<String, Session>>,
    clock: AtomicU64,
    dirty: AtomicBool,
}

impl History {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            clock: AtomicU64::new(1),
            dirty: AtomicBool::new(false),
        }
    }

    pub fn load(path: &Path) -> Self {
        let history = Self::new();
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(_) => return history,
        };
        let snapshot: Snapshot = match serde_json::from_slice(&bytes) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                tracing::warn!(error = %error, "history snapshot ignored");
                return history;
            }
        };
        let mut max_used = 1;
        let mut map = HashMap::new();
        for session in snapshot.sessions {
            max_used = max_used.max(session.used);
            map.insert(
                session.key,
                Session {
                    turns: session.turns.into(),
                    used: session.used,
                },
            );
        }
        *history.inner.lock().expect("history") = map;
        history.clock.store(max_used, Ordering::Relaxed);
        history
    }

    pub fn push(&self, key: &str, role: &str, text: &str, at: u64) {
        if key.is_empty() || text.is_empty() {
            return;
        }
        let mut map = self.inner.lock().expect("history");
        let used = self.clock.fetch_add(1, Ordering::Relaxed) + 1;
        let session = map.entry(key.to_string()).or_insert_with(|| Session {
            turns: VecDeque::new(),
            used,
        });
        session.used = used;
        session.turns.push_back(Turn {
            role: role.to_string(),
            text: text.to_string(),
            at,
        });
        while session.turns.len() > MAX_TURNS {
            session.turns.pop_front();
        }
        while map.len() > MAX_KEYS {
            let victim = map
                .iter()
                .min_by_key(|(_, session)| session.used)
                .map(|(key, _)| key.clone());
            if let Some(victim) = victim {
                map.remove(&victim);
            } else {
                break;
            }
        }
        self.dirty.store(true, Ordering::Relaxed);
    }

    pub fn recent(&self, key: &str, now_ms: u64) -> Vec<Turn> {
        let mut map = self.inner.lock().expect("history");
        let Some(session) = map.get_mut(key) else {
            return Vec::new();
        };
        session
            .turns
            .retain(|turn| now_ms.saturating_sub(turn.at) <= MAX_AGE_MS);
        session.used = self.clock.fetch_add(1, Ordering::Relaxed) + 1;
        session.turns.iter().cloned().collect()
    }

    pub fn len_keys(&self) -> usize {
        self.inner.lock().expect("history").len()
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty.load(Ordering::Relaxed)
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let snapshot = {
            let map = self.inner.lock().expect("history");
            let sessions = map
                .iter()
                .map(|(key, session)| SnapshotSession {
                    key: key.clone(),
                    turns: session.turns.iter().cloned().collect(),
                    used: session.used,
                })
                .collect();
            Snapshot { sessions }
        };
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let tmp = tmp_path(path);
        let bytes = serde_json::to_vec_pretty(&snapshot)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, path)?;
        self.dirty.store(false, Ordering::Relaxed);
        Ok(())
    }
}

impl Default for History {
    fn default() -> Self {
        Self::new()
    }
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    PathBuf::from(tmp)
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_at_ten_turns() {
        let history = History::new();
        for index in 0..11 {
            history.push("chat", "user", &format!("m{index}"), 1_000 + index);
        }
        let turns = history.recent("chat", 2_000);
        assert_eq!(turns.len(), 10);
        assert_eq!(turns[0].text, "m1");
        assert_eq!(turns[9].text, "m10");
    }

    #[test]
    fn evicts_least_recently_used_key() {
        let history = History::new();
        for index in 0..=MAX_KEYS {
            history.push(&format!("k{index}"), "user", "hi", 1);
        }
        assert_eq!(history.len_keys(), MAX_KEYS);
        assert!(history.recent("k0", 1).is_empty());
        assert_eq!(history.recent("k1", 1).len(), 1);
        assert_eq!(history.recent(&format!("k{MAX_KEYS}"), 1).len(), 1);
    }

    #[test]
    fn stale_turns_are_ignored() {
        let history = History::new();
        let now = MAX_AGE_MS + 10_000_000;
        history.push("chat", "user", "old", now - MAX_AGE_MS - 1);
        history.push("chat", "assistant", "fresh", now - 1_000);
        let turns = history.recent("chat", now);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].text, "fresh");
    }

    #[test]
    fn snapshot_round_trip_and_corrupt_file() {
        let dir = std::env::temp_dir().join(format!("poko-bot-history-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.json");
        let history = History::new();
        history.push("telegram_chat_1", "user", "hi", 50);
        history.push("telegram_chat_1", "assistant", "hey", 60);
        history.save(&path).unwrap();
        assert!(!path.with_extension("json.tmp").exists());
        let loaded = History::load(&path);
        assert_eq!(loaded.recent("telegram_chat_1", 100)[1].text, "hey");

        fs::write(&path, b"{not json").unwrap();
        let broken = History::load(&path);
        assert_eq!(broken.len_keys(), 0);
        let missing = History::load(&dir.join("missing.json"));
        assert_eq!(missing.len_keys(), 0);
        let _ = fs::remove_dir_all(&dir);
    }
}
