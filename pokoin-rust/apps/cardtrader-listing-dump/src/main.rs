//! Daily raw listing books for every live CardTrader game; no inferred sales.
//!
//! Rust port of `scripts/dump-all-cardtrader-listings.py`. Same inputs (the
//! run folder's `*-target.json` and `_expansions-all.json`), same order (new
//! printings first, then Pokémon, then the other games, newest expansion
//! first), same `listing-dump-status.json` fields, same deadline and exit
//! codes (75 = stopped at the deadline, 1 = errors, 0 = every book).
//!
//! Differences:
//! - books are stored as `<game>-<expansion>.ctb` (crates/ctbook: lossless
//!   columnar JSON + brotli, ~5x smaller than the old `.json.gz`); a resumed
//!   run still counts `.json.gz` books the Python dump left behind;
//! - up to `POKOIN_DUMP_INFLIGHT` (3) requests are in flight and books are
//!   parsed and encoded on `POKOIN_DUMP_ENCODERS` (3) threads, so CardTrader's
//!   latency, the ssh transfer and the encoding overlap instead of adding up;
//!   the bridge's gate still spaces listing requests 1.05 s apart;
//! - the bridge is the Rust `pokoin-cardtrader-bridge` on Oracle
//!   (`POKOIN_CT_BRIDGE_CMD`, run through `sh -c`), asked for zstd frames
//!   (`POKOIN_CT_ENCODING=none` turns that off): the Oracle → nezopt link
//!   moves ~4-5 MB/s and books compress ~27x. Plain line replies (the Python
//!   bridge) are still understood.

use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

const DEFAULT_BRIDGE: &str =
    "ssh -o BatchMode=yes -o ConnectTimeout=20 pokoin-marketplace /home/ubuntu/bin/pokoin-cardtrader-bridge";
const DEFAULT_PSQL: &str = "docker exec pokoin-marketplace-postgres-15t psql -U pokoin_marketplace";
const BLOCKED: &str = "CardTrader listing endpoint refused by Cloudflare; retaining collected books and retrying at the next scheduled run";
const UNREADABLE: &str = "Bridge closed or sent an unreadable reply";

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn env_f64(name: &str, default: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

/// `str(value)` of a JSON id as Python would write it in a file name.
fn text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn int(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0),
        Some(Value::String(text)) => text.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))
}

#[derive(Clone)]
struct Expansion {
    id: Value,
    id_num: i64,
    game: Value,
    game_num: i64,
}

impl Expansion {
    fn file(&self, out: &Path, extension: &str) -> PathBuf {
        out.join(format!("{}-{}{extension}", text(&self.game), text(&self.id)))
    }

    fn error(&self, message: &str) -> Value {
        json!({"expansionId": self.id, "gameId": self.game, "error": message})
    }
}

struct Status {
    path: PathBuf,
    report: Map<String, Value>,
}

impl Status {
    fn add(&mut self, key: &str, amount: u64) {
        let current = self.report.get(key).and_then(Value::as_u64).unwrap_or(0);
        self.report.insert(key.into(), Value::from(current + amount));
    }

    fn get(&self, key: &str) -> u64 {
        self.report.get(key).and_then(Value::as_u64).unwrap_or(0)
    }

    fn push_error(&mut self, error: Value) {
        if let Some(Value::Array(errors)) = self.report.get_mut("errors") {
            errors.push(error);
        }
    }

    fn has_errors(&self) -> bool {
        matches!(self.report.get("errors"), Some(Value::Array(errors)) if !errors.is_empty())
    }

    fn write(&self) {
        let body = serde_json::to_string_pretty(&Value::Object(self.report.clone())).expect("status");
        if let Err(error) = std::fs::write(&self.path, body) {
            eprintln!("cannot write {}: {error}", self.path.display());
        }
    }

    fn book_stored(&mut self, counts: ctbook::Counts, priority: bool) {
        self.add("completed", 1);
        self.add("blueprintsWithListings", counts.blueprints);
        self.add("listings", counts.listings);
        if priority {
            self.add("newPrintingExpansionsCompleted", 1);
        }
    }

    fn progress(&self, total: usize) {
        println!(
            "{} daily listing books {} / {total} listings {}",
            now_iso(),
            self.get("completed"),
            self.get("listings")
        );
    }
}

/// Expansion ids with printings imported since the run date, per game database.
fn new_printings(root: &Path, targets: &[Value]) -> Result<HashSet<i64>, String> {
    let psql = std::env::var("POKOIN_DUMP_PSQL").unwrap_or_else(|_| DEFAULT_PSQL.into());
    let day = root.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    let mut priority = HashSet::new();
    for target in targets {
        let schema = target.get("schema").and_then(Value::as_str).unwrap_or_default();
        let table = target.get("table").and_then(Value::as_str).unwrap_or_default();
        let db = if int(target.get("cardtraderGameId")) == 5 {
            "pokoin_marketplace".to_string()
        } else {
            format!("pokoin_{}", schema.strip_prefix("marketplace_").unwrap_or(schema))
        };
        let sql = format!("SELECT DISTINCT expansion_id FROM {schema}.{table} WHERE imported_at >= '{day}'::date;");
        let output = Command::new("sh")
            .arg("-c")
            .arg(format!("{psql} -d \"$0\" -At -v ON_ERROR_STOP=1 -c \"$1\""))
            .arg(&db)
            .arg(&sql)
            .output()
            .map_err(|error| format!("Cannot determine new-printing listing scope: {error}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail: String = stderr.chars().rev().take(500).collect::<Vec<_>>().into_iter().rev().collect();
            return Err(format!("Cannot determine new-printing listing scope: {tail}"));
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if !line.is_empty() && line.bytes().all(|byte| byte.is_ascii_digit()) {
                if let Ok(id) = line.parse() {
                    priority.insert(id);
                }
            }
        }
    }
    Ok(priority)
}

enum Event {
    Line(Vec<u8>),
    Eof,
    Stored { index: usize, result: Result<ctbook::Counts, String> },
}

struct Job {
    index: usize,
    line: Vec<u8>,
    dest: PathBuf,
}

/// `{"id":<n>,"data":` or `{"id":<n>,"error":` — read without parsing the book.
fn reply_head(line: &[u8]) -> Option<(usize, bool)> {
    let rest = line.strip_prefix(b"{\"id\":")?;
    let digits = rest.iter().take_while(|byte| byte.is_ascii_digit()).count();
    let id = std::str::from_utf8(&rest[..digits]).ok()?.parse().ok()?;
    let rest = &rest[digits..];
    if rest.starts_with(b",\"data\":") {
        Some((id, false))
    } else if rest.starts_with(b",\"error\":") {
        Some((id, true))
    } else {
        None
    }
}

/// One bridge reply as a JSON line: a plain line as it is, a zstd frame
/// (`{"id":N,"encoding":"zstd","bytes":L}` + L bytes) decoded back to
/// `{"id":N,"data":<book>}`. `None` at the end of the stream.
fn read_reply(reader: &mut impl BufRead) -> std::io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    if reader.read_until(b'\n', &mut line)? == 0 {
        return Ok(None);
    }
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if reply_head(&line).is_some() || line.len() > 512 {
        return Ok(Some(line));
    }
    let Ok(header) = serde_json::from_slice::<Value>(&line) else {
        return Ok(Some(line));
    };
    let (Some(id), Some(encoding), Some(len)) = (
        header.get("id").cloned(),
        header.get("encoding").and_then(Value::as_str),
        header.get("bytes").and_then(Value::as_u64),
    ) else {
        return Ok(Some(line));
    };
    let mut frame = vec![0u8; len as usize];
    std::io::Read::read_exact(reader, &mut frame)?;
    let decoded = match encoding {
        "zstd" => zstd::stream::decode_all(&frame[..]).map_err(|error| error.to_string()),
        other => Err(format!("unknown encoding {other}")),
    };
    drop(frame);
    Ok(Some(match decoded {
        Ok(raw) => {
            let mut out = Vec::with_capacity(raw.len() + 32);
            out.extend_from_slice(format!("{{\"id\":{id},\"data\":").as_bytes());
            out.extend_from_slice(&raw);
            out.push(b'}');
            out
        }
        Err(error) => json!({"id": id, "error": format!("ZstdError: {error}")})
            .to_string()
            .into_bytes(),
    }))
}

/// Parse one book reply and store it as `.ctb`.
fn store(line: Vec<u8>, dest: &Path, quality: u32) -> Result<ctbook::Counts, String> {
    let message: Value = serde_json::from_slice(&line).map_err(|_| UNREADABLE.to_string())?;
    drop(line);
    let Value::Object(mut message) = message else {
        return Err(UNREADABLE.into());
    };
    let mut data = message.remove("data").unwrap_or(Value::Null);
    // The bridge forwards the book unparsed, so its shape is checked here.
    if let Value::Object(map) = &mut data {
        if let Some(array) = map.remove("array") {
            data = array;
        }
    }
    if !data.is_object() {
        return Err("ValueError: Expected listing book".into());
    }
    let file = ctbook::write(&data, quality).map_err(|error| format!("ctbook: {error}"))?;
    ctbook::write_atomic(dest, &file).map_err(|error| format!("OSError: {error}"))?;
    Ok(ctbook::counts(&data))
}

fn spawn_bridge() -> Result<Child, String> {
    let command = std::env::var("POKOIN_CT_BRIDGE_CMD").unwrap_or_else(|_| DEFAULT_BRIDGE.into());
    Command::new("sh")
        .arg("-c")
        .arg(&command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| format!("cannot start the bridge ({command}): {error}"))
}

fn stop_bridge(mut child: Child, patience: Duration) {
    drop(child.stdin.take());
    let started = Instant::now();
    while started.elapsed() < patience {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn main() {
    std::process::exit(match run() {
        Ok(code) => code,
        Err(message) => {
            eprintln!("{message}");
            1
        }
    });
}

fn run() -> Result<i32, String> {
    let root = PathBuf::from(std::env::var("POKOIN_CATALOG_RUN_ROOT").unwrap_or_else(|_| {
        format!(
            "/home/nez/data/pokoin-catalog-refresh/{}",
            chrono::Utc::now().format("%Y-%m-%d")
        )
    }));
    let out = root.join("listing-books");
    std::fs::create_dir_all(&out).map_err(|error| format!("{}: {error}", out.display()))?;

    let mut targets = Vec::new();
    let mut entries: Vec<PathBuf> = std::fs::read_dir(&root)
        .map_err(|error| format!("{}: {error}", root.display()))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.to_string_lossy().ends_with("-target.json"))
        .collect();
    entries.sort();
    for path in entries {
        targets.push(read_json(&path)?);
    }
    let games: BTreeSet<i64> = targets.iter().map(|target| int(target.get("cardtraderGameId"))).collect();
    let expansions = match read_json(&root.join("_expansions-all.json"))? {
        Value::Array(expansions) => expansions,
        _ => return Err("_expansions-all.json is not a list".into()),
    };
    let mut wanted: Vec<Expansion> = expansions
        .iter()
        .filter(|expansion| games.contains(&int(expansion.get("game_id"))))
        .map(|expansion| Expansion {
            id: expansion.get("id").cloned().unwrap_or(Value::Null),
            id_num: int(expansion.get("id")),
            game: expansion.get("game_id").cloned().unwrap_or(Value::Null),
            game_num: int(expansion.get("game_id")),
        })
        .collect();
    // New printings in any expansion get captured before the historical backlog.
    let mut priority = new_printings(&root, &targets)?;
    wanted.sort_by_key(|e| (!priority.contains(&e.id_num), e.game_num != 5, e.game_num, -e.id_num));
    if let Ok(limit) = std::env::var("POKOIN_DUMP_LIMIT") {
        if let Ok(limit) = limit.trim().parse::<usize>() {
            wanted.truncate(limit);
        }
    }
    let wanted_ids: HashSet<i64> = wanted.iter().map(|e| e.id_num).collect();
    priority.retain(|id| wanted_ids.contains(id));

    let max_seconds = env_f64("POKOIN_DUMP_MAX_SECONDS", 36_000.0);
    let grace_seconds = env_f64("POKOIN_DUMP_INFLIGHT_GRACE_SECONDS", 1_800.0);
    let in_flight_max = env_usize("POKOIN_DUMP_INFLIGHT", 3).max(1);
    let encoders = env_usize("POKOIN_DUMP_ENCODERS", 3).max(1);
    let quality = env_usize("POKOIN_DUMP_QUALITY", 9) as u32;
    let zstd_frames = std::env::var("POKOIN_CT_ENCODING").map(|value| value != "none").unwrap_or(true);
    let deadline = Instant::now() + Duration::from_secs_f64(max_seconds.max(0.0));
    let give_up = deadline + Duration::from_secs_f64(grace_seconds.max(0.0));

    let mut report = Map::new();
    report.insert("startedAt".into(), now_iso().into());
    report.insert("totalExpansions".into(), wanted.len().into());
    report.insert("completed".into(), 0.into());
    report.insert("blueprintsWithListings".into(), 0.into());
    report.insert("listings".into(), 0.into());
    report.insert("errors".into(), Value::Array(Vec::new()));
    report.insert("games".into(), games.iter().copied().collect::<Vec<_>>().into());
    report.insert("maxSeconds".into(), json!(max_seconds));
    report.insert("newPrintingExpansions".into(), priority.len().into());
    report.insert("newPrintingExpansionsCompleted".into(), 0.into());
    report.insert("bookFormat".into(), "ctb1".into());
    report.insert("inFlight".into(), in_flight_max.into());
    let mut status = Status {
        path: root.join("listing-dump-status.json"),
        report,
    };

    // Account for every retained book before resuming, regardless of queue order.
    let mut pending: VecDeque<usize> = VecDeque::new();
    for (index, e) in wanted.iter().enumerate() {
        let ctb = e.file(&out, ".ctb");
        let gz = e.file(&out, ".json.gz");
        let counts = if ctb.exists() {
            match ctbook::check_file(&ctb) {
                Ok(header) => Some(header.counts),
                Err(_) => {
                    quarantine(&ctb);
                    None
                }
            }
        } else if gz.exists() {
            // A book the Python dump stored earlier in this run.
            match ctbook::read_json_book(&gz) {
                Ok(book) if book.is_object() => Some(ctbook::counts(&book)),
                _ => {
                    quarantine(&gz);
                    None
                }
            }
        } else {
            None
        };
        match counts {
            Some(counts) => status.book_stored(counts, priority.contains(&e.id_num)),
            None => pending.push_back(index),
        }
    }
    status.write();

    let mut bridge = spawn_bridge()?;
    let mut bridge_in = bridge.stdin.take().ok_or("bridge stdin")?;
    let bridge_out = bridge.stdout.take().ok_or("bridge stdout")?;
    let (events, inbox) = mpsc::channel::<Event>();
    {
        let events = events.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::with_capacity(1 << 20, bridge_out);
            loop {
                match read_reply(&mut reader) {
                    Ok(Some(line)) => {
                        if events.send(Event::Line(line)).is_err() {
                            return;
                        }
                    }
                    Ok(None) | Err(_) => {
                        let _ = events.send(Event::Eof);
                        return;
                    }
                }
            }
        });
    }
    let (jobs, job_inbox) = mpsc::channel::<Job>();
    let job_inbox = Arc::new(Mutex::new(job_inbox));
    for _ in 0..encoders {
        let job_inbox = Arc::clone(&job_inbox);
        let events = events.clone();
        std::thread::spawn(move || loop {
            let job = match job_inbox.lock().unwrap().recv() {
                Ok(job) => job,
                Err(_) => return,
            };
            let result = store(job.line, &job.dest, quality);
            if events.send(Event::Stored { index: job.index, result }).is_err() {
                return;
            }
        });
    }
    drop(events);

    let total = wanted.len();
    let mut in_flight: BTreeMap<usize, ()> = BTreeMap::new();
    let mut storing: HashSet<usize> = HashSet::new();
    let mut stopped = false;
    let mut halted = false; // bridge gone, protocol broken or CardTrader blocked

    'run: loop {
        // Received books waiting for an encoder count too, so a slow encoder
        // never lets whole books pile up in memory.
        while !halted && !stopped && in_flight.len() + storing.len() < in_flight_max + encoders {
            if in_flight.len() >= in_flight_max {
                break;
            }
            let Some(&index) = pending.front() else { break };
            if Instant::now() >= deadline {
                stopped = true;
                break;
            }
            pending.pop_front();
            let e = &wanted[index];
            let mut request = json!({"id": index + 1, "path": "/marketplace/products", "params": {"expansion_id": e.id}});
            if zstd_frames {
                request["encoding"] = "zstd".into();
            }
            if writeln!(bridge_in, "{request}").and_then(|()| bridge_in.flush()).is_err() {
                status.push_error(e.error(UNREADABLE));
                status.write();
                halted = true;
                break;
            }
            in_flight.insert(index, ());
        }
        if in_flight.is_empty() && storing.is_empty() {
            break;
        }
        let wait = if in_flight.is_empty() {
            Duration::from_secs(3600)
        } else {
            give_up.saturating_duration_since(Instant::now())
        };
        let event = match inbox.recv_timeout(wait) {
            Ok(event) => event,
            Err(mpsc::RecvTimeoutError::Timeout) if !in_flight.is_empty() => {
                let first = *in_flight.keys().next().unwrap();
                status.report.insert("abandonedExpansionId".into(), wanted[first].id.clone());
                stopped = true;
                break 'run;
            }
            Err(_) => break 'run,
        };
        match event {
            Event::Stored { index, result } => {
                storing.remove(&index);
                let e = &wanted[index];
                match result {
                    Ok(counts) => status.book_stored(counts, priority.contains(&e.id_num)),
                    Err(message) => status.push_error(e.error(&message)),
                }
                status.write();
                if (index + 1) % 25 == 0 {
                    status.progress(total);
                }
            }
            // Halted: replies to requests still in flight are no longer wanted.
            _ if halted => {}
            Event::Eof | Event::Line(_) if in_flight.is_empty() => {
                // Nothing was asked: the bridge has no business talking or leaving.
                if !pending.is_empty() || !halted {
                    if let Some(&index) = pending.front() {
                        status.push_error(wanted[index].error(UNREADABLE));
                        status.write();
                    }
                    halted = true;
                }
            }
            Event::Eof => {
                // Empty line = the bridge exited: the protocol is out of sync.
                let first = *in_flight.keys().next().unwrap();
                status.push_error(wanted[first].error(UNREADABLE));
                status.write();
                in_flight.clear();
                halted = true;
            }
            Event::Line(line) => {
                let head = reply_head(&line).or_else(|| {
                    let message: Value = serde_json::from_slice(&line).ok()?;
                    let id = message.get("id")?.as_u64()? as usize;
                    Some((id, message.get("error").is_some()))
                });
                let Some((id, is_error)) = head.filter(|(id, _)| *id >= 1 && in_flight.contains_key(&(id - 1))) else {
                    let first = *in_flight.keys().next().unwrap();
                    status.push_error(wanted[first].error(UNREADABLE));
                    status.write();
                    in_flight.clear();
                    halted = true;
                    continue;
                };
                let index = id - 1;
                in_flight.remove(&index);
                let e = &wanted[index];
                if is_error {
                    let message = serde_json::from_slice::<Value>(&line)
                        .ok()
                        .and_then(|message| message.get("error").map(text))
                        .unwrap_or_else(|| UNREADABLE.to_string());
                    status.push_error(e.error(&message));
                    status.write();
                    if message.contains("403") || message.contains("401") {
                        status.report.insert("blocked".into(), BLOCKED.into());
                        status.write();
                        in_flight.clear();
                        halted = true;
                        continue;
                    }
                    if (index + 1) % 25 == 0 {
                        status.progress(total);
                    }
                } else {
                    storing.insert(index);
                    let dest = e.file(&out, ".ctb");
                    if jobs.send(Job { index, line, dest }).is_err() {
                        return Err("encoder threads are gone".into());
                    }
                }
            }
        }
        if halted {
            // Stop asking; wait only for books already received.
            in_flight.clear();
            if storing.is_empty() {
                break;
            }
        }
    }

    // Books already received are still being encoded: finish them.
    while !storing.is_empty() {
        match inbox.recv_timeout(Duration::from_secs(600)) {
            Ok(Event::Stored { index, result }) => {
                storing.remove(&index);
                let e = &wanted[index];
                match result {
                    Ok(counts) => status.book_stored(counts, priority.contains(&e.id_num)),
                    Err(message) => status.push_error(e.error(&message)),
                }
                status.write();
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    drop(jobs);
    if stopped {
        status.report.insert("stoppedAtDeadline".into(), true.into());
        println!(
            "{} daily listing books stopped at the {} h deadline: {} / {total}",
            now_iso(),
            (max_seconds / 360.0).round() / 10.0,
            status.get("completed")
        );
    }
    drop(bridge_in);
    stop_bridge(bridge, Duration::from_secs(if stopped { 30 } else { 180 }));
    status.report.insert("finishedAt".into(), now_iso().into());
    status.write();
    // 75 (EX_TEMPFAIL) = stopped at the deadline; 1 = errors; 0 = every book collected.
    Ok(if stopped {
        75
    } else if status.has_errors() {
        1
    } else {
        0
    })
}

/// A crash can leave a renamed but empty/truncated book: set it aside so it is downloaded again.
fn quarantine(path: &Path) {
    let mut corrupt = path.as_os_str().to_owned();
    corrupt.push(".corrupt");
    let _ = std::fs::rename(path, PathBuf::from(corrupt));
    println!(
        "re-downloading corrupt book {}",
        path.file_name().unwrap_or_default().to_string_lossy()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_are_plain_lines_or_zstd_frames() {
        let book = br#"{"1":[{"id":5}]}"#;
        let frame = zstd::stream::encode_all(&book[..], 3).unwrap();
        let mut stream = Vec::new();
        stream.extend_from_slice(format!("{{\"id\":2,\"encoding\":\"zstd\",\"bytes\":{}}}\n", frame.len()).as_bytes());
        stream.extend_from_slice(&frame);
        stream.extend_from_slice(b"{\"id\":3,\"error\":\"HTTPError: HTTP Error 500\"}\n");
        stream.extend_from_slice(b"{\"id\":4,\"encoding\":\"zstd\",\"bytes\":3}\nabc");
        stream.extend_from_slice(b"{\"id\":5,\"data\":{}}\n");
        let mut reader = std::io::Cursor::new(stream);
        assert_eq!(read_reply(&mut reader).unwrap().unwrap(), br#"{"id":2,"data":{"1":[{"id":5}]}}"#);
        assert_eq!(read_reply(&mut reader).unwrap().unwrap(), br#"{"id":3,"error":"HTTPError: HTTP Error 500"}"#);
        let broken: Value = serde_json::from_slice(&read_reply(&mut reader).unwrap().unwrap()).unwrap();
        assert_eq!(broken["id"], 4);
        assert!(broken["error"].as_str().unwrap().starts_with("ZstdError"));
        assert_eq!(read_reply(&mut reader).unwrap().unwrap(), br#"{"id":5,"data":{}}"#);
        assert_eq!(read_reply(&mut reader).unwrap(), None);
    }

    #[test]
    fn reply_head_reads_id_and_kind_without_parsing() {
        assert_eq!(reply_head(br#"{"id":12,"data":{"1":[]}}"#), Some((12, false)));
        assert_eq!(reply_head(br#"{"id":3,"error":"HTTPError: HTTP Error 403"}"#), Some((3, true)));
        assert_eq!(reply_head(br#"{"data":{},"id":3}"#), None);
        assert_eq!(reply_head(b""), None);
    }
}
