//! Native Rust read handlers for three Pokoin catalog routes.
//!
//! Contract parity is with the deployed Node references (read-only) under
//! `.reference-node/api/`:
//!   - `marketplace-card-sales.js`          -> `sales`     (CardTrader historical sold graph)
//!   - `marketplace-card-cheapest-price.js`  -> `cheapest`
//!   - `marketplace-card-price-history.js`   -> `price_history`
//!
//! No Node runtime, no proxy, no JS engine: plain Axum + sqlx against the
//! shared replica `PgPool`.

pub mod cheapest;
pub mod price_history;
pub mod sales;
pub mod util;

use axum::{http::{header, HeaderValue, StatusCode}, response::{IntoResponse, Response}, routing::get, Router};
use sqlx::PgPool;

/// Axum router exposing the three catalog routes.
pub fn router(pool: PgPool) -> Router {
    Router::new()
        .route("/api/marketplace-card-sales", get(sales::handle))
        .route(
            "/api/marketplace-card-cheapest-price",
            get(cheapest::handle).options(options),
        )
        .route(
            "/api/marketplace-card-price-history",
            get(price_history::handle).options(options),
        )
        .with_state(pool)
}

async fn options() -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, OPTIONS"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type, Authorization"),
    );
    response
}
