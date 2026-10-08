use axum::Router;
use pokoin_api_common::RouteState;

/// Routes owned by this module (filled in by the porting task).
pub fn routes() -> Router<RouteState> {
    Router::new()
}
