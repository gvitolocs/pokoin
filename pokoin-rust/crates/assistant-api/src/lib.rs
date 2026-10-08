//! Native assistant endpoints (pokoin-assistant, trainingai-card-classify).
//!
//! Reference: the live Node handlers snapshot in ~/.local/share/rust-port-ref/live-node-ref/api.

pub mod assistant;

use pokoin_api_common::RouteState;

/// Every route of this crate; paths carry the full `/api/...` prefix.
pub fn router(state: RouteState) -> axum::Router {
    axum::Router::new()
        .merge(assistant::routes())
        .with_state(state)
}
