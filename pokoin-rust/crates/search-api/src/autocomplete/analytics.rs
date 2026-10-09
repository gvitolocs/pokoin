//! Analytics layer: `analyticsBoostsForRows` / `emptyAnalyticsBoosts`,
//! `optionalPersonalizationUser`, the cancel-state helpers of
//! `marketplace-autocomplete.js` and the in-memory searchbar session registry
//! of `_searchbar_session.js` (cancel + expiry + size bound).

use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use super::row::{get_any, num_field};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// The analytics boost maps the JS handler passes around (a Map with extra
/// `siteBoosts` / `userBoosts` / `sources` properties).
#[derive(Clone, Debug, Default)]
pub struct AnalyticsBoosts {
    pub boosts: HashMap<String, f64>,
    pub site_boosts: HashMap<String, f64>,
    pub user_boosts: HashMap<String, f64>,
    pub source_site: String,
    pub source_user: String,
}

/// `emptyAnalyticsBoosts()`.
pub fn empty_analytics_boosts() -> AnalyticsBoosts {
    AnalyticsBoosts {
        boosts: HashMap::new(),
        site_boosts: HashMap::new(),
        user_boosts: HashMap::new(),
        source_site: "marketplace_hot_blueprints".to_owned(),
        source_user: "none".to_owned(),
    }
}

impl AnalyticsBoosts {
    /// `analyticsBoosts.size` (the main map in the JS handler).
    pub fn size(&self) -> usize {
        self.boosts.len()
    }

    pub fn to_json(&self) -> Value {
        json!({
            "siteBoosts": self.site_boosts,
            "userBoosts": self.user_boosts,
            "sources": {"site": self.source_site, "user": self.source_user},
        })
    }
}

/// `analyticsBoostsForRows` — safe f64→i64 conversion for card ids.
fn id_to_i64(id: f64) -> Option<i64> {
    if id.is_finite() && id.fract() == 0.0 && id > 0.0 && id <= 9_007_199_254_740_991.0 {
        Some(id as i64)
    } else {
        None
    }
}

/// Site + user boosts for the pool rows (`analyticsBoostsForRows`).
pub async fn analytics_boosts_for_rows(
    pool: &PgPool,
    rows: &[Value],
    user_uid: Option<&str>,
) -> Result<AnalyticsBoosts, super::engine::EngineError> {
    let mut ids: Vec<i64> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let Some(id) = id_to_i64(num_field(row, &["card_id"])) else {
            continue;
        };
        if seen.insert(id) {
            ids.push(id);
        }
    }
    ids.truncate(500);
    if ids.is_empty() {
        return Ok(empty_analytics_boosts());
    }
    let site_sql = r#"
      select
        h.blueprint_id::text as card_id,
        (
          least(coalesce(h.hot_score_1h, 0), 5000) * 0.35 +
          least(coalesce(h.hot_score_24h, 0), 15000) * 0.12 +
          least(coalesce(h.hot_score_7d, 0), 40000) * 0.03 +
          least(coalesce(h.searches_24h, 0), 500) * 8 +
          least(coalesce(h.clicks_24h, 0), 500) * 14 +
          least(coalesce(h.cart_adds_24h, 0), 100) * 28 +
          least(coalesce(h.reserves_24h, 0), 100) * 34 +
          least(coalesce(h.sales_24h, 0), 50) * 55 +
          least(coalesce(s.active_listing_count, 0), 50) * 24 +
          least(coalesce(s.listed_quantity, 0), 200) * 4
        )::real as analytics_boost
      from public.marketplace_hot_blueprints h
      left join public.marketplace_blueprint_price_summary s
        on s.blueprint_id = h.blueprint_id
      where h.blueprint_id = any($1::bigint[])
    "#;
    let mut query = sqlx::query(site_sql);
    for id in &ids {
        query = query.bind(*id);
    }
    let mut boosts = empty_analytics_boosts();
    let rows = query
        .fetch_all(pool)
        .await
        .map_err(|error| super::engine::EngineError::from_sqlx(error))?;
    for row in &rows {
        let card_id: String = row.try_get("card_id").unwrap_or_default();
        let boost: f32 = row.try_get("analytics_boost").unwrap_or(0.0);
        boosts
            .site_boosts
            .insert(card_id.clone(), f32_to_f64(boost));
    }
    if let Some(user_uid) = user_uid {
        let user_sql = r#"
          select
            e.card_id::text as card_id,
            (
              least(coalesce(sum(e.weight) filter (where e.occurred_at >= now() - interval '1 hour'), 0), 500) * 1.25 +
              least(coalesce(sum(e.weight) filter (where e.occurred_at >= now() - interval '24 hours'), 0), 1500) * 0.55 +
              least(coalesce(sum(e.weight) filter (where e.occurred_at >= now() - interval '30 days'), 0), 3000) * 0.18 +
              least(count(*) filter (where e.event_type = 'search' and e.occurred_at >= now() - interval '30 days'), 30) * 14 +
              least(count(*) filter (where e.event_type in ('view', 'click') and e.occurred_at >= now() - interval '30 days'), 60) * 10 +
              least(count(*) filter (where e.event_type in ('cart_add', 'reserve', 'sale') and e.occurred_at >= now() - interval '30 days'), 20) * 35
            )::real as user_boost
          from public.marketplace_card_events e
          where e.card_id = any($1::bigint[])
            and e.user_uid = $2
            and e.occurred_at >= now() - interval '30 days'
          group by e.card_id
        "#;
        let mut query = sqlx::query(user_sql);
        for id in &ids {
            query = query.bind(*id);
        }
        query = query.bind(user_uid);
        match query.fetch_all(pool).await {
            Ok(rows) => {
                for row in &rows {
                    let card_id: String = row.try_get("card_id").unwrap_or_default();
                    let boost: f32 = row.try_get("user_boost").unwrap_or(0.0);
                    boosts.user_boosts.insert(card_id, f32_to_f64(boost));
                }
            }
            Err(error) => {
                // JS rethrows anything but the missing-column code.
                if error
                    .as_database_error()
                    .map(|error| error.code().as_deref() != Some("42703"))
                    .unwrap_or(true)
                {
                    return Err(super::engine::EngineError::from_sqlx(error));
                }
            }
        }
    }
    for id in &ids {
        let key = id.to_string();
        let total = boosts.site_boosts.get(&key).copied().unwrap_or(0.0)
            + boosts.user_boosts.get(&key).copied().unwrap_or(0.0);
        boosts.boosts.insert(key, total);
    }
    boosts.source_site = "marketplace_hot_blueprints".to_owned();
    boosts.source_user = if user_uid.is_some() {
        "marketplace_card_events:user_uid".to_owned()
    } else {
        "none".to_owned()
    };
    Ok(boosts)
}

/// pg `float4` arrives as text in the JS driver; keep the shortest f32 form so
/// `748.0501` serializes identically.
pub fn f32_to_f64(value: f32) -> f64 {
    if value.is_finite() {
        value.to_string().parse().unwrap_or(value as f64)
    } else {
        value as f64
    }
}

/// `optionalPersonalizationUser(req)` — `{ uid, error }` of the bearer claims:
/// the uid of a valid token (≤128 chars), or `null` when the token is absent
/// or failed verification (the error rides along for `debug`).
pub fn optional_personalization_user(
    claims: Option<&pokoin_accounts::firebase::Claims>,
    auth_error: Option<Value>,
) -> (Option<String>, Option<Value>) {
    let Some(claims) = claims else {
        return (None, auth_error);
    };
    let uid = claims.uid.trim();
    if uid.is_empty() {
        return (None, auth_error);
    }
    (Some(uid.chars().take(128).collect()), auth_error)
}

// --- searchbar session registry (_searchbar_session.js) ---

const SEARCH_SESSION_TTL_MS: u64 = 2 * 60 * 1000;
const MAX_CANCELLED_SESSIONS: usize = 2000;

#[derive(Clone, Debug)]
pub struct CancelledSession {
    pub session_id: String,
    pub query: String,
    pub reason: String,
    pub canceled_at: u64,
    pub expires_at: u64,
}

static CANCELLED_SESSIONS: LazyLock<Mutex<HashMap<String, CancelledSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// `cleanSearchSessionId(value)`.
pub fn clean_search_session_id(value: Option<&Value>) -> String {
    let raw = super::normalize::js_str_or(value);
    let id: String = raw.trim().chars().take(120).collect();
    let valid = id.len() >= 8
        && id.len() <= 120
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b':' || b == b'-');
    if valid {
        id
    } else {
        String::new()
    }
}

/// `pruneCancelledSessions(now)`.
pub fn prune_cancelled_sessions(now: u64) {
    let mut sessions = CANCELLED_SESSIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    sessions.retain(|_, entry| entry.expires_at > now);
    while sessions.len() > MAX_CANCELLED_SESSIONS {
        let Some(oldest) = sessions
            .iter()
            .min_by_key(|(_, entry)| entry.canceled_at)
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        sessions.remove(&oldest);
    }
}

/// `cancelSearchSession(sessionId, metadata)`.
pub fn cancel_search_session(
    session_id: Option<&Value>,
    metadata: Option<&Value>,
) -> Option<CancelledSession> {
    let id = clean_search_session_id(session_id);
    if id.is_empty() {
        return None;
    }
    let now = now_ms();
    prune_cancelled_sessions(now);
    let meta = metadata.cloned().unwrap_or(Value::Null);
    let entry = CancelledSession {
        session_id: id.clone(),
        query: super::normalize::js_str_or(get_any(&meta, &["query"]))
            .trim()
            .chars()
            .take(80)
            .collect(),
        reason: {
            let reason = super::normalize::js_str_or(get_any(&meta, &["reason"]))
                .trim()
                .chars()
                .take(40)
                .collect::<String>();
            if reason.is_empty() {
                "cancel".to_owned()
            } else {
                reason
            }
        },
        canceled_at: now,
        expires_at: now + SEARCH_SESSION_TTL_MS,
    };
    CANCELLED_SESSIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(id, entry.clone());
    Some(entry)
}

/// `isSearchSessionCancelled(sessionId)`.
pub fn is_search_session_cancelled(session_id: &str) -> bool {
    if session_id.is_empty() {
        return false;
    }
    let mut sessions = CANCELLED_SESSIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match sessions.get(session_id) {
        None => false,
        Some(entry) => {
            if entry.expires_at <= now_ms() {
                sessions.remove(session_id);
                false
            } else {
                true
            }
        }
    }
}

/// `clearSearchSessionForTest(sessionId)`.
pub fn clear_search_session_for_test(session_id: &str) {
    if session_id.is_empty() {
        return;
    }
    CANCELLED_SESSIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(session_id);
}

/// `searchCancelState(req, sessionId)` — `clientDisconnected` cannot be
/// observed in the axum handler (Node listens to `req.on('aborted')`), so it
/// stays false; session cancellation is fully honoured.
#[derive(Clone, Debug, Default)]
pub struct SearchCancelState {
    pub session_id: String,
    pub client_disconnected: bool,
}

/// `searchCancelState`.
pub fn search_cancel_state(session_id: &str) -> SearchCancelState {
    SearchCancelState {
        session_id: session_id.to_owned(),
        client_disconnected: false,
    }
}

/// `isSearchCanceled(cancelState)`.
pub fn is_search_canceled(cancel_state: &SearchCancelState) -> bool {
    cancel_state.client_disconnected || is_search_session_cancelled(&cancel_state.session_id)
}

/// `canceledAutocompleteResponse(searchTerm, searchLanguage, cancelState)`.
pub fn canceled_autocomplete_response(
    search_term: &str,
    search_language: &str,
    cancel_state: &SearchCancelState,
) -> Value {
    json!({
        "rows": [],
        "pool": {
            "source": "session_canceled",
            "size": 0,
            "limit": 0,
            "strategy": "session_canceled",
        },
        "search_context": Value::Null,
        "canceled": true,
        "search_session_id": cancel_state.session_id,
        "debug": {
            "searchTerm": search_term,
            "searchLanguage": search_language,
            "searchPath": "session_canceled",
            "canceled": true,
            "cancelReason": if cancel_state.client_disconnected {
                "client_disconnected"
            } else {
                "session_canceled"
            },
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_ids_need_the_shape() {
        assert_eq!(
            clean_search_session_id(Some(&json!("abcd1234"))),
            "abcd1234"
        );
        assert_eq!(clean_search_session_id(Some(&json!("short"))), "");
        assert_eq!(clean_search_session_id(Some(&json!("has space-1234"))), "");
        assert_eq!(clean_search_session_id(Some(&json!(12345678))), "12345678"); // String(12345678)
                                                                                 // JS slices to 120 BEFORE the shape test, so 130 a's truncate to a valid id.
        let long: String = "a".repeat(130);
        assert_eq!(clean_search_session_id(Some(&json!(long))), "a".repeat(120));
    }

    #[test]
    fn cancel_and_query_the_session_map() {
        let id = json!("test-session-1");
        clear_search_session_for_test("test-session-1");
        assert!(!is_search_session_cancelled("test-session-1"));
        let entry =
            cancel_search_session(Some(&id), Some(&json!({"query": "pika", "reason": "ui"})))
                .expect("entry");
        assert_eq!(entry.query, "pika");
        assert_eq!(entry.reason, "ui");
        assert!(is_search_session_cancelled("test-session-1"));
        clear_search_session_for_test("test-session-1");
        assert!(!is_search_session_cancelled("test-session-1"));
    }

    #[test]
    fn cancel_metadata_defaults_to_cancel() {
        let entry = cancel_search_session(Some(&json!("test-session-2")), None).expect("entry");
        assert_eq!(entry.reason, "cancel");
        clear_search_session_for_test("test-session-2");
    }

    #[test]
    fn canceled_response_envelope() {
        let state = search_cancel_state("sess-12345678");
        let body = canceled_autocomplete_response("pika", "en", &state);
        assert_eq!(body["canceled"], true);
        assert_eq!(body["rows"], serde_json::json!([]));
        assert_eq!(body["search_context"], Value::Null);
        assert_eq!(body["pool"]["source"], "session_canceled");
        assert_eq!(body["debug"]["cancelReason"], "session_canceled");
        assert_eq!(body["search_session_id"], "sess-12345678");
    }
}
