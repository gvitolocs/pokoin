//! Native operator/debug and analytics endpoints.
//!
//! Reference: the live Node handlers snapshot in ~/.local/share/rust-port-ref/live-node-ref/api.

pub mod debug;
pub mod analytics;

use pokoin_api_common::RouteState;

/// Every route of this crate; paths carry the full `/api/...` prefix.
pub fn router(state: RouteState) -> axum::Router {
    axum::Router::new()
        .merge(debug::routes())
        .merge(analytics::routes())
        .with_state(state)
}
