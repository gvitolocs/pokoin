//! Native Rust port of the Pokoin external-integrations API domain.
//!
//! Scope: CardTrader and Power Tools seller integrations, inventory reconcile,
//! CardTrader order webhooks and Zero picking lists, the `/api/scan/*`
//! recognition proxies, the private R2 user-photo proxy, and system routes
//! (edge client country, currency quote). No Node runtime, no subprocesses and
//! no JS engine: SQL, Redis, REST, HMAC/AES and SigV4 are native.
//!
//! Integration contract (see `HANDOFF.txt`): the root worker adds
//! `crates/external` to the workspace, removes the crate-local `[workspace]`
//! block in `Cargo.toml`, builds a [`state::DomainState`] and mounts
//! [`router`].
//!
//! Paths whose maintained Node handler is not ported yet answer `501` with
//! `code: "not_implemented"` and are listed in `external-coverage.json`; they
//! never return a fake success.

pub mod crypto;
pub mod db;
pub mod error;
pub mod firebase;
pub mod geo;
pub mod powertools;
pub mod price_check;
pub mod pricing;
pub mod r2;
pub mod redis;
pub mod redirects;
pub mod routes;
pub mod scan;
pub mod scan_connect;
pub mod scan_store;
pub mod social;
pub mod state;
pub mod supabase;
pub mod time_util;

pub mod cardtrader_listings;
pub mod cardtrader_live;

pub mod cardtrader {
    pub mod async_sync;
    pub mod client;
    pub mod integration;
    pub mod push;
    pub mod sync;
    pub mod sync_core;
    pub mod webhook;
    pub mod zero;
}

pub use error::{ApiError, ApiResult};
pub use routes::router;
pub use state::{DomainConfig, DomainState};

pub mod cardmarket;
