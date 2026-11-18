//! Reversible Power Tools picking-sort probe (§9 of
//! ~/Projects/candyext/dump/POKOIN_CT_INVESTIGATION.md, docs/CARDTRADER_ZERO.md).
//!
//! ```text
//! PT_JWT=<jwt cookie> cargo run -p pokoin-external --example pt_sort_probe -- \
//!   --list <ptId> [--order <ctOrderId>] [--apply-permutation]
//! ```
//!
//! Without `--apply-permutation` it only reads (`getArticlesToPick
//! {pickingListId}`) and prints the current sequence. With it, it reverses
//! the to-pick part (a permutation no sort field produces), writes it with
//! `updateSorting` keeping the list's sortingFields, reads back, prints
//! whether Power Tools kept it, then RESTORES the original sequence and reads
//! back again. The session is read from `PT_JWT` and never printed. Run it by
//! hand only, on a list you own; check CardTrader's Zero page between steps.

use pokoin_external::cardtrader::zero::{pt_item_ids, pt_list_sorting_fields, pt_sort_items, pt_to_pick_ids};
use pokoin_external::powertools::{id_text, PowerToolsClient};
use serde_json::{json, Value};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn id_value(raw: &str) -> Value {
    raw.parse::<i64>().map(Value::from).unwrap_or_else(|_| json!(raw))
}

/// Item ids in `items`, limited to one CardTrader order when given.
fn shown(items: &[Value], order: Option<&str>) -> Vec<String> {
    items
        .iter()
        .filter(|item| order.is_none_or(|o| id_text(item.get("sourceOrderId").unwrap_or(&Value::Null)) == o))
        .map(|item| id_text(item.get("sourceArticleId").unwrap_or(&Value::Null)))
        .collect()
}

async fn read(client: &PowerToolsClient, jwt: &str, list: &Value) -> anyhow::Result<(Value, Vec<Value>)> {
    let payload = client.fetch_articles_to_pick(jwt, list).await.map_err(|e| anyhow::anyhow!("read: {} ({:?})", e.message, e.code))?;
    let items = pt_sort_items(&payload, None).map_err(|e| anyhow::anyhow!("items: {}", e.message))?;
    Ok((payload, items))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(list) = arg(&args, "--list") else {
        anyhow::bail!("usage: pt_sort_probe --list <ptId> [--order <ctOrderId>] [--apply-permutation]");
    };
    let order = arg(&args, "--order");
    let apply = args.iter().any(|a| a == "--apply-permutation");
    let jwt = std::env::var("PT_JWT").map_err(|_| anyhow::anyhow!("set PT_JWT to the Power Tools jwt cookie"))?;
    let client = PowerToolsClient::new();
    let list = id_value(&list);

    let (payload, original) = read(&client, &jwt, &list).await?;
    let sorting_fields = pt_list_sorting_fields(&payload);
    println!("sortingFields: {sorting_fields}");
    println!("current ({} articles): {:?}", original.len(), shown(&original, order.as_deref()));
    if !apply {
        println!("read-only (pass --apply-permutation to write a reversed order and restore it)");
        return Ok(());
    }

    // Reverse the to-pick part only; picked articles keep their place first.
    let all_ids = pt_item_ids(&original);
    let to_pick = pt_to_pick_ids(&payload);
    let mut reversed = to_pick.clone();
    reversed.reverse();
    let permuted = pt_sort_items(&payload, Some(&reversed)).map_err(|e| anyhow::anyhow!("{}", e.message))?;
    println!("writing   : {:?}", shown(&permuted, order.as_deref()));
    client
        .update_sorting(&jwt, &list, &sorting_fields, &json!(permuted))
        .await
        .map_err(|e| anyhow::anyhow!("updateSorting: {} ({:?})", e.message, e.code))?;
    let (_, after) = read(&client, &jwt, &list).await?;
    let kept = pt_item_ids(&after) == pt_item_ids(&permuted);
    println!("read back : {:?}", shown(&after, order.as_deref()));
    println!("Power Tools kept the permutation: {kept}");

    println!("restoring : {:?}", shown(&original, order.as_deref()));
    client
        .update_sorting(&jwt, &list, &sorting_fields, &json!(original))
        .await
        .map_err(|e| anyhow::anyhow!("restore updateSorting: {} ({:?})", e.message, e.code))?;
    let (_, restored) = read(&client, &jwt, &list).await?;
    println!("restored  : {:?}", shown(&restored, order.as_deref()));
    println!("restore matches the original: {}", pt_item_ids(&restored) == all_ids);
    Ok(())
}
