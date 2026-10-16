//! The bridge binary against a scripted local HTTP server: same cases as
//! `scripts/cardtrader-rate-limit.test.py`, plus concurrent books.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

struct Server {
    base: String,
    seen: Arc<Mutex<Vec<String>>>,
}

#[derive(Clone)]
struct Route {
    status: &'static str,
    headers: &'static str,
    body: Vec<u8>,
    delay: Duration,
}

/// Answers `(status, extra headers, body)` in connection order, one response per connection.
/// For single-request tests; concurrent paths use [`serve_routes`].
fn serve(responses: Vec<(&'static str, &'static str, Vec<u8>)>) -> Server {
    let responses = Arc::new(Mutex::new(responses.into_iter()));
    listen(move |_| {
        responses.lock().unwrap().next().map(|(status, headers, body)| Route {
            status,
            headers,
            body,
            delay: Duration::ZERO,
        })
    })
}

/// Answers by the request path (suffix after `/api/v2`, query stripped). An unmatched path is 404.
fn serve_routes(routes: Vec<(&'static str, Route)>) -> Server {
    let routes = Arc::new(routes);
    listen(move |request_line| {
        let path = request_path(request_line);
        let key = path.strip_prefix("/api/v2").unwrap_or(path);
        Some(
            routes
                .iter()
                .find(|(suffix, _)| *suffix == key)
                .map(|(_, route)| route.clone())
                .unwrap_or(Route {
                    status: "404 Not Found",
                    headers: "",
                    body: Vec::new(),
                    delay: Duration::ZERO,
                }),
        )
    })
}

fn listen(pick: impl Fn(&str) -> Option<Route> + Send + Sync + 'static) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/api/v2", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    let pick = Arc::new(pick);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let log = Arc::clone(&log);
            let pick = Arc::clone(&pick);
            std::thread::spawn(move || {
                let (request_line, auth) = read_request(&mut stream);
                log.lock().unwrap().push(format!("{} | {auth}", request_line.trim()));
                let Some(route) = pick(request_line.trim()) else { return };
                if !route.delay.is_zero() {
                    std::thread::sleep(route.delay);
                }
                write_response(&mut stream, route.status, route.headers, &route.body);
            });
        }
    });
    Server { base, seen }
}

fn read_request(stream: &mut TcpStream) -> (String, String) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request_line = String::new();
    reader.read_line(&mut request_line).unwrap();
    let mut auth = String::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line.to_ascii_lowercase().starts_with("authorization:") {
            auth = line.trim().to_string();
        }
        if line == "\r\n" || line.is_empty() {
            break;
        }
    }
    (request_line, auth)
}

fn request_path(request_line: &str) -> &str {
    request_line.split_whitespace().nth(1).unwrap_or("").split('?').next().unwrap_or("")
}

fn write_response(stream: &mut TcpStream, status: &str, headers: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

/// Run the bridge with `requests` on stdin; return its stdout lines and the cooldown file.
fn run(server: &Server, requests: &[Value], backoff: &str) -> (Vec<Value>, String) {
    let dir = std::env::temp_dir().join(format!("ct-bridge-test-{}-{}", std::process::id(), rand_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    let cooldown = dir.join("cooldown.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_pokoin-cardtrader-bridge"))
        .env("POKOIN_CT_API_BASE", &server.base)
        .env("POKOIN_CT_TOKEN", "test-token")
        .env("POKOIN_CT_COOLDOWN_FILE", &cooldown)
        .env("POKOIN_CT_BACKOFF_SECONDS", backoff)
        .env("POKOIN_CT_RETRY_BASE_SECONDS", "0.01")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();
        for request in requests {
            writeln!(stdin, "{request}").unwrap();
        }
    }
    let mut out = String::new();
    child.stdout.take().unwrap().read_to_string(&mut out).unwrap();
    assert!(child.wait().unwrap().success());
    let cooldown_text = std::fs::read_to_string(&cooldown).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);
    (
        out.lines().map(|line| serde_json::from_str(line).unwrap()).collect(),
        cooldown_text,
    )
}

fn rand_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

fn book_request(id: u64) -> Value {
    json!({"id": id, "path": "/marketplace/products", "params": {"expansion_id": 4690}})
}

#[test]
fn rate_limit_pauses_through_the_shared_file_and_retries_the_same_request() {
    let server = serve(vec![
        ("429 Too Many Requests", "", b"{}".to_vec()),
        ("200 OK", "", b"{}".to_vec()),
    ]);
    let (lines, cooldown) = run(&server, &[book_request(7)], "0.2");
    assert_eq!(lines, vec![json!({"id": 7, "data": {}})]);
    let seen = server.seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0], seen[1], "the retry must be the same request");
    assert!(seen[0].contains("expansion_id=4690") && seen[0].contains("Bearer test-token"));
    let cooldown: Value = serde_json::from_str(&cooldown).unwrap();
    assert_eq!(cooldown["httpStatus"], 429);
}

#[test]
fn retry_after_longer_than_the_default_pause_is_honoured() {
    let server = serve(vec![
        ("429 Too Many Requests", "Retry-After: 1\r\n", b"{}".to_vec()),
        ("200 OK", "", b"{}".to_vec()),
    ]);
    let started = std::time::Instant::now();
    let (lines, _) = run(&server, &[book_request(1)], "0.1");
    assert_eq!(lines, vec![json!({"id": 1, "data": {}})]);
    assert!(started.elapsed().as_secs_f64() >= 0.9, "Retry-After: 1 was not honoured");
}

#[test]
fn authentication_failure_is_not_retried() {
    let server = serve(vec![("401 Unauthorized", "", b"{}".to_vec())]);
    let (lines, cooldown) = run(&server, &[book_request(7)], "0.1");
    assert_eq!(lines.len(), 1);
    assert!(lines[0]["error"].as_str().unwrap().contains("401"), "{lines:?}");
    assert_eq!(server.seen.lock().unwrap().len(), 1);
    assert!(cooldown.is_empty(), "401 must not start a cooldown");
}

#[test]
fn listing_book_is_forwarded_unparsed_on_one_line() {
    let body = b"{\"1\":[{\"id\":5,\"name\":\"A\\nB\"}],\r\n \"2\":[]}\n".to_vec();
    let server = serve(vec![("200 OK", "", body)]);
    let (lines, _) = run(&server, &[book_request(3)], "0.1");
    assert_eq!(lines, vec![json!({"id": 3, "data": {"1": [{"id": 5, "name": "A\nB"}], "2": []}})]);
}

#[test]
fn listing_book_that_is_not_an_object_is_retried_then_reported() {
    let server = serve((0..6).map(|_| ("200 OK", "", b"[1,2]".to_vec())).collect());
    let (lines, _) = run(&server, &[book_request(4)], "0.1");
    assert!(lines[0]["error"].as_str().unwrap().contains("Expected listing book"), "{lines:?}");
    assert_eq!(server.seen.lock().unwrap().len(), 6);
}

fn catalogue_route(body: &'static [u8], delay: Duration) -> Route {
    Route { status: "200 OK", headers: "", body: body.to_vec(), delay }
}

#[test]
fn catalogue_paths_are_parsed_and_unwrapped() {
    let server = serve_routes(vec![
        ("/expansions", catalogue_route(br#"{"array":[{"id":1}]}"#, Duration::ZERO)),
        ("/games", catalogue_route(br#"[{"id":2}]"#, Duration::ZERO)),
    ]);
    let (mut lines, _) = run(
        &server,
        &[
            json!({"id": "a", "path": "/expansions", "params": {}}),
            json!({"id": "b", "path": "/games"}),
        ],
        "0.1",
    );
    lines.sort_by_key(|line| line["id"].as_str().unwrap().to_string());
    assert_eq!(
        lines,
        vec![json!({"id": "a", "data": [{"id": 1}]}), json!({"id": "b", "data": [{"id": 2}]})]
    );
}

#[test]
fn catalogue_replies_follow_their_request_not_completion_order() {
    // The ordered mock paired by arrival, which is what flaked on 2026-10-16.
    let server = serve_routes(vec![
        ("/expansions", catalogue_route(br#"{"array":[{"id":1}]}"#, Duration::from_millis(1500))),
        ("/games", catalogue_route(br#"[{"id":2}]"#, Duration::ZERO)),
    ]);
    let (lines, _) = run(
        &server,
        &[
            json!({"id": "a", "path": "/expansions", "params": {}}),
            json!({"id": "b", "path": "/games"}),
        ],
        "0.1",
    );
    assert_eq!(
        lines,
        vec![json!({"id": "b", "data": [{"id": 2}]}), json!({"id": "a", "data": [{"id": 1}]})]
    );
    let seen = server.seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen.iter().filter(|line| line.contains("/expansions")).count(), 1);
    assert_eq!(seen.iter().filter(|line| line.contains("/games")).count(), 1);
}

#[test]
fn unsupported_path_is_rejected_without_a_request() {
    let server = serve(vec![]);
    let (lines, _) = run(&server, &[json!({"id": 9, "path": "/orders"})], "0.1");
    assert_eq!(lines, vec![json!({"id": 9, "error": "ValueError: Unsupported API path"})]);
    assert!(server.seen.lock().unwrap().is_empty());
}

#[test]
fn zstd_books_come_as_a_frame_and_plain_requests_still_get_lines() {
    let body = b"{\"1\":[{\"id\":5,\"name\":\"A\\nB\"}],\r\n \"2\":[]}\n".to_vec();
    let server = serve(vec![("200 OK", "", body.clone()), ("200 OK", "", body)]);
    let dir = std::env::temp_dir().join(format!("ct-bridge-zstd-{}-{}", std::process::id(), rand_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_pokoin-cardtrader-bridge"))
        .env("POKOIN_CT_API_BASE", &server.base)
        .env("POKOIN_CT_TOKEN", "test-token")
        .env("POKOIN_CT_COOLDOWN_FILE", dir.join("cooldown.json"))
        .env("POKOIN_CT_WORKERS", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();
        let mut zstd_request = book_request(1);
        zstd_request["encoding"] = json!("zstd");
        writeln!(stdin, "{zstd_request}").unwrap();
        writeln!(stdin, "{}", book_request(2)).unwrap();
    }
    let mut out = Vec::new();
    child.stdout.take().unwrap().read_to_end(&mut out).unwrap();
    assert!(child.wait().unwrap().success());
    let _ = std::fs::remove_dir_all(&dir);

    let newline = out.iter().position(|&byte| byte == b'\n').unwrap();
    let header: Value = serde_json::from_slice(&out[..newline]).unwrap();
    assert_eq!(header["id"], 1);
    assert_eq!(header["encoding"], "zstd");
    let len = header["bytes"].as_u64().unwrap() as usize;
    let frame = &out[newline + 1..newline + 1 + len];
    let book: Value = serde_json::from_slice(&zstd::stream::decode_all(frame).unwrap()).unwrap();
    assert_eq!(book, json!({"1": [{"id": 5, "name": "A\nB"}], "2": []}));
    let rest: Value = serde_json::from_slice(out[newline + 1 + len..].strip_suffix(b"\n").unwrap()).unwrap();
    assert_eq!(rest, json!({"id": 2, "data": {"1": [{"id": 5, "name": "A\nB"}], "2": []}}));
}

#[test]
fn several_books_in_flight_each_get_one_whole_line() {
    let big = format!("{{\"7\":[{}]}}", vec![r#"{"id":1,"name":"x"}"#; 20_000].join(","));
    let server = serve(
        (0..3)
            .map(|_| ("200 OK", "", big.clone().into_bytes()))
            .collect(),
    );
    let (lines, _) = run(&server, &[book_request(1), book_request(2), book_request(3)], "0.1");
    let mut ids: Vec<u64> = lines.iter().map(|line| line["id"].as_u64().unwrap()).collect();
    ids.sort();
    assert_eq!(ids, vec![1, 2, 3]);
    for line in &lines {
        assert_eq!(line["data"]["7"].as_array().unwrap().len(), 20_000);
    }
}
