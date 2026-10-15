//! CardTrader GET bridge for the 1 GB Oracle VM (`pokoin-marketplace`): the
//! CardTrader token stays on Oracle, responses go to nezopt over ssh.
//!
//! Rust port of `scripts/cardtrader-fetch-bridge.py`, same protocol:
//! - stdin: one JSON request per line, `{"id":<any>,"path":"<api path>","params":{...}}`;
//! - stdout: one reply line per request, in completion order,
//!   `{"id":<id>,"data":<value>}` or `{"id":<id>,"error":"<Type>: <message>"}`.
//!
//! `/marketplace/products` listing books are forwarded unparsed (CR/LF
//! removed, which only drops whitespace since JSON strings cannot hold raw
//! newlines). Each book is streamed to an already-unlinked temp file, checked,
//! then streamed out, so memory stays flat however large the book is.
//!
//! Requests start through one shared gate: 1.05 s apart for listing books,
//! 0.3 s for catalogue paths, and every process of the pipeline honours the
//! cooldown file a 403/429 writes (5 min, or the server's longer
//! Retry-After). 401 fails at once; other failures retry with 1, 2, 4, 8, 16 s
//! pauses before the error is reported.
//!
//! Test hooks (env): `POKOIN_CT_API_BASE`, `POKOIN_CT_TOKEN`,
//! `POKOIN_CT_BACKOFF_SECONDS`, `POKOIN_CT_RETRY_BASE_SECONDS`, `POKOIN_CT_WORKERS`.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const TOKEN_FILES: [&str; 2] = [
    "/home/ubuntu/cardtrader-oracle-api/.env.cardtrader-nezopt",
    "/home/ubuntu/cardtrader-oracle-api/.env",
];
const PATHS: [&str; 5] = [
    "/games",
    "/categories",
    "/expansions",
    "/blueprints/export",
    "/marketplace/products",
];
const BOOK_PATH: &str = "/marketplace/products";
const MAX_ATTEMPT: u32 = 5;

fn env_f64(name: &str, default: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

fn wall_now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs_f64())
        .unwrap_or(0.0)
}

fn sleep_secs(seconds: f64) {
    if seconds > 0.0 {
        std::thread::sleep(Duration::from_secs_f64(seconds));
    }
}

/// `CARDTRADER_AUTH_TOKEN` from the env files; a later file wins, like the Python bridge.
fn load_token() -> Option<String> {
    if let Ok(token) = std::env::var("POKOIN_CT_TOKEN") {
        if !token.is_empty() {
            return Some(token);
        }
    }
    let mut token = None;
    for path in TOKEN_FILES {
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        for line in text.lines() {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "CARDTRADER_AUTH_TOKEN" {
                    token = Some(value.trim().trim_matches(|c| c == '\'' || c == '"').to_string());
                }
            }
        }
    }
    token.filter(|token| !token.is_empty())
}

// ------------------------------------------------------------------- gate

/// Five-minute pause shared by every Oracle process of the pipeline through a
/// flock-guarded JSON file, plus this process's own request spacing.
struct Gate {
    path: PathBuf,
    next_request: Mutex<Option<Instant>>,
    backoff_seconds: f64,
}

struct Locked(File);

impl Locked {
    fn open(path: &PathBuf) -> std::io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .open(path)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self(file))
    }

    fn until(&mut self) -> f64 {
        let mut text = String::new();
        if self.0.seek(SeekFrom::Start(0)).is_err() || self.0.read_to_string(&mut text).is_err() {
            return 0.0;
        }
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| value.get("until").and_then(Value::as_f64))
            .unwrap_or(0.0)
    }
}

impl Gate {
    fn new() -> Self {
        Self {
            path: PathBuf::from(
                std::env::var("POKOIN_CT_COOLDOWN_FILE")
                    .unwrap_or_else(|_| "/tmp/pokoin-catalog-cardtrader-cooldown.json".into()),
            ),
            next_request: Mutex::new(None),
            backoff_seconds: env_f64("POKOIN_CT_BACKOFF_SECONDS", 300.0),
        }
    }

    fn file_until(&self) -> f64 {
        Locked::open(&self.path).map(|mut file| file.until()).unwrap_or(0.0)
    }

    fn wait(&self, interval: f64) {
        loop {
            let delay = {
                let mut next = self.next_request.lock().unwrap();
                let now = Instant::now();
                let own = next
                    .map(|at| at.saturating_duration_since(now).as_secs_f64())
                    .unwrap_or(0.0);
                let delay = (self.file_until() - wall_now()).max(own);
                if delay <= 0.0 {
                    *next = Some(now + Duration::from_secs_f64(interval));
                    return;
                }
                delay
            };
            sleep_secs(delay);
        }
    }

    fn backoff(&self, status: u16, retry_after: Option<&str>) {
        let mut delay = self.backoff_seconds;
        if let Some(value) = retry_after.map(str::trim) {
            if let Ok(seconds) = value.parse::<f64>() {
                delay = delay.max(seconds);
            } else if let Some(at) = parse_http_date(value) {
                delay = delay.max(at - wall_now());
            }
        }
        let until = match Locked::open(&self.path) {
            Ok(mut file) => {
                let until = file.until().max(wall_now() + delay);
                let body = json!({"until": until, "httpStatus": status}).to_string();
                let _ = file.0.set_len(0);
                let _ = file.0.write_all(body.as_bytes());
                let _ = file.0.flush();
                until
            }
            Err(_) => wall_now() + delay,
        };
        eprintln!(
            "CardTrader HTTP {status}: pausing for {}s before retry",
            (until - wall_now()).round() as i64
        );
    }
}

/// IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`) as Unix seconds.
fn parse_http_date(value: &str) -> Option<f64> {
    let parts: Vec<&str> = value.split_whitespace().collect();
    if parts.len() != 6 || parts[5] != "GMT" {
        return None;
    }
    let day: i64 = parts[1].parse().ok()?;
    let month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        .iter()
        .position(|name| *name == parts[2])? as i64
        + 1;
    let year: i64 = parts[3].parse().ok()?;
    let time: Vec<i64> = parts[4].split(':').map(|v| v.parse().ok()).collect::<Option<_>>()?;
    if time.len() != 3 {
        return None;
    }
    // Days from civil (Howard Hinnant).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days * 86_400 + time[0] * 3600 + time[1] * 60 + time[2]) as f64)
}

// ------------------------------------------------------------------- request

/// `urllib.parse.urlencode(params)`: quote_plus keys and `str()` values.
fn urlencode(params: &serde_json::Map<String, Value>) -> String {
    fn quote_plus(text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        for byte in text.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-' | b'~' => out.push(byte as char),
                b' ' => out.push('+'),
                _ => out.push_str(&format!("%{byte:02X}")),
            }
        }
        out
    }
    params
        .iter()
        .map(|(key, value)| {
            let text = match value {
                Value::String(text) => text.clone(),
                Value::Bool(true) => "True".into(),
                Value::Bool(false) => "False".into(),
                Value::Null => "None".into(),
                other => other.to_string(),
            };
            format!("{}={}", quote_plus(key), quote_plus(&text))
        })
        .collect::<Vec<_>>()
        .join("&")
}

enum Failure {
    /// Retrying will not help (401, bad request): report at once.
    Fatal(String),
    /// 403/429: shared cooldown, then the same request again.
    RateLimited(u16, Option<String>),
    /// Anything else: retried with exponential pauses.
    Retry(String),
}

enum Reply {
    Data(Value),
    /// The listing book, CR/LF removed, in an unlinked temp file.
    Book(File),
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_file() -> std::io::Result<File> {
    let path = std::env::temp_dir().join(format!(
        "pokoin-ct-bridge-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)?;
    // Unlinked at once: nothing is left behind if the bridge is killed.
    std::fs::remove_file(&path)?;
    Ok(file)
}

/// Stream a listing book into a temp file without CR/LF; it must start with `{`
/// (ignoring whitespace in the first 64 bytes, as the Python bridge checks).
fn store_book(mut body: impl Read) -> Result<File, Failure> {
    let file = temp_file().map_err(|error| Failure::Retry(format!("OSError: {error}")))?;
    let mut writer = BufWriter::with_capacity(1 << 16, file);
    let mut head: Vec<u8> = Vec::with_capacity(64);
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = match body.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) => return Err(Failure::Retry(format!("URLError: {error}"))),
        };
        let mut start = 0;
        for at in 0..read {
            let byte = buffer[at];
            if byte == b'\n' || byte == b'\r' {
                if start < at {
                    writer
                        .write_all(&buffer[start..at])
                        .map_err(|error| Failure::Retry(format!("OSError: {error}")))?;
                    take_head(&mut head, &buffer[start..at]);
                }
                start = at + 1;
            }
        }
        if start < read {
            writer
                .write_all(&buffer[start..read])
                .map_err(|error| Failure::Retry(format!("OSError: {error}")))?;
            take_head(&mut head, &buffer[start..read]);
        }
    }
    let first = head.iter().find(|byte| !byte.is_ascii_whitespace() && **byte != 0x0b);
    if first != Some(&b'{') {
        return Err(Failure::Retry("ValueError: Expected listing book".into()));
    }
    let mut file = writer
        .into_inner()
        .map_err(|error| Failure::Retry(format!("OSError: {error}")))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| Failure::Retry(format!("OSError: {error}")))?;
    Ok(file)
}

fn take_head(head: &mut Vec<u8>, bytes: &[u8]) {
    let room = 64usize.saturating_sub(head.len());
    head.extend_from_slice(&bytes[..room.min(bytes.len())]);
}

struct Bridge {
    agent: ureq::Agent,
    token: String,
    base: String,
    gate: Gate,
    retry_base: f64,
    out: Mutex<std::io::Stdout>,
}

impl Bridge {
    fn attempt(&self, path: &str, url: &str) -> Result<Reply, Failure> {
        let response = self
            .agent
            .get(url)
            .set("Authorization", &format!("Bearer {}", self.token))
            .set("Accept", "application/json")
            .set("User-Agent", "Pokoin-catalog-refresh/1")
            .call();
        let response = match response {
            Ok(response) => response,
            Err(ureq::Error::Status(status, response)) => {
                let text = format!("HTTPError: HTTP Error {status}: {}", response.status_text());
                return Err(match status {
                    401 => Failure::Fatal(text),
                    403 | 429 => Failure::RateLimited(status, response.header("Retry-After").map(str::to_string)),
                    _ => Failure::Retry(text),
                });
            }
            Err(ureq::Error::Transport(error)) => return Err(Failure::Retry(format!("URLError: {error}"))),
        };
        if path == BOOK_PATH {
            return store_book(response.into_reader()).map(Reply::Book);
        }
        let mut data: Value = serde_json::from_reader(BufReader::new(response.into_reader()))
            .map_err(|error| Failure::Retry(format!("JSONDecodeError: {error}")))?;
        if let Value::Object(map) = &mut data {
            if let Some(array) = map.remove("array") {
                data = array;
            }
        }
        if !data.is_array() {
            return Err(Failure::Retry("ValueError: Expected catalogue array".into()));
        }
        Ok(Reply::Data(data))
    }

    fn fetch(&self, request: &Value) -> Result<Reply, String> {
        let path = request
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "KeyError: 'path'".to_string())?;
        if !PATHS.contains(&path) {
            return Err("ValueError: Unsupported API path".into());
        }
        let empty = serde_json::Map::new();
        let params = request.get("params").and_then(Value::as_object).unwrap_or(&empty);
        let url = format!("{}{}?{}", self.base, path, urlencode(params));
        let mut attempt = 0u32;
        loop {
            self.gate.wait(if path == BOOK_PATH { 1.05 } else { 0.3 });
            match self.attempt(path, &url) {
                Ok(reply) => return Ok(reply),
                Err(Failure::Fatal(message)) => return Err(message),
                Err(Failure::RateLimited(status, retry_after)) => {
                    self.gate.backoff(status, retry_after.as_deref());
                }
                Err(Failure::Retry(message)) => {
                    if attempt == MAX_ATTEMPT {
                        return Err(message);
                    }
                    sleep_secs(self.retry_base * f64::from(1u32 << attempt));
                    attempt += 1;
                }
            }
        }
    }

    fn handle(&self, request: Value) {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let result = self.fetch(&request);
        let mut out = self.out.lock().unwrap();
        let written = match result {
            Err(message) => writeln!(out, "{}", json!({"id": id, "error": message})),
            Ok(Reply::Data(data)) => writeln!(out, "{}", json!({"id": id, "data": data})),
            Ok(Reply::Book(file)) => (|| {
                write!(out, "{{\"id\":{id},\"data\":")?;
                std::io::copy(&mut BufReader::with_capacity(1 << 16, file), &mut *out)?;
                out.write_all(b"}\n")
            })(),
        };
        // The reader on nezopt is gone: nothing useful left to do.
        if written.and_then(|()| out.flush()).is_err() {
            std::process::exit(1);
        }
    }
}

fn main() {
    let Some(token) = load_token() else {
        eprintln!("CardTrader token unavailable");
        std::process::exit(1);
    };
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(90))
        .timeout_write(Duration::from_secs(90))
        .build();
    let bridge = Arc::new(Bridge {
        agent,
        token,
        base: std::env::var("POKOIN_CT_API_BASE").unwrap_or_else(|_| "https://api.cardtrader.com/api/v2".into()),
        gate: Gate::new(),
        retry_base: env_f64("POKOIN_CT_RETRY_BASE_SECONDS", 1.0),
        out: Mutex::new(std::io::stdout()),
    });
    let workers = std::env::var("POKOIN_CT_WORKERS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(4)
        .max(1);
    let (sender, receiver) = mpsc::channel::<Value>();
    let receiver = Arc::new(Mutex::new(receiver));
    let handles: Vec<_> = (0..workers)
        .map(|_| {
            let bridge = Arc::clone(&bridge);
            let receiver = Arc::clone(&receiver);
            std::thread::spawn(move || loop {
                let request = match receiver.lock().unwrap().recv() {
                    Ok(request) => request,
                    Err(_) => return,
                };
                bridge.handle(request);
            })
        })
        .collect();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(request) => {
                if sender.send(request).is_err() {
                    break;
                }
            }
            Err(error) => {
                // The Python bridge dies on a bad request line too; the caller sees EOF.
                eprintln!("bad request line: {error}");
                std::process::exit(1);
            }
        }
    }
    drop(sender);
    for handle in handles {
        let _ = handle.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_matches_python() {
        let params = json!({"expansion_id": 4690, "q": "a b/c", "flag": true});
        assert_eq!(
            urlencode(params.as_object().unwrap()),
            "expansion_id=4690&q=a+b%2Fc&flag=True"
        );
        assert_eq!(urlencode(&serde_json::Map::new()), "");
    }

    #[test]
    fn http_date_parses_to_unix_seconds() {
        assert_eq!(parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT"), Some(784_111_777.0));
        assert_eq!(parse_http_date("soon"), None);
    }

    #[test]
    fn book_is_stored_on_one_line_and_checked() {
        let mut file = match store_book(&b"  {\"1\":[{\"id\":5,\"name\":\"A\\nB\"}],\r\n \"2\":[]}\n"[..]) {
            Ok(file) => file,
            Err(_) => panic!("valid book rejected"),
        };
        let mut text = String::new();
        file.read_to_string(&mut text).unwrap();
        assert_eq!(text, "  {\"1\":[{\"id\":5,\"name\":\"A\\nB\"}], \"2\":[]}");
        assert!(matches!(store_book(&b"[1,2]"[..]), Err(Failure::Retry(message)) if message.contains("Expected listing book")));
        assert!(matches!(store_book(&b""[..]), Err(Failure::Retry(_))));
    }
}
