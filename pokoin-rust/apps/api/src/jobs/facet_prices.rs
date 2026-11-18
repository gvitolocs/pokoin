//! `job cardtrader-facet-prices [--game=<slug>] [--dry-run]`
//!
//! Refills the CardTrader price store (`cardtrader_facet_prices`,
//! `pokoin_external::facet_store`, docs/PRICING.md "Price store"): Pokémon
//! from the professional-seller floor of the current daily book, computed on
//! the writer; every other game from its CardRails PKP3 price file. Each game
//! is its own writer transaction that writes only changed rows, deletes the
//! vanished ones and refuses to drop more than half of a game's rows. A game
//! without a price file is skipped. `--dry-run` rolls every game back.
//!
//! Prints one JSON line per game; exits non-zero when any game failed.
use super::Options;
use anyhow::{bail, Result};
use pokoin_external::{facet_store, price_book};
use serde_json::json;
use std::time::Instant;

pub(super) async fn run(options: &Options) -> Result<()> {
    let read = super::read_pool().await?;
    let writer = super::writer_pool(&read).await?;
    let games: Vec<&str> = match options.game.as_deref() {
        Some(game) => {
            let all = facet_store::games();
            match all.into_iter().find(|known| *known == game) {
                Some(known) => vec![known],
                None => bail!("unknown game {game}"),
            }
        }
        None => facet_store::games(),
    };
    let mut failed = Vec::new();
    for game in games {
        let started = Instant::now();
        let outcome = if game == "pokemon" {
            facet_store::refill_pokemon(&writer, options.dry_run).await.map_err(|e| e.to_string())
        } else {
            match price_book::download(game).await {
                Ok(asks) => facet_store::refill_zero(&writer, game, &asks, options.dry_run)
                    .await
                    .map_err(|e| e.to_string()),
                Err(error) if facet_store::missing_file(&error) => {
                    println!("{}", json!({"game": game, "skipped": "no_price_file"}));
                    continue;
                }
                Err(error) => Err(error),
            }
        };
        match outcome {
            Ok(report) => {
                let mut line = report.to_json();
                line["ms"] = json!(started.elapsed().as_millis() as u64);
                println!("{line}");
            }
            Err(error) => {
                println!("{}", json!({"game": game, "error": error}));
                failed.push(game);
            }
        }
    }
    if !failed.is_empty() {
        bail!("price store refill failed for {}", failed.join(", "));
    }
    Ok(())
}
