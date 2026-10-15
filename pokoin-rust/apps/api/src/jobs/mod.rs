//! Native one-shot Pi timer jobs. Never invoke the retired Node backend.
mod cardtrader;
mod eur;
mod referral;
mod reprice;
mod search;

use anyhow::{bail, Context, Result};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::time::Duration;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Options {
    dry_run: bool,
    since: Option<String>,
    /// `--seller=<uid>`: the one seller a seller job works on.
    seller: Option<String>,
    /// `--apply`: a job that is a dry run by default writes.
    apply: bool,
    /// `--csv=<path>`: where a job writes its CSV report.
    csv: Option<String>,
}
impl Options {
    fn parse(args: impl IntoIterator<Item = String>) -> Self {
        let mut options = Self::default();
        for arg in args {
            if arg == "--dry-run" {
                options.dry_run = true;
            }
            if let Some(since) = arg.strip_prefix("--since=") {
                if options.since.is_none() {
                    options.since = Some(since.to_string());
                }
            }
            if arg == "--apply" {
                options.apply = true;
            }
            if let Some(seller) = arg.strip_prefix("--seller=").filter(|v| !v.trim().is_empty()) {
                options.seller.get_or_insert_with(|| seller.trim().to_string());
            }
            if let Some(path) = arg.strip_prefix("--csv=").filter(|v| !v.trim().is_empty()) {
                options.csv.get_or_insert_with(|| path.trim().to_string());
            }
        }
        options
    }
}
/// Invoked before any HTTP listeners are opened. Failure means non-zero exit.
pub async fn run(name: &str) -> Result<()> {
    let options = Options::parse(std::env::args().skip(1));
    match name {
        "eur-orders-sweep" => eur::run(&options).await,
        "referral-reconcile" => referral::run(&options).await,
        "cardtrader-seller-reconcile" => cardtrader::run(&options).await,
        "cardtrader-pro-floor-reprice" => reprice::run(&options).await,
        "search-delta" => search::run(&options).await,
        "search-reindex" => search::run_reindex(&options).await,
        _ => bail!("Unknown native job: {name}"),
    }
}
async fn read_pool() -> Result<PgPool> {
    let url = std::env::var("MARKETPLACE_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .context("MARKETPLACE_DATABASE_URL is required")?;
    pool(&url).await
}
async fn pool(url: &str) -> Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(8))
        .connect(url)
        .await
        .context("marketplace database connect failed")
}
async fn writer_pool(read: &PgPool) -> Result<PgPool> {
    let read_url = std::env::var("MARKETPLACE_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_default();
    match std::env::var("MARKETPLACE_WRITER_DATABASE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        // The overflow points both URLs at the writer: one pool, not two.
        Some(url) if url.trim() != read_url.trim() => pool(&url).await,
        _ => Ok(read.clone()),
    }
}
fn accounts_firestore() -> Result<pokoin_accounts::firestore::Firestore> {
    pokoin_accounts::DomainState::from_env()
        .firestore()
        .map_err(|e| anyhow::anyhow!(e.to_string()))
}
async fn redis_connection() -> Result<redis::aio::ConnectionManager> {
    let host = std::env::var("REDIS_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("REDIS_PORT").unwrap_or_else(|_| "6380".into());
    let client = redis::Client::open(format!("redis://{host}:{port}"))?;
    tokio::time::timeout(Duration::from_secs(5), client.get_connection_manager())
        .await
        .context("Redis connect timed out")?
        .context("Redis connect failed")
}
fn now_ms() -> i64 {
    pokoin_external::time_util::now_ms()
}
fn text(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        Some(serde_json::Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}
fn clipped(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seller_job_flags() {
        let options = Options::parse(["--seller=u1".into(), "--apply".into(), "--csv=/tmp/x.csv".into(), "--seller=u2".into()]);
        assert_eq!(options.seller.as_deref(), Some("u1"));
        assert!(options.apply && !options.dry_run);
        assert_eq!(options.csv.as_deref(), Some("/tmp/x.csv"));
        assert_eq!(Options::parse(["--seller=".into()]).seller, None);
    }
    #[test]
    fn timer_flags_keep_first_since_and_dry_run() {
        assert_eq!(
            Options::parse([
                "--job".into(),
                "search-delta".into(),
                "--since=a".into(),
                "--since=b".into(),
                "--dry-run".into()
            ]),
            Options {
                dry_run: true,
                since: Some("a".into()),
                ..Default::default()
            }
        );
    }
    #[tokio::test]
    async fn unknown_job_fails_before_opening_dependencies() {
        assert!(run("not-a-job").await.is_err());
    }
}
