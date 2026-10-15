//! Nightly CardTrader price cache for every game.
//!
//! Reads one run folder of listing books and writes each game database's
//! `cardtrader_blueprint_listing_cache`, using the Oracle job's eligibility
//! and ranking rules. See `docs/CARDTRADER_DAILY_DUMP.md`.

mod books;
mod db;
mod eligibility;
mod money;
mod rank;
mod run;

pub use books::{ingest_books, read_listing_book, Ingest};
pub use db::{ensure_schema, native_blueprint_id, write_cache, CacheRow, BATCH};
pub use eligibility::{eligible_cardtrader, flag_is_true, is_one_day_ready, shipping_mode};
pub use money::{checkout_rate, format_rat, parse_rat, price_to_pkn, Rat};
pub use rank::{rank, Offer, Provider, Winner};
pub use run::{cache_row, pokoin_card_id_for_winner, run};
