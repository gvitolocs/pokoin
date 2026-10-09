//! Page BFF routes (ports of the live `marketplace-*-page` / rails /
//! version-set / sales-pulse handlers). One file per route; `routes()`
//! registers them with the exact production paths.

use axum::routing::{any, get};
use axum::Router;
use pokoin_api_common::RouteState;

pub mod expansion_page;
pub mod home_page;
pub mod rails;
pub mod sales_pulse;
mod support;
pub mod version_set;

#[cfg(test)]
mod tests;

/// Routes owned by this module (paths carry the full `/api/...` prefix).
pub fn routes() -> Router<RouteState> {
    Router::new()
        .route(
            "/api/marketplace-expansion-page",
            get(expansion_page::handler)
                .options(preflight)
                .fallback(expansion_page::method_not_allowed),
        )
        // `any()` + in-handler dispatch: the reference 405 carries no Allow.
        .route("/api/marketplace-version-set", any(version_set::handler))
        .route(
            "/api/marketplace-rails",
            get(rails::handler)
                .options(preflight)
                .fallback(rails::method_not_allowed),
        )
        .route(
            "/api/marketplace-home-page",
            get(home_page::handler)
                .options(preflight)
                .fallback(home_page::method_not_allowed),
        )
        .route(
            "/api/marketplace-sales-pulse",
            get(sales_pulse::handler)
                .options(preflight)
                .fallback(sales_pulse::method_not_allowed),
        )
}

/// `OPTIONS` preflight: `setCorsHeaders` + 204, exactly like every handler.
async fn preflight() -> axum::response::Response {
    pokoin_api_common::http::read_preflight()
}
