use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
pub struct Metrics {
    pub requests: AtomicU64,
    pub valkey_hits: AtomicU64,
    pub valkey_misses: AtomicU64,
    pub sql_errors: AtomicU64,
}

impl Metrics {
    pub fn request(&self) {
        self.requests.fetch_add(1, Ordering::Relaxed);
    }
}

pub fn init_tracing() {
    tracing::info!("pokoin rust api tracing enabled");
}
