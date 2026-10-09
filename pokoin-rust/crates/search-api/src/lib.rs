//! Native search endpoints (autocomplete, search candidates, searchbar, extension search).
//!
//! Reference: the live Node handlers snapshot in ~/.local/share/rust-port-ref/live-node-ref/api.

pub mod autocomplete;
pub mod lookup;

use pokoin_api_common::RouteState;

/// Every route of this crate; paths carry the full `/api/...` prefix.
pub fn router(state: RouteState) -> axum::Router {
    axum::Router::new()
        .merge(autocomplete::routes())
        .merge(lookup::routes())
        .with_state(state)
}
