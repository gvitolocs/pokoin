use crate::{array, sources::resolve_source_host, text, timestamp};
use serde_json::{json, Value};
use std::collections::HashSet;
fn n(v: &Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or(0.0)
}
pub fn hints(pack: &Value, now: i64) -> Value {
    let sources = array(&pack["sourceList"]);
    let independent: HashSet<_> = sources
        .iter()
        .map(|s| resolve_source_host(text(s, "outlet")))
        .filter(|s| !s.is_empty())
        .collect();
    let added: Vec<_> = sources
        .iter()
        .filter_map(|s| timestamp(text(s, "addedAt")))
        .collect();
    let span = added
        .iter()
        .max()
        .zip(added.iter().min())
        .map(|(max, min)| (*max - *min) as f64 / 3_600_000.0)
        .filter(|n| *n > 0.0);
    let first = if !text(pack, "firstSeenAt").is_empty() {
        timestamp(text(pack, "firstSeenAt"))
    } else {
        added.iter().min().copied()
    };
    let conflicts = array(&pack["conflicts"]).len();
    let entities = pack
        .get("entities")
        .or_else(|| pack.get("pokoinEntities"))
        .map(array)
        .unwrap_or(&[]);
    json!({"angle":pack.get("angle").unwrap_or(&Value::Null),"storyStatus":pack.get("status").unwrap_or(&Value::Null),
        "sourceCount":sources.len(),"independentSourceCount":independent.len(),"imageCount":array(&pack["images"]).len(),
        "marketDataAvailable":pack["market"]["sufficient"]==true,"entityCount":entities.len(),
        "evolving":pack["isUpdate"]==true || (sources.len()>=3 && span.is_some_and(|n|n>6.0)),
        "claimVerificationCentral":pack["status"]=="rumor" || conflicts>0 || pack["angle"]=="RUMOR","conflictCount":conflicts,
        "originalReportingScore":pack["scores"].get("originalReporting").filter(|v|v.is_number()).cloned().unwrap_or(json!(0)),
        "firstSeenHoursAgo":first.map(|t|(now-t) as f64/3_600_000.0),
        "revealClaims":array(&pack["claimLedger"]).iter().filter(|c|c["kind"]=="reveal" || (c["kind"]=="count" && regex::Regex::new("(?i)promo|card").is_ok_and(|r|r.is_match(text(&c["value"],"noun"))))).count(),
        "comparableProducts":array(&pack["comparableProducts"]).len()})
}
pub fn valid_templates(h: &Value) -> Vec<String> {
    if h["storyStatus"] == "rumor" {
        return vec!["fact_check".into()];
    }
    let mut out = Vec::new();
    for (id, yes) in [
        (
            "fact_check",
            h["claimVerificationCentral"] == true || n(h, "conflictCount") >= 1.0,
        ),
        ("developing", h["evolving"] == true),
        (
            "reveal",
            ["CARD_REVEAL", "SET_REVEAL", "PROMO", "PRODUCT_RELEASE"].contains(&text(h, "angle"))
                || n(h, "revealClaims") > 0.0,
        ),
        (
            "breaking",
            n(h, "sourceCount") >= 1.0
                && h["storyStatus"] != "rumor"
                && h["firstSeenHoursAgo"].as_f64().is_some_and(|n| n < 24.0),
        ),
        ("market_pulse", h["marketDataAvailable"] == true),
        (
            "data_deep_dive",
            h["marketDataAvailable"] == true && n(h, "originalReportingScore") >= 0.6,
        ),
        ("comparison", n(h, "comparableProducts") >= 2.0),
        ("trend", n(h, "independentSourceCount") >= 2.0),
        (
            "analysis",
            n(h, "sourceCount") >= 2.0
                && (h["storyStatus"] == "confirmed" || h["claimVerificationCentral"] == true),
        ),
        ("explainer", true),
    ] {
        if yes {
            out.push(id.into());
        }
    }
    out
}
pub fn worthiness(pack: &Value, hints: &Value, covered: bool, single: bool) -> Value {
    let sources = array(&pack["sourceList"]);
    let independent: HashSet<_> = sources
        .iter()
        .map(|s| {
            resolve_source_host(if text(s, "url").is_empty() {
                text(s, "outlet")
            } else {
                text(s, "url")
            })
        })
        .collect();
    let tier = |t| sources.iter().any(|s| text(s, "tier") == t);
    let recency = hints["firstSeenHoursAgo"]
        .as_f64()
        .map(|h| (1.0 - h / 96.0).clamp(0.0, 1.0))
        .unwrap_or(0.4);
    let reliability = if tier("A") {
        1.0
    } else if tier("B") {
        0.75
    } else if tier("C") {
        0.45
    } else {
        0.1
    };
    let independence = ((independent.len() as f64 - 1.0) / 3.0).clamp(0.0, 1.0);
    let relevance = if array(&pack["claimLedger"]).is_empty() {
        0.2
    } else {
        (array(&pack["claimLedger"]).len() as f64 / 6.0).clamp(0.0, 1.0)
    };
    let value: f64 = if pack["market"]["sufficient"] == true {
        0.6
    } else {
        0.0
    } + if !array(&pack["related"]["cards"]).is_empty() {
        0.25
    } else {
        0.0
    } + if !array(&pack["related"]["sets"]).is_empty() {
        0.15
    } else {
        0.0
    };
    let conflict = if array(&pack["conflicts"]).is_empty() {
        0.0
    } else {
        1.0
    };
    let score = (0.2 * recency
        + 0.15 * reliability
        + 0.25 * independence
        + 0.1 * relevance
        + 0.15 * value.clamp(0.0_f64, 1.0)
        + 0.15 * conflict
        - if covered { 0.5 } else { 0.0 })
    .clamp(0.0, 1.0);
    let mut decision = if covered || score < 0.25 {
        "skip"
    } else if score < 0.4 {
        "flash_only"
    } else {
        "article"
    };
    let mut components = json!({"recency":recency,"sourceReliability":reliability,"independentSources":independence,"relevance":relevance,"pokoinValue":value,"conflictValue":conflict,"alreadyCovered":if covered{1}else{0}});
    if single && decision == "flash_only" && (tier("A") || tier("B")) {
        decision = "article";
        components["singleSpecialist"] = json!(true);
    }
    node_numbers(
        json!({"score":(score*100.0).round()/100.0,"components":components,"decision":decision}),
    )
}

fn node_numbers(value: Value) -> Value {
    match value {
        Value::Number(ref n)
            if n.as_f64()
                .is_some_and(|n| n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0) =>
        {
            json!(n.as_f64().unwrap_or(0.0) as i64)
        }
        Value::Array(a) => Value::Array(a.into_iter().map(node_numbers).collect()),
        Value::Object(o) => {
            Value::Object(o.into_iter().map(|(k, v)| (k, node_numbers(v))).collect())
        }
        _ => value,
    }
}
