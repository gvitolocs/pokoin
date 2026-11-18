//! `job cardtrader-fee-profile --seller=<uid> [--vat-registered=true|false] [--apply]`
//!
//! Shows the CardTrader commission plan Pokoin prices a connected seller at
//! (`ct_fees::resolve_seller_channel`: tier, Zero or direct, VAT) and, with
//! `--vat-registered`, sets whether the seller is a VAT-registered business
//! (`seller_integrations/{uid}__cardtrader` `metadata.vatRegistered`). A
//! VAT-registered business outside Italy pays no VAT on CardTrader's
//! commission (reverse charge); a private seller pays their country's rate.
//! Nothing CardTrader returns says which a seller is, so it is set here when
//! the seller confirms it (2026-10-22: PeppeV / Flareon99, a Danish business).
//! A dry run unless `--apply`: it prints the plan now and the plan it would
//! become.
use super::Options;
use anyhow::{bail, Context, Result};
use pokoin_external::cardtrader::integration::{self, integration_doc_id, COLLECTION};
use pokoin_external::ct_fees;
use serde_json::{json, Value};

fn flag_arg() -> Result<Option<bool>> {
    match std::env::args().find_map(|a| a.strip_prefix("--vat-registered=").map(|v| v.trim().to_string())) {
        None => Ok(None),
        Some(v) if v == "true" => Ok(Some(true)),
        Some(v) if v == "false" => Ok(Some(false)),
        Some(v) => bail!("--vat-registered must be true or false, not {v:?}"),
    }
}

/// The integration's metadata with `vatRegistered` set, every other field kept.
pub fn with_vat_registered(data: &Value, registered: bool) -> Value {
    let mut metadata = data.get("metadata").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
    metadata["vatRegistered"] = json!(registered);
    metadata
}

pub(super) async fn run(options: &Options) -> Result<()> {
    let seller = options.seller.clone().context("--seller=<uid> is required")?;
    let registered = flag_arg()?;
    let state = pokoin_external::DomainState::from_env(2).await?;
    let doc = integration::read_integration_doc(state.firestore.as_ref(), &seller).await?;
    if !doc.exists {
        bail!("seller {seller} has no CardTrader integration");
    }
    let rule = ct_fees::rule();
    let now = ct_fees::resolve_seller_channel(&state.db, &doc.data).await;
    let mut summary = json!({
        "seller": seller, "apply": options.apply, "doc": format!("{COLLECTION}/{}", integration_doc_id(&seller)),
        "vatRegistered": doc.data.pointer("/metadata/vatRegistered").cloned().unwrap_or(Value::Null),
        "plan": rule.describe(now),
    });
    if let Some(registered) = registered {
        let metadata = with_vat_registered(&doc.data, registered);
        let mut after = doc.data.clone();
        after["metadata"] = metadata.clone();
        summary["vatRegisteredAfter"] = json!(registered);
        summary["planAfter"] = rule.describe(ct_fees::resolve_seller_channel(&state.db, &after).await);
        if options.apply {
            state.firestore.merge_doc(COLLECTION, &integration_doc_id(&seller), json!({ "metadata": metadata })).await?;
            summary["written"] = json!(true);
        }
    }
    println!("cardtrader fee profile {summary}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flag_is_set_and_the_rest_of_the_metadata_kept() {
        let data = json!({"metadata": {"user": {"id": 595699}, "oneDayReady": false, "firstSyncAt": "2026-10-14"}});
        let metadata = with_vat_registered(&data, true);
        assert_eq!(metadata["vatRegistered"], true);
        assert_eq!(metadata["user"]["id"], 595699);
        assert_eq!(metadata["firstSyncAt"], "2026-10-14");
        assert_eq!(with_vat_registered(&json!({}), false), json!({"vatRegistered": false}));
        // PeppeV after the flag: 5 % direct, no VAT.
        let mut after = data.clone();
        after["metadata"] = metadata;
        after["metadata"]["country"] = json!("DK");
        let plan = ct_fees::seller_channel(&after);
        assert_eq!(ct_fees::rule().vat_for(plan), 0);
    }
}
