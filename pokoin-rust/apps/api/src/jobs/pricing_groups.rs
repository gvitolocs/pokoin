//! `job pricing-groups-daily [--dry-run]`
//!
//! Re-prices every MyPokoin pricing group whose "Reprice every day" switch is
//! on (`seller_pricing_groups.auto_daily`, scripts/sql/138), oldest last
//! apply first, with the group's strategy over its live and paused listings:
//! the same plan and write as the Pricer tab's Apply
//! (`pokoin_commerce::handlers::pricer::run_daily`, docs/PRICING.md
//! "Pricer"). Each group keeps a summary of the run (`last_applied`,
//! trigger `daily`).
//!
//! It writes by default (the timer passes no flags); `--dry-run` only plans.
//! One group failing (its strategy deleted, a price check error) is counted
//! and the run goes on; the job fails only when every group failed.
use super::{read_pool, writer_pool, Options};
use anyhow::{bail, Result};
use pokoin_commerce::{CommerceConfig, DomainState, FirestoreClient};
use serde_json::Value;
use std::sync::Arc;

pub(super) async fn run(options: &Options) -> Result<()> {
    let read = read_pool().await?;
    let write = writer_pool(&read).await?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let verifier = Arc::new(pokoin_commerce::auth::FirebaseVerifier::new(
        std::env::var("FIREBASE_PROJECT_ID").unwrap_or_default(),
        http.clone(),
    ));
    let state = DomainState::with_pools(
        CommerceConfig::from_env(),
        read,
        write,
        None,
        verifier,
        Some(FirestoreClient::from_env(http)?),
    );
    // A CardTrader-linked listing's new price reaches CardTrader through the
    // listing outbox either way; the adapter is only wired when configured.
    let state = match pokoin_commerce::cardtrader_adapter::NativeCardTrader::from_env() {
        Ok(adapter) => state.with_cardtrader(Arc::new(adapter)),
        Err(_) => state,
    };
    let summary = pokoin_commerce::handlers::pricer::run_daily(&state, !options.dry_run)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
    println!("pricing groups daily {summary}");
    if failed_run(&summary) {
        bail!("Every pricing group failed.");
    }
    Ok(())
}

/// Every group of a run with at least one group failed.
fn failed_run(summary: &Value) -> bool {
    let groups = summary["groups"].as_u64().unwrap_or(0);
    let failed = summary["failed"].as_array().map_or(0, Vec::len) as u64;
    groups > 0 && failed == groups
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_run_fails_only_when_every_group_failed() {
        assert!(!failed_run(&json!({"groups": 0, "failed": []})), "nothing to do is not a failure");
        assert!(failed_run(&json!({"groups": 2, "failed": [{"groupId": "a"}, {"groupId": "b"}]})));
        assert!(!failed_run(&json!({"groups": 2, "failed": [{"groupId": "a"}]})));
    }
}
