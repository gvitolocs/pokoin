//! Market reads: competitive meta, personal recommendations, the live
//! listing stream and the CardTrader deal scan.

pub mod common;
pub mod competitive;
pub mod competitive_sql;
pub mod deal_scan;
pub mod live;
pub mod recommend;
pub mod recommendations;

use axum::routing::any;
use axum::Router;
use pokoin_api_common::RouteState;

/// Routes owned by this module (every method reaches the handler like Node).
pub fn routes() -> Router<RouteState> {
    Router::new()
        .route("/api/marketplace-competitive", any(competitive::handler))
        .route("/api/marketplace-recommendations", any(recommendations::handler))
        .route("/api/marketplace-live", any(live::handler))
        .route("/api/cardtrader-deal-scan", any(deal_scan::handler))
}
