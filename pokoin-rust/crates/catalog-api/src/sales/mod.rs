//! Card sale/price routes (ports of `marketplace-card-sales.js`,
//! `marketplace-card-last-median.js`, `marketplace-card-cheapest-price.js`,
//! `marketplace-card-price-history.js` + `_card_price_history.js`,
//! `marketplace-tcgplayer-history.js` + `_tcgcsv_prices.js`).

use axum::routing::any;
use axum::Router;
use pokoin_api_common::RouteState;

pub mod core;
pub mod routes;
pub mod tcgcsv;

pub fn routes() -> Router<RouteState> {
    Router::new()
        .route("/api/marketplace-card-sales", any(routes::card_sales))
        .route("/api/marketplace-card-last-median", any(routes::card_last_median))
        .route("/api/marketplace-card-cheapest-price", any(routes::card_cheapest_price))
        .route("/api/marketplace-card-price-history", any(routes::card_price_history))
        .route("/api/marketplace-tcgplayer-history", any(routes::tcgplayer_history))
}
