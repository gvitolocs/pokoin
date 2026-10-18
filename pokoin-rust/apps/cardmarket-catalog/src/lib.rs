//! Cardmarket ids, missing singles and daily prices for the Cardmarket-only
//! games (docs/CARDMARKET_GAMES.md).
//!
//! ```text
//! pokoin-cardmarket-catalog match  [--game battle_spirits_saga] [--refresh]
//! pokoin-cardmarket-catalog prices [--game battle_spirits_saga] [--file guide.json] [--apply]
//! ```
//!
//! `match` only reads the database. It pairs Cardmarket singles with catalog
//! rows and writes `<cache>/raw/cardmarket-match.json`: `matches` (source_key →
//! idProducts) and `extras` (singles the catalog lacks). The Python importer
//! (`scripts/catalog/import_catalog.py <game> --images --apply`) writes both,
//! so catalog rows keep one writer and one image pipeline.
//!
//! `prices` downloads the day's price guide and, with `--apply`, stores it in
//! `cardmarket_price_guide_daily` (migration 126) and sets each priced card's
//! `marketplace_card_daily_median` (EUR × 200 PKN), which set desks and tiles
//! read. Without `--apply` it reports coverage only.

pub mod db;
pub mod game;
pub mod matcher;
pub mod sources;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::json;

use sources::PriceGuide;

/// €1 = 200 PKN (`EUR_TO_PKN`, commerce `money.rs`).
pub const PKN_PER_EUR: f64 = 200.0;

/// The display price of one price-guide row, EUR: Cardmarket's trend, else the
/// 7/30/1-day sale averages; foil only when the card has no regular price.
/// `low` is the cheapest ask, never a sale price (docs/MARKET.md: asks stay
/// out of medians), so a card with only asks shows no price.
pub fn display_eur(row: &PriceGuide) -> Option<f64> {
    let pick = |values: [Option<f64>; 5]| values.into_iter().flatten().find(|v| *v > 0.0);
    pick([row.trend, row.avg7, row.avg30, row.avg1, row.avg]).or_else(|| {
        pick([
            row.trend_foil,
            row.avg7_foil,
            row.avg30_foil,
            row.avg1_foil,
            row.avg_foil,
        ])
    })
}

pub fn pkn(eur: f64) -> f64 {
    (eur * PKN_PER_EUR).round()
}

struct Options {
    command: String,
    game: game::Game,
    cache: PathBuf,
    refresh: bool,
    apply: bool,
    file: Option<PathBuf>,
}

fn options() -> Result<Options, String> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();
    if !matches!(command.as_str(), "match" | "prices") {
        return Err("usage: pokoin-cardmarket-catalog match|prices [--game slug] [--cache dir] [--refresh] [--file guide.json] [--apply]".into());
    }
    let mut slug = "battle_spirits_saga".to_string();
    let mut cache = None;
    let (mut refresh, mut apply, mut file) = (false, false, None);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--game" => slug = args.next().ok_or("--game needs a slug")?,
            "--cache" => cache = Some(PathBuf::from(args.next().ok_or("--cache needs a dir")?)),
            "--file" => file = Some(PathBuf::from(args.next().ok_or("--file needs a path")?)),
            "--refresh" => refresh = true,
            "--apply" => apply = true,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let game =
        game::by_slug(&slug).ok_or_else(|| format!("no Cardmarket table for game {slug}"))?;
    let cache = cache.unwrap_or_else(|| {
        let root = std::env::var("POKOIN_CATALOG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
                    .join("pokoin-catalogs")
            });
        root.join(game.slug)
    });
    Ok(Options {
        command,
        game,
        cache,
        refresh,
        apply,
        file,
    })
}

pub async fn run() -> Result<i32, String> {
    let o = options()?;
    match o.command.as_str() {
        "match" => run_match(&o).await,
        _ => run_prices(&o).await,
    }
}

fn match_path(cache: &Path) -> PathBuf {
    sources::raw_dir(cache).join("cardmarket-match.json")
}

async fn run_match(o: &Options) -> Result<i32, String> {
    let game = &o.game;
    let src = sources::load(
        &o.cache,
        game.cardmarket_game,
        game.tcgplayer_category,
        o.refresh,
    )
    .await?;
    let pool = db::connect(&game.database(), true).await?;
    let cards = db::cards(&pool, &game.schema())
        .await
        .map_err(|e| e.to_string())?;
    // Today's price guide (downloaded, not stored) for the coverage figures.
    let (_, guide) =
        sources::price_guide(&o.cache, game.cardmarket_game, o.file.as_deref()).await?;
    let prices: HashMap<i64, f64> = guide
        .rows
        .iter()
        .filter_map(|r| Some((r.id, display_eur(r)?)))
        .collect();
    let trend: HashMap<i64, f64> = guide
        .rows
        .iter()
        .filter_map(|r| Some((r.id, r.trend?)))
        .collect();

    let outcome = matcher::run(
        game,
        &cards,
        &src.singles,
        &src.nonsingles,
        &src.tcg,
        &trend,
    );

    println!(
        "{} — {} catalog rows, {} Cardmarket singles, {} TCGplayer cards",
        game.slug,
        cards.len(),
        src.singles.len(),
        src.tcg.len()
    );
    println!();
    println!(
        "{:<6} {:<28} {:>7} {:>8} {:>5} {:>9} {:>9} {:>8}",
        "idExp", "Pokoin set", "singles", "matched", "new", "new+img", "unpaired", "match%"
    );
    let mut total = matcher::ExpansionReport::default();
    for r in &outcome.expansions {
        let rate = 100.0 * r.matched as f64 / r.singles.max(1) as f64;
        println!(
            "{:<6} {:<28} {:>7} {:>8} {:>5} {:>9} {:>9} {:>7.1}%",
            r.id, r.set, r.singles, r.matched, r.new, r.new_with_image, r.unpaired, rate
        );
        total.singles += r.singles;
        total.matched += r.matched;
        total.new += r.new;
        total.new_with_image += r.new_with_image;
        total.unpaired += r.unpaired;
    }
    println!(
        "{:<6} {:<28} {:>7} {:>8} {:>5} {:>9} {:>9}",
        "", "total", total.singles, total.matched, total.new, total.new_with_image, total.unpaired
    );
    for (id, n) in &outcome.unknown_expansions {
        println!("unknown Cardmarket expansion {id}: {n} singles (add it to game.rs)");
    }

    // Catalog coverage per Pokoin set.
    println!();
    println!(
        "{:<28} {:>6} {:>12} {:>8}",
        "Pokoin set", "cards", "with CM id", "share"
    );
    let mut sets: Vec<&str> = cards.iter().map(|c| c.set_name.as_str()).collect();
    sets.sort();
    sets.dedup();
    for set in sets {
        let in_set: Vec<&db::Card> = cards.iter().filter(|c| c.set_name == set).collect();
        let with = in_set
            .iter()
            .filter(|c| outcome.matches.contains_key(&c.key))
            .count();
        println!(
            "{:<28} {:>6} {:>12} {:>7.1}%",
            set,
            in_set.len(),
            with,
            100.0 * with as f64 / in_set.len().max(1) as f64
        );
    }

    // Price coverage after the import (existing rows + new rows).
    let matched_ids: Vec<i64> = outcome.matches.values().flatten().copied().collect();
    let listed_extras: Vec<&matcher::Extra> = outcome
        .extras
        .iter()
        .filter(|e| !e.image_url.is_empty())
        .collect();
    let priced =
        |ids: &mut dyn Iterator<Item = &i64>| ids.filter(|id| prices.contains_key(id)).count();
    let singles_priced = src
        .singles
        .iter()
        .filter(|p| prices.contains_key(&p.id))
        .count();
    let cards_priced = outcome
        .matches
        .values()
        .filter(|ids| ids.iter().any(|id| prices.contains_key(id)))
        .count();
    let extras_priced = listed_extras
        .iter()
        .filter(|e| e.card_market_ids.iter().any(|id| prices.contains_key(id)))
        .count();
    let listed = outcome.matches.len() + listed_extras.len();
    println!();
    println!(
        "price guide {}: {} rows, {} with a display price",
        guide.created_at,
        guide.rows.len(),
        prices.len()
    );
    println!(
        "Cardmarket singles with a price: {singles_priced}/{} ({:.1}%)",
        src.singles.len(),
        100.0 * singles_priced as f64 / src.singles.len().max(1) as f64
    );
    println!(
        "matched Cardmarket ids with a price: {}/{}",
        priced(&mut matched_ids.iter()),
        matched_ids.len()
    );
    println!(
        "Pokoin cards with a price after import: {} of {} with a Cardmarket id ({} existing + {} new listed); catalog {} + {} new listed = {}",
        cards_priced + extras_priced,
        listed,
        cards_priced,
        extras_priced,
        cards.len(),
        listed_extras.len(),
        cards.len() + listed_extras.len()
    );
    println!(
        "price-order check: {} groups compared, {} clear conflicts",
        outcome.price_order_checked,
        outcome.price_order_conflicts.len()
    );
    for c in outcome.price_order_conflicts.iter().take(20) {
        println!("  conflict: {c}");
    }
    for n in outcome.notes.iter().take(40) {
        println!("  {n}");
    }

    let path = match_path(&o.cache);
    let body = json!({
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "game": game.slug,
        "priceGuide": guide.created_at,
        "matches": outcome.matches,
        "extras": outcome.extras,
        "expansions": outcome.expansions,
        "priceOrderConflicts": outcome.price_order_conflicts,
        "notes": outcome.notes,
    });
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    println!();
    println!("wrote {} ({} matches, {} new rows); apply with scripts/catalog/import_catalog.py {} --images --apply", path.display(), outcome.matches.len(), outcome.extras.len(), game.slug);
    Ok(0)
}

async fn run_prices(o: &Options) -> Result<i32, String> {
    let game = &o.game;
    let (path, guide) =
        sources::price_guide(&o.cache, game.cardmarket_game, o.file.as_deref()).await?;
    let day =
        chrono::NaiveDate::parse_from_str(guide.created_at.get(..10).unwrap_or(""), "%Y-%m-%d")
            .map_err(|e| format!("price guide createdAt {}: {e}", guide.created_at))?;
    let pool = db::connect(&game.database(), !o.apply).await?;
    let cards = db::cards(&pool, &game.schema())
        .await
        .map_err(|e| e.to_string())?;
    let by_product: HashMap<i64, &PriceGuide> = guide.rows.iter().map(|r| (r.id, r)).collect();

    let mut medians: Vec<(i64, f64)> = Vec::new();
    let (mut with_id, mut unprojected) = (0, 0);
    for card in &cards {
        if card.card_market_ids.is_empty() {
            continue;
        }
        with_id += 1;
        let Some(eur) = card
            .card_market_ids
            .iter()
            .find_map(|id| by_product.get(id).and_then(|r| display_eur(r)))
        else {
            continue;
        };
        match card.card_id {
            Some(card_id) => medians.push((card_id, pkn(eur))),
            None => unprojected += 1,
        }
    }
    medians.sort_by_key(|m| m.0);
    medians.dedup_by_key(|m| m.0);
    println!(
        "{}: price guide {} ({} rows, saved {}); {} catalog rows, {} with a Cardmarket id, {} priced cards ({} not projected)",
        game.slug,
        guide.created_at,
        guide.rows.len(),
        path.display(),
        cards.len(),
        with_id,
        medians.len(),
        unprojected
    );
    if !o.apply {
        println!(
            "dry run: rerun with --apply to store the guide and {} display prices",
            medians.len()
        );
        return Ok(0);
    }
    if !db::has_table(&pool, "public.cardmarket_price_guide_daily")
        .await
        .map_err(|e| e.to_string())?
    {
        return Err("public.cardmarket_price_guide_daily is missing: apply scripts/sql/126_cardmarket_price_guide.sql".into());
    }
    let stored = db::store_guide(&pool, &day.to_string(), &guide.rows)
        .await
        .map_err(|e| e.to_string())?;
    let (upserted, removed) = db::store_medians(&pool, &day.to_string(), &medians)
        .await
        .map_err(|e| e.to_string())?;
    println!("stored {stored} price-guide rows for {day}; {upserted} display prices set, {removed} stale removed");
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(trend: Option<f64>, avg7: Option<f64>, trend_foil: Option<f64>) -> PriceGuide {
        PriceGuide {
            id: 1,
            category: None,
            avg: None,
            low: Some(0.02),
            trend,
            avg1: None,
            avg7,
            avg30: None,
            avg_foil: None,
            low_foil: None,
            trend_foil,
            avg1_foil: None,
            avg7_foil: None,
            avg30_foil: None,
        }
    }

    #[test]
    fn display_price_prefers_trend_then_averages() {
        assert_eq!(display_eur(&row(Some(3.54), Some(3.0), None)), Some(3.54));
        assert_eq!(display_eur(&row(None, Some(3.0), None)), Some(3.0));
        assert_eq!(display_eur(&row(Some(0.0), None, Some(2.4))), Some(2.4));
        assert_eq!(
            display_eur(&row(None, None, None)),
            None,
            "the lowest ask is not a price"
        );
        assert_eq!(pkn(3.54), 708.0);
    }
}
