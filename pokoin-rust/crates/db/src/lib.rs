use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

pub async fn pool(url: &str, max: u32) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(max.max(1))
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect(url)
        .await
}
