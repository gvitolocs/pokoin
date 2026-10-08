use axum::{extract::{Query, State}, response::{IntoResponse, Response}};
use serde::Deserialize;
use sqlx::PgPool;

use crate::util::{clean_card_id, RouteError};

#[derive(Deserialize)]
pub struct Params {
    #[serde(rename = "cardIds")]
    card_ids: Option<String>,
}

pub async fn handle(State(pool): State<PgPool>, Query(params): Query<Params>) -> Response {
    let card_ids = params.card_ids.unwrap_or_default();
    let ids = card_ids
        .split(',')
        .filter_map(clean_card_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return (axum::http::StatusCode::BAD_REQUEST, axum::Json(serde_json::json!({"error":"cardIds is required."}))).into_response();
    }
    let placeholders = (1..=ids.len()).map(|i| format!("${i}")).collect::<Vec<_>>().join(",");
    let sql = format!(
        "select card_id, min(price_pkn) as price_pkn from marketplace_user_listings where card_id in ({placeholders}) and status = 'active' and quantity_available > 0 group by card_id"
    );
    let mut query = sqlx::query(&sql);
    for id in ids {
        query = query.bind(id);
    }
    match query.fetch_all(&pool).await {
        Ok(rows) => {
            let mut result = serde_json::Map::new();
            for row in rows {
                use sqlx::Row;
                let id: i64 = row.try_get("card_id").unwrap_or_default();
                let price: Option<f64> = row.try_get("price_pkn").ok();
                result.insert(id.to_string(), price.map(serde_json::Value::from).unwrap_or(serde_json::Value::Null));
            }
            (axum::http::StatusCode::OK, axum::Json(serde_json::Value::Object(result))).into_response()
        }
        Err(error) => RouteError::from(error).into_response(),
    }
}
