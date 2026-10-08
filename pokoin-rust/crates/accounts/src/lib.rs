//! Native Rust Pokoin accounts domain.
//!
//! This crate is the native replacement for the Node handlers that own
//! accounts, identity, wallets, the forum, the collection/portfolio BFFs and
//! news comments. It talks to Firebase, Firestore, Supabase PostgREST and
//! Cloudflare R2 directly over HTTPS: no Node process, no JS engine, no
//! Rust-to-Node fallback.
//!
//! # Wiring it up
//!
//! ```no_run
//! # async fn run() {
//! let state = pokoin_accounts::DomainState::from_env();
//! let app: axum::Router = pokoin_accounts::router(state);
//! // merge `app` next to the other domain routers
//! # }
//! ```
//!
//! [`DomainState::from_env`] never panics. When the Firebase service account is
//! absent, exactly the routes that need it answer a truthful
//! `500 Firestore is not configured.` — they never fake success.
//!
//! # Reusable infrastructure
//!
//! [`firebase`], [`firestore`] and [`identity`] are public and self-contained so
//! other domains (commerce, scan, listings) can share one implementation
//! instead of forking their own:
//!
//! * [`firebase::TokenVerifier`] / [`firebase::FirebaseVerifier`] — RS256 ID
//!   token verification against the cached Google JWKS, plus the
//!   `pok_email_verified` password gate.
//! * [`firebase::ServiceAccount`] — cached OAuth 2.0 access tokens and Firebase
//!   custom-token minting.
//! * [`firestore::Firestore`] — typed values, document CRUD, structured queries
//!   and transactions with `ABORTED` retries.
//! * [`identity::FirebaseAuth`] — Identity Toolkit user administration.
//! * [`domain::collection`] — the single source of truth for collection
//!   ownership, reused by the scan/listing workers.

pub mod config;
pub mod domain;
pub mod email;
pub mod error;
pub mod firebase;
pub mod firestore;
pub mod handlers;
pub mod http;
pub mod identity;
pub mod r2;
pub mod rate_limit;
pub mod sql;
pub mod state;
pub mod supabase;
pub mod username;

pub use config::AccountsConfig;
pub use error::{ApiError, Result};
pub use firebase::{Claims, FirebaseVerifier, TokenVerifier};
pub use firestore::{DocData, Document, DocumentRef, FieldValue, Firestore, Query, Value};
pub use state::{Clock, DomainState};

use axum::routing::{get, post};
use axum::Router;

/// `(method, path)` pairs this crate implements natively today.
pub const PORTED_ROUTES: &[&str] = &[
    "POST /api/auth-login",
    "POST /api/ensure-username",
    "POST /api/signup-notification",
    "POST /api/register-email",
    "POST /api/verify-email-signup",
    "POST /api/wallet-auth/nonce",
    "POST /api/wallet-auth/verify",
    "POST /api/wallet-link",
    "POST /api/wallet-link/session",
    "POST /api/wallet-link/complete",
    "GET /api/forum",
    "POST /api/forum-create-topic",
    "POST /api/forum-create-post",
    "POST /api/forum-upload-media",
    "GET /api/marketplace-collection",
    "POST /api/marketplace-collection",
    "GET /api/marketplace-collection-summary",
    "GET /api/news-comments",
    "POST /api/news-comments",
    "GET /api/search-recipient-emails",
    "POST /api/search-recipient-emails",
    "GET /api/user-current-page",
    "POST /api/user-current-page",
    "GET /api/marketplace-associate-suggest",
    "GET /api/marketplace-associate",
    "GET /api/marketplace-portfolio-history",
    "GET /api/marketplace-portfolio",
    "GET /api/marketplace-referral",
    "POST /api/marketplace-referral",
    "POST /api/poko-connect",
    "POST /api/poko-personal-context",
    "POST /api/poko-bets",
    "GET /api/poko-chat",
    "POST /api/poko-chat",
    "GET /api/chat",
    "POST /api/chat",
    "GET /api/pokoin-partner",
    "POST /api/pokoin-partner",
];

/// `(method, path)` pairs assigned to this worker that are **not** implemented
/// yet. They are deliberately not mounted, so a request 404s instead of hitting
/// a stub that would look like a success. See `accounts-coverage.json`.
pub const UNPORTED_ROUTES: &[&str] = &[
    "POST /api/poko-market",
];

/// Routes owned by another worker (photos/R2/social/assistant). Listed so the
/// split is explicit and asserted, rather than silently dropped.
pub const EXTERNAL_ROUTES: &[&str] = &[
    "GET /api/user-photos/:kind/:uid/:file",
    "POST /api/upload-profile-picture",
    "POST /api/remove-profile-picture",
    "POST /api/cache-google-profile-picture",
    "POST /api/social-autopost",
    "GET /api/social-autopost/hot-card",
    "POST /api/social-autopost/hot-card",
    "POST /api/social-post-agent",
    "POST /api/pokoin-assistant",
];

/// The accounts router.
///
/// Mount it with `Router::merge` or `Router::nest`; the paths inside already
/// carry the `/api/...` prefix, matching the live route manifest.
pub fn router(state: DomainState) -> Router {
    Router::new()
        .route(
            "/api/auth-login",
            post(handlers::auth::auth_login).options(handlers::preflight),
        )
        .route(
            "/api/ensure-username",
            post(handlers::auth::ensure_username),
        )
        .route(
            "/api/signup-notification",
            post(handlers::auth::signup_notification),
        )
        .route(
            "/api/register-email",
            post(handlers::auth::register_email).options(handlers::preflight),
        )
        .route(
            "/api/verify-email-signup",
            post(handlers::auth::verify_email_signup).options(handlers::preflight),
        )
        .route(
            "/api/wallet-auth/nonce",
            post(handlers::wallet::wallet_auth_nonce).options(handlers::preflight),
        )
        .route(
            "/api/wallet-auth/verify",
            post(handlers::wallet::wallet_auth_verify).options(handlers::preflight),
        )
        .route("/api/wallet-link", post(handlers::wallet::wallet_link))
        .route(
            "/api/wallet-link/session",
            post(handlers::wallet::wallet_link_session),
        )
        .route(
            "/api/wallet-link/complete",
            post(handlers::wallet::wallet_link_complete),
        )
        .route("/api/forum", get(handlers::forum::forum))
        .route(
            "/api/forum-create-topic",
            post(handlers::forum::forum_create_topic),
        )
        .route(
            "/api/forum-create-post",
            post(handlers::forum::forum_create_post),
        )
        .route(
            "/api/forum-upload-media",
            post(handlers::forum::forum_upload_media),
        )
        .route(
            "/api/marketplace-collection",
            get(handlers::collection::marketplace_collection_get)
                .post(handlers::collection::marketplace_collection),
        )
        .route(
            "/api/marketplace-collection-summary",
            get(handlers::collection::marketplace_collection_summary),
        )
        .route(
            "/api/news-comments",
            get(handlers::news::news_comments).post(handlers::news::news_comments_create),
        )
        .route(
            "/api/search-recipient-emails",
            get(handlers::user::search_recipient_emails_get)
                .post(handlers::user::search_recipient_emails_post),
        )
        .route(
            "/api/user-current-page",
            get(handlers::user::user_current_page).post(handlers::user::user_current_page),
        )
        .route(
            "/api/marketplace-associate-suggest",
            get(handlers::associate::marketplace_associate_suggest)
                .options(handlers::preflight),
        )
        .route(
            "/api/marketplace-portfolio",
            get(handlers::portfolio::marketplace_portfolio)
                .options(handlers::portfolio::marketplace_portfolio)
                .fallback(handlers::portfolio::portfolio_other),
        )
        .route(
            "/api/marketplace-portfolio-history",
            get(handlers::portfolio::marketplace_portfolio_history)
                .fallback(handlers::portfolio::portfolio_history_other),
        )
        .route(
            "/api/marketplace-associate",
            get(handlers::associate::marketplace_associate)
                .options(handlers::associate::marketplace_associate_preflight)
                .fallback(handlers::associate::marketplace_associate_other),
        )
        .route(
            "/api/marketplace-referral",
            get(handlers::referral::marketplace_referral)
                .post(handlers::referral::marketplace_referral)
                .options(handlers::referral::marketplace_referral_options),
        )
        .route(
            "/api/poko-connect",
            post(handlers::poko::poko_connect).fallback(handlers::poko::poko_connect_other),
        )
        .route(
            "/api/poko-chat",
            get(handlers::poko_chat::poko_chat)
                .post(handlers::poko_chat::poko_chat)
                .fallback(handlers::poko_chat::poko_chat_other),
        )
        .route(
            "/api/poko-bets",
            post(handlers::poko_bets::poko_bets)
                .fallback(handlers::poko_bets::poko_bets_other),
        )
        .route(
            "/api/poko-personal-context",
            post(handlers::poko::poko_personal_context)
                .fallback(handlers::poko::poko_connect_other),
        )
        .route(
            "/api/chat",
            get(handlers::chat::chat).post(handlers::chat::chat),
        )
        .route(
            "/api/pokoin-partner",
            get(handlers::partner::pokoin_partner)
                .post(handlers::partner::pokoin_partner)
                .fallback(handlers::partner::pokoin_partner_other),
        )
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_route_ledgers_are_disjoint() {
        let all: Vec<&str> = PORTED_ROUTES
            .iter()
            .chain(UNPORTED_ROUTES.iter())
            .chain(EXTERNAL_ROUTES.iter())
            .copied()
            .collect();
        let unique: std::collections::HashSet<&str> = all.iter().copied().collect();
        assert_eq!(all.len(), unique.len(), "a route is listed twice: {all:?}");
    }

    #[test]
    fn every_assigned_route_is_accounted_for() {
        // 23 ported + 16 unported = the 39 (method, path) pairs assigned to this
        // worker; 9 more belong to the external photos/R2/social assistant worker.
        assert_eq!(PORTED_ROUTES.len(), 38);
        assert_eq!(UNPORTED_ROUTES.len(), 1);
        assert_eq!(EXTERNAL_ROUTES.len(), 9);
    }

    #[test]
    fn router_builds_without_credentials() {
        // Construction must not panic even with no Firebase configuration, and
        // must not require a running service.
        let state = DomainState::default();
        let _app = router(state);
    }
}
