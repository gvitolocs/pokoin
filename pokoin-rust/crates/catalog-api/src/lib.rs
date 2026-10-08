//! Native catalog read BFFs (ports of the api/marketplace-* read handlers).
//!
//! Reference: the live Node handlers snapshot in ~/.local/share/rust-port-ref/live-node-ref/api.

pub mod shared;
pub mod pages;
pub mod reads;
pub mod market;

use pokoin_api_common::RouteState;

/// Every route of this crate; paths carry the full `/api/...` prefix.
pub fn router(state: RouteState) -> axum::Router {
    axum::Router::new()
        .merge(pages::routes())
        .merge(reads::routes())
        .merge(market::routes())
        .with_state(state)
}
