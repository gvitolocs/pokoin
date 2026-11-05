//! The seller's named strategies in Firestore (`users/{uid}.pricingStrategies`):
//! read (upgraded from the shapes saved before, `pricing::upgrade_stored_strategy`),
//! save and delete with the same checks wherever they come from (the Pricer
//! route `/api/marketplace-pricing-strategies` and the Card Rails connector).

use serde_json::{json, Value};
use sqlx::PgPool;

use crate::error::{clean_text, ApiError, ApiResult};
use crate::firebase::FirestoreStore;
use crate::{pricing, pricing_store, time_util};

/// The raw user document and its strategies, upgraded.
pub async fn read(fs: &dyn FirestoreStore, uid: &str) -> ApiResult<(Value, Vec<Value>)> {
    let doc = fs.get_doc("users", uid).await?;
    let data = if doc.exists { doc.data } else { json!({}) };
    let now = time_util::iso_from_ms(time_util::now_ms());
    let mut strategies: Vec<Value> = Vec::new();
    for row in data.get("pricingStrategies").and_then(Value::as_array).into_iter().flatten() {
        let upgraded = pricing::upgrade_stored_strategy(row, &strategies, &now);
        strategies.push(upgraded);
    }
    Ok((data, strategies))
}

/// Store the whole list (and `extra` fields of the user document).
pub async fn write(fs: &dyn FirestoreStore, uid: &str, strategies: &[Value], extra: Value) -> ApiResult<()> {
    let mut patch = json!({
        "pricingStrategies": strategies,
        "updatedAt": time_util::iso_from_ms(time_util::now_ms()),
    });
    if let (Some(patch), Some(extra)) = (patch.as_object_mut(), extra.as_object()) {
        patch.extend(extra.clone());
    }
    fs.merge_doc("users", uid, patch).await
}

/// Create or edit one strategy (`pricing::sanitize_strategy`: unique names,
/// at most `MAX_STRATEGIES`). Returns the saved strategy and the new list.
pub async fn save(fs: &dyn FirestoreStore, uid: &str, input: &Value, extra: Value) -> ApiResult<(Value, Vec<Value>)> {
    let (_, mut strategies) = read(fs, uid).await?;
    let provided_id = clean_text(input.get("id").and_then(Value::as_str), 40);
    let position = strategies
        .iter()
        .position(|row| !provided_id.is_empty() && row["id"].as_str() == Some(provided_id.as_str()));
    if !provided_id.is_empty() && position.is_none() {
        return Err(ApiError::not_found("Strategy not found.").with_code("pricing_strategy_unknown"));
    }
    if position.is_none() && strategies.len() >= pricing::MAX_STRATEGIES {
        return Err(ApiError::bad_request(format!("You can keep up to {} strategies.", pricing::MAX_STRATEGIES)));
    }
    let others: Vec<Value> = strategies
        .iter()
        .enumerate()
        .filter(|(index, _)| Some(*index) != position)
        .map(|(_, row)| row.clone())
        .collect();
    let now = time_util::iso_from_ms(time_util::now_ms());
    let saved = pricing::sanitize_strategy(input, position.map(|index| &strategies[index]), &others, &now)?;
    match position {
        Some(index) => strategies[index] = saved.clone(),
        None => strategies.push(saved.clone()),
    }
    write(fs, uid, &strategies, extra).await?;
    Ok((saved, strategies))
}

/// Delete one strategy; refused (409 `strategy_in_use`) while a group uses it.
pub async fn delete(fs: &dyn FirestoreStore, db: &PgPool, uid: &str, id: &str) -> ApiResult<Vec<Value>> {
    let id = clean_text(Some(id), 40);
    if id.is_empty() {
        return Err(ApiError::bad_request("Strategy id is required."));
    }
    let using = pricing_store::groups_using_strategy(db, uid, &id).await?;
    if !using.is_empty() {
        return Err(ApiError::conflict(format!("Used by {}. Pick another strategy for those groups first.", using.join(", ")))
            .with_code("strategy_in_use"));
    }
    let (_, strategies) = read(fs, uid).await?;
    let next: Vec<Value> = strategies.into_iter().filter(|row| row["id"].as_str() != Some(id.as_str())).collect();
    write(fs, uid, &next, json!({})).await?;
    Ok(next)
}

/// A strategy as tools see it: every rule field plus its one-line summary.
pub fn view(strategy: &Value) -> Value {
    let mut out = strategy.clone();
    if let Some(object) = out.as_object_mut() {
        object.remove("legacyScope");
        object.insert("summary".into(), json!(pricing::strategy_summary(strategy)));
    }
    out
}
