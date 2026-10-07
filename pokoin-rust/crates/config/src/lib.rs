#[derive(Clone, Debug)]
pub struct Config {
    pub bind: String,
    pub database_url: Option<String>,
    pub valkey_url: Option<String>,
    pub meili_url: Option<String>,
    pub meili_key: Option<String>,
    pub meili_index: String,
    pub redis_index: String,
    pub search_engine: String,
    pub node_origin: String,
    pub db_pool_max: u32,
}

fn env_first(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            bind: std::env::var("POKOIN_RUST_BIND").unwrap_or_else(|_| "127.0.0.1:18082".into()),
            database_url: env_first(&["MARKETPLACE_DATABASE_URL", "DATABASE_URL"]),
            valkey_url: env_first(&["VALKEY_URL", "REDIS_URL"]).or_else(|| {
                let host = env_first(&["VALKEY_HOST", "REDIS_HOST"])
                    .unwrap_or_else(|| "127.0.0.1".into());
                // Pi Redis is :6380. REDIS_PORT is what the Node container exports.
                let port = env_first(&["VALKEY_PORT", "REDIS_PORT", "POKOIN_REDIS_PORT"])
                    .unwrap_or_else(|| "6380".into());
                Some(format!("redis://{host}:{port}"))
            }),
            meili_url: env_first(&["MEILI_HOST", "MEILISEARCH_HOST", "MEILI_URL"]),
            meili_key: env_first(&["MEILI_API_KEY", "MEILISEARCH_API_KEY"]),
            meili_index: std::env::var("MEILI_MARKETPLACE_INDEX")
                .unwrap_or_else(|_| "marketplace_cards".into()),
            redis_index: std::env::var("POKOIN_REDIS_INDEX")
                .unwrap_or_else(|_| "pokoin:cards".into()),
            search_engine: env_first(&["MARKETPLACE_SEARCH_ENGINE", "SEARCH_ENGINE"])
                .unwrap_or_else(|| "legacy".into()),
            node_origin: std::env::var("POKOIN_NODE_ORIGIN")
                .unwrap_or_else(|_| "http://127.0.0.1:18080".into()),
            db_pool_max: std::env::var("POKOIN_RUST_DB_POOL_MAX")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(4),
        }
    }
}
