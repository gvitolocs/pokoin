//! `refresh_cardtrader_sold_daily`: observations → one row per blueprint, day
//! and slice (condition × language × reverse/foil × 1st edition × graded).

use std::collections::{BTreeMap, BTreeSet};

use crate::fx::{FxMap, FxSet};

use crate::engine::{Day, Engine, Reason, Status, MIN_AGE_DAYS};
use crate::listing::{sold_condition, Strings, EMPTY};

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SoldKey {
    pub blueprint: i64,
    pub day: Day,
    pub condition: String,
    pub language: String,
    /// Pokémon reverse holo; the game's foil elsewhere.
    pub reverse: bool,
    pub first_edition: bool,
    pub graded: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SoldRow {
    pub key: SoldKey,
    pub median_pkn: f64,
    pub min_pkn: f64,
    pub max_pkn: f64,
    pub sold_qty: i64,
    pub listings: i64,
    pub sample_count: i64,
    pub graded_comments: Vec<String>,
}

/// Rows for removed days in `[from, to]`, from the engine's final state (the
/// last night's full rebuild).
pub fn sold_rows(engine: &Engine, strings: &Strings, from: Day, to: Day) -> Vec<SoldRow> {
    // once_sold: a vanished listing counts on exactly one day.
    let mut sale_days: FxMap<u64, BTreeSet<Day>> = FxMap::default();
    for episode in engine
        .episodes
        .iter()
        .filter(|e| e.observed && e.reason != Reason::QuantityDecreased)
    {
        sale_days
            .entry(episode.listing.id)
            .or_default()
            .insert(episode.removed_day);
    }
    let live: FxSet<u64> = engine.live_listing_ids();

    let mut groups: BTreeMap<SoldKey, (Vec<f64>, i64, BTreeSet<String>)> = BTreeMap::new();
    for episode in &engine.episodes {
        if !episode.observed
            || episode.status != Status::Provisional
            || !episode.reason.is_sale()
            || episode.removed_day < from
            || episode.removed_day > to
            || episode.first_seen > episode.removed_day - MIN_AGE_DAYS
        {
            continue;
        }
        let Some(price) = episode.listing.price_pkn.filter(|price| *price > 0.0) else {
            continue;
        };
        if episode.reason == Reason::InferredSale {
            let once = sale_days
                .get(&episode.listing.id)
                .is_some_and(|days| days.len() == 1);
            if !once || live.contains(&episode.listing.id) {
                continue;
            }
        }
        let condition = strings.get(episode.listing.condition);
        let condition = if condition.is_empty() {
            "NM"
        } else {
            condition
        };
        let Some(condition) = sold_condition(condition) else {
            continue;
        };
        let language = strings.get(episode.listing.sold_language).to_string();
        if language.is_empty() {
            continue;
        }
        let key = SoldKey {
            blueprint: episode.listing.blueprint,
            day: episode.removed_day,
            condition,
            language,
            reverse: episode.listing.foil != EMPTY,
            first_edition: episode.listing.first_edition,
            graded: episode.listing.graded,
        };
        let entry = groups.entry(key).or_default();
        entry.0.push(price);
        entry.1 += i64::from(episode.listing.quantity);
        if episode.listing.graded {
            if let Some(comment) = &episode.listing.comment {
                entry.2.insert(comment.to_string());
            }
        }
    }
    groups
        .into_iter()
        .map(|(key, (mut prices, quantity, comments))| {
            prices.sort_by(f64::total_cmp);
            let count = prices.len() as i64;
            SoldRow {
                graded_comments: if key.graded {
                    comments.into_iter().collect()
                } else {
                    Vec::new()
                },
                key,
                median_pkn: percentile_cont(&prices, 0.5),
                min_pkn: prices[0],
                max_pkn: prices[prices.len() - 1],
                sold_qty: quantity,
                listings: count,
                sample_count: count,
            }
        })
        .collect()
}

/// Postgres `percentile_cont` over sorted values.
pub fn percentile_cont(sorted: &[f64], fraction: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let position = fraction * (sorted.len() - 1) as f64;
    let low = position.floor() as usize;
    let high = position.ceil() as usize;
    sorted[low] + (sorted[high] - sorted[low]) * (position - low as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_interpolates_like_postgres() {
        assert_eq!(percentile_cont(&[1.0], 0.5), 1.0);
        assert_eq!(percentile_cont(&[1.0, 4.0], 0.5), 2.5);
        assert_eq!(percentile_cont(&[1.0, 2.0, 10.0], 0.5), 2.0);
    }
}
