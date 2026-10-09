//! Native public edge (api.pokoin.com origin) and disk CDN (cdn.pokoin.com origin)
//! for the Pi — ports of `pokoin-api-edge.js` and `pokoin-pi-cdn-server.js`.

pub mod cdn;
pub mod edge;

pub use cdn::{cdn_router, Cdn, CdnConfig};
pub use edge::{edge_router, EdgeConfig};
