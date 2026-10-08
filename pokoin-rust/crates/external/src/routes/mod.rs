//! HTTP surface for the external-integrations domain.
//!
//! `router(state)` returns an `axum::Router` the root API mounts. Paths are
//! the public Pokoin paths (`/api/...`) so the router can be nested at `/`.

use axum::routing::{get, post};
use axum::Router;

use crate::state::DomainState;

pub mod cardtrader;
pub mod media;
pub mod powertools;
pub mod redirects;
pub mod scan;
pub mod social;
pub mod system;
pub mod util;

/// Build the domain router. State is injected once here.
pub fn router(state: DomainState) -> Router {
    Router::new()
        // CardTrader integration + inventory sync.
        .route("/api/cardtrader-connect", post(cardtrader::connect).delete(cardtrader::disconnect))
        .route("/api/cardtrader-status", get(cardtrader::status))
        .route("/api/cardtrader-disconnect", post(cardtrader::disconnect))
        .route("/api/cardtrader-import-dry-run", post(cardtrader::import_dry_run))
        .route("/api/cardtrader-sync", get(cardtrader::sync_status).post(cardtrader::sync_start))
        .route("/api/cardtrader-assets", get(cardtrader::assets))
        .route("/api/cardtrader-zero", get(cardtrader::zero))
        .route("/api/cardtrader-clean-listings", post(cardtrader::clean_listings))
        .route("/api/cardtrader-webhook/{uid}", post(cardtrader::webhook))
        .route("/api/cardtrader-blueprint-listings", get(cardtrader::blueprint_listings))
        .route("/api/cardtrader-live-listings", get(cardtrader::live_listings))
        .route(
            "/api/cardtrader-daily-listings-refresh",
            get(cardtrader::daily_refresh).post(cardtrader::daily_refresh),
        )
        .route(
            "/api/cardtrader-game-ingest",
            get(cardtrader::game_ingest).post(cardtrader::game_ingest),
        )
        // Power Tools session + pricer.
        .route(
            "/api/powertools-connect",
            get(powertools::status).post(powertools::connect).delete(powertools::disconnect),
        )
        .route(
            "/api/marketplace-pricing-strategies",
            get(powertools::strategies_get)
                .post(powertools::strategies_post)
                .delete(powertools::strategies_delete),
        )
        .route("/api/marketplace-price-check", get(powertools::price_check))
        // Recognition proxies.
        .route(
            "/api/scan/identify",
            post(scan::identify).options(scan::preflight),
        )
        .route(
            "/api/scan/identify-album",
            post(scan::identify_album).options(scan::preflight),
        )
        .route("/api/scan/print", get(scan::print).options(scan::preflight))
        .route("/api/scan/catalogs", get(scan::catalogs).options(scan::preflight))
        .route("/api/scan/health", get(scan::health).options(scan::preflight))
        // Scan Connect (unresolved: see external-coverage.json).
        .route(
            "/api/scan-batch",
            get(scan::batch).post(scan::batch).options(scan::preflight),
        )
        .route("/api/scan-pair", post(scan::pair).options(scan::preflight))
        .route("/api/scan-phone", post(scan::phone).options(scan::preflight))
        .route(
            "/api/scan-session",
            get(scan::session).post(scan::session).options(scan::preflight),
        )
        .route("/api/scan-stream", get(scan::stream).options(scan::preflight))
        // R2 media.
        .route("/api/user-photos/{kind}/{uid}/{file}", get(media::user_photos))
        .route(
            "/api/upload-profile-picture",
            post(media::upload_profile_picture),
        )
        .route(
            "/api/remove-profile-picture",
            post(media::remove_profile_picture),
        )
        .route(
            "/api/cache-google-profile-picture",
            post(media::cache_google_profile_picture),
        )
        // Outbound marketplace redirects.
        .route("/api/cardtrader-redirect", get(redirects::cardtrader))
        .route("/api/tcgplayer-redirect", get(redirects::tcgplayer))
        .route("/api/cardmarket-redirect", get(redirects::cardmarket))
        // Social autoposter (external-owned; live sends need provider env).
        .route(
            "/api/social-autopost",
            post(social::autopost).options(social::preflight),
        )
        .route(
            "/api/social-autopost/hot-card",
            get(social::hot_card).post(social::hot_card).options(social::preflight),
        )
        .route(
            "/api/social-post-agent",
            post(social::post_agent).options(social::preflight),
        )
        // System.
        .route("/api/client-country", get(system::client_country))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn router_builds_with_domain_state() {
        // Route table construction must not panic and must be reusable.
        let _ = router(DomainState::for_test());
        let _ = router(DomainState::for_test());
    }
}
