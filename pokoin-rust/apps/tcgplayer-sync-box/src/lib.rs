//! TCGplayer sync box worker.
//!
//! Heartbeat, claim, portal, complete. The browser portal is tested against a
//! local mock only. The bearer token is read from `--token-file` and is
//! redacted in [`api::ApiClient`]'s `Debug`.
mod api;
mod browser;
mod portal;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use serde_json::Value;

use api::{ApiClient, ClaimedJob, DeviceError, MAX_CLAIM};
use browser::LaunchOptions;
use portal::PortalWrite;

pub use api::ApiClient as Client;
pub use browser::{find_chrome, BrowserPortal, LaunchOptions as BrowserLaunch, PortalConfig};
pub use portal::{csv_portal, open_portal, FakePortal, Portal, PortalError, PortalError as Error};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const HEARTBEAT_EVERY: Duration = Duration::from_secs(30);
const WRITES_PER_HOUR: u32 = 600;

/// One listing the portal should write. Absolute quantity and price.
#[derive(Debug, Clone, Default)]
pub struct ListingTarget {
    pub listing_id: String,
    pub external_id: String,
    pub quantity: i64,
    pub price_cents: Option<i64>,
    pub card_id: String,
    pub card_name: String,
    pub set_name: String,
    pub collector_number: String,
    pub condition: String,
    pub language: String,
    pub reverse: bool,
    pub first_edition: bool,
    pub kind: String,
}

struct Applied {
    writes: u32,
    external_id: Option<String>,
    result: Option<Value>,
}

fn jitter() -> Duration {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    Duration::from_millis(2_000 + u64::from(nanos % 4_001))
}

async fn apply_one(portal: &dyn Portal, target: &ListingTarget) -> Result<PortalWrite, PortalError> {
    match target.kind.as_str() {
        "set_qty" => portal.set_quantity(target).await,
        "set_price" => portal.set_price(target).await,
        _ => portal.set_listing(target).await,
    }
}

async fn apply_job(portal: &dyn Portal, job: &ClaimedJob) -> Result<Applied, PortalError> {
    if job.kind == "pull_orders" {
        let orders = portal.fetch_orders(job.since.as_deref()).await?;
        return Ok(Applied {
            writes: 0,
            external_id: None,
            result: Some(serde_json::json!({"orders": orders})),
        });
    }
    let wrote = apply_one(portal, &job.target).await?;
    let external_id = if wrote.external_id.is_empty() { None } else { Some(wrote.external_id) };
    Ok(Applied { writes: u32::from(wrote.changed), external_id, result: None })
}

async fn finish(api: &ApiClient, job: &ClaimedJob, outcome: &str, external_id: Option<&str>, result: Option<&Value>, error: Option<&str>) -> anyhow::Result<()> {
    match api.complete(job.job_id, &job.lease_token, outcome, external_id, result, error).await {
        Ok(()) => Ok(()),
        Err(DeviceError::LeaseLost) => {
            tracing::warn!(job_id = job.job_id, "channel sync lease lost");
            Ok(())
        }
        Err(DeviceError::Http(error)) => Err(error),
    }
}

fn blocked_message(reason: &str) -> String {
    format!("blocked: {reason} — open the box's Chrome window and clear it")
}

fn claim_limit(pace: bool, hourly: u32, total: u32, max_writes: Option<u32>) -> Option<i64> {
    if pace && hourly >= WRITES_PER_HOUR {
        return None;
    }
    if max_writes.is_some_and(|limit| total >= limit) {
        return None;
    }
    let hour_room = if pace { WRITES_PER_HOUR.saturating_sub(hourly) } else { MAX_CLAIM as u32 };
    let budget = max_writes.map(|limit| limit.saturating_sub(total)).unwrap_or(u32::MAX);
    let room = hour_room.min(budget);
    if room == 0 {
        return None;
    }
    Some(i64::from(room).clamp(1, MAX_CLAIM))
}

async fn drive(
    api: &ApiClient,
    portal: &dyn Portal,
    pace: bool,
    writes: &mut u32,
    total_writes: &mut u32,
    max_writes: Option<u32>,
    blocked: &mut Option<String>,
) -> anyhow::Result<()> {
    match portal.signed_in().await {
        Ok(true) => *blocked = None,
        Ok(false) | Err(PortalError::SignedOut) => {
            if let Some(reason) = blocked.clone() {
                let message = blocked_message(&reason);
                api.heartbeat(false, false, VERSION, Some(&message)).await?;
            } else {
                api.heartbeat(false, true, VERSION, None).await?;
            }
            return Ok(());
        }
        Err(PortalError::Blocked(reason)) => {
            *blocked = Some(reason.clone());
            let message = blocked_message(&reason);
            api.heartbeat(false, false, VERSION, Some(&message)).await?;
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    }
    let beat = api.heartbeat(true, true, VERSION, None).await?;
    if !beat.enabled {
        return Ok(());
    }
    let Some(max) = claim_limit(pace, *writes, *total_writes, max_writes) else {
        return Ok(());
    };
    let jobs = api.claim(max).await?;
    let mut halt: Option<String> = None;
    for job in &jobs {
        if let Some(message) = &halt {
            finish(api, job, "needs_sign_in", None, None, Some(message)).await?;
            continue;
        }
        if claim_limit(pace, *writes, *total_writes, max_writes).is_none() {
            break;
        }
        match apply_job(portal, job).await {
            Ok(applied) => {
                if job.kind == "pull_orders" {
                    let orders = applied.result.as_ref().and_then(|value| value["orders"].as_array()).cloned().unwrap_or_default();
                    api.post_orders(&orders).await?;
                    finish(api, job, "done", None, None, None).await?;
                } else {
                    *writes = writes.saturating_add(applied.writes);
                    *total_writes = total_writes.saturating_add(applied.writes);
                    if pace && applied.writes > 0 {
                        tokio::time::sleep(jitter()).await;
                    }
                    finish(api, job, "done", applied.external_id.as_deref(), applied.result.as_ref(), None).await?;
                }
            }
            Err(PortalError::SignedOut) => {
                halt = Some("signed out".to_string());
                finish(api, job, "needs_sign_in", None, None, Some("signed out")).await?;
            }
            Err(PortalError::Blocked(reason)) => {
                *blocked = Some(reason.clone());
                let message = blocked_message(&reason);
                halt = Some(message.clone());
                finish(api, job, "needs_sign_in", None, None, Some(&message)).await?;
            }
            Err(PortalError::Transient(message)) => {
                let message = clip(&message);
                finish(api, job, "retry", None, None, Some(&message)).await?;
            }
            Err(PortalError::Permanent(message)) => {
                let message = clip(&message);
                finish(api, job, "failed", None, None, Some(&message)).await?;
            }
        }
    }
    if let Some(reason) = blocked.clone() {
        if halt.as_deref().is_some_and(|message| message.starts_with("blocked:")) {
            let message = blocked_message(&reason);
            api.heartbeat(false, false, VERSION, Some(&message)).await?;
        }
    }
    Ok(())
}

fn clip(message: &str) -> String {
    message.chars().take(500).collect()
}

/// One pass: heartbeat, and if the box is enabled and signed in, claim and complete.
pub async fn run_once(api: &ApiClient, portal: &dyn Portal) -> anyhow::Result<()> {
    let mut writes = 0u32;
    let mut total_writes = 0u32;
    let mut blocked = None;
    drive(api, portal, false, &mut writes, &mut total_writes, None, &mut blocked).await
}

/// Heartbeat every 30s. Portal writes wait 2–6s and stop at 600 an hour.
/// `max_writes` ends the process with success once that many changed writes
/// have happened. A captcha latch stays up until a later pass's `signed_in` succeeds.
pub async fn run(api: &ApiClient, portal: &dyn Portal, max_writes: Option<u32>) -> anyhow::Result<()> {
    let mut writes = 0u32;
    let mut total_writes = 0u32;
    let mut window = Instant::now();
    let mut blocked = None;
    loop {
        if max_writes.is_some_and(|limit| total_writes >= limit) {
            return Ok(());
        }
        if window.elapsed() >= Duration::from_secs(3600) {
            window = Instant::now();
            writes = 0;
        }
        let started = Instant::now();
        if let Err(error) = drive(api, portal, true, &mut writes, &mut total_writes, max_writes, &mut blocked).await {
            tracing::warn!(%error, "tcgplayer sync box pass failed");
        }
        if max_writes.is_some_and(|limit| total_writes >= limit) {
            return Ok(());
        }
        let pause = HEARTBEAT_EVERY.saturating_sub(started.elapsed());
        if !pause.is_zero() {
            tokio::time::sleep(pause).await;
        }
    }
}

/// `--profile-dir`, mode 700. Session state for the unbuilt browser portal
/// would live only here.
pub fn prepare_profile_dir(path: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(path).with_context(|| format!("could not create {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("could not set permissions on {}", path.display()))?;
    }
    Ok(())
}

enum Command {
    Run,
    Check,
    SignIn,
}

struct Args {
    command: Command,
    api: String,
    token_file: Option<PathBuf>,
    profile_dir: PathBuf,
    portal: Option<String>,
    chrome: Option<PathBuf>,
    headless: bool,
    portal_config: Option<PathBuf>,
    sku: Option<String>,
    max_writes: Option<u32>,
}

fn default_profile() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(".local/share/pokoin-tcgplayer-box/profile")
}

fn usage() -> &'static str {
    "tcgplayer-sync-box [--api URL] [--token-file PATH] [--profile-dir PATH] \
     [--portal fake|csv|browser] [--chrome PATH] [--headless] [--max-writes N] [--portal-config FILE] \
     [check [--sku ID]|sign-in]"
}

fn parse_args(args: impl IntoIterator<Item = String>) -> anyhow::Result<Args> {
    let mut command = Command::Run;
    let mut api = "https://api.pokoin.com".to_string();
    let mut token_file = None;
    let mut profile_dir = None;
    let mut portal = None;
    let mut chrome = None;
    let mut headless = false;
    let mut portal_config = None;
    let mut sku = None;
    let mut max_writes = None;
    let mut args = args.into_iter().peekable();
    while let Some(arg) = args.next() {
        if arg == "--help" || arg == "-h" {
            println!("{}", usage());
            std::process::exit(0);
        }
        if arg == "check" {
            command = Command::Check;
            continue;
        }
        if arg == "sign-in" {
            command = Command::SignIn;
            continue;
        }
        if arg == "--headless" {
            headless = true;
            continue;
        }
        let (key, value) = if let Some((key, value)) = arg.split_once('=') {
            (key.to_string(), value.to_string())
        } else if arg.starts_with("--") {
            let value = args.next().with_context(|| format!("missing value for {arg}"))?;
            (arg, value)
        } else {
            anyhow::bail!("unknown argument {arg}");
        };
        match key.as_str() {
            "--api" => api = value,
            "--token-file" => token_file = Some(PathBuf::from(value)),
            "--profile-dir" => profile_dir = Some(PathBuf::from(value)),
            "--portal" => portal = Some(value),
            "--chrome" => chrome = Some(PathBuf::from(value)),
            "--portal-config" => portal_config = Some(PathBuf::from(value)),
            "--sku" => sku = Some(value),
            "--max-writes" => {
                max_writes = Some(value.parse::<u32>().with_context(|| format!("--max-writes wants a number, got {value}"))?);
            }
            other => anyhow::bail!("unknown argument {other}"),
        }
    }
    if matches!(command, Command::Run) {
        token_file.as_ref().context("--token-file is required")?;
        portal.as_ref().context("--portal is required (fake, csv, or browser)")?;
    }
    Ok(Args { command, api, token_file, profile_dir: profile_dir.unwrap_or_else(default_profile), portal, chrome, headless, portal_config, sku, max_writes })
}

fn launch_options(args: &Args, headless: bool) -> anyhow::Result<LaunchOptions> {
    let config = match &args.portal_config {
        Some(path) => PortalConfig::load(path)?,
        None => PortalConfig::tcgplayer_defaults(),
    };
    Ok(LaunchOptions {
        profile_dir: args.profile_dir.clone(),
        chrome: args.chrome.clone(),
        headless,
        config,
        action_gap_ms: browser::ACTION_GAP_MS,
    })
}

fn read_token(path: &Path) -> anyhow::Result<String> {
    let token = std::fs::read_to_string(path)
        .with_context(|| format!("could not read token file {}", path.display()))?;
    let token = token.trim().to_string();
    if token.is_empty() || !token.starts_with("pkn_") {
        anyhow::bail!("token file does not contain a Pokoin API token");
    }
    Ok(token)
}

pub async fn cli(args: impl IntoIterator<Item = String>) -> anyhow::Result<()> {
    let args = parse_args(args)?;
    prepare_profile_dir(&args.profile_dir)?;
    match args.command {
        Command::Check => {
            let portal = BrowserPortal::launch(launch_options(&args, args.headless)?).await?;
            println!("{}", portal.check(args.sku.as_deref()).await?);
            Ok(())
        }
        Command::SignIn => {
            let portal = BrowserPortal::launch(launch_options(&args, false)?).await?;
            println!("Sign in in the Chrome window. The box will not type.");
            portal.wait_for_sign_in().await?;
            println!("Signed in.");
            Ok(())
        }
        Command::Run => {
            let token = read_token(args.token_file.as_deref().context("--token-file is required")?)?;
            let portal_kind = args.portal.clone().context("--portal is required (fake, csv, or browser)")?;
            let portal = open_portal(&portal_kind, launch_options(&args, args.headless)?).await?;
            let api = ApiClient::new(args.api, token)?;
            run(&api, portal.as_ref(), args.max_writes).await
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::routing::post;
    use axum::{Json, Router};
    use serde_json::{json, Value};

    use super::*;
    use crate::portal::PortalError;

    #[test]
    fn a_pass_claims_at_most_five_jobs() {
        assert_eq!(MAX_CLAIM, 5);
        assert_eq!(claim_limit(true, 599, 0, Some(1000)), Some(1));
        assert_eq!(claim_limit(true, 600, 0, Some(1000)), None);
        assert_eq!(claim_limit(true, 0, 0, Some(2)), Some(2));
        assert_eq!(claim_limit(false, 0, 2, Some(2)), None);
    }

    #[tokio::test]
    async fn max_writes_stops_after_the_in_flight_job() {
        let mock = Mock::default();
        {
            let mut guard = mock.inner.lock().unwrap();
            guard.enabled = true;
            guard.jobs = vec![job(1, "set_qty"), job(2, "set_qty"), job(3, "set_qty"), job(4, "set_qty")];
        }
        let (base, mock) = mock.server("pkn_testtokenvalue").await;
        let portal = FakePortal::new();
        let api = client(&base).await;
        let mut writes = 0u32;
        let mut total = 0u32;
        let mut blocked = None;
        drive(&api, &portal, false, &mut writes, &mut total, Some(2), &mut blocked).await.expect("first");
        assert_eq!(portal.writes().len(), 2);
        assert_eq!(total, 2);
        {
            let guard = mock.inner.lock().unwrap();
            assert_eq!(guard.claim_calls, 1);
            assert_eq!(guard.claim_max, 2);
            assert_eq!(guard.completes.len(), 2);
            assert!(guard.completes.iter().all(|row| row["outcome"] == "done"));
        }
        drive(&api, &portal, false, &mut writes, &mut total, Some(2), &mut blocked).await.expect("stopped");
        assert_eq!(mock.inner.lock().unwrap().claim_calls, 1);
        assert_eq!(portal.writes().len(), 2);
    }

    #[derive(Clone, Default)]
    struct Mock {
        inner: Arc<Mutex<MockInner>>,
    }

    #[derive(Default)]
    struct MockInner {
        enabled: bool,
        claim_calls: u32,
        completes: Vec<Value>,
        heartbeats: Vec<Value>,
        order_posts: u32,
        posted_orders: Vec<Value>,
        jobs: Vec<Value>,
        lease_lost: Vec<i64>,
        claim_max: i64,
    }

    impl Mock {
        async fn server(self, token: &str) -> (String, Mock) {
            let token = token.to_string();
            let state = self.clone();
            let app = Router::new()
                .route(
                    "/api/channel-sync/device",
                    post(move |State(mock): State<Mock>, headers: axum::http::HeaderMap, Json(body): Json<Value>| async move {
                        let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("");
                        if auth != format!("Bearer {token}") {
                            return (StatusCode::UNAUTHORIZED, Json(json!({"error": "no"})));
                        }
                        let mut guard = mock.inner.lock().expect("mock");
                        let action = body["action"].as_str().unwrap_or("");
                        match action {
                            "heartbeat" => {
                                guard.heartbeats.push(body);
                                let enabled = guard.enabled;
                                (StatusCode::OK, Json(json!({"enabled": enabled, "pollAfterMs": 30000})))
                            }
                            "claim" => {
                                guard.claim_calls += 1;
                                guard.claim_max = body["max"].as_i64().unwrap_or(0);
                                let jobs = guard.jobs.clone();
                                (StatusCode::OK, Json(json!({"jobs": jobs})))
                            }
                            "complete" => {
                                let job_id = body["jobId"].as_i64().unwrap_or(0);
                                if let Some(pos) = guard.lease_lost.iter().position(|id| *id == job_id) {
                                    guard.lease_lost.remove(pos);
                                    return (
                                        StatusCode::CONFLICT,
                                        Json(json!({"error": "This job was claimed again.", "code": "channel_sync/lease-lost"})),
                                    );
                                }
                                guard.completes.push(body);
                                (StatusCode::OK, Json(json!({"ok": true})))
                            }
                            "orders" => {
                                guard.order_posts += 1;
                                if let Some(orders) = body["orders"].as_array() {
                                    guard.posted_orders.extend(orders.clone());
                                }
                                (StatusCode::OK, Json(json!({"orders": 1, "inserted": 1, "updated": 0, "stockApplied": 0, "unmatched": 0})))
                            }
                            _ => (StatusCode::BAD_REQUEST, Json(json!({"error": "unknown"}))),
                        }
                    }),
                )
                .with_state(state.clone());
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
            listener.set_nonblocking(true).expect("nonblocking");
            let address = listener.local_addr().expect("addr");
            let listener = tokio::net::TcpListener::from_std(listener).expect("tokio");
            tokio::spawn(async move {
                axum::serve(listener, app).await.expect("serve");
            });
            tokio::time::sleep(Duration::from_millis(30)).await;
            (format!("http://{address}"), self)
        }
    }

    fn job(id: i64, kind: &str) -> Value {
        json!({
            "jobId": id,
            "leaseToken": format!("lease-{id}"),
            "kind": kind,
            "listingId": format!("listing-{id}"),
            "externalId": "",
            "quantity": 2,
            "priceCents": 100,
            "cardId": "22",
            "cardName": "Eevee",
            "setName": "Jungle",
            "collectorNumber": "51/64",
            "condition": "NM",
            "language": "EN",
            "reverse": false,
            "firstEdition": false
        })
    }

    async fn client(base: &str) -> ApiClient {
        ApiClient::new(base, "pkn_testtokenvalue").expect("client")
    }

    #[tokio::test]
    async fn disabled_box_does_not_claim() {
        let mock = Mock::default();
        mock.inner.lock().unwrap().enabled = false;
        let (base, mock) = mock.server("pkn_testtokenvalue").await;
        let portal = FakePortal::new();
        run_once(&client(&base).await, &portal).await.expect("run");
        assert_eq!(mock.inner.lock().unwrap().claim_calls, 0);
    }

    #[tokio::test]
    async fn signed_out_box_does_not_claim() {
        let mock = Mock::default();
        mock.inner.lock().unwrap().enabled = true;
        let (base, mock) = mock.server("pkn_testtokenvalue").await;
        let portal = FakePortal::new();
        portal.set_signed_in(false);
        run_once(&client(&base).await, &portal).await.expect("run");
        assert_eq!(mock.inner.lock().unwrap().claim_calls, 0);
    }

    #[tokio::test]
    async fn claim_sets_the_listing_and_completes_with_its_external_id() {
        let mock = Mock::default();
        {
            let mut guard = mock.inner.lock().unwrap();
            guard.enabled = true;
            guard.jobs = vec![job(7, "push_listing")];
        }
        let (base, mock) = mock.server("pkn_testtokenvalue").await;
        let portal = FakePortal::new();
        run_once(&client(&base).await, &portal).await.expect("run");
        let completes = mock.inner.lock().unwrap().completes.clone();
        assert_eq!(completes.len(), 1);
        assert_eq!(completes[0]["outcome"], "done");
        assert_eq!(completes[0]["externalId"], "fake-listing-7");
        assert_eq!(portal.writes(), vec!["listing:fake-listing-7".to_string()]);
    }

    #[tokio::test]
    async fn transient_portal_error_completes_as_retry() {
        let mock = Mock::default();
        {
            let mut guard = mock.inner.lock().unwrap();
            guard.enabled = true;
            guard.jobs = vec![job(1, "push_listing")];
        }
        let (base, mock) = mock.server("pkn_testtokenvalue").await;
        let portal = FakePortal::new();
        portal.fail_next(PortalError::Transient("portal timed out".into()));
        run_once(&client(&base).await, &portal).await.expect("run");
        let completes = mock.inner.lock().unwrap().completes.clone();
        assert_eq!(completes[0]["outcome"], "retry");
    }

    #[tokio::test]
    async fn signed_out_during_a_write_completes_as_needs_sign_in() {
        let mock = Mock::default();
        {
            let mut guard = mock.inner.lock().unwrap();
            guard.enabled = true;
            guard.jobs = vec![job(1, "push_listing")];
        }
        let (base, mock) = mock.server("pkn_testtokenvalue").await;
        let portal = FakePortal::new();
        portal.fail_next(PortalError::SignedOut);
        run_once(&client(&base).await, &portal).await.expect("run");
        let completes = mock.inner.lock().unwrap().completes.clone();
        assert_eq!(completes[0]["outcome"], "needs_sign_in");
    }

    #[tokio::test]
    async fn lease_lost_does_not_abort_the_batch() {
        let mock = Mock::default();
        {
            let mut guard = mock.inner.lock().unwrap();
            guard.enabled = true;
            guard.jobs = vec![job(1, "push_listing"), job(2, "push_listing")];
            guard.lease_lost = vec![1];
        }
        let (base, mock) = mock.server("pkn_testtokenvalue").await;
        let portal = FakePortal::new();
        run_once(&client(&base).await, &portal).await.expect("run");
        let completes = mock.inner.lock().unwrap().completes.clone();
        assert_eq!(completes.len(), 1, "the lost lease is not a successful complete");
        assert_eq!(completes[0]["jobId"], 2);
        assert_eq!(completes[0]["outcome"], "done");
        assert_eq!(portal.writes().len(), 2);
    }

    #[tokio::test]
    async fn pull_orders_posts_orders_once() {
        let mock = Mock::default();
        {
            let mut guard = mock.inner.lock().unwrap();
            guard.enabled = true;
            guard.jobs = vec![json!({"jobId": 9, "leaseToken": "lease-9", "kind": "pull_orders", "since": null})];
        }
        let (base, mock) = mock.server("pkn_testtokenvalue").await;
        let portal = FakePortal::new();
        portal.set_orders(vec![json!({"externalOrderId": "A-1", "lines": []})]);
        run_once(&client(&base).await, &portal).await.expect("run");
        let guard = mock.inner.lock().unwrap();
        assert_eq!(guard.order_posts, 1);
        assert_eq!(guard.posted_orders.len(), 1);
        assert_eq!(guard.posted_orders[0]["externalOrderId"], "A-1");
        assert_eq!(guard.completes.len(), 1);
        assert_eq!(guard.completes[0]["outcome"], "done");
    }

    #[test]
    fn api_client_debug_redacts_the_token() {
        let client = ApiClient::new("http://127.0.0.1:9", "pkn_supersecretvalue").expect("client");
        let rendered = format!("{client:?}");
        assert!(!rendered.contains("pkn_supersecretvalue"));
        assert!(!rendered.contains("supersecret"));
        assert!(rendered.contains("<redacted>"));
    }

    #[test]
    fn csv_portal_is_not_built_and_a_missing_chrome_path_is_rejected() {
        let err = csv_portal().err().expect("csv portal built");
        assert!(err.to_string().contains("csv portal not built yet"));
        assert!(find_chrome(Some(Path::new("/no/such/chrome-for-pokoin"))).is_none());
    }

    #[tokio::test]
    async fn blocked_portal_stops_the_batch_until_sign_in_succeeds() {
        let mock = Mock::default();
        {
            let mut guard = mock.inner.lock().unwrap();
            guard.enabled = true;
            guard.jobs = vec![job(1, "push_listing"), job(2, "push_listing")];
        }
        let (base, mock) = mock.server("pkn_testtokenvalue").await;
        let api = client(&base).await;
        let portal = FakePortal::new();
        portal.fail_next(PortalError::Blocked("recaptcha frame".into()));
        let mut writes = 0u32;
        let mut total_writes = 0u32;
        let mut blocked = None;
        drive(&api, &portal, false, &mut writes, &mut total_writes, None, &mut blocked).await.expect("pass");
        {
            let guard = mock.inner.lock().unwrap();
            assert_eq!(guard.claim_calls, 1);
            assert_eq!(guard.completes.len(), 2);
            assert!(guard.completes.iter().all(|row| row["outcome"] == "needs_sign_in"));
            let stopped: Vec<_> = guard.heartbeats.iter().filter(|row| row["running"] == false).collect();
            assert_eq!(stopped.len(), 1);
            let error = stopped[0]["error"].as_str().unwrap();
            assert_eq!(error, "blocked: recaptcha frame — open the box's Chrome window and clear it");
        }
        assert!(blocked.is_some());
        portal.block_sign_in("recaptcha frame");
        drive(&api, &portal, false, &mut writes, &mut total_writes, None, &mut blocked).await.expect("still blocked");
        assert_eq!(mock.inner.lock().unwrap().claim_calls, 1, "a later pass does not claim while sign-in is blocked");
        portal.clear_sign_in_block();
        drive(&api, &portal, false, &mut writes, &mut total_writes, None, &mut blocked).await.expect("clear");
        assert!(blocked.is_none());
        assert_eq!(mock.inner.lock().unwrap().claim_calls, 2);
    }

    #[test]
    fn check_command_does_not_require_a_token() {
        let args = parse_args(["check", "--headless", "--chrome", "/usr/bin/google-chrome", "--portal-config", "portal.json"].map(str::to_string)).expect("parse");
        assert!(matches!(args.command, Command::Check));
        assert!(args.headless);
        assert!(args.token_file.is_none());
        assert_eq!(args.chrome.unwrap(), PathBuf::from("/usr/bin/google-chrome"));
        let sku = parse_args(["check", "--sku", "NM-EN"].map(str::to_string)).expect("sku");
        assert_eq!(sku.sku.as_deref(), Some("NM-EN"));
        let limited = parse_args(["--token-file", "token", "--portal", "fake", "--max-writes", "5"].map(str::to_string)).expect("max");
        assert_eq!(limited.max_writes, Some(5));
    }

    #[test]
    fn profile_dir_is_owner_only() {
        let dir = std::env::temp_dir().join(format!("pokoin-tcg-box-profile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        prepare_profile_dir(&dir).expect("create");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dir).expect("meta").permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
