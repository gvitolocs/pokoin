//! PowerTools-style pricer: strategy validation and target math.
//!
//! Faithful port of the retired Node `marketplace-pricing-strategies.js`
//! (sanitizeStrategy / sanitizeSettings / evaluateStrategyTarget /
//! strategyMatchesRow). Pure functions, no I/O, so the SPA and the server can
//! share exactly one implementation.

use serde_json::{json, Value};

use crate::error::{clean_text, f64_field, ApiError, ApiResult};

pub const SOURCES: [&str; 2] = ["pokoin", "cardtrader"];
pub const ACTIONS: [&str; 3] = ["match", "undercut", "premium"];
pub const ROUNDINGS: [&str; 2] = ["none", "integer"];
pub const CONDITIONS: [&str; 6] = ["", "NM", "SP", "MP", "PL", "Poor"];

fn number_or(value: Option<f64>, fallback: f64, min: f64, max: f64) -> f64 {
    match value {
        Some(n) if n.is_finite() => n.clamp(min, max),
        _ => fallback,
    }
}

fn light(value: &Value, keys: &[&str], max: usize) -> String {
    clean_text(value.get(keys[0]).and_then(Value::as_str), max)
}

/// Validate + normalize one strategy. `existing` supplies defaults for an
/// upsert (id, createdAt, enabled). Returns the same 400s as the reference.
pub fn sanitize_strategy(input: &Value, existing: Option<&Value>, now_iso: &str) -> ApiResult<Value> {
    let existing = existing.unwrap_or(&Value::Null);
    let id = {
        let provided = clean_text(input.get("id").and_then(Value::as_str), 40);
        if !provided.is_empty() {
            provided
        } else {
            let prior = clean_text(existing.get("id").and_then(Value::as_str), 40);
            if !prior.is_empty() {
                prior
            } else {
                // `st_<base36 ms><6 random>` — collision-safe enough for one user's list.
                let mut rng = rand::thread_rng();
                format!(
                    "st_{}{}",
                    crate::time_util::now_ms().max(0) as u64,
                    crate::crypto::random_secret(4, &mut rng)
                )
            }
        }
    };
    let name = clean_text(input.get("name").and_then(Value::as_str), 80);
    if name.is_empty() {
        return Err(ApiError::bad_request("Strategy name is required."));
    }
    let source = light(input, &["source"], 20).to_lowercase();
    if !SOURCES.contains(&source.as_str()) {
        return Err(ApiError::bad_request("Pricer source must be pokoin or cardtrader."));
    }
    let action = light(input, &["action"], 20).to_lowercase();
    if !ACTIONS.contains(&action.as_str()) {
        return Err(ApiError::bad_request("Strategy action must be match, undercut or premium."));
    }
    let amount_pct = number_or(f64_field(input, &["amountPct"]), 0.0, 0.0, 90.0);
    let amount_pkn = number_or(f64_field(input, &["amountPkn"]), 0.0, 0.0, 1_000_000.0);
    let min_pkn = number_or(f64_field(input, &["minPkn"]), 0.0, 0.0, 1_000_000.0);
    let rounding_raw = light(input, &["rounding"], 20).to_lowercase();
    let rounding = if ROUNDINGS.contains(&rounding_raw.as_str()) { rounding_raw } else { "none".to_string() };
    let condition = clean_text(input.get("condition").and_then(Value::as_str), 8).to_uppercase();
    if !CONDITIONS.contains(&condition.as_str()) {
        return Err(ApiError::bad_request("Condition scope is invalid."));
    }
    let language = clean_text(input.get("language").and_then(Value::as_str), 8).to_uppercase();
    let enabled = match input.get("enabled") {
        None | Some(Value::Null) => existing.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        Some(value) => value == &Value::Bool(true),
    };
    let created_at = {
        let prior = clean_text(existing.get("createdAt").and_then(Value::as_str), 40);
        if !prior.is_empty() {
            prior
        } else {
            let provided = clean_text(input.get("createdAt").and_then(Value::as_str), 40);
            if provided.is_empty() { now_iso.to_string() } else { provided }
        }
    };

    let mut out = existing.as_object().cloned().unwrap_or_default();
    out.insert("id".into(), json!(id));
    out.insert("name".into(), json!(name));
    out.insert("source".into(), json!(source));
    out.insert("action".into(), json!(action));
    out.insert("amountPct".into(), json!(round4(amount_pct)));
    out.insert("amountPkn".into(), json!(round6(amount_pkn)));
    out.insert("minPkn".into(), json!(round6(min_pkn)));
    out.insert("rounding".into(), json!(rounding));
    out.insert("condition".into(), json!(condition));
    out.insert("language".into(), json!(language));
    out.insert("enabled".into(), json!(enabled));
    out.insert("createdAt".into(), json!(created_at));
    out.insert("updatedAt".into(), json!(now_iso));
    Ok(Value::Object(out))
}

/// `sanitizeSettings` — `{ defaultSource, autoMarketColumn }`.
pub fn sanitize_settings(input: Option<&Value>) -> Value {
    let raw = input.unwrap_or(&Value::Null);
    let source = clean_text(raw.get("defaultSource").and_then(Value::as_str), 20).to_lowercase();
    let default_source = if SOURCES.contains(&source.as_str()) { source } else { "cardtrader".to_string() };
    json!({
        "defaultSource": default_source,
        "autoMarketColumn": raw.get("autoMarketColumn") == Some(&Value::Bool(true)),
    })
}

/// Target PKN for a comp under this strategy.
pub fn evaluate_strategy_target(comp_pkn: Option<f64>, strategy: &Value) -> Option<f64> {
    let comp = comp_pkn?;
    if !(comp > 0.0) {
        return None;
    }
    let mut target = comp;
    let pct = f64_field(strategy, &["amountPct"]).unwrap_or(0.0);
    let flat = f64_field(strategy, &["amountPkn"]).unwrap_or(0.0);
    match strategy.get("action").and_then(Value::as_str) {
        Some("undercut") => target = target * (1.0 - pct / 100.0) - flat,
        Some("premium") => target = target * (1.0 + pct / 100.0) + flat,
        _ => {}
    }
    if strategy.get("rounding").and_then(Value::as_str) == Some("integer") {
        target = target.round();
    }
    let min = f64_field(strategy, &["minPkn"]).unwrap_or(0.0);
    if min > 0.0 {
        target = target.max(min);
    }
    if !(target > 0.0) {
        return None;
    }
    Some(round6(target))
}

/// Does this strategy apply to a listing row's condition/language facets?
pub fn strategy_matches_row(strategy: &Value, row: &Value) -> bool {
    if strategy.get("enabled") == Some(&Value::Bool(false)) {
        return false;
    }
    let condition = clean_text(strategy.get("condition").and_then(Value::as_str), 8).to_uppercase();
    if !condition.is_empty() {
        let row_condition = clean_text(row.get("condition").and_then(Value::as_str), 8).to_uppercase();
        let row_condition = if row_condition.is_empty() { "NM".to_string() } else { row_condition };
        if row_condition != condition {
            return false;
        }
    }
    let language = clean_text(strategy.get("language").and_then(Value::as_str), 8).to_uppercase();
    if !language.is_empty() {
        let row_language = clean_text(row.get("language").and_then(Value::as_str), 8).to_uppercase();
        if row_language != language {
            return false;
        }
    }
    true
}

fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

fn round6(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn now() -> &'static str {
        "2026-10-08T00:00:00.000Z"
    }

    #[test]
    fn strategy_validation_matches_reference() {
        let ok = sanitize_strategy(
            &json!({"name": "Undercut 5%", "source": "cardtrader", "action": "undercut", "amountPct": 5}),
            None,
            now(),
        )
        .unwrap();
        assert_eq!(ok["name"], "Undercut 5%");
        assert_eq!(ok["source"], "cardtrader");
        assert_eq!(ok["rounding"], "none");
        assert_eq!(ok["enabled"], true);
        assert_eq!(ok["createdAt"], now());
        assert!(ok["id"].as_str().unwrap().starts_with("st_"));

        assert_eq!(
            sanitize_strategy(&json!({"source": "pokoin", "action": "match"}), None, now())
                .unwrap_err()
                .message,
            "Strategy name is required."
        );
        assert_eq!(
            sanitize_strategy(&json!({"name": "x", "source": "ebay", "action": "match"}), None, now())
                .unwrap_err()
                .message,
            "Pricer source must be pokoin or cardtrader."
        );
        assert_eq!(
            sanitize_strategy(&json!({"name": "x", "source": "pokoin", "action": "nuke"}), None, now())
                .unwrap_err()
                .message,
            "Strategy action must be match, undercut or premium."
        );
        assert_eq!(
            sanitize_strategy(&json!({"name": "x", "source": "pokoin", "action": "match", "condition": "XX"}), None, now())
                .unwrap_err()
                .message,
            "Condition scope is invalid."
        );
    }

    #[test]
    fn strategy_upsert_keeps_identity_and_clamps() {
        let existing = json!({"id": "st_keep", "createdAt": "2025-01-01T00:00:00.000Z", "enabled": false});
        let out = sanitize_strategy(
            &json!({"name": "Premium", "source": "pokoin", "action": "premium", "amountPct": 999, "amountPkn": -5}),
            Some(&existing),
            now(),
        )
        .unwrap();
        assert_eq!(out["id"], "st_keep");
        assert_eq!(out["createdAt"], "2025-01-01T00:00:00.000Z");
        assert_eq!(out["enabled"], false);
        assert_eq!(out["amountPct"], 90.0);
        assert_eq!(out["amountPkn"], 0.0);
        assert_eq!(out["updatedAt"], now());
    }

    #[test]
    fn target_math_matches_the_spa() {
        let undercut = json!({"action": "undercut", "amountPct": 10, "amountPkn": 1, "rounding": "none", "minPkn": 0});
        assert_eq!(evaluate_strategy_target(Some(100.0), &undercut), Some(89.0));
        let premium = json!({"action": "premium", "amountPct": 20, "amountPkn": 0, "rounding": "integer", "minPkn": 0});
        assert_eq!(evaluate_strategy_target(Some(10.5), &premium), Some(13.0));
        let floored = json!({"action": "undercut", "amountPct": 90, "amountPkn": 0, "rounding": "none", "minPkn": 50});
        assert_eq!(evaluate_strategy_target(Some(100.0), &floored), Some(50.0));
        assert_eq!(evaluate_strategy_target(None, &undercut), None);
        assert_eq!(evaluate_strategy_target(Some(0.0), &undercut), None);
        // target <= 0 → null even with no floor
        let wipe = json!({"action": "undercut", "amountPct": 90, "amountPkn": 1_000_000, "rounding": "none", "minPkn": 0});
        assert_eq!(evaluate_strategy_target(Some(1.0), &wipe), None);
    }

    #[test]
    fn settings_and_row_matching() {
        assert_eq!(sanitize_settings(None), json!({"defaultSource": "cardtrader", "autoMarketColumn": false}));
        assert_eq!(
            sanitize_settings(Some(&json!({"defaultSource": "POKOIN", "autoMarketColumn": "yes"}))),
            json!({"defaultSource": "pokoin", "autoMarketColumn": false})
        );
        let strategy = json!({"enabled": true, "condition": "NM", "language": ""});
        assert!(strategy_matches_row(&strategy, &json!({"condition": "nm"})));
        assert!(strategy_matches_row(&strategy, &json!({})));
        assert!(!strategy_matches_row(&strategy, &json!({"condition": "SP"})));
        assert!(!strategy_matches_row(&json!({"enabled": false}), &json!({"condition": "NM"})));
        assert!(strategy_matches_row(&json!({"condition": "", "language": "JP"}), &json!({"language": "jp"})));
    }
}
