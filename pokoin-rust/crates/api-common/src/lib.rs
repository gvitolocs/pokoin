//! Shared runtime for native Pokoin API route crates.
//!
//! `ApiState` owns the lazily connected Postgres pools (replica read, writer),
//! a shared Redis connection and per-game catalog pools. `http` mirrors the
//! request/response conventions of the retired Node runtime
//! (`server/oracle-api-server.js`): query maps, body decoding, JSON responses.
//! `public_error` is the port of `api/_public_error.js`.

pub mod game;
pub mod http;
pub mod limits;
pub mod public_error;
pub mod route_state;
pub mod security;
pub mod state;

pub use route_state::RouteState;
pub use state::ApiState;
