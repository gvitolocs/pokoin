//! Native Rust port of the Pokoin commerce backend.
//!
//! Owns the shared marketplace commerce surface: listings + inventory, stock
//! CSV, account carts, watchlist/recents/events, seller shop + settings,
//! addresses, shipping/checkout quotes, orders, Stripe Connect/checkout/webhook
//! and the PKN/wPKN/crypto wallet flows.
//!
//! Everything runs on native SQL (Postgres), Redis and direct HTTPS. There is
//! no Node process, no JavaScript engine and no shell-out at request time.
//!
//! The root API binary mounts this crate with:
//!
//! ```ignore
//! let state = pokoin_commerce::DomainState::from_env(pool);
//! let app = pokoin_commerce::router(state);
//! ```

pub mod auth;
/// The CardTrader boundary the integrations crate implements.
pub mod cardtrader;
pub mod cardtrader_adapter;
/// Native Bitcoin P2WPKH payout transactions (BIP143).
pub mod bitcoin;
pub mod config;
pub mod domain;
/// Resend transactional email (`_email.js`).
pub mod email;
pub mod error;
/// Native EVM RLP/EIP-155 transaction encoding and signing (payout paths).
pub mod evm;
/// Native Firestore client (OAuth, documents, queries, transactions) — public
/// reusable infrastructure for every Pokoin Rust service.
pub mod firestore;
/// Marketplace game scoping (Pokémon shared DB + satellite per-game DBs).
pub mod game;
pub mod handlers;
pub mod listing_live;
pub mod listing_sync;
pub mod ports;
/// In-memory set of card ids with a Sold-on-Pokoin row (native-sales fast path).
pub mod sales_index;
/// Redis read-through cache for public seller profile fields.
pub mod seller_cache;
pub mod state;
pub mod store;

pub use auth::{Claims, FirebaseVerifier, TokenVerifier};
pub use firestore::{FirestoreClient, FirestoreWrite, ServiceAccount, StructuredQuery};
pub use config::CommerceConfig;
pub use error::{ApiError, ApiResult};
pub use ports::{ChainClient, Clock, FixedClock, PriceOracle, StripeClient, SystemClock};
pub use state::DomainState;

use axum::routing::{get, post};
use axum::Router;

/// Every commerce route, ready to merge into the main API router.
///
/// `DomainState` is `Clone` (one `Arc` inside), so the same state can be shared
/// with the search/catalog routers via `Router::with_state`.
pub fn router(state: DomainState) -> Router {
    listing_sync::start(&state);
    Router::new()
        // listings + inventory + stock CSV
        .route(
            "/api/marketplace-listings",
            get(handlers::listings::marketplace_listings_get)
                .post(handlers::listings::marketplace_listings_post)
                .patch(handlers::listings::marketplace_listings_patch)
                .head(handlers::listings::marketplace_listings_other)
                .fallback(handlers::listings::marketplace_listings_other),
        )
        .route(
            "/api/marketplace-listings-csv",
            get(handlers::listings::marketplace_listings_csv_get)
                .post(handlers::listings::marketplace_listings_csv_post),
        )
        // cart + watchlist + recents + events
        .route("/api/marketplace-cart", post(handlers::cart::marketplace_cart))
        .route(
            "/api/marketplace-watchlist",
            post(handlers::cart::marketplace_watchlist),
        )
        .route(
            "/api/marketplace-cart-sync",
            get(handlers::cart::marketplace_cart_sync_get)
                .put(handlers::cart::marketplace_cart_sync_put)
                .options(cart_sync_options)
                .fallback(handlers::cart::cart_sync_method_not_allowed),
        )
        .route(
            "/api/marketplace-recents",
            get(handlers::cart::marketplace_recents_get)
                .put(handlers::cart::marketplace_recents_write)
                .post(handlers::cart::marketplace_recents_write)
                .options(recents_options),
        )
        .route(
            "/api/marketplace-event",
            post(handlers::cart::marketplace_event),
        )
        // seller shop + settings
        .route(
            "/api/marketplace-seller-shop",
            get(handlers::seller::marketplace_seller_shop),
        )
        .route(
            "/api/marketplace-seller-settings",
            get(handlers::seller::marketplace_seller_settings_get)
                .post(handlers::seller::marketplace_seller_settings_post),
        )
        // addresses + shipping
        .route(
            "/api/account-addresses",
            get(handlers::addresses::account_addresses_get)
                .post(handlers::addresses::account_addresses_post)
                .put(handlers::addresses::account_addresses_put)
                .delete(handlers::addresses::account_addresses_delete)
                .fallback(handlers::addresses::account_addresses_method_not_allowed),
        )
        .route(
            "/api/marketplace-shipping-options",
            get(handlers::addresses::marketplace_shipping_options),
        )
        .route(
            "/api/marketplace-checkout-quote",
            post(handlers::addresses::marketplace_checkout_quote),
        )
        // orders + sales
        .route(
            "/api/marketplace-orders",
            get(handlers::orders::marketplace_orders_get)
                .post(handlers::orders::marketplace_orders_post),
        )
        .route(
            "/api/marketplace-native-sales",
            get(handlers::orders::marketplace_native_sales),
        )
        // Stripe
        .route(
            "/api/stripe-connect-onboard",
            get(handlers::stripe::stripe_connect_onboard_get)
                .post(handlers::stripe::stripe_connect_onboard_post),
        )
        .route(
            "/api/create-order-checkout-session",
            post(handlers::orders::create_order_checkout_session),
        )
        .route(
            "/api/create-pkn-checkout-session",
            post(handlers::stripe::create_pkn_checkout_session),
        )
        .route(
            "/api/stripe-webhook",
            post(handlers::stripe::stripe_webhook).fallback(handlers::stripe::stripe_webhook_method_not_allowed),
        )
        // crypto + wPKN
        .route(
            "/api/crypto-pkn-purchase/{action}",
            get(handlers::crypto::crypto_pkn_purchase).post(handlers::crypto::crypto_pkn_purchase),
        )
        .route(
            "/api/crypto-pkn-sale/{action}",
            get(handlers::crypto::crypto_pkn_sale).post(handlers::crypto::crypto_pkn_sale),
        )
        .route(
            "/api/wpkn-exchange/{action}",
            get(handlers::crypto::wpkn_exchange).post(handlers::crypto::wpkn_exchange),
        )
        .route(
            "/api/wpkn-pkn-quote",
            get(handlers::crypto::wpkn_pkn_quote).post(handlers::crypto::wpkn_pkn_quote),
        )
        // PKN wallet
        .route(
            "/api/top-up-account-balance",
            post(handlers::wallet::top_up_account_balance),
        )
        .route(
            "/api/transfer-account-balance",
            post(handlers::wallet::transfer_account_balance),
        )
        .route(
            "/api/request-pkn-withdraw",
            post(handlers::wallet::request_pkn_withdraw),
        )
        .route("/api/unlock-silver", post(handlers::wallet::unlock_silver))
        .route(
            "/api/money-request",
            get(handlers::wallet::money_request_get).post(handlers::wallet::money_request_post),
        )
        .route(
            "/api/earn-pkn",
            post(handlers::wallet::earn_pkn).options(earn_pkn_options),
        )
        .with_state(state)
}

async fn cart_sync_options() -> axum::response::Response {
    handlers::cart::options_response("GET, PUT, OPTIONS")
}

async fn recents_options() -> axum::response::Response {
    handlers::cart::options_response("GET, PUT, POST, OPTIONS")
}

async fn earn_pkn_options() -> axum::response::Response {
    handlers::cart::options_response("POST, OPTIONS")
}

/// Convenience alias kept next to the router so the root agent can `use` it.
#[allow(dead_code)]
pub fn commerce_router(state: DomainState) -> Router {
    router(state)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::auth::AuthError;

    struct RejectAll;

    #[async_trait]
    impl TokenVerifier for RejectAll {
        async fn verify(&self, _token: &str) -> Result<Claims, AuthError> {
            Err(AuthError::Invalid("test verifier rejects".into()))
        }
    }

    fn state() -> DomainState {
        DomainState::lazy(
            CommerceConfig::default(),
            "postgres://127.0.0.1:1/none",
            Arc::new(RejectAll),
            Arc::new(FixedClock(1_700_000_000_000)),
        )
    }

    /// Pins the wPKN price so the quote handler reaches amount validation
    /// without the GeckoTerminal round trip (same as WPKN_USD_PRICE_OVERRIDE).
    fn state_with_prices() -> DomainState {
        let mut config = CommerceConfig::default();
        config.wpkn_usd_price_override = Some(0.006);
        config.crypto_pkn_usdt_price = Some(0.005);
        DomainState::lazy(
            config,
            "postgres://127.0.0.1:1/none",
            Arc::new(RejectAll),
            Arc::new(FixedClock(1_700_000_000_000)),
        )
    }

    #[tokio::test]
    async fn every_assigned_route_is_wired() {
        // A 404 means the route is missing; a 401/400/405 means the handler ran.
        let routes: &[(&str, &str)] = &[
            ("GET", "/api/marketplace-listings"),
            ("POST", "/api/marketplace-listings"),
            ("PATCH", "/api/marketplace-listings"),
            ("GET", "/api/marketplace-listings-csv"),
            ("POST", "/api/marketplace-listings-csv"),
            ("POST", "/api/marketplace-cart"),
            ("POST", "/api/marketplace-watchlist"),
            ("GET", "/api/marketplace-cart-sync"),
            ("PUT", "/api/marketplace-cart-sync"),
            ("OPTIONS", "/api/marketplace-cart-sync"),
            ("GET", "/api/marketplace-recents"),
            ("PUT", "/api/marketplace-recents"),
            ("POST", "/api/marketplace-recents"),
            ("OPTIONS", "/api/marketplace-recents"),
            ("POST", "/api/marketplace-event"),
            ("GET", "/api/marketplace-seller-shop"),
            ("GET", "/api/marketplace-seller-settings"),
            ("POST", "/api/marketplace-seller-settings"),
            ("GET", "/api/account-addresses"),
            ("POST", "/api/account-addresses"),
            ("PUT", "/api/account-addresses"),
            ("DELETE", "/api/account-addresses"),
            ("GET", "/api/marketplace-shipping-options"),
            ("POST", "/api/marketplace-checkout-quote"),
            ("GET", "/api/marketplace-orders"),
            ("POST", "/api/marketplace-orders"),
            ("GET", "/api/marketplace-native-sales"),
            ("GET", "/api/stripe-connect-onboard"),
            ("POST", "/api/stripe-connect-onboard"),
            ("POST", "/api/create-order-checkout-session"),
            ("POST", "/api/create-pkn-checkout-session"),
            ("POST", "/api/stripe-webhook"),
            ("GET", "/api/crypto-pkn-purchase/status"),
            ("POST", "/api/crypto-pkn-purchase/quote"),
            ("GET", "/api/crypto-pkn-sale/status"),
            ("POST", "/api/crypto-pkn-sale/quote"),
            ("GET", "/api/wpkn-exchange/status"),
            ("POST", "/api/wpkn-exchange/quote"),
            ("GET", "/api/wpkn-pkn-quote"),
            ("POST", "/api/wpkn-pkn-quote"),
            ("POST", "/api/top-up-account-balance"),
            ("POST", "/api/transfer-account-balance"),
            ("POST", "/api/request-pkn-withdraw"),
            ("POST", "/api/unlock-silver"),
            ("GET", "/api/money-request"),
            ("POST", "/api/money-request"),
            ("POST", "/api/earn-pkn"),
            ("OPTIONS", "/api/earn-pkn"),
        ];
        for (method, path) in routes {
            let request = Request::builder()
                .method(*method)
                .uri(*path)
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap();
            let response = router(state())
                .oneshot(request)
                .await
                .expect("router call");
            assert_ne!(
                response.status(),
                StatusCode::NOT_FOUND,
                "{method} {path} is not wired into the commerce router"
            );
        }
    }

    #[tokio::test]
    async fn unauthenticated_listings_read_requires_a_token_for_owner_reads() {
        let request = Request::builder()
            .method("GET")
            .uri("/api/marketplace-listings?sellerUid=someone")
            .body(Body::empty())
            .unwrap();
        let response = router(state()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn public_seller_shop_requires_a_username() {
        let request = Request::builder()
            .method("GET")
            .uri("/api/marketplace-seller-shop")
            .body(Body::empty())
            .unwrap();
        let response = router(state()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn newsletter_event_rejects_an_invalid_event_before_touching_the_database() {
        let request = Request::builder()
            .method("POST")
            .uri("/api/marketplace-event")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"cardId":0,"eventType":"nope"}"#))
            .unwrap();
        let response = router(state()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn earn_pkn_validates_the_form_before_queueing() {
        let request = Request::builder()
            .method("POST")
            .uri("/api/earn-pkn")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"name":"","email":"nope"}"#))
            .unwrap();
        let response = router(state()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn wpkn_quote_requires_a_valid_direction() {
        for body in [
            r#"{"direction":"sideways","amountIn":1000}"#,
            r#"{"direction":"pkn_to_wpkn","amountIn":0}"#,
            r#"{"direction":"pkn_to_wpkn","amountIn":1.5}"#,
        ] {
            let request = Request::builder()
                .method("POST")
                .uri("/api/wpkn-pkn-quote")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap();
            let response = router(state_with_prices()).oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{body}");
        }
    }

    #[tokio::test]
    async fn listings_csv_export_validates_the_format_before_auth_work() {
        let request = Request::builder()
            .method("GET")
            .uri("/api/marketplace-listings-csv?format=nope")
            .body(Body::empty())
            .unwrap();
        let response = router(state()).oneshot(request).await.unwrap();
        // The test verifier rejects every token, so auth wins first: 401.
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn error_body_shape_matches_the_node_contract() {
        let request = Request::builder()
            .method("POST")
            .uri("/api/marketplace-event")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"cardId":0,"eventType":"nope"}"#))
            .unwrap();
        let response = router(state()).oneshot(request).await.unwrap();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(payload.get("error").is_some());
    }
}
