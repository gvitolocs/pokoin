//! Search lookups around the autocomplete engine: artist suggestions, the
//! searchbar wrappers, search candidates, extension search, the search-page
//! card grid and token prediction.

pub mod artist_suggestions;
pub mod extension_card_search;
pub mod marketplace_cards;
pub mod search_candidates;
pub mod searchbar;
pub mod token_predict;

use axum::routing::any;
use axum::Router;
use pokoin_api_common::RouteState;

/// Routes owned by this module (every method reaches the handler like Node).
pub fn routes() -> Router<RouteState> {
    Router::new()
        .route("/api/marketplace-artist-suggestions", any(artist_suggestions::handler))
        .route("/api/searchbar-cancel", any(searchbar::cancel))
        .route("/api/searchbar-cards", any(searchbar::cards))
        .route("/api/marketplace-search-candidates", any(search_candidates::handler))
        .route("/api/extension-card-search", any(extension_card_search::handler))
        .route("/api/marketplace-cards", any(marketplace_cards::handler))
        .route("/api/searchbar-token-predict", any(token_predict::handler))
}
