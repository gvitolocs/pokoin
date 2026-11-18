//! Nightly CardTrader sold graph for every game, from the stored listing books.
//!
//! The Pokémon graph comes from the Oracle job, which fetches the Pokémon
//! expansions again and runs the writer's persist SQL. The other games had
//! books and a price cache but no sold graph. This job replays the same rules
//! (seller-stack identity, 3-day minimum age, 3 complete absences, continuity,
//! vacation, store withdrawal) over the nights already on disk and writes only
//! `cardtrader_sold_daily` into each game database, so the per-listing history
//! never reaches the Pi replica. See `docs/CARDTRADER_DAILY_DUMP.md`.

pub mod db;
pub mod engine;
pub mod fx;
pub mod listing;
pub mod nights;
pub mod run;
pub mod sold;

pub use run::run;
