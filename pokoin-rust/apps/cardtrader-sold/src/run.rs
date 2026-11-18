//! One pass: replay the recent nights of every game's books and store the
//! sold graph of the days that can no longer change much.
//!
//! Replay starts `REPLAY_NIGHTS` nights back from a cold book, so the first
//! `WARMUP_NIGHTS` nights only build state (a listing seen on the first night
//! looks brand new, and 101 keeps listings under three days old out of sales).
//! Rows are written for `[from + WARMUP_NIGHTS, to]`; older days keep what an
//! earlier run wrote. 093's three complete absences mean the newest days fill
//! in over the next two nights, exactly as on the Pokémon graph.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::{json, Value};

use crate::db;
use crate::engine::{Day, Engine, Night};
use crate::listing::{Raw, Rules, Shaper};
use crate::nights::{self, date_of, day_of, parse_date, Game, RunDir};
use crate::sold::{sold_rows, SoldRow};

pub const REPLAY_NIGHTS: Day = 16;
pub const WARMUP_NIGHTS: Day = 4;
const DEFAULT_ROOT: &str = "/home/nez/data/pokoin-catalog-refresh/daily";

const USAGE: &str =
    "usage: pokoin-cardtrader-sold [--root DIR] [--game SLUG,...] [--from YYYY-MM-DD] \
[--to YYYY-MM-DD] [--write-from YYYY-MM-DD] [--dry-run] [--compare] [--sample BLUEPRINT_ID]";

#[derive(Default)]
struct Args {
    root: Option<PathBuf>,
    games: Vec<String>,
    from: Option<Day>,
    to: Option<Day>,
    write_from: Option<Day>,
    dry_run: bool,
    compare: bool,
    sample: Option<i64>,
}

impl Args {
    fn parse() -> Result<Self, String> {
        let mut args = Self::default();
        let mut rest = std::env::args().skip(1);
        while let Some(arg) = rest.next() {
            let (name, inline) = match arg.split_once('=') {
                Some((name, value)) => (name.to_string(), Some(value.to_string())),
                None => (arg.clone(), None),
            };
            let mut value = |name: &str| -> Result<String, String> {
                inline
                    .clone()
                    .or_else(|| rest.next())
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| format!("{name} needs a value"))
            };
            match name.as_str() {
                "--dry-run" => args.dry_run = true,
                "--compare" => args.compare = true,
                "--root" => args.root = Some(PathBuf::from(value("--root")?)),
                "--game" => args.games.extend(
                    value("--game")?
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty()),
                ),
                "--from" => args.from = Some(day_of(parse_date(&value("--from")?)?)),
                "--to" => args.to = Some(day_of(parse_date(&value("--to")?)?)),
                "--write-from" => {
                    args.write_from = Some(day_of(parse_date(&value("--write-from")?)?))
                }
                "--sample" => {
                    args.sample = Some(
                        value("--sample")?
                            .parse()
                            .map_err(|_| "--sample needs a blueprint id".to_string())?,
                    )
                }
                "--help" | "-h" => return Err(USAGE.into()),
                _ => return Err(format!("unknown argument {arg}\n{USAGE}")),
            }
        }
        Ok(args)
    }
}

pub async fn run() -> Result<i32, String> {
    let args = Args::parse()?;
    let root = args.root.clone().unwrap_or_else(default_root);
    let to = match args.to.or_else(run_root_day) {
        Some(day) => day,
        None => nights::discover(&root, None, None)?
            .last()
            .map(|run| run.day)
            .ok_or("no run folders with listing books")?,
    };
    let from = args.from.unwrap_or(to - (REPLAY_NIGHTS - 1));
    let runs = nights::discover(&root, Some(from), Some(to))?;
    let Some(latest) = runs.last() else {
        return Err("no run folders in range".into());
    };
    let write_from = args.write_from.unwrap_or(from + WARMUP_NIGHTS).min(to);
    let mut games = nights::load_targets(&latest.path)?;
    if args.games.is_empty() {
        // Pokémon keeps the Oracle SQL pipeline (pokoin-cardtrader-daily-market-refresh).
        games.retain(|game| game.game_id != 5);
    } else {
        games.retain(|game| {
            args.games
                .iter()
                .any(|slug| *slug == game.slug || *slug == game.game_id.to_string())
        });
        if games.is_empty() {
            return Err(format!("no target for {}", args.games.join(",")));
        }
    }
    if !args.dry_run && games.iter().any(|game| game.game_id == 5) {
        return Err(
            "Pokémon's sold graph is written by the Oracle job; use --dry-run --compare".into(),
        );
    }
    let rate = std::env::var("PKN_CHECKOUT_USDT_PRICE")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.005);
    let needs_db = !args.dry_run || args.compare || games.iter().any(|game| game.game_id == 5);
    let login = if needs_db {
        Some((credentials()?, pg_port()?))
    } else {
        None
    };

    eprintln!(
        "pokoin-cardtrader-sold: {} nights {}..{}, writing {}..{}{}",
        runs.len(),
        date_of(from),
        date_of(to),
        date_of(write_from),
        date_of(to),
        if args.dry_run { " (dry run)" } else { "" }
    );
    let started = now_iso();
    let mut reports = Vec::new();
    let mut failed = false;
    for game in &games {
        let report = run_game(game, &runs, write_from, to, rate, &args, login.as_ref()).await;
        if report.get("error").is_some_and(|value| !value.is_null()) {
            failed = true;
        }
        println!("{}", report);
        reports.push(report);
    }
    let status = json!({
        "startedAt": started,
        "finishedAt": now_iso(),
        "dryRun": args.dry_run,
        "from": date_of(from).to_string(),
        "to": date_of(to).to_string(),
        "writeFrom": date_of(write_from).to_string(),
        "nights": runs.len(),
        "games": reports,
    });
    let name = if args.dry_run {
        "sold-dry-status.json"
    } else {
        "sold-status.json"
    };
    let _ = std::fs::write(
        latest.path.join(name),
        serde_json::to_string_pretty(&status).unwrap_or_default(),
    );
    Ok(if failed { 1 } else { 0 })
}

type Login = ((String, String), u16);

async fn run_game(
    game: &Game,
    runs: &[RunDir],
    write_from: Day,
    to: Day,
    rate: f64,
    args: &Args,
    login: Option<&Login>,
) -> Value {
    let started = Instant::now();
    let mut report = json!({"game": game.slug, "gameId": game.game_id, "database": game.database, "error": null});
    let mut nationality = HashMap::new();
    if game.game_id == 5 {
        let Some(((user, password), port)) = login else {
            unreachable!("pokemon needs the database")
        };
        match db::connect(&game.database, user, password, *port, true).await {
            Ok(pool) => match db::pokemon_nationality(&pool).await {
                Ok(map) => nationality = map,
                Err(error) => report["error"] = json!(format!("nationality: {error}")),
            },
            Err(error) => report["error"] = json!(error),
        }
        if !report["error"].is_null() {
            return report;
        }
    }
    let mut shaper = Shaper::new(rate, nationality);
    let mut engine = Engine::default();
    let mut night_reports = Vec::new();
    for run in runs {
        let night_started = Instant::now();
        let night = Night::new(run.day);
        let before = engine.counts.clone();
        let sellers = ctbook::Sellers::load(&run.books_dir().join(ctbook::SELLERS_FILE)).ok();
        let books = match run.game_books(game.game_id) {
            Ok(books) => books,
            Err(error) => {
                report["error"] = json!(error);
                return report;
            }
        };
        let (mut read, mut failed) = (0u64, 0u64);
        let (mut decode_seconds, mut engine_seconds) = (0f64, 0f64);
        // Books decode and shape in parallel (brotli + JSON is most of the time);
        // the engine still takes them one by one in expansion order.
        let Shaper { strings, rules } = &mut shaper;
        let engine_ref = &mut engine;
        decode_in_order(
            &books,
            sellers.as_ref(),
            rules,
            decode_threads(),
            |index, result, waited| {
                decode_seconds += waited;
                let engine_started = Instant::now();
                let (expansion, path) = &books[index];
                match result {
                    Ok(raws) => {
                        let rows = raws.into_iter().map(|raw| strings.listing(raw)).collect();
                        engine_ref.expansion(night, *expansion, rows);
                        read += 1;
                    }
                    Err(error) => {
                        failed += 1;
                        eprintln!(
                            "pokoin-cardtrader-sold: skipped {}: {error}",
                            path.display()
                        );
                    }
                }
                engine_seconds += engine_started.elapsed().as_secs_f64();
            },
        );
        let finalize_started = Instant::now();
        engine.finalize(night);
        let finalize_seconds = finalize_started.elapsed().as_secs_f64();
        let after = &engine.counts;
        night_reports.push(json!({
            "day": date_of(run.day).to_string(),
            "books": read,
            "booksFailed": failed,
            "listings": after.listings - before.listings,
            "drips": after.drips - before.drips,
            "inferred": after.inferred - before.inferred,
            "rotated": after.rotated - before.rotated,
            "young": after.young - before.young,
            "cutover": after.cutover - before.cutover,
            "confirmed": after.confirmed - before.confirmed,
            "retracted": after.retracted - before.retracted,
            "suspiciousBlueprints": after.suspicious_blueprints - before.suspicious_blueprints,
            "vacationRows": after.vacation_rows - before.vacation_rows,
            "withdrawnRows": after.withdrawn_rows - before.withdrawn_rows,
            "seconds": round(night_started.elapsed().as_secs_f64()),
            "decodeSeconds": round(decode_seconds),
            "engineSeconds": round(engine_seconds),
            "finalizeSeconds": round(finalize_seconds),
        }));
        eprintln!(
            "pokoin-cardtrader-sold: {} {} books {read} listings {} ({:.1}s: decode {decode_seconds:.1}s, engine {engine_seconds:.1}s, finalize {finalize_seconds:.1}s)",
            game.slug,
            date_of(run.day),
            after.listings - before.listings,
            night_started.elapsed().as_secs_f64()
        );
    }
    let rows = sold_rows(&engine, &shaper.strings, write_from, to);
    let mut per_day: BTreeMap<String, (u64, i64)> = BTreeMap::new();
    for row in &rows {
        let entry = per_day.entry(date_of(row.key.day).to_string()).or_default();
        entry.0 += 1;
        entry.1 += row.sold_qty;
    }
    report["nights"] = json!(night_reports);
    report["liveListings"] = json!(engine.books.values().map(|book| book.len()).sum::<usize>());
    report["episodes"] = json!(engine.episodes.len());
    report["soldRows"] = json!(rows.len());
    report["soldBlueprints"] = json!(rows
        .iter()
        .map(|row| row.key.blueprint)
        .collect::<std::collections::HashSet<_>>()
        .len());
    report["soldByDay"] = json!(per_day
        .iter()
        .map(|(day, (rows, qty))| json!({"day": day, "rows": rows, "soldQty": qty}))
        .collect::<Vec<_>>());
    if let Some(blueprint) = args.sample {
        report["sample"] = sample(&engine, &shaper, &rows, blueprint);
    }

    if let Some(((user, password), port)) = login {
        if args.compare {
            match compare(game, &rows, write_from, to, user, password, *port).await {
                Ok(value) => report["compare"] = value,
                Err(error) => report["error"] = json!(error),
            }
        }
        if !args.dry_run {
            let written = match db::connect(&game.database, user, password, *port, false).await {
                Ok(pool) => db::write_rows(&pool, write_from, to, &rows)
                    .await
                    .map_err(|error| db::redact(&error.to_string(), password)),
                Err(error) => Err(error),
            };
            match written {
                Ok(count) => report["written"] = json!(count),
                Err(error) => report["error"] = json!(error),
            }
        }
    }
    report["seconds"] = json!(round(started.elapsed().as_secs_f64()));
    report
}

fn sample(engine: &Engine, shaper: &Shaper, rows: &[SoldRow], blueprint: i64) -> Value {
    let strings = &shaper.strings;
    let episodes: Vec<Value> = engine
        .episodes
        .iter()
        .filter(|episode| episode.listing.blueprint == blueprint)
        .map(|episode| {
            json!({
                "listing": episode.listing.id,
                "seller": strings.get(episode.listing.seller_name),
                "removed": date_of(episode.removed_day).to_string(),
                "firstSeen": date_of(episode.first_seen).to_string(),
                "reason": episode.reason.name(),
                "status": format!("{:?}", episode.status),
                "qty": episode.listing.quantity,
                "pkn": episode.listing.price_pkn,
                "condition": strings.get(episode.listing.condition),
                "language": strings.get(episode.listing.sold_language),
                "foil": strings.get(episode.listing.foil),
                "observed": episode.observed,
            })
        })
        .collect();
    let live = engine.books.get(&blueprint).map_or(0, |book| book.len());
    let sold: Vec<Value> = rows
        .iter()
        .filter(|row| row.key.blueprint == blueprint)
        .map(|row| {
            json!({"day": date_of(row.key.day).to_string(), "condition": row.key.condition, "language": row.key.language,
                "reverse": row.key.reverse, "medianPkn": row.median_pkn, "soldQty": row.sold_qty, "listings": row.listings})
        })
        .collect();
    json!({"blueprint": blueprint, "liveListings": live, "episodes": episodes, "soldRows": sold})
}

/// Our rows against the stored ones (the Pokémon parity check).
async fn compare(
    game: &Game,
    rows: &[SoldRow],
    from: Day,
    to: Day,
    user: &str,
    password: &str,
    port: u16,
) -> Result<Value, String> {
    let pool = db::connect(&game.database, user, password, port, true).await?;
    let stored = db::read_rows(&pool, from, to)
        .await
        .map_err(|error| db::redact(&error.to_string(), password))?;
    let key = |blueprint: i64,
               day: &str,
               condition: &str,
               language: &str,
               reverse: bool,
               first: bool,
               graded: bool| {
        format!("{blueprint}|{day}|{condition}|{language}|{reverse}|{first}|{graded}")
    };
    let mut theirs: HashMap<String, (f64, i64)> = HashMap::new();
    let mut by_day: BTreeMap<String, [f64; 8]> = BTreeMap::new();
    for row in &stored {
        let day = row["day"].as_str().unwrap_or("").to_string();
        let k = key(
            row["blueprint"].as_i64().unwrap_or(0),
            &day,
            row["condition"].as_str().unwrap_or(""),
            row["language"].as_str().unwrap_or(""),
            row["reverse"].as_bool().unwrap_or(false),
            row["firstEdition"].as_bool().unwrap_or(false),
            row["graded"].as_bool().unwrap_or(false),
        );
        theirs.insert(
            k,
            (
                row["median"].as_f64().unwrap_or(0.0),
                row["qty"].as_i64().unwrap_or(0),
            ),
        );
        let entry = by_day.entry(day).or_default();
        entry[1] += 1.0;
        entry[3] += row["qty"].as_f64().unwrap_or(0.0);
    }
    let (mut both, mut same_median, mut near_median) = (0u64, 0u64, 0u64);
    for row in rows {
        let day = date_of(row.key.day).to_string();
        let k = key(
            row.key.blueprint,
            &day,
            &row.key.condition,
            &row.key.language,
            row.key.reverse,
            row.key.first_edition,
            row.key.graded,
        );
        let entry = by_day.entry(day).or_default();
        entry[0] += 1.0;
        entry[2] += row.sold_qty as f64;
        if let Some((median, _)) = theirs.get(&k) {
            both += 1;
            entry[4] += 1.0;
            if (median - row.median_pkn).abs() < 0.01 {
                same_median += 1;
                entry[5] += 1.0;
            }
            if (median - row.median_pkn).abs() <= 0.1 * median.abs().max(1.0) {
                near_median += 1;
            }
        }
    }
    Ok(json!({
        "ours": rows.len(),
        "stored": stored.len(),
        "bothKeys": both,
        "sameMedian": same_median,
        "medianWithin10pct": near_median,
        "byDay": by_day.iter().map(|(day, v)| json!({"day": day, "oursRows": v[0], "storedRows": v[1],
            "oursQty": v[2], "storedQty": v[3], "bothKeys": v[4], "sameMedian": v[5]})).collect::<Vec<_>>(),
    }))
}

fn default_root() -> PathBuf {
    match std::env::var("POKOIN_CATALOG_RUN_ROOT") {
        Ok(run) if !run.trim().is_empty() => Path::new(run.trim())
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_ROOT)),
        _ => PathBuf::from(DEFAULT_ROOT),
    }
}

/// The daily job's own run folder, when it calls us.
fn run_root_day() -> Option<Day> {
    let run = std::env::var("POKOIN_CATALOG_RUN_ROOT").ok()?;
    let name = Path::new(run.trim()).file_name()?.to_str()?.to_string();
    parse_date(&name).ok().map(day_of)
}

fn credentials() -> Result<(String, String), String> {
    for (user_var, password_var) in [
        ("POKOIN_CT_SOLD_PG_USER", "POKOIN_CT_SOLD_PG_PASSWORD"),
        (
            "POKOIN_PRICE_CACHE_PG_USER",
            "POKOIN_PRICE_CACHE_PG_PASSWORD",
        ),
        ("POSTGRES_USER", "POSTGRES_PASSWORD"),
    ] {
        if let (Ok(user), Ok(password)) = (std::env::var(user_var), std::env::var(password_var)) {
            if !user.is_empty() && !password.is_empty() {
                return Ok((user, password));
            }
        }
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
    let list: Vec<String> = serde_json::from_slice(&output.stdout)
        .map_err(|_| "docker inspect env is not a JSON list".to_string())?;
    let find = |prefix: &str| {
        list.iter()
            .find_map(|item| item.strip_prefix(prefix))
            .map(str::to_string)
            .filter(|v| !v.is_empty())
    };
    match (find("POSTGRES_USER="), find("POSTGRES_PASSWORD=")) {
        (Some(user), Some(password)) => Ok((user, password)),
        _ => Err("postgres credentials are not in the container environment".into()),
    }
}

fn pg_port() -> Result<u16, String> {
    for var in ["POKOIN_CT_SOLD_PG_PORT", "POKOIN_PRICE_CACHE_PG_PORT"] {
        if let Ok(value) = std::env::var(var) {
            if !value.trim().is_empty() {
                return value
                    .trim()
                    .parse()
                    .map_err(|_| format!("{var} is not a port"));
            }
        }
    }
    Ok(25433)
}

/// Decodes and shapes `books` on `threads` workers and hands each result to
/// `each(index, result, seconds waited)` in book order. Workers stay at most
/// `2 × threads` books ahead, so memory holds a bounded number of books.
fn decode_in_order(
    books: &[(i64, PathBuf)],
    sellers: Option<&ctbook::Sellers>,
    rules: &Rules,
    threads: usize,
    mut each: impl FnMut(usize, Result<Vec<Raw>, String>, f64),
) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Condvar, Mutex};
    let next = AtomicUsize::new(0);
    let consumed = (Mutex::new(0usize), Condvar::new());
    let window = threads * 2;
    let (tx, rx) = mpsc::channel::<(usize, Result<Vec<Raw>, String>)>();
    std::thread::scope(|scope| {
        for _ in 0..threads {
            let tx = tx.clone();
            let (next, consumed) = (&next, &consumed);
            scope.spawn(move || loop {
                let index = next.fetch_add(1, Ordering::SeqCst);
                if index >= books.len() {
                    break;
                }
                {
                    let mut done = consumed
                        .0
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    while index >= *done + window {
                        done = consumed
                            .1
                            .wait(done)
                            .unwrap_or_else(|poison| poison.into_inner());
                    }
                }
                let result =
                    nights::read_book(&books[index].1, sellers).map(|book| rules.book(&book));
                if tx.send((index, result)).is_err() {
                    break;
                }
            });
        }
        drop(tx);
        let mut pending: BTreeMap<usize, Result<Vec<Raw>, String>> = BTreeMap::new();
        let mut want = 0usize;
        let mut waiting = Instant::now();
        for (index, result) in rx {
            pending.insert(index, result);
            while let Some(result) = pending.remove(&want) {
                each(want, result, waiting.elapsed().as_secs_f64());
                want += 1;
                *consumed
                    .0
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner()) = want;
                consumed.1.notify_all();
                waiting = Instant::now();
            }
        }
        for index in want..books.len() {
            each(index, Err("decode worker stopped".into()), 0.0);
        }
    });
}

/// `POKOIN_CT_SOLD_THREADS`, else up to 6 (the job shares nezopt with the writer).
fn decode_threads() -> usize {
    std::env::var("POKOIN_CT_SOLD_THREADS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map_or(4, |n| n.get())
                .min(6)
        })
}

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn round(seconds: f64) -> f64 {
    (seconds * 10.0).round() / 10.0
}
