use super::{clipped, now_ms, read_pool, redis_connection, text, Options};
use anyhow::{bail, Context, Result};
use serde_json::Value;
use sqlx::PgPool;
const PREFIX: &str = "pokoin:card:";
// Verbatim SELECT from the running redis-search-delta.js.
const DELTA_SQL: &str = r#"
    select
      c.card_id::text as card_id,
      c.name,
      public.marketplace_search_normalize(c.name) as name_normalized,
      public.marketplace_search_compact(c.name) as name_compact,
      coalesce(c.set_name, '') as set_name,
      coalesce(c.expansion_name, '') as expansion_name,
      coalesce(c.card_number, '') as card_number,
      coalesce(c.rarity, '') as rarity,
      coalesce(c.cdn_image_url, c.image_url, '') as cdn_image_url,
      coalesce(c.search_weight, 0) as search_weight,
      coalesce((
        select e.nationality
        from public.pokoin_pokemon_expansions e
        where e.name = c.set_name
        limit 1
      ), '') as nationality
    from public.marketplace_search_candidates c
    where coalesce(c.projected_at, c.imported_at, now()) >= $1::timestamptz
    order by c.card_id asc
"#;
fn since_iso(explicit: Option<&str>, env: Option<&str>, now: i64) -> Result<String> {
    let value = explicit.or(env).filter(|s| !s.is_empty());
    let ms = match value {
        Some(value) => pokoin_accounts::domain::portfolio_history::coerce_date_millis(Some(
            &Value::String(value.into()),
        ))
        .context("Invalid time value")?,
        None => now - 10 * 60 * 1000,
    };
    let mut iso = pokoin_external::time_util::iso_from_ms(ms);
    if !iso.contains('.') && iso.ends_with('Z') {
        iso = format!("{}.000Z", iso.trim_end_matches('Z'));
    }
    Ok(iso)
}
fn print_bucket(nationality: &str) -> &'static str {
    match nationality.trim().to_lowercase().as_str() {
        "japanese" | "ja" | "jp" => "japanese",
        "korean" | "ko" => "korean",
        "chinese" | "zh" | "cn" | "zht" => "chinese",
        "indonesian" | "id" => "indonesian",
        "thai" | "th" => "thai",
        "western" | "european" | "eu" | "american" | "us" | "french" | "fr" | "german" | "de" => {
            "western"
        }
        _ => "unknown",
    }
}
fn hash_fields(row: &Value) -> Option<(String, Vec<(String, String)>)> {
    let id = text(row.get("card_id")).trim().to_string();
    if id.is_empty() {
        return None;
    }
    let name = text(row.get("name"));
    let nationality = text(row.get("nationality"));
    let weight = row
        .get("search_weight")
        .and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(0.0);
    let mut fields = vec![
        ("card_id".into(), id.clone()),
        ("name".into(), name.clone()),
        ("name_group".into(), name),
    ];
    for field in [
        "name_normalized",
        "name_compact",
        "nicknames",
        "card_number",
        "set_name",
        "expansion_name",
        "rarity",
        "cdn_image_url",
    ] {
        fields.push((
            field.into(),
            if field == "nicknames" {
                String::new()
            } else {
                text(row.get(field))
            },
        ));
    }
    fields.extend([
        ("language".into(), "en".into()),
        ("nationality".into(), nationality.to_lowercase()),
        (
            "effective_print_bucket".into(),
            print_bucket(&nationality).into(),
        ),
        (
            "search_weight".into(),
            if weight == 0.0 {
                "0".into()
            } else {
                weight.to_string()
            },
        ),
    ]);
    Some((format!("{PREFIX}{id}"), fields))
}
trait Backend {
    async fn ping(&mut self) -> Result<String>;
    async fn index_exists(&mut self, index: &str) -> bool;
    async fn rows(&mut self, since: &str) -> Result<Vec<Value>>;
    async fn write(&mut self, key: &str, fields: &[(String, String)]) -> Result<()>;
}
async fn delta(
    backend: &mut impl Backend,
    index: &str,
    since: &str,
    dry_run: bool,
) -> Result<usize> {
    let ping = backend.ping().await?;
    if ping != "PONG" {
        bail!("redis ping {}", clipped(&ping, 100));
    }
    if !backend.index_exists(index).await {
        bail!("redis index {index} is missing; run redis-search-reindex.js");
    }
    let mut written = 0;
    for row in backend.rows(since).await? {
        let Some((key, fields)) = hash_fields(&row) else {
            continue;
        };
        if !dry_run {
            backend.write(&key, &fields).await?;
        }
        written += 1;
    }
    Ok(written)
}
struct Native {
    pool: PgPool,
    redis: redis::aio::ConnectionManager,
}
impl Backend for Native {
    async fn ping(&mut self) -> Result<String> {
        Ok(redis::cmd("PING").query_async(&mut self.redis).await?)
    }
    async fn index_exists(&mut self, index: &str) -> bool {
        redis::cmd("FT.INFO")
            .arg(index)
            .query_async::<redis::Value>(&mut self.redis)
            .await
            .is_ok()
    }
    async fn rows(&mut self, since: &str) -> Result<Vec<Value>> {
        let mut connection = self.pool.acquire().await?;
        sqlx::query("set statement_timeout = 0")
            .execute(&mut *connection)
            .await?;
        let sql = format!("select row_to_json(delta) from ({DELTA_SQL}) delta");
        Ok(sqlx::query_scalar::<_, Value>(&sql)
            .bind(since)
            .fetch_all(&mut *connection)
            .await?)
    }
    async fn write(&mut self, key: &str, fields: &[(String, String)]) -> Result<()> {
        let mut command = redis::cmd("HSET");
        command.arg(key);
        for (name, value) in fields {
            command.arg(name).arg(value);
        }
        command.query_async::<i64>(&mut self.redis).await?;
        Ok(())
    }
}
pub(super) async fn run(options: &Options) -> Result<()> {
    let since = since_iso(
        options.since.as_deref(),
        std::env::var("REDIS_DELTA_SINCE").ok().as_deref(),
        now_ms(),
    )?;
    let index = std::env::var("POKOIN_REDIS_INDEX").unwrap_or_else(|_| "pokoin:cards".into());
    let mut backend = Native {
        pool: read_pool().await?,
        redis: redis_connection().await?,
    };
    let written = delta(&mut backend, &index, &since, options.dry_run).await?;
    println!(
        "redis delta since {since}: {written} documents index={index}{}",
        if options.dry_run { " (dry run)" } else { "" }
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    #[derive(Default)]
    struct Mock {
        docs: HashMap<String, Vec<(String, String)>>,
        failure: bool,
        missing: bool,
    }
    impl Backend for Mock {
        async fn ping(&mut self) -> Result<String> {
            Ok("PONG".into())
        }
        async fn index_exists(&mut self, _: &str) -> bool {
            !self.missing
        }
        async fn rows(&mut self, _: &str) -> Result<Vec<Value>> {
            Ok(vec![
                json!({"card_id":" 42 ","name":"Eevee","nationality":"JP","search_weight":"2"}),
                json!({"card_id":""}),
            ])
        }
        async fn write(&mut self, key: &str, fields: &[(String, String)]) -> Result<()> {
            if self.failure {
                bail!("Redis write failed");
            }
            self.docs.insert(key.into(), fields.to_vec());
            Ok(())
        }
    }
    #[test]
    fn buckets_match_all_reference_aliases() {
        for (name, expected) in [
            (" JA ", "japanese"),
            ("ko", "korean"),
            ("ZHT", "chinese"),
            ("id", "indonesian"),
            ("th", "thai"),
            ("fr", "western"),
            ("EN", "unknown"),
            ("", "unknown"),
        ] {
            assert_eq!(print_bucket(name), expected);
        }
    }
    #[test]
    fn since_default_precedence_and_invalid_input() {
        assert_eq!(
            since_iso(None, None, 600000).unwrap(),
            "1970-01-01T00:00:00.000Z"
        );
        assert_eq!(
            since_iso(Some("2026-10-08"), Some("bad"), 0).unwrap(),
            "2026-10-08T00:00:00.000Z"
        );
        assert!(since_iso(Some("invalid"), None, 0).is_err());
    }
    #[test]
    fn hash_fields_keep_node_key_and_empty_nicknames() {
        let (key, fields) =
            hash_fields(&json!({"card_id":42,"name":"Eevee","nationality":" JP "})).unwrap();
        let fields: HashMap<_, _> = fields.into_iter().collect();
        assert_eq!(key, "pokoin:card:42");
        assert_eq!(fields["name_group"], "Eevee");
        assert_eq!(fields["nicknames"], "");
        assert_eq!(fields["nationality"], " jp ");
        assert_eq!(fields["effective_print_bucket"], "japanese");
        assert_eq!(fields["search_weight"], "0");
    }
    #[tokio::test]
    async fn delta_is_idempotent_and_dry_run_does_not_write() {
        let mut backend = Mock::default();
        assert_eq!(
            delta(&mut backend, "pokoin:cards", "since", true)
                .await
                .unwrap(),
            1
        );
        assert!(backend.docs.is_empty());
        delta(&mut backend, "pokoin:cards", "since", false)
            .await
            .unwrap();
        let first = backend.docs.clone();
        delta(&mut backend, "pokoin:cards", "since", false)
            .await
            .unwrap();
        assert_eq!(backend.docs, first);
    }
    #[tokio::test]
    async fn missing_index_and_write_failure_are_errors() {
        let mut backend = Mock {
            missing: true,
            ..Default::default()
        };
        assert!(delta(&mut backend, "x", "since", false).await.is_err());
        backend.missing = false;
        backend.failure = true;
        assert!(delta(&mut backend, "x", "since", false).await.is_err());
    }
}
