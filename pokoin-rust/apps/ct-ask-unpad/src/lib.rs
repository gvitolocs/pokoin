//! `ct-ask-unpad` — take the 200 PKN shipping pad out of the stored CardTrader
//! lowest ask in `public.cardtrader_blueprint_daily_analytics`.
//!
//! Until 2026-09-21 the CardTrader price cache converted a EUR ask to PKN and
//! then added a flat 1 EUR (200 PKN) on top. The job was fixed on 2026-09-21;
//! the history it had already written was not, so a card page reads a "CT lowest
//! ask" 200 PKN too high for the days the pad covers.
//!
//! The rule, the day ranges and the backup-table contract are in README.md. The
//! same SQL text drives `plan` and `apply`, so a plan reports exactly what the
//! apply will do.

mod apply;
mod args;
mod ident;
mod plan;
mod preflight;
mod query;
mod report;
mod revert;
mod secret;
mod sql;
mod verify;

use sqlx::postgres::PgPoolOptions;

pub use args::{parse, Args, Command, NAME, USAGE};
pub use report::Report;

/// The pad the job added on top of the EUR→PKN conversion, in PKN.
pub const PAD_PKN: i64 = 200;
/// First `observed_day` whose rows carry the pad.
pub const PAD_FROM: &str = "2026-08-31";
/// Last `observed_day` whose rows carry the pad.
pub const PAD_TO: &str = "2026-09-19";
/// Day whose prices are right but whose `previous_min_price_pkn` still points
/// at a padded value.
pub const PREVIOUS_DAY: &str = "2026-09-23";
/// The day just before the window, which `verify` proves was never written.
pub const BEFORE_WINDOW_DAY: &str = "2026-08-10";

/// Environment variable read for the connection URL when `--database-url-env`
/// is absent. The URL is never an argument, never printed and never logged.
pub const DEFAULT_URL_ENV: &str = "MARKETPLACE_DATABASE_URL";

/// Sample rows `plan` prints from each end of the price range.
pub const SAMPLES: i64 = 5;

/// Run `args`: read the URL from the named environment variable, then dispatch.
/// Errors are redacted, so the URL cannot escape in a message.
pub async fn run(args: &Args) -> Result<Report, String> {
    let name = args
        .database_url_env
        .clone()
        .unwrap_or_else(|| DEFAULT_URL_ENV.to_string());
    let url = std::env::var(&name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} is not set"))?;
    match execute(args, url.trim()).await {
        Ok(report) => Ok(report),
        Err(error) => Err(secret::redact(&url, &error)),
    }
}

/// Run `args` against a URL the caller already holds. The tests use this: they
/// own a throwaway database and never go through the process environment.
pub async fn execute(args: &Args, url: &str) -> Result<Report, String> {
    // One connection: `plan` and `verify` set a session-level read-only flag,
    // and it has to be the connection their own queries run on.
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(60))
        .connect(url)
        .await
        .map_err(|error| format!("cannot connect to the marketplace database: {error}"))?;
    let mut conn = pool
        .acquire()
        .await
        .map_err(|error| format!("cannot take a connection: {error}"))?;
    if matches!(args.command, Command::Plan | Command::Verify) {
        sqlx::query(sql::READ_ONLY)
            .execute(&mut *conn)
            .await
            .map_err(|error| query::why("cannot make this session read-only", error))?;
    }
    let outcome = dispatch(args, &mut conn).await;
    drop(conn);
    let _ = pool.close().await;
    outcome
}

async fn dispatch(args: &Args, conn: &mut sqlx::PgConnection) -> Result<Report, String> {
    match args.command {
        Command::Plan => plan::plan(conn, args.backup_table.as_deref()).await,
        Command::Apply => apply::apply(conn, backup_for(args)?).await,
        Command::Verify => verify::verify(conn, backup_for(args)?).await,
        Command::Revert => revert::revert(conn, backup_for(args)?).await,
    }
}

/// The commands that speak of work already done are meaningless without the
/// table that records it. `parse` refuses them; this is the same gate on the
/// path a caller takes when it built `Args` itself.
fn backup_for(args: &Args) -> Result<&str, String> {
    args.backup_table
        .as_deref()
        .ok_or_else(|| format!("{} needs --backup-table", args.command.name()))
}
