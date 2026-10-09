use super::{accounts_firestore, now_ms, Options};
use anyhow::{bail, Result};
use pokoin_accounts::{domain::referral::SettleCounts, firestore::Query};
use serde_json::{json, Value};
fn report(counts: &SettleCounts) -> Value {
    json!({ "checked": counts.checked, "rewarded": counts.rewarded, "waiting": counts.waiting,
        "treasuryLow": counts.treasury_low, "failed": counts.failed })
}
fn checked_report(counts: &SettleCounts) -> Result<Value> {
    let result = report(counts);
    println!("referral reconcile complete {result}");
    if counts.failed > 0 {
        bail!("Referral reconcile failed for {} referrals", counts.failed);
    }
    Ok(result)
}
pub(super) async fn run(options: &Options) -> Result<()> {
    let firestore = accounts_firestore()?;
    if options.dry_run {
        let pending = firestore
            .run_query(&Query::collection("referrals").where_eq("status", "pending"))
            .await?;
        println!(
            "referral reconcile dry run {}",
            json!({ "pending": pending.len() })
        );
        return Ok(());
    }
    // Exact reference default: at most 300 pending referrals per ten-minute run.
    let counts =
        pokoin_accounts::domain::referral::settle_pending(&firestore, now_ms(), 300, "").await?;
    checked_report(&counts)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn treasury_low_is_reported_but_failure_exits_unsuccessfully() {
        let mut counts = SettleCounts::default();
        counts.treasury_low = 2;
        assert_eq!(checked_report(&counts).unwrap()["treasuryLow"], 2);
        counts.failed = 1;
        assert!(checked_report(&counts).is_err());
    }
    #[test]
    fn report_preserves_node_camel_case_and_counts() {
        let counts = SettleCounts {
            checked: 9,
            rewarded: 3,
            waiting: 2,
            treasury_low: 1,
            failed: 3,
        };
        assert_eq!(
            report(&counts),
            json!({ "checked": 9, "rewarded": 3, "waiting": 2, "treasuryLow": 1, "failed": 3 })
        );
    }
}
