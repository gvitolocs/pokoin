//! What the box can ask a Seller Portal to do.
//!
//! `FakePortal` is in memory and is what the worker tests drive. `BrowserPortal`
//! drives Chrome. `csv` is still not built.
use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;

use crate::ListingTarget;

#[derive(Debug, Clone)]
pub struct PortalWrite {
    pub external_id: String,
    /// False when the portal already showed this quantity or price, so nothing was typed.
    pub changed: bool,
}

/// Transient retries, permanent fails the job, signed-out and blocked wait
/// without spending an attempt.
#[derive(Debug, Clone)]
pub enum PortalError {
    Transient(String),
    Permanent(String),
    SignedOut,
    Blocked(String),
}

impl std::fmt::Display for PortalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transient(message) | Self::Permanent(message) => write!(f, "{message}"),
            Self::SignedOut => write!(f, "signed out"),
            Self::Blocked(reason) => write!(f, "blocked: {reason}"),
        }
    }
}

impl std::error::Error for PortalError {}

#[async_trait]
pub trait Portal: Send + Sync {
    async fn signed_in(&self) -> Result<bool, PortalError>;
    async fn set_listing(&self, target: &ListingTarget) -> Result<PortalWrite, PortalError>;
    async fn set_quantity(&self, target: &ListingTarget) -> Result<PortalWrite, PortalError>;
    async fn set_price(&self, target: &ListingTarget) -> Result<PortalWrite, PortalError>;
    async fn fetch_orders(&self, since: Option<&str>) -> Result<Vec<Value>, PortalError>;
}

struct FakeState {
    signed_in: bool,
    sign_in_block: Option<String>,
    next_error: Option<PortalError>,
    orders: Vec<Value>,
    writes: Vec<String>,
    listings: HashMap<String, String>,
}

/// In-memory portal. `--portal fake` and the worker tests.
pub struct FakePortal {
    inner: Mutex<FakeState>,
}

impl FakePortal {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(FakeState {
                signed_in: true,
                sign_in_block: None,
                next_error: None,
                orders: Vec::new(),
                writes: Vec::new(),
                listings: HashMap::new(),
            }),
        }
    }

    pub fn set_signed_in(&self, signed_in: bool) {
        self.inner.lock().expect("portal").signed_in = signed_in;
    }

    pub fn block_sign_in(&self, reason: impl Into<String>) {
        self.inner.lock().expect("portal").sign_in_block = Some(reason.into());
    }

    pub fn clear_sign_in_block(&self) {
        self.inner.lock().expect("portal").sign_in_block = None;
    }

    pub fn fail_next(&self, error: PortalError) {
        self.inner.lock().expect("portal").next_error = Some(error);
    }

    pub fn set_orders(&self, orders: Vec<Value>) {
        self.inner.lock().expect("portal").orders = orders;
    }

    pub fn writes(&self) -> Vec<String> {
        self.inner.lock().expect("portal").writes.clone()
    }

    fn take_error(&self) -> Option<PortalError> {
        self.inner.lock().expect("portal").next_error.take()
    }
}

impl Default for FakePortal {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Portal for FakePortal {
    async fn signed_in(&self) -> Result<bool, PortalError> {
        let guard = self.inner.lock().expect("portal");
        if let Some(reason) = guard.sign_in_block.clone() {
            return Err(PortalError::Blocked(reason));
        }
        Ok(guard.signed_in)
    }

    async fn set_listing(&self, target: &ListingTarget) -> Result<PortalWrite, PortalError> {
        if let Some(error) = self.take_error() {
            return Err(error);
        }
        let external_id = if target.external_id.is_empty() {
            format!("fake-{}", target.listing_id)
        } else {
            target.external_id.clone()
        };
        let mut guard = self.inner.lock().expect("portal");
        guard.listings.insert(target.listing_id.clone(), external_id.clone());
        guard.writes.push(format!("listing:{external_id}"));
        Ok(PortalWrite { external_id, changed: true })
    }

    async fn set_quantity(&self, target: &ListingTarget) -> Result<PortalWrite, PortalError> {
        if let Some(error) = self.take_error() {
            return Err(error);
        }
        let external_id = target.external_id.clone();
        self.inner.lock().expect("portal").writes.push(format!("qty:{external_id}:{}", target.quantity));
        Ok(PortalWrite { external_id, changed: true })
    }

    async fn set_price(&self, target: &ListingTarget) -> Result<PortalWrite, PortalError> {
        if let Some(error) = self.take_error() {
            return Err(error);
        }
        let external_id = target.external_id.clone();
        self.inner
            .lock()
            .expect("portal")
            .writes
            .push(format!("price:{external_id}:{:?}", target.price_cents));
        Ok(PortalWrite { external_id, changed: true })
    }

    async fn fetch_orders(&self, _since: Option<&str>) -> Result<Vec<Value>, PortalError> {
        if let Some(error) = self.take_error() {
            return Err(error);
        }
        Ok(self.inner.lock().expect("portal").orders.clone())
    }
}

pub fn csv_portal() -> anyhow::Result<Box<dyn Portal>> {
    anyhow::bail!("csv portal not built yet")
}

pub async fn open_portal(kind: &str, options: crate::browser::LaunchOptions) -> anyhow::Result<Box<dyn Portal>> {
    match kind {
        "fake" => Ok(Box::new(FakePortal::new())),
        "browser" => {
            let portal = crate::browser::BrowserPortal::launch(options).await?;
            Ok(Box::new(portal))
        }
        "csv" => csv_portal(),
        other => anyhow::bail!("unknown portal {other}"),
    }
}
