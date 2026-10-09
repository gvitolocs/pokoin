//! Port of `api/marketplace-debug-cardtrader-blueprints.js` — inspect and
//! enqueue CardTrader Oracle import jobs (`public.marketplace_cardtrader_import_jobs`).

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::Response,
};
use serde_json::{json, Value};
use sqlx::Row;

use pokoin_api_common::{http, RouteState};

use super::{
    db_error_code, db_error_message, internal_error, is_missing_table_error, iso_millis,
    js_number_of, js_string, js_truthy_string, request_query, truncate_utf16, value_get, DebugUser,
};

const DEFAULT_GAME: &str = "pokemon";
const ACTIVE_STATUSES: [&str; 2] = ["queued", "running"];

/// `cleanGame(value)`.
pub(crate) fn clean_game(value: Option<&str>) -> String {
    let game = value
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_GAME)
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let trimmed = game.trim_matches('_');
    if trimmed.is_empty() {
        DEFAULT_GAME.to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// `cleanMode(value)`.
pub(crate) fn clean_mode(value: &Value) -> String {
    if value.as_str() == Some("apply") {
        "apply".to_owned()
    } else {
        "dry_run".to_owned()
    }
}

/// `cleanBoolean(value, fallback)`.
pub(crate) fn clean_boolean(value: &Value, fallback: bool) -> bool {
    match value {
        Value::Bool(exact) => *exact,
        Value::String(text) if text == "true" || text == "1" => true,
        Value::String(text) if text == "false" || text == "0" => false,
        _ => fallback,
    }
}

/// `cleanPositiveInteger(value, fallback, min, max)` for a present JSON value
/// (`Number(null)` is 0, so an explicit null clamps to the minimum).
pub(crate) fn clean_positive_integer(value: &Value, fallback: i64, min: i64, max: i64) -> i64 {
    clean_positive_integer_optional(Some(value), fallback, min, max)
}

/// The `Option` flavour: a missing key is JS `undefined` (NaN -> fallback).
pub(crate) fn clean_positive_integer_optional(
    value: Option<&Value>,
    fallback: i64,
    min: i64,
    max: i64,
) -> i64 {
    match super::js_number_of_optional(value) {
        Some(number) if number.is_finite() => (number.trunc() as i64).clamp(min, max),
        _ => fallback,
    }
}

/// `cleanLimit(value, fallback = 'all')`: `'all'` or a clamped numeric string.
pub(crate) fn clean_limit(value: &Value) -> String {
    let raw = match value {
        Value::Null => "all".to_owned(),
        other => js_string(other),
    };
    let raw = raw.trim().to_lowercase();
    if raw.is_empty() || raw == "all" || raw == "none" {
        return "all".to_owned();
    }
    clean_positive_integer(&Value::String(raw), 500, 1, 50_000).to_string()
}

/// `cleanExpansionIds(value)`: array or comma string of positive safe
/// integers, capped at 500.
pub(crate) fn clean_expansion_ids(value: &Value) -> Vec<i64> {
    let entries: Vec<Value> = match value {
        Value::Array(items) => items.clone(),
        Value::String(text) if !text.is_empty() => text
            .split(',')
            .map(|entry| Value::String(entry.trim().to_owned()))
            .collect(),
        _ => vec![],
    };
    entries
        .iter()
        .filter_map(|entry| match js_number_of(entry) {
            Some(number)
                if number.is_finite()
                    && number.trunc() == number
                    && number > 0.0
                    && number <= 9_007_199_254_740_991.0 =>
            {
                Some(number as i64)
            }
            _ => None,
        })
        .take(500)
        .collect()
}

/// `publicJob(row)` for a JSON-shaped job row (the typed read path builds the
/// same object in `job_row_to_json`); kept for the Node `_test` parity.
#[cfg(test)]
pub(crate) fn public_job(row: Option<&Value>) -> Value {
    let Some(row) = row else {
        return Value::Null;
    };
    let status = row
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let game = row
        .get("game")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let mode = row
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let non_empty_or = |value: String, fallback: &str| {
        if value.is_empty() {
            fallback.to_owned()
        } else {
            value
        }
    };
    json!({
        "jobId": row.get("job_id").and_then(Value::as_str).unwrap_or(""),
        "game": non_empty_or(game, DEFAULT_GAME),
        "mode": non_empty_or(mode, "dry_run"),
        "status": status,
        "active": ACTIVE_STATUSES.contains(&status.as_str()),
        "requestPayload": row.get("requestPayload").cloned().unwrap_or_else(|| json!({})),
        "progress": row.get("progress").cloned().filter(|v| !v.is_null()).unwrap_or_else(|| json!({})),
        "summary": row.get("summary").cloned().filter(|v| !v.is_null()).unwrap_or_else(|| json!({})),
        "errorMessage": row.get("errorMessage").and_then(Value::as_str).unwrap_or(""),
        "requestedAt": row.get("requestedAt").cloned().unwrap_or(Value::Null),
        "startedAt": row.get("startedAt").cloned().unwrap_or(Value::Null),
        "heartbeatAt": row.get("heartbeatAt").cloned().unwrap_or(Value::Null),
        "finishedAt": row.get("finishedAt").cloned().unwrap_or(Value::Null),
        "updatedAt": row.get("updatedAt").cloned().unwrap_or(Value::Null),
    })
}

/// `tableMissingResponse(res)`.
fn table_missing_response() -> Response {
    http::json(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({
            "error": "CardTrader Oracle import job table is not installed yet.",
            "setupRequired": true,
            "migration": "oracle-postgres/schema/009_cardtrader_import_jobs.sql",
        }),
    )
}

/// `requestPayload(body)`.
pub(crate) fn request_payload(body: &Value) -> Value {
    let game = clean_game(value_get(body, "game").as_str());
    let mode = clean_mode(value_get(body, "mode"));
    let expansion_ids = clean_expansion_ids(value_get(body, "expansionIds"));
    let stream_all = if expansion_ids.is_empty() {
        clean_boolean(value_get(body, "streamAll"), true)
    } else {
        false
    };
    let limit = match value_get(body, "limit") {
        Value::Null => {
            if mode == "apply" {
                "5000".to_owned()
            } else {
                "all".to_owned()
            }
        }
        other => clean_limit(other),
    };
    let languages = {
        let text = truncate_utf16(js_truthy_string(value_get(body, "languages")).trim(), 60);
        if text.is_empty() {
            "en".to_owned()
        } else {
            text
        }
    };
    let supabase_transport = {
        let text = truncate_utf16(
            js_truthy_string(value_get(body, "supabaseTransport")).trim(),
            40,
        );
        if text.is_empty() {
            "rest".to_owned()
        } else {
            text
        }
    };
    let positive = |key: &str, fallback: i64, min: i64, max: i64| {
        clean_positive_integer_optional(body.get(key), fallback, min, max)
    };
    json!({
        "game": game,
        "mode": mode,
        "streamAll": stream_all,
        "expansionIds": expansion_ids,
        "limit": limit,
        "batchSize": positive("batchSize", 500, 1, 5000),
        "concurrency": positive("concurrency", 4, 1, 20),
        "imageConcurrency": positive("imageConcurrency", 4, 1, 12),
        "imageChunkSize": positive("imageChunkSize", 50, 1, 200),
        "images": clean_boolean(value_get(body, "images"), mode == "apply"),
        "refresh": clean_boolean(value_get(body, "refresh"), mode == "apply"),
        "syncSearch": clean_boolean(value_get(body, "syncSearch"), mode == "apply"),
        "ensureSchema": clean_boolean(value_get(body, "ensureSchema"), false),
        "languages": languages,
        "supabaseTransport": supabase_transport,
    })
}

/// `latestJob(game)` from the read pool.
async fn latest_job(state: &RouteState, game: &str) -> Result<Option<Value>, sqlx::Error> {
    let row = sqlx::query(
        r#"
      select *
      from public.marketplace_cardtrader_import_jobs
      where lower(game) = lower($1)
      order by requested_at desc
      limit 1
    "#,
    )
    .bind(game)
    .fetch_optional(state.api.read())
    .await?;
    Ok(row.map(|row| job_row_to_json(&row)))
}

/// Typed projection of the `select *` job row (`publicJob` input).
fn job_row_to_json(row: &sqlx::postgres::PgRow) -> Value {
    let timestamp = |column: &str| -> Value {
        let value: Option<chrono::DateTime<chrono::Utc>> = row.try_get(column).unwrap_or(None);
        iso_millis(&value)
    };
    let jsonb = |column: &str| -> Value {
        let value: Option<Value> = row.try_get(column).unwrap_or(None);
        value.unwrap_or_else(|| json!({}))
    };
    let text = |column: &str| -> String {
        row.try_get::<Option<String>, _>(column)
            .unwrap_or_default()
            .unwrap_or_default()
    };
    let status = text("status");
    let game = text("game");
    let mode = text("mode");
    json!({
        "jobId": text("job_id"),
        "game": if game.is_empty() { DEFAULT_GAME.to_owned() } else { game },
        "mode": if mode.is_empty() { "dry_run".to_owned() } else { mode },
        "status": status,
        "active": ACTIVE_STATUSES.contains(&status.as_str()),
        "requestPayload": jsonb("request_payload"),
        "progress": jsonb("progress"),
        "summary": jsonb("summary"),
        "errorMessage": text("error_message"),
        "requestedAt": timestamp("requested_at"),
        "startedAt": timestamp("started_at"),
        "heartbeatAt": timestamp("heartbeat_at"),
        "finishedAt": timestamp("finished_at"),
        "updatedAt": timestamp("updated_at"),
    })
}

/// `insertJob({ game, mode, payload, user })` — job id matches the Node
/// format `cti_<base36 now>_<12 hex>`.
async fn insert_job(
    state: &RouteState,
    game: &str,
    mode: &str,
    payload: &Value,
    user: &DebugUser,
) -> Result<Value, sqlx::Error> {
    let job_id = format!(
        "cti_{}_{}",
        base36(chrono::Utc::now().timestamp_millis()),
        random_hex_12()
    );
    let row = sqlx::query(
        r#"
      insert into public.marketplace_cardtrader_import_jobs (
        job_id,
        game,
        mode,
        requested_by_uid,
        requested_by_email,
        requested_by_username,
        request_payload
      )
      values (
        $7,
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::jsonb
      )
      returning *
    "#,
    )
    .bind(game)
    .bind(mode)
    .bind(&user.uid)
    .bind(&user.email)
    .bind(&user.username)
    .bind(payload.to_string())
    .bind(&job_id)
    .fetch_one(state.api.write())
    .await?;
    Ok(job_row_to_json(&row))
}

/// `crypto.randomBytes(6).toString('hex')`.
fn random_hex_12() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// `Date.now().toString(36)`.
fn base36(value: i64) -> String {
    let mut value = value;
    if value == 0 {
        return "0".to_owned();
    }
    let digits: Vec<char> = "0123456789abcdefghijklmnopqrstuvwxyz".chars().collect();
    let negative = value < 0;
    let mut out = Vec::new();
    while value != 0 {
        out.push(digits[(value % 36).unsigned_abs() as usize]);
        value /= 36;
    }
    let mut text: String = out.iter().rev().collect();
    if negative {
        text.insert(0, '-');
    }
    text
}

fn oracle_worker(note: &str) -> Value {
    json!({
        "configured": false,
        "note": note,
    })
}

pub(crate) async fn handle(
    State(state): State<RouteState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    if method != Method::GET && method != Method::POST {
        return http::json_with(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({ "error": "Method not allowed." }),
            &[("allow", "GET, POST")],
        );
    }

    let user = match state.require_debug_admin(&headers).await {
        Ok(claims) => DebugUser::from_claims(&claims),
        Err(error) => return error,
    };

    if method == Method::GET {
        let query = request_query(&uri);
        let game = clean_game(query.first("game"));
        let job = match latest_job(&state, &game).await {
            Ok(job) => job,
            Err(error) => {
                if is_missing_table_error(&error) {
                    return table_missing_response();
                }
                return internal_error(&db_error_message(&error));
            }
        };
        return http::json_with(
            StatusCode::OK,
            json!({
                "ok": true,
                "game": game,
                "job": job,
                "oracleWorker": oracle_worker(
                    "Vercel only queues and reads jobs. Run scripts/cardtrader-oracle-import-worker.js on the Oracle Cloud VM to process them.",
                ),
            }),
            &[("cache-control", "no-store")],
        );
    }

    let parsed = match http::parse_body(&headers, &body) {
        Ok(parsed) => parsed.json(),
        Err(error) => return error,
    };
    let payload = request_payload(&parsed);
    let game = value_get(&payload, "game")
        .as_str()
        .unwrap_or(DEFAULT_GAME)
        .to_owned();
    let mode = value_get(&payload, "mode")
        .as_str()
        .unwrap_or("dry_run")
        .to_owned();
    match insert_job(&state, &game, &mode, &payload, &user).await {
        Ok(job) => http::json_with(
            StatusCode::ACCEPTED,
            json!({
                "ok": true,
                "enqueued": true,
                "job": job,
                "oracleWorker": oracle_worker(
                    "Queued in Oracle Postgres. The Oracle Cloud worker must pick this up; Vercel does not run the import.",
                ),
            }),
            &[("cache-control", "no-store")],
        ),
        Err(error) => {
            if is_missing_table_error(&error) {
                return table_missing_response();
            }
            if db_error_code(&error).as_deref() == Some("23505") {
                return http::json(
                    StatusCode::CONFLICT,
                    json!({
                        "error": "A CardTrader import job is already queued or running for this game.",
                        "code": "23505",
                    }),
                );
            }
            tracing::error!(
                message = %db_error_message(&error),
                "marketplace-debug-cardtrader-blueprints failed"
            );
            let mut body = serde_json::Map::new();
            body.insert("error".to_owned(), Value::String(db_error_message(&error)));
            if let Some(code) = db_error_code(&error) {
                body.insert("code".to_owned(), Value::String(code));
            }
            http::json(StatusCode::INTERNAL_SERVER_ERROR, Value::Object(body))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_game_normalizes() {
        assert_eq!(clean_game(Some("POKEMON")), "pokemon");
        assert_eq!(clean_game(Some(" one piece ")), "one_piece");
        assert_eq!(clean_game(Some("!!")), "pokemon");
        assert_eq!(clean_game(Some("")), "pokemon");
        assert_eq!(
            clean_game(Some("-one-")),
            "-one-",
            "hyphens are kept, only _ is trimmed"
        );
        assert_eq!(clean_game(Some("star wars")), "star_wars");
    }

    #[test]
    fn clean_mode_and_boolean() {
        assert_eq!(clean_mode(&json!("apply")), "apply");
        assert_eq!(clean_mode(&json!("APPLY")), "dry_run");
        assert_eq!(clean_mode(&json!(null)), "dry_run");
        assert!(clean_boolean(&json!(true), false));
        assert!(clean_boolean(&json!("true"), false));
        assert!(clean_boolean(&json!("1"), false));
        assert!(!clean_boolean(&json!(false), true));
        assert!(!clean_boolean(&json!("0"), true));
        assert!(clean_boolean(&json!(null), true));
        assert!(
            clean_boolean(&json!("yes"), true),
            "unrecognised text falls back"
        );
    }

    #[test]
    fn clean_positive_integer_clamps() {
        let n = |value: Value| clean_positive_integer(&value, 500, 1, 5000);
        assert_eq!(n(json!("10")), 10);
        assert_eq!(n(json!(0)), 1);
        assert_eq!(n(json!(99999)), 5000);
        assert_eq!(n(json!("abc")), 500);
        assert_eq!(n(json!(null)), 1, "Number(null) is 0, clamped to min");
        assert_eq!(n(json!(7.9)), 7);
    }

    #[test]
    fn clean_limit_keeps_all_or_clamps() {
        assert_eq!(clean_limit(&json!(null)), "all");
        assert_eq!(clean_limit(&json!("")), "all");
        assert_eq!(clean_limit(&json!("all")), "all");
        assert_eq!(clean_limit(&json!("NONE")), "all");
        assert_eq!(clean_limit(&json!("100")), "100");
        assert_eq!(clean_limit(&json!(0)), "1");
        assert_eq!(clean_limit(&json!("999999")), "50000");
        assert_eq!(clean_limit(&json!("junk")), "500");
    }

    #[test]
    fn clean_expansion_ids_parses_both_shapes() {
        assert_eq!(clean_expansion_ids(&json!([1, "2", 3.0])), vec![1, 2, 3]);
        assert_eq!(clean_expansion_ids(&json!("4, 5,,x")), vec![4, 5]);
        assert!(clean_expansion_ids(&json!(null)).is_empty());
        assert!(clean_expansion_ids(&json!("x,y")).is_empty());
        assert_eq!(clean_expansion_ids(&json!("-1,0,6")), vec![6]);
        let many = clean_expansion_ids(&json!((1..=600).collect::<Vec<i64>>()));
        assert_eq!(many.len(), 500);
    }

    #[test]
    fn request_payload_defaults_match_node() {
        let payload = request_payload(&json!({}));
        assert_eq!(payload["game"], "pokemon");
        assert_eq!(payload["mode"], "dry_run");
        assert_eq!(payload["streamAll"], true);
        assert_eq!(payload["expansionIds"], json!([]));
        assert_eq!(payload["limit"], "all");
        assert_eq!(payload["batchSize"], 500);
        assert_eq!(payload["concurrency"], 4);
        assert_eq!(payload["imageConcurrency"], 4);
        assert_eq!(payload["imageChunkSize"], 50);
        assert_eq!(payload["images"], false);
        assert_eq!(payload["refresh"], false);
        assert_eq!(payload["syncSearch"], false);
        assert_eq!(payload["ensureSchema"], false);
        assert_eq!(payload["languages"], "en");
        assert_eq!(payload["supabaseTransport"], "rest");

        let explicit_null = request_payload(&json!({"batchSize": null}));
        assert_eq!(
            explicit_null["batchSize"], 1,
            "explicit null is Number(null) = 0"
        );

        let apply = request_payload(
            &json!({"mode": "apply", "expansionIds": [7], "languages": "en,ja", "limit": "10"}),
        );
        assert_eq!(apply["mode"], "apply");
        assert_eq!(apply["streamAll"], false);
        assert_eq!(apply["images"], true);
        assert_eq!(apply["languages"], "en,ja");
        assert_eq!(apply["limit"], "10");
    }

    #[test]
    fn public_job_null_stays_null_and_flags_active() {
        assert_eq!(public_job(None), Value::Null);
        let running = public_job(Some(&json!({
            "jobId": "cti_x",
            "game": "",
            "mode": "",
            "status": "running",
            "requestPayload": {"game": "pokemon"},
            "progress": null,
            "summary": null,
            "errorMessage": "",
            "requestedAt": null,
            "startedAt": null,
            "heartbeatAt": null,
            "finishedAt": null,
            "updatedAt": null
        })));
        assert_eq!(running["game"], "pokemon");
        assert_eq!(running["mode"], "dry_run");
        assert_eq!(running["active"], true);
        assert_eq!(running["requestPayload"]["game"], "pokemon");
        assert_eq!(running["progress"], json!({}));
        let done = public_job(Some(&json!({"status": "done"})));
        assert_eq!(done["active"], false);
    }
}
