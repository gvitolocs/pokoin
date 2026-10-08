use axum::{extract::{Query, State}, response::{IntoResponse, Response}};
use serde::Deserialize;
use sqlx::PgPool;

use crate::util::{clean_card_id, RouteError};

#[derive(Deserialize)]
pub struct Params {
    #[serde(rename = "cardId")]
    card_id: String,
}

pub async fn handle(State(pool): State<PgPool>, Query(params): Query<Params>) -> Response {
    let Some(card_id) = clean_card_id(&params.card_id) else {
        return (axum::http::StatusCode::BAD_REQUEST, axum::Json(serde_json::json!({"error":"cardId is required."}))).into_response();
    };
    let result = sqlx::query(
        "select day, median_pkn, min_pkn, max_pkn, sold_qty, listings from cardtrader_sold_daily where card_id = $1 order by day"
    )
    .bind(card_id)
    .fetch_all(&pool)
    .await;
    match result {
        Ok(rows) => {
            use sqlx::Row;
            let rows = rows.into_iter().map(|row| serde_json::json!({
                "day": row.try_get::<String, _>("day").unwrap_or_default(),
                "medianPkn": row.try_get::<f64, _>("median_pkn").unwrap_or_default(),
                "minPkn": row.try_get::<f64, _>("min_pkn").unwrap_or_default(),
                "maxPkn": row.try_get::<f64, _>("max_pkn").unwrap_or_default(),
                "soldQty": row.try_get::<i64, _>("sold_qty").unwrap_or_default(),
                "listings": row.try_get::<i64, _>("listings").unwrap_or_default(),
            })).collect::<Vec<_>>();
            (axum::http::StatusCode::OK, axum::Json(serde_json::json!({"cardId":card_id,"rows":rows}))).into_response()
        }
        Err(error) => RouteError::from(error).into_response(),
    }
}
