//! The MyPokoin pricer's rules: named strategies, pricing groups and the
//! reprice plan. Pure functions, no I/O. `market/src/pricer.js` states the
//! same rules for the web; keep the two in step (docs/PRICING.md, "Pricer").
//!
//! - A **strategy** (`users/{uid}.pricingStrategies`) is a named rule for how
//!   to price: a market number (`source`, `basis`, `feeExclusive`), an
//!   `action` (match, undercut, premium by `amountPct` % and `amountPkn`),
//!   `rounding`, a floor (`minPkn`) and `activatePaused`. Names are unique per
//!   seller, ignoring case. Strategies have no scope any more: the seller
//!   picks the listings by putting them in a group.
//! - A **pricing group** (`seller_pricing_groups`, scripts/sql/138) is a named
//!   set of hand-picked listings priced by one strategy, optionally every day
//!   (`autoDaily`). A listing is in at most one group.

use serde_json::{json, Map, Value};

use crate::ct_fees::{floor_price_rounded, Rounding, MAX_ASK_PKN, SCALE};
pub use crate::price_check::Match;
use crate::error::{clean_text, f64_field, ApiError, ApiResult};

pub const SOURCES: [&str; 2] = ["pokoin", "cardtrader"];
pub const ACTIONS: [&str; 3] = ["match", "undercut", "premium"];
pub const ROUNDINGS: [&str; 4] = ["none", "integer", "down", "up"];
/// What a strategy prices from (market/src/pricer.js `PRICER_BASES`): the
/// current offers (on CardTrader narrowed by the `match` toggles) or the
/// 30-day sold median. Strategies saved before 2026-11-05 had `matched` (all
/// toggles on) and `cheapest` (all off); both read as `offers`.
pub const BASES: [&str; 2] = ["offers", "sold"];
/// The scope a strategy had before groups (kept as `legacyScope` and
/// turned into a group once, `migrate_strategies`).
pub const LEGACY_STATUSES: [&str; 3] = ["", "active", "paused"];
pub const MAX_STRATEGIES: usize = 50;
pub const MAX_GROUPS: usize = 200;

fn number_or(value: Option<f64>, fallback: f64, min: f64, max: f64) -> f64 {
    match value {
        Some(n) if n.is_finite() => n.clamp(min, max),
        _ => fallback,
    }
}

fn word(value: &Value, key: &str, max: usize) -> String {
    clean_text(value.get(key).and_then(Value::as_str), max).to_lowercase()
}

fn new_id(prefix: &str) -> String {
    let mut rng = rand::thread_rng();
    format!(
        "{prefix}_{}{}",
        crate::time_util::now_ms().max(0) as u64,
        crate::crypto::random_secret(4, &mut rng)
    )
}

/// The same name, ignoring case and outer space.
fn same_name(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

fn name_taken(name: &str, id: &str, others: &[Value]) -> bool {
    others.iter().any(|other| {
        other.get("id").and_then(Value::as_str) != Some(id)
            && same_name(other.get("name").and_then(Value::as_str).unwrap_or(""), name)
    })
}

fn kept_text(input: &Value, existing: &Value, key: &str, max: usize) -> String {
    let provided = clean_text(input.get(key).and_then(Value::as_str), max);
    if !provided.is_empty() {
        return provided;
    }
    clean_text(existing.get(key).and_then(Value::as_str), max)
}

/// The scope fields of a strategy saved before groups, or `None` when it
/// had none (it priced every listing) or was switched off.
pub fn legacy_scope(strategy: &Value) -> Option<Value> {
    if let Some(scope) = strategy.get("legacyScope").filter(|scope| scope.is_object()) {
        return Some(scope.clone());
    }
    if strategy.get("enabled") == Some(&Value::Bool(false)) {
        return None;
    }
    let game = clean_text(strategy.get("game").and_then(Value::as_str), 40).to_lowercase();
    let status = word(strategy, "status", 12);
    let condition = clean_text(strategy.get("condition").and_then(Value::as_str), 8).to_uppercase();
    let language = clean_text(strategy.get("language").and_then(Value::as_str), 8).to_uppercase();
    let status = if LEGACY_STATUSES.contains(&status.as_str()) { status } else { String::new() };
    if game.is_empty() && status.is_empty() && condition.is_empty() && language.is_empty() {
        return None;
    }
    let game = if game.is_empty() { game } else { crate::db::normalize_game(&game) };
    Some(json!({ "game": game, "status": status, "condition": condition, "language": language }))
}

/// Does a pre-groups scope take this listing row? (The old
/// `pricerMatches`, used once to fill the group a scoped strategy becomes.)
pub fn legacy_scope_matches(scope: &Value, row: &Value) -> bool {
    let text = |value: &Value, keys: &[&str]| {
        keys.iter()
            .find_map(|key| value.get(*key).and_then(Value::as_str))
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let status = text(row, &["status"]).to_lowercase();
    if status != "active" && status != "paused" {
        return false;
    }
    let want = |key: &str| text(scope, &[key]);
    let game = text(row, &["marketplace_game", "marketplaceGame"]).to_lowercase();
    let game = if game.is_empty() { "pokemon".to_string() } else { game };
    if !want("game").is_empty() && want("game").to_lowercase() != game {
        return false;
    }
    if !want("status").is_empty() && want("status").to_lowercase() != status {
        return false;
    }
    let condition = text(row, &["condition"]).to_uppercase();
    let condition = if condition.is_empty() { "NM".to_string() } else { condition };
    if !want("condition").is_empty() && want("condition").to_uppercase() != condition {
        return false;
    }
    if !want("language").is_empty() && want("language").to_uppercase() != text(row, &["language"]).to_uppercase() {
        return false;
    }
    true
}

/// Validate + normalize one strategy. `existing` is the stored one on an
/// edit (id, createdAt, legacyScope are kept); `others` the seller's other
/// strategies (names are unique). Unknown keys, and the old scope fields, are
/// not stored.
pub fn sanitize_strategy(input: &Value, existing: Option<&Value>, others: &[Value], now_iso: &str) -> ApiResult<Value> {
    let existing = existing.unwrap_or(&Value::Null);
    let id = {
        let id = kept_text(input, existing, "id", 40);
        if id.is_empty() { new_id("st") } else { id }
    };
    let name = clean_text(input.get("name").and_then(Value::as_str), 80);
    if name.is_empty() {
        return Err(ApiError::bad_request("Strategy name is required.").with_code("strategy_name_required"));
    }
    if name_taken(&name, &id, others) {
        return Err(ApiError::conflict(format!("You already have a strategy named “{name}”."))
            .with_code("strategy_name_taken"));
    }
    let source = word(input, "source", 20);
    if !SOURCES.contains(&source.as_str()) {
        return Err(ApiError::bad_request("Pricer source must be pokoin or cardtrader."));
    }
    let action = word(input, "action", 20);
    if !ACTIONS.contains(&action.as_str()) {
        return Err(ApiError::bad_request("Strategy action must be match, undercut or premium."));
    }
    let rounding = word(input, "rounding", 20);
    let rounding = if ROUNDINGS.contains(&rounding.as_str()) { rounding } else { "none".to_string() };
    let raw_basis = word(input, "basis", 20);
    let basis = if raw_basis == "sold" { "sold" } else { "offers" }.to_string();
    let toggles = match_of(input, &raw_basis);
    let created_at = {
        let created = clean_text(existing.get("createdAt").and_then(Value::as_str), 40);
        if !created.is_empty() {
            created
        } else {
            let provided = clean_text(input.get("createdAt").and_then(Value::as_str), 40);
            if provided.is_empty() { now_iso.to_string() } else { provided }
        }
    };
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    out.insert("name".into(), json!(name));
    out.insert("source".into(), json!(source));
    out.insert("basis".into(), json!(basis));
    out.insert("match".into(), match_json(toggles));
    // Fee-exclusive unless the seller asks for the CardTrader ask itself.
    out.insert("feeExclusive".into(), json!(input.get("feeExclusive") != Some(&Value::Bool(false))));
    out.insert("action".into(), json!(action));
    out.insert("amountPct".into(), json!(round4(number_or(f64_field(input, &["amountPct"]), 0.0, 0.0, 90.0))));
    out.insert("amountPkn".into(), json!(round2(number_or(f64_field(input, &["amountPkn"]), 0.0, 0.0, 1_000_000.0))));
    out.insert("rounding".into(), json!(rounding));
    out.insert("minPkn".into(), json!(round2(number_or(f64_field(input, &["minPkn"]), 0.0, 0.0, 1_000_000.0))));
    out.insert("activatePaused".into(), json!(input.get("activatePaused") == Some(&Value::Bool(true))));
    if let Some(scope) = existing.get("legacyScope").filter(|scope| scope.is_object()) {
        out.insert("legacyScope".into(), scope.clone());
    }
    out.insert("createdAt".into(), json!(created_at));
    out.insert("updatedAt".into(), json!(now_iso));
    Ok(Value::Object(out))
}

/// A strategy as stored before groups, read back: the rule is kept, its
/// scope (if any) moves to `legacyScope`, and a missing or duplicate name
/// gets a readable unique one. Never fails, so an old document always reads.
pub fn upgrade_stored_strategy(stored: &Value, earlier: &[Value], now_iso: &str) -> Value {
    let mut input = stored.clone();
    if !SOURCES.contains(&word(stored, "source", 20).as_str()) {
        input["source"] = json!("cardtrader");
    }
    if !ACTIONS.contains(&word(stored, "action", 20).as_str()) {
        input["action"] = json!("match");
    }
    let base = clean_text(stored.get("name").and_then(Value::as_str), 74);
    let base = if base.is_empty() { "Strategy".to_string() } else { base };
    let id = clean_text(stored.get("id").and_then(Value::as_str), 40);
    let mut name = base.clone();
    let mut n = 2;
    while name_taken(&name, &id, earlier) {
        name = format!("{base} ({n})");
        n += 1;
    }
    input["name"] = json!(name);
    let mut existing = json!({ "id": stored.get("id"), "createdAt": stored.get("createdAt") });
    if let Some(scope) = legacy_scope(stored) {
        existing["legacyScope"] = scope;
    }
    let updated_at = clean_text(stored.get("updatedAt").and_then(Value::as_str), 40);
    let when = if updated_at.is_empty() { now_iso } else { updated_at.as_str() };
    sanitize_strategy(&input, Some(&existing), earlier, when)
        .expect("an upgraded strategy has a unique name, a source and an action")
}

/// `sanitizeSettings` — `{ defaultSource, autoMarketColumn }`.
pub fn sanitize_settings(input: Option<&Value>) -> Value {
    let raw = input.unwrap_or(&Value::Null);
    let source = word(raw, "defaultSource", 20);
    let default_source = if SOURCES.contains(&source.as_str()) { source } else { "cardtrader".to_string() };
    json!({
        "defaultSource": default_source,
        "autoMarketColumn": raw.get("autoMarketColumn") == Some(&Value::Bool(true)),
    })
}

/// Validate + normalize one pricing group: `{ id, name, strategyId,
/// autoDaily }`. The strategy must be one of the seller's; names are unique.
pub fn sanitize_group(input: &Value, existing: Option<&Value>, strategies: &[Value], others: &[Value]) -> ApiResult<Value> {
    let existing = existing.unwrap_or(&Value::Null);
    let id = {
        let id = kept_text(input, existing, "id", 40);
        if id.is_empty() { new_id("pg") } else { id }
    };
    let name = clean_text(input.get("name").and_then(Value::as_str), 80);
    if name.is_empty() {
        return Err(ApiError::bad_request("Group name is required.").with_code("group_name_required"));
    }
    if name_taken(&name, &id, others) {
        return Err(ApiError::conflict(format!("You already have a group named “{name}”.")).with_code("group_name_taken"));
    }
    let strategy_id = kept_text(input, existing, "strategyId", 40);
    if !strategies.iter().any(|s| s.get("id").and_then(Value::as_str) == Some(strategy_id.as_str())) {
        return Err(ApiError::bad_request("Pick one of your strategies for this group.").with_code("pricing_strategy_unknown"));
    }
    let auto_daily = match input.get("autoDaily") {
        Some(Value::Bool(on)) => *on,
        _ => existing.get("autoDaily") == Some(&Value::Bool(true)),
    };
    Ok(json!({ "id": id, "name": name, "strategyId": strategy_id, "autoDaily": auto_daily }))
}

fn positive(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number > 0.0).then_some(number)
}

/// The `match` toggles of a strategy (or of an edit): the `match` object when
/// there is one (a toggle not sent is on), else from a basis saved before the
/// toggles (`cheapest`: all off; anything else: all on, the exact copy).
fn match_of(input: &Value, raw_basis: &str) -> Match {
    match input.get("match").filter(|m| m.is_object()) {
        Some(m) => {
            let on = |key: &str| m.get(key) != Some(&Value::Bool(false));
            Match { condition: on("condition"), language: on("language"), finish: on("finish"), first_edition: on("firstEdition") }
        }
        None if raw_basis == "cheapest" => Match::ANY,
        None => Match::EXACT,
    }
}

/// Which attributes a strategy's CardTrader offers must share with the listing.
pub fn strategy_match(strategy: &Value) -> Match {
    match_of(strategy, &word(strategy, "basis", 20))
}

fn match_json(m: Match) -> Value {
    json!({ "condition": m.condition, "language": m.language, "finish": m.finish, "firstEdition": m.first_edition })
}

/// The toggles in words: "all exact", "any copy", or "same condition and language".
pub fn match_summary(m: Match) -> String {
    if m == Match::EXACT {
        return "all exact".into();
    }
    if m == Match::ANY {
        return "any copy".into();
    }
    let names: Vec<&str> = [(m.condition, "condition"), (m.language, "language"), (m.finish, "finish"), (m.first_edition, "1st edition")]
        .iter()
        .filter(|(on, _)| *on)
        .map(|(_, name)| *name)
        .collect();
    match names.split_last() {
        Some((last, [])) => format!("same {last}"),
        Some((last, rest)) => format!("same {} and {last}", rest.join(", ")),
        None => "any copy".into(),
    }
}

/// The market number a strategy starts from, in PKN (`strategyComp`): a
/// price-check comp's fee-exclusive number, or the CardTrader ask when the
/// strategy is not fee-exclusive (an answer without the ask: the net either
/// way). CardTrader offers come from the comp's `ctMatch` entry of the
/// strategy's toggles (no entry: no such offer); an answer from before
/// `ctMatch` only knows the exact copy and the cheapest one. Pokoin: the
/// cheapest Pokoin ask, else the sold median.
pub fn strategy_comp(comp: &Value, strategy: &Value) -> Option<f64> {
    let fee_exclusive = strategy.get("feeExclusive") != Some(&Value::Bool(false));
    let choose = |net: Option<&Value>, gross: Option<&Value>| {
        if fee_exclusive {
            positive(net)
        } else {
            positive(gross).or_else(|| positive(net))
        }
    };
    let sold = || choose(comp.get("soldMedianPkn"), comp.get("soldMedianGrossPkn"));
    let basis = word(strategy, "basis", 20);
    if strategy.get("source").and_then(Value::as_str) == Some("pokoin") {
        if basis == "sold" {
            return sold();
        }
        return positive(comp.get("pokoinCheapestPkn")).or_else(sold);
    }
    if basis == "sold" {
        return sold();
    }
    let m = strategy_match(strategy);
    if let Some(map) = comp.get("ctMatch").and_then(Value::as_object) {
        return map.get(&m.key()).and_then(|entry| choose(entry.get("pkn"), entry.get("grossPkn")));
    }
    match m {
        Match::EXACT => choose(comp.get("ctMatchedPkn"), comp.get("ctMatchedGrossPkn")),
        Match::ANY => choose(comp.get("ctCheapestPkn"), comp.get("ctCheapestGrossPkn")),
        _ => None,
    }
}

fn rounding_of(strategy: &Value) -> Rounding {
    match strategy.get("rounding").and_then(Value::as_str) {
        Some("integer") => Rounding::Nearest,
        Some("down") => Rounding::Down,
        Some("up") => Rounding::Up,
        _ => Rounding::Exact,
    }
}

/// Target PKN for a comp under this strategy: undercut or premium, then the
/// rounding and the floor in the verified integer core
/// (`ct_fees::floor_price_rounded`), then cents. `None` for no comp, a comp
/// beyond the proofs' range, or a target of 0 or less.
pub fn evaluate_strategy_target(comp_pkn: Option<f64>, strategy: &Value) -> Option<f64> {
    let comp = comp_pkn.filter(|comp| comp.is_finite() && *comp > 0.0 && *comp <= MAX_ASK_PKN as f64)?;
    let pct = number_or(f64_field(strategy, &["amountPct"]), 0.0, 0.0, 90.0);
    let flat = number_or(f64_field(strategy, &["amountPkn"]), 0.0, 0.0, 1_000_000.0);
    let target = match strategy.get("action").and_then(Value::as_str) {
        Some("undercut") => comp * (1.0 - pct / 100.0) - flat,
        Some("premium") => comp * (1.0 + pct / 100.0) + flat,
        _ => comp,
    };
    let floor = number_or(f64_field(strategy, &["minPkn"]), 0.0, 0.0, 1_000_000.0);
    let scaled = |pkn: f64| (pkn * SCALE as f64).round() as i128;
    let result = floor_price_rounded(scaled(target), rounding_of(strategy), scaled(floor));
    if result <= 0 {
        return None;
    }
    Some(round2(result as f64 / SCALE as f64))
}

/// What the plan does with one listing (`planReprice`).
#[derive(Clone, Debug, PartialEq)]
pub enum PlanOutcome {
    /// Not a live or paused listing: never repriced.
    Skipped,
    /// No market number for it: counted, never guessed.
    NoComp,
    /// Already at the target (and not to be put on sale).
    Unchanged,
    Change { current: f64, comp_pkn: f64, target: f64, activate: bool },
}

/// One listing row (snake or camel case) against its comp.
pub fn plan_row(row: &Value, comp: Option<&Value>, strategy: &Value) -> PlanOutcome {
    let status = row.get("status").and_then(Value::as_str).unwrap_or("active").to_lowercase();
    if status != "active" && status != "paused" {
        return PlanOutcome::Skipped;
    }
    let Some(comp_pkn) = comp.and_then(|comp| strategy_comp(comp, strategy)) else {
        return PlanOutcome::NoComp;
    };
    let Some(target) = evaluate_strategy_target(Some(comp_pkn), strategy) else {
        return PlanOutcome::NoComp;
    };
    let current = ["price_pkn", "pricePkn"]
        .iter()
        .find_map(|key| f64_field(row, &[key]))
        .filter(|price| price.is_finite())
        .unwrap_or(0.0);
    let activate = strategy.get("activatePaused") == Some(&Value::Bool(true)) && status == "paused";
    if (target - current).abs() < 0.01 && !activate {
        return PlanOutcome::Unchanged;
    }
    PlanOutcome::Change { current, comp_pkn, target, activate }
}

/// The listing update one change sends.
pub fn plan_update(target: f64, activate: bool) -> Value {
    if activate {
        json!({ "pricePkn": target, "status": "active" })
    } else {
        json!({ "pricePkn": target })
    }
}

/// One line describing a strategy (`pricerSummary`).
pub fn strategy_summary(strategy: &Value) -> String {
    let get = |key: &str| strategy.get(key).and_then(Value::as_str).unwrap_or("");
    let num = |key: &str| f64_field(strategy, &[key]).unwrap_or(0.0);
    let mut parts = vec![if get("source") == "pokoin" { "Pokoin" } else { "CardTrader" }.to_string()];
    if get("basis") == "sold" {
        parts.push("sold median (30 days)".into());
    } else if get("source") == "pokoin" {
        parts.push("cheapest Pokoin ask".into());
    } else {
        parts.push(match_summary(strategy_match(strategy)));
    }
    if get("source") != "pokoin" {
        parts.push(if strategy.get("feeExclusive") == Some(&Value::Bool(false)) { "CardTrader ask" } else { "net of CardTrader fees" }.to_string());
    }
    let flat = |sign: &str| if num("amountPkn") > 0.0 { format!(" {sign} {} PKN", trim_number(num("amountPkn"))) } else { String::new() };
    match get("action") {
        "undercut" => parts.push(format!("undercut {}%{}", trim_number(num("amountPct")), flat("−"))),
        "premium" => parts.push(format!("+{}%{}", trim_number(num("amountPct")), flat("+"))),
        _ => parts.push("match".into()),
    }
    match get("rounding") {
        "integer" => parts.push("whole PKN".into()),
        "down" => parts.push("rounded down".into()),
        "up" => parts.push("rounded up".into()),
        _ => {}
    }
    if num("minPkn") > 0.0 {
        parts.push(format!("min {} PKN", trim_number(num("minPkn"))));
    }
    parts.join(" · ")
}

fn trim_number(value: f64) -> String {
    let text = format!("{:.2}", value);
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn now() -> &'static str {
        "2026-11-04T00:00:00.000Z"
    }

    // The Spiderling comp of 2026-10-21: a €0.14 CardTrader ask nets 25.56 PKN.
    fn spiderling() -> Value {
        json!({"ctMatchedPkn": 25.56, "ctMatchedGrossPkn": 28, "ctCheapestPkn": 25.56, "ctCheapestGrossPkn": 28,
               "soldMedianPkn": 30, "soldMedianGrossPkn": 33, "pokoinCheapestPkn": 40})
    }

    #[test]
    fn strategies_are_named_unique_and_have_no_scope() {
        let ok = sanitize_strategy(
            &json!({"name": "Undercut 5%", "source": "cardtrader", "action": "undercut", "amountPct": 5,
                    "game": "riftbound", "condition": "NM", "enabled": false, "junk": 1}),
            None, &[], now(),
        )
        .unwrap();
        assert_eq!(ok["name"], "Undercut 5%");
        assert_eq!(ok["rounding"], "none");
        assert!(ok["id"].as_str().unwrap().starts_with("st_"));
        for gone in ["game", "condition", "status", "language", "enabled", "junk"] {
            assert!(ok.get(gone).is_none(), "{gone} is not stored");
        }
        let err = |input: Value, others: &[Value]| sanitize_strategy(&input, None, others, now()).unwrap_err();
        assert_eq!(err(json!({"source": "pokoin", "action": "match"}), &[]).code.as_deref(), Some("strategy_name_required"));
        assert_eq!(err(json!({"name": "x", "source": "ebay", "action": "match"}), &[]).message, "Pricer source must be pokoin or cardtrader.");
        assert_eq!(err(json!({"name": "x", "source": "pokoin", "action": "nuke"}), &[]).message, "Strategy action must be match, undercut or premium.");
        let taken = err(json!({"name": " undercut 5% ", "source": "pokoin", "action": "match"}), &[ok.clone()]);
        assert_eq!((taken.status, taken.code.as_deref()), (409, Some("strategy_name_taken")));
        // Renaming a strategy to its own name is not a clash.
        let same = sanitize_strategy(&json!({"id": ok["id"], "name": "UNDERCUT 5%", "source": "pokoin", "action": "match"}), Some(&ok), &[ok.clone()], now());
        assert!(same.is_ok());
    }

    #[test]
    fn an_edit_keeps_identity_and_clamps() {
        let existing = json!({"id": "st_keep", "createdAt": "2025-01-01T00:00:00.000Z", "legacyScope": {"game": "riftbound"}});
        let out = sanitize_strategy(
            &json!({"name": "Premium", "source": "pokoin", "action": "premium", "amountPct": 999, "amountPkn": -5, "basis": "magic", "feeExclusive": false}),
            Some(&existing), &[], now(),
        )
        .unwrap();
        assert_eq!((out["id"].clone(), out["createdAt"].clone()), (json!("st_keep"), json!("2025-01-01T00:00:00.000Z")));
        assert_eq!((out["amountPct"].clone(), out["amountPkn"].clone()), (json!(90.0), json!(0.0)));
        assert_eq!((out["basis"].clone(), out["feeExclusive"].clone(), out["activatePaused"].clone()), (json!("offers"), json!(false), json!(false)));
        assert_eq!(out["match"], json!({"condition": true, "language": true, "finish": true, "firstEdition": true}), "no toggles sent: all exact");
        assert_eq!(out["legacyScope"], json!({"game": "riftbound"}), "the old scope survives edits until it became a group");
        assert_eq!(out["updatedAt"], now());
    }

    #[test]
    fn an_old_strategy_reads_back_with_its_scope_kept_aside() {
        let old = json!({"id": "st_1", "name": "Riftbound paused", "source": "cardtrader", "action": "match", "basis": "cheapest",
                         "rounding": "down", "game": "Riftbound", "status": "paused", "condition": "Poor", "activatePaused": true,
                         "enabled": true, "createdAt": "2026-10-21T00:00:00.000Z", "updatedAt": "2026-10-22T00:00:00.000Z"});
        let up = upgrade_stored_strategy(&old, &[], now());
        assert_eq!(up["legacyScope"], json!({"game": "riftbound", "status": "paused", "condition": "POOR", "language": ""}));
        assert_eq!((up["rounding"].clone(), up["basis"].clone(), up["activatePaused"].clone()), (json!("down"), json!("offers"), json!(true)));
        assert_eq!(up["match"], json!({"condition": false, "language": false, "finish": false, "firstEdition": false}), "the old cheapest copy is every toggle off");
        assert_eq!(up["updatedAt"], "2026-10-22T00:00:00.000Z", "reading is not an edit");
        assert!(up.get("game").is_none());
        // No scope, or switched off: nothing to turn into a group.
        assert!(legacy_scope(&json!({"name": "All", "game": "", "status": ""})).is_none());
        assert!(legacy_scope(&json!({"name": "Off", "game": "pokemon", "enabled": false})).is_none());
        // Duplicate and missing names become unique readable ones.
        let twin = upgrade_stored_strategy(&json!({"id": "st_2", "name": "riftbound PAUSED", "source": "x", "action": "y"}), &[up.clone()], now());
        assert_eq!((twin["name"].clone(), twin["source"].clone(), twin["action"].clone()), (json!("riftbound PAUSED (2)"), json!("cardtrader"), json!("match")));
        assert_eq!(upgrade_stored_strategy(&json!({"id": "st_3"}), &[], now())["name"], "Strategy");
    }

    #[test]
    fn a_legacy_scope_matches_what_the_old_pricer_matched() {
        let scope = json!({"game": "riftbound", "status": "paused", "condition": "NM", "language": "EN"});
        let row = json!({"marketplace_game": "riftbound", "status": "paused", "condition": "nm", "language": "en"});
        assert!(legacy_scope_matches(&scope, &row));
        assert!(!legacy_scope_matches(&scope, &json!({"marketplace_game": "pokemon", "status": "paused", "condition": "NM", "language": "EN"})));
        assert!(!legacy_scope_matches(&json!({}), &json!({"status": "sold_out"})), "sold out or removed: never");
        assert!(legacy_scope_matches(&json!({"game": "pokemon", "condition": "NM"}), &json!({"status": "active"})), "no game is Pokémon, no condition NM");
    }

    #[test]
    fn groups_are_named_unique_and_use_one_of_the_sellers_strategies() {
        let strategies = [json!({"id": "st_a", "name": "Match"})];
        let group = sanitize_group(&json!({"name": "Riftbound bulk", "strategyId": "st_a", "autoDaily": true}), None, &strategies, &[]).unwrap();
        assert!(group["id"].as_str().unwrap().starts_with("pg_"));
        assert_eq!((group["strategyId"].clone(), group["autoDaily"].clone()), (json!("st_a"), json!(true)));
        let err = |input: Value| sanitize_group(&input, None, &strategies, &[group.clone()]).unwrap_err().code;
        assert_eq!(err(json!({"name": "", "strategyId": "st_a"})).as_deref(), Some("group_name_required"));
        assert_eq!(err(json!({"name": "RIFTBOUND BULK", "strategyId": "st_a"})).as_deref(), Some("group_name_taken"));
        assert_eq!(err(json!({"name": "Other", "strategyId": "st_nope"})).as_deref(), Some("pricing_strategy_unknown"));
        // A rename keeps the strategy and the daily switch.
        let renamed = sanitize_group(&json!({"id": group["id"], "name": "Riftbound"}), Some(&group), &strategies, &[group.clone()]).unwrap();
        assert_eq!((renamed["strategyId"].clone(), renamed["autoDaily"].clone()), (json!("st_a"), json!(true)));
    }

    #[test]
    fn the_comp_by_source_basis_and_fees() {
        let c = spiderling();
        let s = |v: Value| strategy_comp(&c, &v);
        assert_eq!(s(json!({})), Some(25.56));
        assert_eq!(s(json!({"feeExclusive": false})), Some(28.0));
        assert_eq!(s(json!({"basis": "cheapest"})), Some(25.56));
        assert_eq!(s(json!({"basis": "sold"})), Some(30.0));
        assert_eq!(s(json!({"basis": "sold", "feeExclusive": false})), Some(33.0));
        assert_eq!(s(json!({"source": "pokoin"})), Some(40.0));
        assert_eq!(strategy_comp(&json!({"soldMedianPkn": 30}), &json!({"source": "pokoin"})), Some(30.0));
        assert_eq!(strategy_comp(&json!({"ctMatchedPkn": 25.56}), &json!({"feeExclusive": false})), Some(25.56), "no gross field: the net");
        assert_eq!(strategy_comp(&json!({}), &json!({})), None);
    }

    #[test]
    fn the_toggles_pick_their_offer_from_the_comp() {
        // Asks 28 (exact), 20 (same condition and language), 15 (any copy).
        let comp = json!({
            "ctMatchedPkn": 25.56, "ctMatchedGrossPkn": 28, "ctCheapestPkn": 13.5, "ctCheapestGrossPkn": 15,
            "ctMatch": {
                "CLFE": {"grossPkn": 28, "pkn": 25.56}, "CL": {"grossPkn": 20, "pkn": 18.2}, "": {"grossPkn": 15, "pkn": 13.5},
            },
        });
        let toggles = |c: bool, l: bool, f: bool, e: bool| json!({"match": {"condition": c, "language": l, "finish": f, "firstEdition": e}});
        assert_eq!(strategy_comp(&comp, &toggles(true, true, true, true)), Some(25.56));
        assert_eq!(strategy_comp(&comp, &toggles(true, true, false, false)), Some(18.2));
        assert_eq!(strategy_comp(&comp, &json!({"match": {"condition": true, "language": true, "finish": false, "firstEdition": false}, "feeExclusive": false})), Some(20.0));
        assert_eq!(strategy_comp(&comp, &toggles(false, false, false, false)), Some(13.5));
        assert_eq!(strategy_comp(&comp, &toggles(false, true, false, false)), None, "no offer in that language: no price");
        // An answer from before `ctMatch`: only exact and any copy.
        let old = json!({"ctMatchedPkn": 25.56, "ctCheapestPkn": 13.5});
        assert_eq!(strategy_comp(&old, &toggles(true, true, true, true)), Some(25.56));
        assert_eq!(strategy_comp(&old, &toggles(false, false, false, false)), Some(13.5));
        assert_eq!(strategy_comp(&old, &toggles(true, false, false, false)), None);
        // Sold median and Pokoin ignore the toggles.
        assert_eq!(strategy_comp(&json!({"soldMedianPkn": 30, "ctMatch": {}}), &json!({"basis": "sold", "match": {"condition": false}})), Some(30.0));
        // In words.
        assert_eq!(match_summary(Match::EXACT), "all exact");
        assert_eq!(match_summary(Match::ANY), "any copy");
        assert_eq!(match_summary(Match { condition: true, ..Match::ANY }), "same condition");
        assert_eq!(match_summary(Match { condition: true, language: true, first_edition: true, finish: false }), "same condition, language and 1st edition");
        assert_eq!(Match::from_key(&Match { language: true, finish: true, ..Match::ANY }.key()), Match { language: true, finish: true, ..Match::ANY });
        assert_eq!(Match::all().count(), 16);
    }

    #[test]
    fn the_shared_examples_hold_as_on_the_web() {
        let vectors: Value = serde_json::from_str(include_str!("../../../../market/src/pricer.vectors.json")).unwrap();
        let cases = vectors["cases"].as_array().unwrap();
        assert!(cases.len() >= 10);
        for (index, example) in cases.iter().enumerate() {
            let comp = &vectors["comps"][example["comp"].as_str().unwrap()];
            let comp_pkn = strategy_comp(comp, &example["strategy"]);
            assert_eq!(comp_pkn, example["compPkn"].as_f64(), "case {index}: comp");
            assert_eq!(evaluate_strategy_target(comp_pkn, &example["strategy"]), example["target"].as_f64(), "case {index}: target");
        }
    }

    #[test]
    fn target_math_matches_the_web() {
        let t = |comp: f64, s: Value| evaluate_strategy_target(Some(comp), &s);
        assert_eq!(t(100.0, json!({"action": "undercut", "amountPct": 10, "amountPkn": 1})), Some(89.0));
        assert_eq!(t(10.5, json!({"action": "premium", "amountPct": 20, "rounding": "integer"})), Some(13.0));
        assert_eq!(t(25.56, json!({"rounding": "integer", "minPkn": 1})), Some(26.0));
        assert_eq!(t(25.56, json!({"rounding": "down"})), Some(25.0));
        assert_eq!(t(25.56, json!({"rounding": "up"})), Some(26.0));
        assert_eq!(t(26.0, json!({"rounding": "up"})), Some(26.0), "a whole price is not pushed up");
        assert_eq!(t(3.4, json!({"rounding": "down", "minPkn": 3.5})), Some(3.5), "the floor wins over rounding");
        assert_eq!(t(100.0, json!({"action": "undercut", "amountPct": 90, "minPkn": 50})), Some(50.0));
        assert_eq!(t(1.0, json!({"action": "undercut", "amountPkn": 5})), None, "never 0 or below");
        assert_eq!(t(25.56789, json!({"rounding": "none"})), Some(25.57), "exact is cents");
        assert_eq!(t(1e13, json!({})), None, "beyond the proofs' range");
        assert_eq!(evaluate_strategy_target(None, &json!({})), None);
        assert_eq!(evaluate_strategy_target(Some(0.0), &json!({})), None);
    }

    #[test]
    fn the_plan_prices_paused_rows_and_puts_them_on_sale() {
        let s = json!({"rounding": "integer", "minPkn": 1, "activatePaused": true});
        let c = spiderling();
        assert_eq!(
            plan_row(&json!({"status": "paused", "price_pkn": 0}), Some(&c), &s),
            PlanOutcome::Change { current: 0.0, comp_pkn: 25.56, target: 26.0, activate: true }
        );
        assert_eq!(plan_row(&json!({"status": "active", "pricePkn": 26}), Some(&c), &s), PlanOutcome::Unchanged);
        assert_eq!(plan_row(&json!({"status": "active", "pricePkn": 30}), Some(&json!({"ctMatchedPkn": 19.56})), &s),
            PlanOutcome::Change { current: 30.0, comp_pkn: 19.56, target: 20.0, activate: false });
        assert_eq!(plan_row(&json!({"status": "active"}), None, &s), PlanOutcome::NoComp);
        assert_eq!(plan_row(&json!({"status": "sold_out"}), Some(&c), &s), PlanOutcome::Skipped);
        let keep_paused = json!({"rounding": "integer"});
        assert_eq!(plan_row(&json!({"status": "paused", "price_pkn": 26}), Some(&c), &keep_paused), PlanOutcome::Unchanged);
        assert_eq!(plan_update(26.0, true), json!({"pricePkn": 26.0, "status": "active"}));
        assert_eq!(plan_update(20.0, false), json!({"pricePkn": 20.0}));
    }

    #[test]
    fn settings_and_summary() {
        assert_eq!(sanitize_settings(None), json!({"defaultSource": "cardtrader", "autoMarketColumn": false}));
        assert_eq!(
            sanitize_settings(Some(&json!({"defaultSource": "POKOIN", "autoMarketColumn": "yes"}))),
            json!({"defaultSource": "pokoin", "autoMarketColumn": false})
        );
        assert_eq!(
            strategy_summary(&json!({"source": "cardtrader", "action": "undercut", "amountPct": 5, "rounding": "integer", "minPkn": 1})),
            "CardTrader · all exact · net of CardTrader fees · undercut 5% · whole PKN · min 1 PKN"
        );
        assert_eq!(
            strategy_summary(&json!({"source": "pokoin", "basis": "sold", "action": "premium", "amountPct": 10, "amountPkn": 2.5})),
            "Pokoin · sold median (30 days) · +10% + 2.5 PKN"
        );
    }
}
