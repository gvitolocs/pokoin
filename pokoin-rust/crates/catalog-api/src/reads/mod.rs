//! Catalog read routes (ports of the live `api/*.js` read handlers). One file per
//! route; each handler answers its own 405 like the Node handler (`Allow` +
//! `{"error":"Method not allowed."}`), so routes are mounted with `any()`.

use axum::routing::any;
use axum::Router;
use pokoin_api_common::RouteState;

pub mod artist_cards;
pub mod blueprint_price;
pub mod card_seo;
pub mod card_shortlink;
pub mod card_url;
pub mod card_versions;
pub mod deck_lookup;
pub mod dictionary;
pub mod expansions;
pub mod home;
pub mod hot_blueprints;
pub mod limitless;
pub mod util;

/// Routes owned by this module (paths carry the full `/api/...` prefix).
pub fn routes() -> Router<RouteState> {
    Router::new()
        .route("/api/dictionary", any(dictionary::handler))
        .route("/api/marketplace-expansions", any(expansions::handler))
        .route("/api/marketplace-card-versions", any(card_versions::handler))
        .route("/api/marketplace-card-url", any(card_url::handler))
        .route("/api/marketplace-card-shortlink", any(card_shortlink::handler))
        .route("/api/marketplace-card-seo", any(card_seo::handler))
        .route("/api/limitless-expansion-blueprints", any(limitless::handler))
        .route("/api/marketplace-blueprint-price", any(blueprint_price::handler))
        .route("/api/marketplace-hot-blueprints", any(hot_blueprints::handler))
        .route("/api/deck-card-version-lookup", any(deck_lookup::handler))
        .route("/api/marketplace-artist-cards", any(artist_cards::handler))
        .route("/api/marketplace-home", any(home::handler))
}
