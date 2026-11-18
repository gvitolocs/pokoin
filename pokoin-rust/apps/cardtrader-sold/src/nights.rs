//! Nightly run folders (`/home/nez/data/pokoin-catalog-refresh/daily/<UTC date>/`)
//! and the game targets and books inside them.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use chrono::{Datelike, NaiveDate};
use serde_json::Value;

use crate::engine::Day;

pub fn day_of(date: NaiveDate) -> Day {
    date.num_days_from_ce()
}

pub fn date_of(day: Day) -> NaiveDate {
    NaiveDate::from_num_days_from_ce_opt(day).unwrap_or(NaiveDate::MIN)
}

pub fn parse_date(text: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d")
        .map_err(|_| format!("{text:?} is not a YYYY-MM-DD date"))
}

/// One night's folder with listing books.
#[derive(Clone, Debug)]
pub struct RunDir {
    pub day: Day,
    pub path: PathBuf,
    /// Expansions named in `listing-dump-status.json` errors.
    pub skip: HashSet<i64>,
}

impl RunDir {
    pub fn books_dir(&self) -> PathBuf {
        self.path.join("listing-books")
    }

    /// `(expansion id, path)` of this game's books, expansion order.
    pub fn game_books(&self, game_id: i64) -> Result<Vec<(i64, PathBuf)>, String> {
        let dir = self.books_dir();
        let prefix = format!("{game_id}-");
        let mut books = Vec::new();
        for entry in
            std::fs::read_dir(&dir).map_err(|error| format!("{}: {error}", dir.display()))?
        {
            let path = entry
                .map_err(|error| format!("{}: {error}", dir.display()))?
                .path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(rest) = name.strip_prefix(&prefix) else {
                continue;
            };
            let stem = rest
                .strip_suffix(".ctb")
                .or_else(|| rest.strip_suffix(".json.gz"));
            let Some(expansion) = stem.and_then(|stem| stem.parse::<i64>().ok()) else {
                continue;
            };
            if !self.skip.contains(&expansion) {
                books.push((expansion, path));
            }
        }
        books.sort();
        books.dedup_by_key(|(expansion, _)| *expansion);
        Ok(books)
    }
}

/// Run folders between `from` and `to` (inclusive) that hold listing books.
pub fn discover(root: &Path, from: Option<Day>, to: Option<Day>) -> Result<Vec<RunDir>, String> {
    let mut runs = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|error| format!("{}: {error}", root.display()))? {
        let path = entry
            .map_err(|error| format!("{}: {error}", root.display()))?
            .path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Ok(date) = parse_date(name) else { continue };
        let day = day_of(date);
        if from.is_some_and(|from| day < from) || to.is_some_and(|to| day > to) {
            continue;
        }
        if !path.join("listing-books").is_dir() {
            continue;
        }
        let skip = read_json(&path.join("listing-dump-status.json"))
            .ok()
            .and_then(|status| status.get("errors").and_then(Value::as_array).cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|error| error.get("expansionId").and_then(json_i64))
            .collect();
        runs.push(RunDir { day, path, skip });
    }
    runs.sort_by_key(|run| run.day);
    Ok(runs)
}

/// A decoded book (`.ctb` with the night's `sellers.jsonl`, or `.json.gz`).
pub fn read_book(path: &Path, sellers: Option<&ctbook::Sellers>) -> Result<Value, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if name.ends_with(".json.gz") || name.ends_with(".json") {
        return ctbook::read_json_book(path).map_err(|error| error.to_string());
    }
    let bytes = std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let header = ctbook::read_header(&bytes).map_err(|error| error.to_string())?;
    if header.needs_sellers {
        let sellers =
            sellers.ok_or_else(|| format!("{} needs {}", path.display(), ctbook::SELLERS_FILE))?;
        ctbook::read_with_sellers(&bytes, sellers).map_err(|error| error.to_string())
    } else {
        ctbook::read(&bytes).map_err(|error| error.to_string())
    }
}

/// A game the daily job dumps (`<db>-target.json`).
#[derive(Clone, Debug)]
pub struct Game {
    pub slug: String,
    pub game_id: i64,
    pub database: String,
}

pub fn load_targets(run: &Path) -> Result<Vec<Game>, String> {
    let mut games = Vec::new();
    for entry in std::fs::read_dir(run).map_err(|error| format!("{}: {error}", run.display()))? {
        let path = entry
            .map_err(|error| format!("{}: {error}", run.display()))?
            .path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.ends_with("-target.json") {
            continue;
        }
        let value = read_json(&path)?;
        let game_id = value
            .get("cardtraderGameId")
            .and_then(json_i64)
            .ok_or_else(|| format!("{name}: missing cardtraderGameId"))?;
        let schema = value.get("schema").and_then(Value::as_str).unwrap_or("");
        let (slug, database) = if game_id == 5 {
            ("pokemon".to_string(), "pokoin_marketplace".to_string())
        } else {
            let slug = value
                .get("game")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            (
                slug,
                format!(
                    "pokoin_{}",
                    schema.strip_prefix("marketplace_").unwrap_or(schema)
                ),
            )
        };
        if slug.is_empty() || !is_ident(&database) {
            return Err(format!("{name}: bad game slug or database"));
        }
        games.push(Game {
            slug,
            game_id,
            database,
        });
    }
    games.sort_by_key(|game| game.game_id);
    Ok(games)
}

pub fn is_ident(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphabetic() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

pub fn read_json(path: &Path) -> Result<Value, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))
}

pub fn json_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
}
