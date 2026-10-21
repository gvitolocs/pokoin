//! Time the inventory price check (`price_check::handle`) for one seller's
//! listings, page by page, the way the MyPokoin board asks: one request per
//! game and page, at most 100 items each.
//!
//! ```text
//! MARKETPLACE_DATABASE_URL=postgres://… cargo run --release -p pokoin-external \
//!   --example price_check_bench -- <seller uid> [page size, default 50] [game filter] [status filter]
//! ```
//!
//! Against a database without the price store (`cardtrader_facet_prices`) the
//! handler prices live (pro floor over the book, the PKP3 file); with a
//! fresh store it reads the store. Prints one JSON line per page and a
//! summary. Read-only.
use std::time::Instant;

use pokoin_external::db::DbPools;
use pokoin_external::price_check;
use serde_json::{json, Value};

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let seller = args.next().expect("seller uid");
    let page: usize = args.next().and_then(|v| v.parse().ok()).unwrap_or(50).clamp(1, 100);
    let game_filter = args.next().unwrap_or_default();
    let status_filter = args.next().unwrap_or_default();
    let db = DbPools::from_env(4).await.expect("database");
    let rows = db
        .query(
            "pokemon",
            "select card_id, condition, language, foil_state, reverse, first_edition, graded, signed, altered,
                    coalesce(nullif(marketplace_game, ''), 'pokemon') as marketplace_game
             from public.marketplace_user_listings
             where seller_uid = $1 and status in ('active', 'paused') and quantity_available > 0
               and card_id ~ '^[0-9]+$'
               and ($2 = '' or coalesce(nullif(marketplace_game, ''), 'pokemon') = $2)
               and ($3 = '' or status = $3)
             order by price_pkn desc, created_at desc",
            &[json!(seller), json!(game_filter), json!(status_filter)],
        )
        .await
        .expect("listings");
    let mut timings = Vec::new();
    let mut priced = 0usize;
    let mut total = 0usize;
    let started = Instant::now();
    for (index, chunk) in rows.chunks(page).enumerate() {
        let mut by_game: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        for row in chunk {
            let item = pokoin_external::facet_store::item_from_listing(row);
            let flags: String = [
                (item.reverse, 'R'),
                (item.first_edition, 'F'),
                (item.foil, 'H'),
                (item.graded, 'G'),
                (item.signed, 'S'),
                (item.altered, 'A'),
            ]
            .iter()
            .filter(|(on, _)| *on)
            .map(|(_, flag)| *flag)
            .collect();
            let game = row["marketplace_game"].as_str().unwrap_or("pokemon").to_string();
            by_game.entry(game).or_default().push(format!("{}:{}:{}:{}", item.card_id, item.condition, item.language, flags));
        }
        let page_started = Instant::now();
        let mut page_priced = 0usize;
        // The board sends the games of a page at once.
        let answers = futures_util::future::join_all(by_game.iter().map(|(game, items)| {
            let db = db.clone();
            let raw = items.join(",");
            async move { (game.clone(), price_check::handle(&db, game, &raw, "").await) }
        }))
        .await;
        for (game, answer) in answers {
            let prices = answer.unwrap_or_else(|error| panic!("{game}: {error}"));
            for item in &by_game[&game] {
                total += 1;
                if prices["prices"][item]["ctMatchedPkn"].as_f64().is_some_and(|pkn| pkn > 0.0) {
                    priced += 1;
                    page_priced += 1;
                }
            }
        }
        let ms = page_started.elapsed().as_secs_f64() * 1000.0;
        timings.push(ms);
        println!("{}", json!({"page": index + 1, "items": chunk.len(), "priced": page_priced, "ms": (ms * 10.0).round() / 10.0}));
    }
    let mut sorted = timings.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let pct = |p: f64| sorted.get(((sorted.len() as f64 - 1.0) * p).round() as usize).copied().unwrap_or(0.0);
    let summary: Value = json!({
        "seller": seller, "listings": rows.len(), "pageSize": page, "pages": timings.len(),
        "priced": priced, "unpriced": total - priced,
        "firstPageMs": timings.first().copied().unwrap_or(0.0).round(),
        "p50Ms": pct(0.5).round(), "p95Ms": pct(0.95).round(), "maxMs": pct(1.0).round(),
        "allPagesMs": (started.elapsed().as_secs_f64() * 1000.0).round(),
    });
    println!("summary {summary}");
}
