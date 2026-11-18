//! Chromium Seller Portal. Chrome stays on this machine; the tests never open a live shop.
mod cdp;
mod config;
mod guard;
mod launch;
mod portal;

pub use config::PortalConfig;
pub use launch::{find_chrome, LaunchOptions, ACTION_GAP_MS};
pub use portal::BrowserPortal;
