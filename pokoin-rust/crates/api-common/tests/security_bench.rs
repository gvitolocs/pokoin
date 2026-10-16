//! Per-request cost of the security layer on a hot read route (no route limit
//! applies). Ignored by default; run in release to compare two commits:
//!
//! ```text
//! cargo test --release -p pokoin-api-common --test security_bench -- --ignored --nocapture
//! ```

use std::time::Instant;

use axum::body::Body;
use axum::http::Request;
use axum::routing::get;
use axum::Router;
use pokoin_api_common::{security::security_layer, state::lazy_pool, ApiState};
use tower::ServiceExt;

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore]
async fn security_layer_hot_read_overhead() {
    // Lazy pools never connect: the hot path must not touch Postgres or Redis.
    let pool = lazy_pool("postgres://bench@127.0.0.1:1/bench", 1).unwrap();
    let api = ApiState::new(pool.clone(), pool, None, 1);
    let app = Router::new()
        .route("/api/marketplace-search-page", get(|| async { "ok" }))
        .layer(axum::middleware::from_fn(move |req, next| {
            let api = api.clone();
            async move { security_layer(api, req, next).await }
        }));
    let request = || {
        Request::builder()
            .uri("/api/marketplace-search-page?q=pikachu")
            .header("x-forwarded-for", "203.0.113.9")
            .header("origin", "https://pokoin.com")
            .body(Body::empty())
            .unwrap()
    };
    for _ in 0..20_000 {
        let _ = app.clone().oneshot(request()).await.unwrap();
    }
    let mut samples = Vec::new();
    for _ in 0..5 {
        let rounds = 100_000;
        let started = Instant::now();
        for _ in 0..rounds {
            let response = app.clone().oneshot(request()).await.unwrap();
            assert_eq!(response.status(), 200);
        }
        samples.push(started.elapsed().as_nanos() as f64 / rounds as f64);
    }
    samples.sort_by(|a, b| a.total_cmp(b));
    println!("security_layer hot read: median {:.0} ns/request (samples {samples:.0?})", samples[2]);
}
