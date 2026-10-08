use axum::{extract::{Query, State}, response::{IntoResponse, Response}};
use serde::Deserialize;
use sqlx::PgPool;

#[derive(Deserialize)]
pub struct Params {
    #[serde(rename = "cardId")]
    card_id: Option<String>,
}

pub async fn handle(State(pool): State<PgPool>, Query(params): Query<Params>) -> Response {
    let Some(card_id) = params.card_id.filter(|value| !value.trim().is_empty()) else {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error":"cardId is required."})),
        ).into_response();
    };
    let result = sqlx::query(
        "select observed_at, price_pkn, quantity from marketplace_price_observations where blueprint_id = $1 order by observed_at desc limit 500",
    )
    .bind(card_id.parse::<i64>().unwrap_or_default())
    .fetch_all(&pool)
    .await;
    match result {
        Ok(rows) => {
            use sqlx::Row;
            let rows = rows.into_iter().map(|row| serde_json::json!({
                "soldAt": row.try_get::<String, _>("observed_at").unwrap_or_default(),
                "pricePkn": row.try_get::<f64, _>("price_pkn").unwrap_or_default(),
                "quantity": row.try_get::<i64, _>("quantity").unwrap_or_default(),
            })).collect::<Vec<_>>();
            (axum::http::StatusCode::OK, axum::Json(serde_json::json!({
                "rows": rows,
                "series": [],
                "filters": {},
                "source": "cardtrader_removed_sale",
            }))).into_response()
        }
        Err(error) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({"error": error.to_string()})),
        ).into_response(),
    }
}
