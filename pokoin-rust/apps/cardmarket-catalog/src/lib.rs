//! Cardmarket ids, missing singles and daily prices for the Cardmarket-only
//! games (docs/CARDMARKET_GAMES.md).
//!
//! ```text
//! pokoin-cardmarket-catalog match  [--game battle_spirits_saga] [--refresh]
//! pokoin-cardmarket-catalog prices [--game battle_spirits_saga] [--file guide.json] [--apply]
//! pokoin-cardmarket-catalog links  --game weiss_schwarz --urls harvest.json [--generated] [--apply]
//!                                   [--jp-twins [--images dir] [--max-art-distance 18] [--apply-jp]]
//! pokoin-cardmarket-catalog guides [--game <slug>] [--apply]
//! pokoin-cardmarket-catalog tcgnotify --file dump.json [--apply]
//! pokoin-cardmarket-catalog cm-offers --file minimums.jsonl [--apply]
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
//!
//! `guides` loads Cardmarket's daily price guide for every game (or one
//! `--game`, see `guides.rs`) into `pokoin_marketplace.cardmarket_price_guide`
//! (migration 139) as change-only history: a row is written only when a
//! product's values differ from its newest stored row on or before that day,
//! and `cardmarket_price_guide_runs` records the load. Without `--apply` it is
//! a dry run — the statements execute (real counts) and the transaction rolls
//! back. One JSON line is printed per game.
//!
//! `tcgnotify` loads a TCGNotify dump (`--file`) into
//! `pokoin_marketplace.tcgnotify_price_guide` (migration 140), the cheapest
//! Cardmarket ask per product. The pricer prefers it over the official guide's
//! `low` basis and keeps the guide for every other basis and all foil values.
//! Game and day come from each product, so one dump writes several runs.
//! Without `--apply` it is a dry run, like `guides`.
//!
//! `cm-offers` loads the Cardmarket facet minima a CTCMDeals harvest left
//! behind (`--file`: `worker/data/cm_offers/minimums.jsonl`, or its
//! `latest.json`) into `pokoin_marketplace.cardmarket_offer_minimums`
//! (migration 141): the cheapest offer a professional or a private seller
//! made, per product, language, condition, finish, first edition and seller
//! type, with the moment it was seen. Neither the official guide nor
//! TCGNotify separates sellers, so a facet minimum is the only Cardmarket
//! number that says what the competition charges. The pricer reads the price
//! engine's published snapshot (`cm_prices.current_minimums`) for the same
//! facets and this table as the older hand load, quoting whichever source
//! observed a facet later. One row per facet, newest observation
//! wins; a facet that found no offers is skipped, and so is any record whose
//! product id, facet code, price or timestamp is not usable. Without
//! `--apply` it is a dry run, like `guides`.
//!
//! `links` pairs printings with Cardmarket product pages (`links.rs`) and
//! writes `<cache>/raw/cardmarket-links.json`. `--urls` is the harvested pages
//! as a JSON array of `{id, url}` (`sqlite3 -json cardmarket-links.sqlite
//! "select cm_id id, url from products where game = 'weiss_schwarz'"`).
//! `--apply` upserts harvested-URL links into `marketplace_cm_verified_links`,
//! which `/api/cardmarket-redirect` reads; `--generated` adds the generated ones.
//! `--jp-twins` gives Japanese printings their English twin's page (`twins.rs`);
//! `--apply-jp` writes those to `pokoin_printing_cm_links` (migration 130).

pub mod cm_offers;
pub mod db;
pub mod game;
pub mod guides;
pub mod links;
pub mod matcher;
pub mod sources;
pub mod tcgnotify;
pub mod twins;

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
    /// The `match`/`prices`/`links` game; `None` for `guides`, which runs over
    /// the `guides::GUIDE_GAMES` registry instead.
    game: Option<game::Game>,
    /// `guides --game <slug>`: only that registry game (validated in `options`).
    guide_slug: Option<String>,
    cache: PathBuf,
    refresh: bool,
    apply: bool,
    file: Option<PathBuf>,
    urls: Option<PathBuf>,
    generated: bool,
    jp_twins: bool,
    apply_jp: bool,
    images: Option<PathBuf>,
    max_art_distance: u32,
}

/// The cache root: `$POKOIN_CATALOG_DIR`, else `~/pokoin-catalogs`.
fn cache_root() -> PathBuf {
    std::env::var("POKOIN_CATALOG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
                .join("pokoin-catalogs")
        })
}

fn options() -> Result<Options, String> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();
    if !matches!(command.as_str(), "match" | "prices" | "links" | "guides" | "tcgnotify" | "cm-offers") {
        return Err("usage: pokoin-cardmarket-catalog match|prices|links|guides|tcgnotify|cm-offers [--game slug] [--cache dir] [--refresh] [--file guide.json] [--urls harvest.json] [--generated] [--apply]".into());
    }
    let mut slug: Option<String> = None;
    let mut cache = None;
    let (mut refresh, mut apply, mut file) = (false, false, None);
    let (mut urls, mut generated) = (None, false);
    let (mut jp_twins, mut apply_jp, mut images, mut max_art_distance) = (false, false, None, twins::MAX_DISTANCE);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--game" => slug = Some(args.next().ok_or("--game needs a slug")?),
            "--cache" => cache = Some(PathBuf::from(args.next().ok_or("--cache needs a dir")?)),
            "--file" => file = Some(PathBuf::from(args.next().ok_or("--file needs a path")?)),
            "--urls" => urls = Some(PathBuf::from(args.next().ok_or("--urls needs a path")?)),
            "--generated" => generated = true,
            "--jp-twins" => jp_twins = true,
            "--apply-jp" => (jp_twins, apply_jp) = (true, true),
            "--images" => images = Some(PathBuf::from(args.next().ok_or("--images needs a dir")?)),
            "--max-art-distance" => {
                max_art_distance = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .ok_or("--max-art-distance needs a number of bits")?
            }
            "--refresh" => refresh = true,
            "--apply" => apply = true,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let (game, guide_slug, cache) = if command == "guides" {
        // `guides` does not need a `game::by_slug` game: it runs over the
        // guide registry (`guides::GUIDE_GAMES`), cached under `guides/<slug>`.
        if let Some(slug) = &slug {
            if guides::guide_game(slug).is_none() {
                return Err(format!("unknown guide game {slug}"));
            }
        }
        let cache = cache.unwrap_or_else(|| cache_root().join("guides"));
        (None, slug, cache)
    } else if command == "tcgnotify" {
        // The game comes from each product's Cardmarket URL, not a flag.
        let cache = cache.unwrap_or_else(|| cache_root().join("tcgnotify"));
        (None, None, cache)
    } else if command == "cm-offers" {
        // A harvest file is a finished answer per facet: no game, no cache.
        let cache = cache.unwrap_or_else(|| cache_root().join("cm-offers"));
        (None, None, cache)
    } else {
        let slug = slug.unwrap_or_else(|| "battle_spirits_saga".to_string());
        let game =
            game::by_slug(&slug).ok_or_else(|| format!("no Cardmarket table for game {slug}"))?;
        let cache = cache.unwrap_or_else(|| cache_root().join(game.slug));
        (Some(game), None, cache)
    };
    Ok(Options {
        command,
        game,
        guide_slug,
        cache,
        refresh,
        apply,
        file,
        urls,
        generated,
        jp_twins,
        apply_jp,
        images,
        max_art_distance,
    })
}

pub async fn run() -> Result<i32, String> {
    let o = options()?;
    match o.command.as_str() {
        "match" => run_match(&o).await,
        "links" => run_links(&o).await,
        "guides" => run_guides(&o).await,
        "tcgnotify" => run_tcgnotify(&o).await,
        "cm-offers" => run_cm_offers(&o).await,
        _ => run_prices(&o).await,
    }
}

fn match_path(cache: &Path) -> PathBuf {
    sources::raw_dir(cache).join("cardmarket-match.json")
}

async fn run_match(o: &Options) -> Result<i32, String> {
    let game = o
        .game
        .as_ref()
        .ok_or_else(|| format!("{} needs a known --game", o.command))?;
    if game.expansions.is_empty() {
        return Err(format!("{} has no expansion table; use the links command", game.slug));
    }
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

#[derive(serde::Deserialize)]
struct HarvestRow {
    id: i64,
    url: String,
}

/// Where the links source rows say they came from.
const LINKS_SOURCE: &str = "cardmarket-productlist+harvest";
const JP_TWIN_SOURCE: &str = "ws-en-twin-same-art";

fn report_twins(jp: &twins::JpOutcome, dir: &Path, scans: usize, max: u32) {
    println!();
    println!(
        "Japanese printings: {} of {} share an English twin's Cardmarket page ({} scans in {}, art distance ≤ {max} bits)",
        jp.links.len(),
        jp.jp_cards,
        scans,
        dir.display()
    );
    for method in ["en-twin", "en-twin-parallel"] {
        let n = jp.links.iter().filter(|l| l.method == method).count();
        println!("  {n:>6}  {method}");
    }
    println!("art distance (bits) of compared twins:");
    let line: Vec<String> = jp.distances.iter().map(|(d, n)| format!("{d}:{n}")).collect();
    println!("  {}", line.join(" "));
    println!("Japanese printings without a link:");
    for (reason, n) in &jp.unmatched {
        println!("  {n:>6}  {reason}");
    }
    for (reason, list) in &jp.samples {
        println!("e.g. {reason}:");
        for s in list {
            println!("    {s}");
        }
    }
}

async fn run_links(o: &Options) -> Result<i32, String> {
    let game = o
        .game
        .as_ref()
        .ok_or_else(|| format!("{} needs a known --game", o.command))?;
    let harvest: Vec<links::Harvest> = match &o.urls {
        Some(path) => {
            let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
            let rows: Vec<HarvestRow> = serde_json::from_slice(&bytes)
                .map_err(|e| format!("{}: {e}", path.display()))?;
            rows.into_iter()
                .filter(|r| links::split_url(&r.url).is_some())
                .map(|r| links::Harvest { id: r.id, url: r.url })
                .collect()
        }
        None => Vec::new(),
    };
    let singles = sources::singles(&o.cache, game.cardmarket_game, o.refresh).await?;
    let pool = db::connect(&game.database(), !(o.apply || o.apply_jp)).await?;
    let cards = db::cards(&pool, &game.schema())
        .await
        .map_err(|e| e.to_string())?;
    let outcome = links::run(&cards, &singles, &harvest);

    let harvested = outcome.links.iter().filter(|l| !l.generated).count();
    let generated = outcome.links.len() - harvested;
    println!(
        "{} — {} catalog rows ({} EN, {} JP: Cardmarket lists no JP edition), {} Cardmarket singles, {} harvested URLs",
        game.slug,
        cards.len(),
        outcome.en_cards,
        outcome.jp_cards,
        singles.len(),
        harvest.len()
    );
    println!();
    println!(
        "{:<6} {:<46} {:>7} {:>9} {:>7} {:>9} {:>11}  sets",
        "idExp", "Cardmarket slug", "singles", "harvested", "linked", "generated", "style ok"
    );
    for r in &outcome.expansions {
        println!(
            "{:<6} {:<46} {:>7} {:>9} {:>7} {:>9} {:>5}/{:<5}  {}",
            r.id,
            if r.slug.is_empty() { "-" } else { r.slug.as_str() },
            r.singles,
            r.harvested,
            r.linked,
            r.generated,
            r.style_check.1,
            r.style_check.0,
            r.sets.join(" ")
        );
    }
    println!();
    println!(
        "EN printings linked: {} of {} ({:.1}%): {harvested} harvested URLs, {generated} generated",
        outcome.links.len(),
        outcome.en_cards,
        100.0 * outcome.links.len() as f64 / outcome.en_cards.max(1) as f64
    );
    println!(
        "regular-printing-first check: {}/{} harvested repeated names",
        outcome.order_check.1, outcome.order_check.0
    );
    println!("EN printings without a link:");
    for (reason, n) in &outcome.unmatched {
        println!("  {n:>6}  {reason}");
    }
    println!("Cardmarket singles without a Pokoin printing:");
    for (reason, n) in &outcome.unmatched_products {
        println!("  {n:>6}  {reason}");
    }
    for (reason, list) in &outcome.samples {
        println!("e.g. {reason}:");
        for s in list {
            println!("    {s}");
        }
    }

    let path = sources::raw_dir(&o.cache).join("cardmarket-links.json");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let jp = if o.jp_twins {
        let dir = o.images.clone().unwrap_or_else(|| {
            o.cache.join("images").join(game.slug.replace('_', "-"))
        });
        let scans = twins::scan_index(&dir);
        let jp = twins::run(&cards, &outcome, &scans, o.max_art_distance);
        report_twins(&jp, &dir, scans.len(), o.max_art_distance);
        Some(jp)
    } else {
        None
    };
    let body = json!({
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "game": game.slug,
        "outcome": outcome,
        "jpTwins": jp,
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&body).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    println!();
    println!("wrote {}", path.display());

    let chosen: Vec<&links::Link> = outcome
        .links
        .iter()
        .filter(|l| o.generated || !l.generated)
        .collect();
    if let Some(jp) = jp.as_ref().filter(|_| o.apply_jp) {
        if !db::has_table(&pool, "public.pokoin_printing_cm_links")
            .await
            .map_err(|e| e.to_string())?
        {
            return Err("public.pokoin_printing_cm_links is missing: apply scripts/sql/130_printing_cm_links.sql".into());
        }
        let rows: Vec<db::PrintingLinkRow> = jp
            .links
            .iter()
            .map(|l| db::PrintingLinkRow {
                public_id: l.card_id,
                blueprint_id: l.blueprint_id,
                url: &l.url,
                product: l.product,
                method: l.method,
                series: &l.twin_collector,
            })
            .collect();
        let (written, skipped) = db::store_printing_links(&pool, JP_TWIN_SOURCE, &rows)
            .await
            .map_err(|e| e.to_string())?;
        println!("wrote {written} Japanese twin links, skipped {skipped} (rows of another source)");
    } else if let Some(jp) = &jp {
        println!("dry run: --apply-jp writes {} Japanese twin links to public.pokoin_printing_cm_links", jp.links.len());
    }
    if !o.apply {
        println!(
            "dry run: --apply writes {} links to public.marketplace_cm_verified_links{}",
            chosen.len(),
            if o.generated { "" } else { " (add --generated for the generated URLs)" }
        );
        return Ok(0);
    }
    let rows: Vec<db::LinkRow> = chosen
        .iter()
        .map(|l| db::LinkRow {
            blueprint_id: l.blueprint_id,
            url: &l.url,
            product_slug: links::split_url(&l.url).map(|(_, s)| s).unwrap_or(""),
            name: &l.name,
            set_name: &l.set_name,
            collector: &l.collector,
            notes: format!(
                "CM product {}; {}; {}",
                l.product,
                l.method,
                if l.generated { "generated URL" } else { "harvested URL" }
            ),
        })
        .collect();
    let (written, skipped) = db::store_links(&pool, LINKS_SOURCE, &rows)
        .await
        .map_err(|e| e.to_string())?;
    println!("wrote {written} links, skipped {skipped} (manual rows or URLs held by another printing)");
    Ok(0)
}

async fn run_prices(o: &Options) -> Result<i32, String> {
    let game = o
        .game
        .as_ref()
        .ok_or_else(|| format!("{} needs a known --game", o.command))?;
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

/// Keep only the newest 3 cached `price_guide_<idGame>-*.json` files of one
/// game (they are large; Magic's is ~30 MB). The day is in the file name, so
/// a name sort is oldest first.
fn prune_guide_cache(cache: &Path, cardmarket_game: i64) {
    let dir = sources::raw_dir(cache).join("cardmarket").join("price-guide");
    let prefix = format!("price_guide_{cardmarket_game}-");
    let mut files: Vec<PathBuf> = match std::fs::read_dir(&dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with(&prefix) && n.ends_with(".json"))
                    .unwrap_or(false)
            })
            .collect(),
        Err(_) => return,
    };
    files.sort();
    if files.len() > 3 {
        for old in &files[..files.len() - 3] {
            let _ = std::fs::remove_file(old);
        }
    }
}

/// Load a TCGNotify dump (`--file`: the merged `/api/products` walk, either a
/// bare array or one page) into `tcgnotify_price_guide` (migration 140). The
/// game and day come from each product, so one dump writes several runs. One
/// JSON line per game and day; a failing group does not stop the others.
async fn run_tcgnotify(o: &Options) -> Result<i32, String> {
    let path = o.file.as_ref().ok_or("tcgnotify needs --file <dump.json>")?;
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let (asks, skipped) = tcgnotify::parse_dump(&value)?;
    if asks.is_empty() {
        return Err(format!("{}: no usable products ({skipped} skipped)", path.display()));
    }
    let mut groups: HashMap<(String, String), Vec<tcgnotify::Ask>> = HashMap::new();
    for ask in asks {
        groups.entry((ask.game.clone(), ask.day.clone())).or_default().push(ask);
    }
    // Writable even for a dry run: a read-only session rejects the insert into
    // the permanent table, and without --apply the transaction rolls back.
    let write = db::connect("pokoin_marketplace", false).await?;
    if !db::has_table(&write, "public.tcgnotify_price_guide")
        .await
        .map_err(|e| e.to_string())?
    {
        return Err(
            "tcgnotify_price_guide is not migrated; apply scripts/sql/140_tcgnotify_price_guide.sql".into(),
        );
    }
    let mut keys: Vec<(String, String)> = groups.keys().cloned().collect();
    keys.sort();
    let mut failed = false;
    for (game, day) in keys {
        let rows = &groups[&(game.clone(), day.clone())];
        match db::store_asks(&write, &game, &day, rows, o.apply).await {
            Ok((products, changed)) => println!(
                "{}",
                json!({"game": game, "day": day, "apply": o.apply,
                       "products": products, "changed": changed})
            ),
            Err(error) => {
                failed = true;
                eprintln!("{game} {day}: {error}");
                println!("{}", json!({"game": game, "day": day, "apply": o.apply, "error": error.to_string()}));
            }
        }
    }
    if skipped > 0 {
        eprintln!("skipped {skipped} products with no id, day or known game");
    }
    Ok(if failed { 1 } else { 0 })
}

/// Load one CTCMDeals harvest (`--file`: the run's `minimums.jsonl`, or its
/// `latest.json` index) into `cardmarket_offer_minimums` (migration 141): one
/// row per product facet, the newest observation only, so the pricer can quote
/// what a professional Cardmarket seller asks without asking Cardmarket again.
/// One JSON line, dry run without `--apply`, like `guides`.
async fn run_cm_offers(o: &Options) -> Result<i32, String> {
    let path = o.file.as_ref().ok_or("cm-offers needs --file <minimums.jsonl>")?;
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let (minimums, skipped) = cm_offers::parse_minimums(&text)?;
    if minimums.is_empty() {
        return Err(format!(
            "{}: no usable facet minimum ({} records skipped)",
            path.display(),
            skipped
        ));
    }
    // Writable even for a dry run: a read-only session rejects the insert into
    // the permanent table, and without --apply the transaction rolls back.
    let write = db::connect("pokoin_marketplace", false).await?;
    if !db::has_table(&write, "public.cardmarket_offer_minimums")
        .await
        .map_err(|e| e.to_string())?
    {
        return Err(
            "cardmarket_offer_minimums is not migrated; apply scripts/sql/141_cardmarket_offer_minimums.sql".into(),
        );
    }
    let (facets, changed) = db::store_offer_minimums(&write, &minimums, o.apply)
        .await
        .map_err(|e| e.to_string())?;
    println!(
        "{}",
        json!({"apply": o.apply, "facets": facets, "changed": changed, "skipped": skipped})
    );
    Ok(0)
}

/// One JSON line per game; a failing game does not stop the others, but the
/// process exits 1 when any game failed.
async fn run_guides(o: &Options) -> Result<i32, String> {
    let games: Vec<&'static guides::GuideGame> = match &o.guide_slug {
        Some(slug) => vec![guides::guide_game(slug)
            .ok_or_else(|| format!("unknown guide game {slug}"))?],
        None => guides::GUIDE_GAMES.iter().collect(),
    };
    let mut failed = false;
    for g in games {
        match run_guide(o, g).await {
            Ok(line) => println!("{}", serde_json::to_string(&line).map_err(|e| e.to_string())?),
            Err(error) => {
                failed = true;
                eprintln!("{}: {error}", g.slug);
                println!(
                    "{}",
                    json!({"game": g.slug, "idGame": g.cardmarket_game, "apply": o.apply, "error": error})
                );
            }
        }
    }
    Ok(if failed { 1 } else { 0 })
}

async fn run_guide(o: &Options, g: &'static guides::GuideGame) -> Result<serde_json::Value, String> {
    let cache = o.cache.join(g.slug);
    let (_path, guide) = sources::price_guide(&cache, g.cardmarket_game, None).await?;
    prune_guide_cache(&cache, g.cardmarket_game);
    let day = chrono::NaiveDate::parse_from_str(
        guide
            .created_at
            .get(..10)
            .ok_or_else(|| format!("price guide createdAt {} has no day", guide.created_at))?,
        "%Y-%m-%d",
    )
    .map_err(|e| format!("price guide createdAt {}: {e}", guide.created_at))?;
    // The products this game's catalog references (read-only on the game's db).
    let catalog = db::connect(&g.database(), true).await?;
    let referenced = db::referenced_products(&catalog, &g.catalog_table())
        .await
        .map_err(|e| format!("referenced products of {}: {e}", g.catalog_table()))?;
    let kept = guides::filter_rows(&guide.rows, &referenced);
    guides::sanity_check(referenced.len(), kept.len())?;
    let rows: Vec<PriceGuide> = kept.into_iter().cloned().collect();
    // Writable even for a dry run: a read-only session rejects the insert into
    // the permanent table, and without --apply the transaction rolls back.
    let write = db::connect("pokoin_marketplace", false).await?;
    if !db::has_table(&write, "public.cardmarket_price_guide")
        .await
        .map_err(|e| e.to_string())?
    {
        return Err(
            "public.cardmarket_price_guide is missing: apply scripts/sql/139_pricer_sources.sql"
                .into(),
        );
    }
    let (products, changed) = db::store_guide_changes(
        &write,
        g.slug,
        g.cardmarket_game,
        &day.to_string(),
        &rows,
        o.apply,
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(json!({
        "game": g.slug,
        "idGame": g.cardmarket_game,
        "day": day.to_string(),
        "guideRows": guide.rows.len(),
        "referenced": referenced.len(),
        "products": products,
        "changed": changed,
        "apply": o.apply,
    }))
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
