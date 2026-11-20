#[derive(Clone, Debug)]
pub struct Config {
    pub bind: String,
    pub release: String,
    pub database_url: Option<String>,
    pub valkey_url: Option<String>,
    pub meili_url: Option<String>,
    pub meili_key: Option<String>,
    pub meili_index: String,
    pub redis_index: String,
    pub search_engine: String,
    pub db_pool_max: u32,
    /// search-page gate slots. 0 means "derive it from `db_pool_max`". Only
    /// lower than the derived number is a setting the API honours: anything above
    /// it is clamped where the gate is built (`apps/api/src/main.rs`,
    /// `bounded_gate`), so this cannot spend the pool the route shares.
    pub search_page_slots: u32,
    /// How long a search-page request waits for a slot before it is shed. Past
    /// ten seconds it is a queue, not a shed, so it is clamped there too.
    pub search_page_wait_ms: u64,
    /// The `POKOIN_RUST_SEARCH_PAGE_*` variables that were set to something this
    /// could not read, by name — never the value, which belongs to the operator's
    /// file and not to a log. This crate does not log, having no dependencies at
    /// all, so the API says the line where it builds the gate
    /// (`apps/api/src/main.rs`, `new_state`): without one, a typo in
    /// `Environment=POKOIN_RUST_SEARCH_PAGE_SLOTS=2 slots` is indistinguishable
    /// from a service that was never configured at all.
    pub gate_settings_ignored: Vec<&'static str>,
}

/// One gate setting as a number: its value, or `default` when it is unset, empty
/// or unreadable — and `ignored` learns the name of a value that is there and
/// does not parse. That is the case the operator has to be told about: an
/// `Environment=POKOIN_RUST_SEARCH_PAGE_SLOTS=2 slots` looks, in the running
/// service, exactly like a service that was never configured. An empty value is
/// not that case — it is how a unit file spells "unset" — so it stays silent.
/// The environment string is an argument, not a read, so this is testable without
/// touching the process environment.
fn gate_number<T: std::str::FromStr>(
    name: &'static str,
    raw: Option<String>,
    default: T,
    ignored: &mut Vec<&'static str>,
) -> T {
    let raw = raw.unwrap_or_default();
    let raw = raw.trim();
    if raw.is_empty() {
        return default;
    }
    match raw.parse() {
        Ok(value) => value,
        Err(_) => {
            ignored.push(name);
            default
        }
    }
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
        let mut gate_settings_ignored: Vec<&'static str> = Vec::new();
        // 0 (unset, empty or explicitly 0) means search_page::default_slots
        // derives the slots from db_pool_max: the pool's reserve per parallel
        // statement one search-page request runs.
        let search_page_slots = gate_number(
            "POKOIN_RUST_SEARCH_PAGE_SLOTS",
            std::env::var("POKOIN_RUST_SEARCH_PAGE_SLOTS").ok(),
            0,
            &mut gate_settings_ignored,
        );
        let search_page_wait_ms = gate_number(
            "POKOIN_RUST_SEARCH_PAGE_WAIT_MS",
            std::env::var("POKOIN_RUST_SEARCH_PAGE_WAIT_MS").ok(),
            1_500,
            &mut gate_settings_ignored,
        );
        Self {
            release: std::env::var("POKOIN_RUST_RELEASE").unwrap_or_else(|_|"dev".into()),
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
                .unwrap_or_else(|| "redis".into()),
            db_pool_max: std::env::var("POKOIN_RUST_DB_POOL_MAX")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(16),
            // 0 (unset, empty or explicitly 0) means search_page::default_slots
            // derives it from db_pool_max.
            search_page_slots,
            search_page_wait_ms,
            gate_settings_ignored,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::gate_number;

    /// A setting that is there and does not parse is the one case the operator has
    /// to be told about: `Environment=POKOIN_RUST_SEARCH_PAGE_SLOTS=2 slots` looks
    /// in the running service exactly like a service that was never configured. So
    /// the default stands and the name — never the value — is recorded.
    #[test]
    fn a_gate_setting_that_does_not_parse_keeps_its_default_and_names_itself() {
        let mut ignored = Vec::new();
        assert_eq!(
            gate_number(
                "POKOIN_RUST_SEARCH_PAGE_SLOTS",
                Some("2 slots".into()),
                0,
                &mut ignored,
            ),
            0
        );
        assert_eq!(
            gate_number(
                "POKOIN_RUST_SEARCH_PAGE_WAIT_MS",
                Some("one second".into()),
                1_500,
                &mut ignored,
            ),
            1_500
        );
        assert_eq!(
            ignored,
            [
                "POKOIN_RUST_SEARCH_PAGE_SLOTS",
                "POKOIN_RUST_SEARCH_PAGE_WAIT_MS"
            ]
        );
    }

    /// Unset and empty are not misconfigurations — an empty `Environment=` value is
    /// how a unit file spells "not set" — so they take the default quietly, and a
    /// readable value takes its number.
    #[test]
    fn an_unset_or_blank_gate_setting_is_the_default_and_says_nothing() {
        let mut ignored = Vec::new();
        for raw in [None, Some(String::new()), Some("   ".into())] {
            assert_eq!(
                gate_number(
                    "POKOIN_RUST_SEARCH_PAGE_SLOTS",
                    raw.clone(),
                    2,
                    &mut ignored
                ),
                2,
                "{raw:?}"
            );
        }
        assert_eq!(
            gate_number(
                "POKOIN_RUST_SEARCH_PAGE_SLOTS",
                Some(" 3 ".into()),
                2,
                &mut ignored
            ),
            3
        );
        assert_eq!(
            gate_number(
                "POKOIN_RUST_SEARCH_PAGE_WAIT_MS",
                Some("250".into()),
                1_500,
                &mut ignored
            ),
            250
        );
        assert!(ignored.is_empty(), "{ignored:?}");
    }
}
