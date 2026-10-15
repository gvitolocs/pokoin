//! One nightly pass: every game's readable books become that game's price cache.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::{json, Value};
use sqlx::PgPool;

use crate::books::ingest_books;
use crate::db::{self, CacheRow};
use crate::money::{checkout_rate, format_rat};
use crate::rank::{Provider, Tally, Winner};

pub async fn run() -> Result<i32, String> {
    let args = Args::parse()?;
    let root = run_root();
    let started = now_iso();
    let (user, password) = credentials()?;
    let port = pg_port()?;
    let rate = checkout_rate(std::env::var("PKN_CHECKOUT_USDT_PRICE").ok().as_deref());
    let status = read_json(&root.join("listing-dump-status.json")).unwrap_or_else(|_| json!({}));
    let snapshot_at = status
        .get("startedAt")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or(&started)
        .to_string();
    let skip = error_expansions(&status);
    let books_dir = root.join("listing-books");
    let mut games = load_targets(&root)?;
    if let Some(slug) = &args.game {
        games.retain(|game| game.slug == *slug);
        if games.is_empty() {
            return Err(format!("no target for game {slug}"));
        }
    }
    games.sort_by_key(|game| game.game_id);

    let mut market: Option<PgPool> = None;
    let mut reports = Vec::with_capacity(games.len());
    let mut failed = false;
    for game in &games {
        let report = run_game(
            game,
            &books_dir,
            &skip,
            rate,
            &snapshot_at,
            args.dry_run,
            &user,
            &password,
            port,
            &mut market,
        )
        .await;
        if report.get("error").is_some_and(|value| !value.is_null()) {
            failed = true;
        }
        println!("{}", stdout_line(&report));
        if args.dry_run {
            if let Some(samples) = report.get("samples").and_then(Value::as_array) {
                for sample in samples {
                    println!("{}", sample.as_str().unwrap_or(""));
                }
            }
        }
        reports.push(report);
    }
    let finished = now_iso();
    let status_body = json!({
        "startedAt": started,
        "finishedAt": finished,
        "dryRun": args.dry_run,
        "games": reports.iter().map(public_report).collect::<Vec<_>>(),
        "totals": totals(&reports),
    });
    write_json(&root.join("price-cache-status.json"), &status_body)?;
    Ok(if failed { 1 } else { 0 })
}

struct Args {
    dry_run: bool,
    game: Option<String>,
}

impl Args {
    fn parse() -> Result<Self, String> {
        let mut dry_run = false;
        let mut game = None;
        let mut rest = std::env::args().skip(1);
        while let Some(arg) = rest.next() {
            if arg == "--dry-run" {
                dry_run = true;
            } else if arg == "--game" {
                game = Some(
                    rest.next()
                        .ok_or_else(|| "--game needs a slug".to_string())?,
                );
            } else if let Some(slug) = arg.strip_prefix("--game=") {
                if slug.is_empty() {
                    return Err("--game needs a slug".into());
                }
                game = Some(slug.to_string());
            } else {
                return Err(format!("unknown argument {arg}"));
            }
        }
        Ok(Self { dry_run, game })
    }
}

struct Game {
    slug: String,
    game_id: i64,
    database: String,
    schema: String,
    table: String,
}

#[allow(clippy::too_many_arguments)]
async fn run_game(
    game: &Game,
    books_dir: &Path,
    skip: &HashSet<i64>,
    rate: crate::money::Rat,
    snapshot_at: &str,
    dry_run: bool,
    user: &str,
    password: &str,
    port: u16,
    market: &mut Option<PgPool>,
) -> Value {
    let started = Instant::now();
    let mut report = json!({
        "game": game.slug,
        "gameId": game.game_id,
        "database": game.database,
        "booksRead": 0,
        "booksFailed": 0,
        "expansionsInScope": 0,
        "scopeBlueprints": 0,
        "eligibleListings": 0,
        "nativeListings": 0,
        "winners": 0,
        "upserted": 0,
        "deleted": 0,
        "seconds": 0.0,
        "error": null,
        "samples": [],
    });
    let finish = |report: &mut Value, error: Option<String>| {
        report["seconds"] = json!(round_seconds(started.elapsed().as_secs_f64()));
        if let Some(error) = error {
            report["error"] = json!(db::redact(&error, password));
        }
    };

    let mut ingest = ingest_books(books_dir, game.game_id, skip, rate, true);
    report["booksRead"] = json!(ingest.books_read);
    report["booksFailed"] = json!(ingest.books_failed);
    report["expansionsInScope"] = json!(ingest.expansions.len());
    if let Some(error) = ingest.dir_error.take() {
        finish(&mut report, Some(error));
        return report;
    }
    if ingest.books_failed > 0 && ingest.books_read == 0 {
        finish(
            &mut report,
            Some("every listing book failed to decode".into()),
        );
        return report;
    }
    if ingest.expansions.is_empty() {
        finish(&mut report, None);
        return report;
    }

    let pool = match db::connect(&game.database, user, password, port, dry_run).await {
        Ok(pool) => pool,
        Err(error) => {
            finish(&mut report, Some(error));
            return report;
        }
    };
    if let Err(error) = prepare_and_write(
        &pool,
        game,
        &mut ingest,
        snapshot_at,
        dry_run,
        user,
        password,
        port,
        market,
        &mut report,
    )
    .await
    {
        finish(&mut report, Some(error));
        return report;
    }
    finish(&mut report, None);
    report
}

#[allow(clippy::too_many_arguments)]
async fn prepare_and_write(
    pool: &PgPool,
    game: &Game,
    ingest: &mut crate::books::Ingest,
    snapshot_at: &str,
    dry_run: bool,
    user: &str,
    password: &str,
    port: u16,
    market: &mut Option<PgPool>,
    report: &mut Value,
) -> Result<(), String> {
    if !dry_run {
        db::ensure_schema(pool)
            .await
            .map_err(|error| db::redact(&error.to_string(), password))?;
    }
    let expansions: Vec<i64> = ingest.expansions.iter().copied().collect();
    let scope = db::scope_ids(pool, &game.schema, &game.table, &expansions)
        .await
        .map_err(|error| db::redact(&error.to_string(), password))?;
    report["scopeBlueprints"] = json!(scope.len());
    if scope.is_empty() {
        return Ok(());
    }
    let scope_set: HashSet<i64> = scope.iter().copied().collect();
    ingest.tallies_mut().retain(|id, _| scope_set.contains(id));

    let native_pool = if game.database == "pokoin_marketplace" {
        pool.clone()
    } else {
        marketplace_pool(market, user, password, port, dry_run).await?
    };
    let native = db::native_offers(&native_pool, &game.slug)
        .await
        .map_err(|error| db::redact(&error.to_string(), password))?;
    for offer in native {
        if !scope_set.contains(&offer.blueprint_id) {
            continue;
        }
        match ingest.tallies_mut().entry(offer.blueprint_id) {
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(Tally::from_first(offer));
            }
            std::collections::hash_map::Entry::Occupied(mut slot) => slot.get_mut().push(offer),
        }
    }

    let eligible: i64 = ingest.tallies().values().map(Tally::ct_count).sum();
    let native_count: i64 = ingest.tallies().values().map(Tally::native_count).sum();
    report["eligibleListings"] = json!(eligible);
    report["nativeListings"] = json!(native_count);
    report["winners"] = json!(ingest.tallies().len());

    let ct_ids: Vec<i64> = ingest
        .tallies()
        .iter()
        .filter(|(_, tally)| tally.provider() == Provider::CardTrader)
        .map(|(id, _)| *id)
        .collect();
    let cards = db::card_ids(pool, &ct_ids)
        .await
        .map_err(|error| db::redact(&error.to_string(), password))?;
    let mut winners: Vec<Winner> = ingest.tallies().values().map(Tally::winner).collect();
    winners.sort_by_key(|winner| winner.blueprint_id);
    report["samples"] = json!(sample_lines(&game.slug, &winners, &cards));
    if dry_run {
        return Ok(());
    }
    let updated_at = now_iso();
    let rows: Vec<CacheRow> = winners
        .iter()
        .map(|winner| cache_row(winner, &cards, snapshot_at))
        .collect();
    let stats = db::write_cache(pool, &scope, &rows, &updated_at)
        .await
        .map_err(|error| db::redact(&error.to_string(), password))?;
    report["upserted"] = json!(stats.upserted);
    report["deleted"] = json!(stats.deleted);
    Ok(())
}

async fn marketplace_pool(
    market: &mut Option<PgPool>,
    user: &str,
    password: &str,
    port: u16,
    dry_run: bool,
) -> Result<PgPool, String> {
    if market.is_none() {
        *market = Some(db::connect("pokoin_marketplace", user, password, port, dry_run).await?);
    }
    Ok(market.clone().expect("just inserted"))
}

fn cache_row(winner: &Winner, cards: &HashMap<i64, String>, snapshot_at: &str) -> CacheRow {
    let pokoin_card_id = if winner.provider == Provider::Native {
        winner.blueprint_id.to_string()
    } else {
        cards
            .get(&winner.blueprint_id)
            .cloned()
            .unwrap_or_else(|| winner.blueprint_id.to_string())
    };
    CacheRow {
        provider: winner.provider.as_str(),
        blueprint_id: winner.blueprint_id,
        pokoin_card_id: truncate(&pokoin_card_id, 80),
        price_eur: winner.price_eur.map(format_rat),
        price_pkn: format_rat(winner.price_pkn),
        listing_count: clamp_i32(winner.listing_count),
        quantity: clamp_i32(winner.quantity_sum),
        listing_id: truncate(&winner.listing_id, 160),
        product_id: truncate(&winner.product_id, 160),
        shipping_mode: winner.shipping_mode.to_string(),
        country: truncate(&winner.country, 40),
        source_snapshot_at: winner
            .source_snapshot_at
            .clone()
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| snapshot_at.to_string()),
    }
}

fn sample_lines(slug: &str, winners: &[Winner], cards: &HashMap<i64, String>) -> Vec<String> {
    winners.iter().take(5).map(|winner| {
        let card = if winner.provider == Provider::Native {
            winner.blueprint_id.to_string()
        } else {
            cards.get(&winner.blueprint_id).cloned().unwrap_or_else(|| winner.blueprint_id.to_string())
        };
        let eur = winner.price_eur.map(format_rat).unwrap_or_else(|| "-".to_string());
        format!(
            "{slug} sample blueprint={} provider={} pkn={} eur={eur} listings={} qty={} listing={} shipping={} card={card}",
            winner.blueprint_id,
            winner.provider.as_str(),
            format_rat(winner.price_pkn),
            winner.listing_count,
            winner.quantity_sum,
            winner.listing_id,
            winner.shipping_mode,
        )
    }).collect()
}

fn stdout_line(report: &Value) -> String {
    let error = match report.get("error") {
        Some(Value::String(text)) => format!(" error={text}"),
        _ => String::new(),
    };
    format!(
        "{} gameId={} database={} booksRead={} booksFailed={} expansionsInScope={} scopeBlueprints={} eligibleListings={} nativeListings={} winners={} upserted={} deleted={} seconds={}{error}",
        report["game"].as_str().unwrap_or(""),
        report["gameId"].as_i64().unwrap_or(0),
        report["database"].as_str().unwrap_or(""),
        report["booksRead"].as_u64().unwrap_or(0),
        report["booksFailed"].as_u64().unwrap_or(0),
        report["expansionsInScope"].as_u64().unwrap_or(0),
        report["scopeBlueprints"].as_u64().unwrap_or(0),
        report["eligibleListings"].as_i64().unwrap_or(0),
        report["nativeListings"].as_i64().unwrap_or(0),
        report["winners"].as_u64().unwrap_or(0),
        report["upserted"].as_i64().unwrap_or(0),
        report["deleted"].as_i64().unwrap_or(0),
        report["seconds"].as_f64().unwrap_or(0.0),
    )
}

fn public_report(report: &Value) -> Value {
    let mut copy = report.clone();
    if let Some(object) = copy.as_object_mut() {
        object.remove("samples");
    }
    copy
}

fn totals(reports: &[Value]) -> Value {
    let mut books_read = 0u64;
    let mut books_failed = 0u64;
    let mut expansions = 0u64;
    let mut scope = 0u64;
    let mut eligible = 0i64;
    let mut native = 0i64;
    let mut winners = 0u64;
    let mut upserted = 0i64;
    let mut deleted = 0i64;
    let mut failed_games = 0u64;
    for report in reports {
        books_read += report["booksRead"].as_u64().unwrap_or(0);
        books_failed += report["booksFailed"].as_u64().unwrap_or(0);
        expansions += report["expansionsInScope"].as_u64().unwrap_or(0);
        scope += report["scopeBlueprints"].as_u64().unwrap_or(0);
        eligible += report["eligibleListings"].as_i64().unwrap_or(0);
        native += report["nativeListings"].as_i64().unwrap_or(0);
        winners += report["winners"].as_u64().unwrap_or(0);
        upserted += report["upserted"].as_i64().unwrap_or(0);
        deleted += report["deleted"].as_i64().unwrap_or(0);
        if report.get("error").is_some_and(|value| value.is_string()) {
            failed_games += 1;
        }
    }
    json!({
        "games": reports.len(),
        "booksRead": books_read,
        "booksFailed": books_failed,
        "expansionsInScope": expansions,
        "scopeBlueprints": scope,
        "eligibleListings": eligible,
        "nativeListings": native,
        "winners": winners,
        "upserted": upserted,
        "deleted": deleted,
        "failedGames": failed_games,
    })
}

fn load_targets(root: &Path) -> Result<Vec<Game>, String> {
    let mut games = Vec::new();
    let entries =
        std::fs::read_dir(root).map_err(|error| format!("{}: {error}", root.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("{}: {error}", root.display()))?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.ends_with("-target.json") {
            continue;
        }
        let value = read_json(&path)?;
        let game_id = value
            .get("cardtraderGameId")
            .and_then(crate::eligibility::json_i64)
            .ok_or_else(|| format!("{name}: missing cardtraderGameId"))?;
        let schema = value
            .get("schema")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let table = value
            .get("table")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        ident(&schema).map_err(|error| format!("{name}: schema {error}"))?;
        ident(&table).map_err(|error| format!("{name}: table {error}"))?;
        let slug = if game_id == 5 {
            "pokemon".to_string()
        } else {
            value
                .get("game")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        if slug.is_empty() {
            return Err(format!("{name}: missing game slug"));
        }
        let database = if game_id == 5 {
            "pokoin_marketplace".to_string()
        } else {
            format!(
                "pokoin_{}",
                schema.strip_prefix("marketplace_").unwrap_or(&schema)
            )
        };
        ident(&database).map_err(|error| format!("{name}: database {error}"))?;
        games.push(Game {
            slug,
            game_id,
            database,
            schema,
            table,
        });
    }
    Ok(games)
}

fn ident(value: &str) -> Result<(), String> {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return Err(format!("{value:?} is not an identifier")),
    }
    if chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
        Ok(())
    } else {
        Err(format!("{value:?} is not an identifier"))
    }
}

fn error_expansions(status: &Value) -> HashSet<i64> {
    let mut skip = HashSet::new();
    let Some(errors) = status.get("errors").and_then(Value::as_array) else {
        return skip;
    };
    for error in errors {
        if let Some(id) = error
            .get("expansionId")
            .and_then(crate::eligibility::json_i64)
        {
            skip.insert(id);
        }
    }
    skip
}

fn credentials() -> Result<(String, String), String> {
    let from_env = match (
        std::env::var("POSTGRES_USER"),
        std::env::var("POSTGRES_PASSWORD"),
    ) {
        (Ok(user), Ok(password)) if !user.is_empty() && !password.is_empty() => {
            Some((user, password))
        }
        _ => None,
    };
    if let Some(pair) = from_env {
        return Ok(pair);
    }
    let output = std::process::Command::new("docker")
        .args([
            "inspect",
            "pokoin-marketplace-postgres-15t",
            "--format",
            "{{json .Config.Env}}",
        ])
        .output()
        .map_err(|error| format!("docker inspect failed: {error}"))?;
    if !output.status.success() {
        return Err("docker inspect pokoin-marketplace-postgres-15t failed".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let list: Vec<String> = serde_json::from_str(text.trim())
        .map_err(|_| "docker inspect env is not a JSON list".to_string())?;
    let mut user = None;
    let mut password = None;
    for item in list {
        if let Some(value) = item.strip_prefix("POSTGRES_USER=") {
            user = Some(value.to_string());
        } else if let Some(value) = item.strip_prefix("POSTGRES_PASSWORD=") {
            password = Some(value.to_string());
        }
    }
    match (user, password) {
        (Some(user), Some(password)) if !user.is_empty() && !password.is_empty() => {
            Ok((user, password))
        }
        _ => Err("postgres credentials are not in the container environment".into()),
    }
}

fn pg_port() -> Result<u16, String> {
    match std::env::var("POKOIN_PRICE_CACHE_PG_PORT") {
        Err(_) => Ok(25433),
        Ok(value) if value.trim().is_empty() => Ok(25433),
        Ok(value) => value
            .trim()
            .parse()
            .map_err(|_| "POKOIN_PRICE_CACHE_PG_PORT is not a port".into()),
    }
}

fn run_root() -> PathBuf {
    match std::env::var("POKOIN_CATALOG_RUN_ROOT") {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => {
            let day = chrono::Utc::now().format("%Y-%m-%d");
            PathBuf::from(format!("/home/nez/data/pokoin-catalog-refresh/daily/{day}"))
        }
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let body = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let tmp = path.with_extension("json.part");
    std::fs::write(&tmp, body + "\n").map_err(|error| format!("{}: {error}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|error| format!("{}: {error}", path.display()))
}

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn round_seconds(seconds: f64) -> f64 {
    (seconds * 1000.0).round() / 1000.0
}

fn clamp_i32(value: i64) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX).max(0)
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}
