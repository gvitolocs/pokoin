//! The daily Cardmarket watchlist: which products the price collector is told
//! to open today, in the order it should open them, each with the reason it
//! earned its place.
//!
//! The collector (project `cm-price-engine`, another repository) can afford
//! about 1,200 product pages a day, and Cardmarket answers a page per
//! condition. The owner's decision of 2026-11-18 is that those pages go to the
//! cards that were looked at, listed or scanned lately — everything viewed
//! cannot be visited daily. Which cards those are, and which Cardmarket
//! product each one is, is decided here by one read-only statement over the
//! writer, ranked and capped, and handed over as a JSONL file: that file is
//! the whole contract between the two repositories
//! (`reports/cm-conditions/site-side.md` §3.4, work item W2).
//!
//! The key chain (§2.1) the statement walks:
//!
//! ```text
//!   marketplace_card_events.card_id     bigint
//!   marketplace_user_listings.card_id   text   ┐ each guarded and grouped
//!   scan_items.card_id                  text   ┘ before any cast
//!     → marketplace_search_candidates.card_id → .ct_id
//!     → cardtrader_pokemon_blueprints.id → card_market_ids[] → idProduct
//! ```
//!
//! Why the statement is shaped this way, on the production sizes it runs
//! against (643,000 event rows, 326 MB; 16,228 active listings on 9,262 cards;
//! 355 scan rows):
//!
//! * **The event leg reads the window, not the table.** Its only predicate is
//!   `occurred_at >= now() - days`, so `marketplace_card_events_recent_idx
//!   (occurred_at desc, card_id)` can serve the range and nothing else is
//!   filtered out first — no `event_type` list, since the ranking weight
//!   already says what an event was worth (`view 1, search 2, click 4,
//!   cart_add 8, reserve 10, sale 20`, `crates/commerce/src/handlers/cart.rs:893`)
//!   and a reason must not depend on the spelling of a type. The 30-day window
//!   is 456,000 rows; 7 days is a tenth of that.
//! * **A text id is never cast where an index lives.** The listings leg filters
//!   on bare `card_id`, `status` and `quantity_available`, which is the
//!   partial `marketplace_user_listings_card_active_idx (card_id, price_pkn)
//!   where status = 'active' and quantity_available > 0`; the `::bigint`
//!   happens in the same statement's projection, i.e. once per distinct card
//!   group (~9,000 rows), never per listing row and never on the indexed
//!   column. The events leg joins on bigint to bigint, so it casts nothing.
//! * **A cast that cannot fail.** Both text sources carry
//!   `~ '^[0-9]{1,18}$'` before the cast, so a non-numeric id is dropped
//!   instead of aborting the statement, and 18 digits is what a bigint holds.
//! * **Everything is deduped twice, then ranked once.** One card keeps its
//!   strongest reason (`distinct on (card_id)` over `REASONS` order), one
//!   product keeps the strongest card that asked for it (`distinct on
//!   (id_product)`) so the walk never opens a page twice, then `row_number()`
//!   fixes the day's order and `--cap` cuts it.

use sqlx::postgres::{PgConnection, PgPool, PgRow};
use sqlx::Row;

use crate::db;

/// Days of `marketplace_card_events` a card stays on the list for (`--days`).
pub const DEFAULT_DAYS: i32 = 7;

/// Products one day of collecting can afford (`--cap`).
pub const DEFAULT_CAP: i64 = 1_200;

/// How long a scan keeps a card on the list, fixed whatever `--days` says: the
/// scan table is tiny and a scanned card is stock the seller still holds.
pub const SCAN_DAYS: i32 = 30;

/// The game whose listings count. `cardtrader_pokemon_blueprints` is the
/// Pokémon blueprint table and card ids are only unique inside a game, so a
/// Magic listing must not rank a Pokémon card.
pub const GAME: &str = "pokemon";

/// How long this read may run before Postgres stops it. A daily list is a
/// planning read, not an export of the log: it either answers in seconds or the
/// window it asked for was wrong.
pub const STATEMENT_TIMEOUT_SECS: u64 = 30;

/// The reasons, strongest first. A card that is both a member view and a
/// listing is priced as the member view. This array is bound as `$4` and the
/// statement orders by `array_position` in it, so the order here *is* the
/// precedence Postgres applies; the only thing that has to agree with it is the
/// reason label each branch of the statement writes, which the tests check.
pub const REASONS: [&str; 4] = ["viewed_member", "listed", "scanned", "viewed"];

/// The values `WATCHLIST_SQL` takes.
pub const PARAMS: usize = 5;

/// The card-id guard: plain decimal, at most `bigint` worth of digits.
pub const ID_GUARD: &str = "^[0-9]{1,18}$";

/// One read-only statement: the window, the three sources, the reason per card,
/// the products per card, the rank, the cap and the counts either side of it.
/// Every value is a positional bind — `$1` event days, `$2` scan days, `$3`
/// cap, `$4` reason precedence, `$5` game.
pub const WATCHLIST_SQL: &str = r#"
with ev as (
  select e.card_id,
         count(*) filter (where e.user_uid is not null) as member_hits,
         coalesce(sum(e.weight) filter (where e.user_uid is not null), 0) as member_weight,
         max(e.occurred_at) filter (where e.user_uid is not null) as member_at,
         count(*) filter (where e.user_uid is null) as guest_hits,
         coalesce(sum(e.weight) filter (where e.user_uid is null), 0) as guest_weight,
         max(e.occurred_at) filter (where e.user_uid is null) as guest_at
    from public.marketplace_card_events e
   where e.occurred_at >= now() - ($1 * interval '1 day')
   group by e.card_id
),
listed as (
  select l.card_id::bigint as card_id, count(*) as listings, max(l.updated_at) as last_at
    from public.marketplace_user_listings l
   where l.marketplace_game = $5
     and l.status = 'active'
     and l.quantity_available > 0
     and l.card_id ~ '^[0-9]{1,18}$'
   group by l.card_id
),
scanned as (
  select s.card_id::bigint as card_id, count(*) as scans, max(s.captured_at) as last_at
    from public.scan_items s
   where s.captured_at >= now() - ($2 * interval '1 day')
     and s.card_id ~ '^[0-9]{1,18}$'
   group by s.card_id
),
reasons as (
  select card_id, 'viewed_member' as reason, member_weight as weight, member_at as last_at
    from ev where member_hits > 0
  union all
  select card_id, 'listed', listings::numeric, last_at from listed
  union all
  select card_id, 'scanned', scans::numeric, last_at from scanned
  union all
  select card_id, 'viewed', guest_weight, guest_at from ev where guest_hits > 0
),
picked as (
  select distinct on (card_id) card_id, reason, weight, last_at
    from reasons
   order by card_id, array_position($4::text[], reason) nulls last,
            weight desc nulls last, last_at desc nulls last
),
lines as (
  select p.card_id, p.reason, p.weight, p.last_at, pm.id::bigint as id_product
    from picked p
    join public.marketplace_search_candidates c on c.card_id = p.card_id
    join public.cardtrader_pokemon_blueprints b on b.id = c.ct_id
   cross join lateral jsonb_array_elements_text(
             case when jsonb_typeof(b.card_market_ids) = 'array'
                  then b.card_market_ids else '[]'::jsonb end) pm(id)
    where pm.id ~ '^[0-9]{1,18}$'
),
products as (
  select distinct on (id_product) card_id, reason, weight, last_at, id_product
    from lines
   order by id_product, array_position($4::text[], reason) nulls last,
            weight desc nulls last, last_at desc nulls last, card_id
),
ranked as (
  select id_product, card_id, reason, weight, last_at,
         row_number() over (order by array_position($4::text[], reason) nulls last,
                                    weight desc nulls last, last_at desc nulls last,
                                    card_id, id_product) as rank
    from products
),
counts as (
  select reason, count(*) as total, count(*) filter (where rank <= $3) as kept
    from ranked group by reason
)
select 'line' as kind, id_product, card_id::text as card_id, reason, rank,
       null::bigint as total, null::bigint as kept
  from ranked where rank <= $3
union all
select 'reason', null::bigint, null::text, reason, null::bigint, total, kept
  from counts
 order by 1, 5 nulls last
"#;

/// One line of the exported list: a Cardmarket product, the Pokoin card that
/// asked for it, why, and its place in the day.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id_product: i64,
    pub card_id: String,
    pub reason: String,
    pub rank: i64,
}

/// How many lines one reason had before `--cap` and how many it kept.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReasonCount {
    pub reason: String,
    pub total: i64,
    pub kept: i64,
}

/// What one run answered.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Run {
    pub entries: Vec<Entry>,
    pub counts: Vec<ReasonCount>,
}

/// What the day asks for: `--days` of events and `--cap` products.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Watchlist {
    pub days: i32,
    pub cap: i64,
}

impl Default for Watchlist {
    fn default() -> Self {
        Self {
            days: DEFAULT_DAYS,
            cap: DEFAULT_CAP,
        }
    }
}

impl Watchlist {
    /// The statement's values in bind order, so the order cannot drift from the
    /// `$1..$5` the statement documents.
    pub fn binds(&self) -> (i32, i32, i64, Vec<String>, String) {
        (
            self.days,
            SCAN_DAYS,
            self.cap,
            REASONS.iter().map(|reason| (*reason).to_string()).collect(),
            GAME.to_string(),
        )
    }
}

/// A reason's place in `REASONS`, strongest first; `None` for a label this
/// build does not know.
pub fn priority(reason: &str) -> Option<usize> {
    REASONS.iter().position(|label| *label == reason)
}

/// One JSONL line: `{"idProduct":123,"cardId":"456","reason":"listed","rank":17}`.
/// `cardId` is a string because the collector joins it back to Pokoin ids that
/// are text in the listing and scan tables.
pub fn line(entry: &Entry) -> String {
    serde_json::json!({
        "idProduct": entry.id_product,
        "cardId": entry.card_id,
        "reason": entry.reason,
        "rank": entry.rank,
    })
    .to_string()
}

/// The whole file: one line per product, each ending in a newline.
pub fn body(entries: &[Entry]) -> String {
    let mut out = String::with_capacity(entries.len() * 80);
    for entry in entries {
        out.push_str(&line(entry));
        out.push('\n');
    }
    out
}

/// The counts text: per reason, how many products the day had before the cap
/// and how many it kept, strongest reason first.
pub fn report(list: &Watchlist, run: &Run) -> String {
    let ranked: i64 = run.counts.iter().map(|count| count.total).sum();
    let width = REASONS.iter().map(|reason| reason.len()).max().unwrap_or(0);
    let mut out = format!(
        "watchlist: {} lines kept of {} ranked (events {} days, scans {} days, cap {}, game {})\n",
        run.entries.len(),
        ranked,
        list.days,
        SCAN_DAYS,
        list.cap,
        GAME,
    );
    out.push_str(&format!(
        "{:<width$}  {:>8} {:>8}\n",
        "reason",
        "before",
        "after",
        width = width
    ));
    for reason in REASONS {
        let found = run.counts.iter().find(|count| count.reason == reason);
        out.push_str(&format!(
            "{:<width$}  {:>8} {:>8}\n",
            reason,
            found.map_or(0, |count| count.total),
            found.map_or(0, |count| count.kept),
            width = width
        ));
    }
    out
}

/// Run the read on a pool connection: the session guards first, then the
/// statement, both on the same connection so the guards are the ones the
/// statement ran under.
pub async fn fetch(pool: &PgPool, list: &Watchlist) -> Result<Run, sqlx::Error> {
    let mut conn = pool.acquire().await?;
    fetch_conn(&mut conn, list).await
}

/// The same on one connection the caller holds.
pub async fn fetch_conn(conn: &mut PgConnection, list: &Watchlist) -> Result<Run, sqlx::Error> {
    db::read_session(conn, STATEMENT_TIMEOUT_SECS).await?;
    let (days, scan_days, cap, reasons, game) = list.binds();
    let rows = sqlx::query(WATCHLIST_SQL)
        .bind(days)
        .bind(scan_days)
        .bind(cap)
        .bind(reasons)
        .bind(game)
        .fetch_all(&mut *conn)
        .await?;
    decode(&rows)
}

/// Split the statement's two row kinds back into lines and counts. Lines are
/// returned in rank order, counts in `REASONS` order, whatever the server sent.
fn decode(rows: &[PgRow]) -> Result<Run, sqlx::Error> {
    let mut run = Run::default();
    for row in rows {
        let kind: String = row.try_get("kind")?;
        let reason: String = row.try_get("reason")?;
        match kind.as_str() {
            "line" => {
                let (id_product, card_id, rank) = (
                    row.try_get::<Option<i64>, _>("id_product")?,
                    row.try_get::<Option<String>, _>("card_id")?,
                    row.try_get::<Option<i64>, _>("rank")?,
                );
                match (id_product, card_id, rank) {
                    (Some(id_product), Some(card_id), Some(rank)) => run.entries.push(Entry {
                        id_product,
                        card_id,
                        reason,
                        rank,
                    }),
                    _ => {
                        return Err(sqlx::Error::Protocol(
                            "a watchlist line came back without a product, a card id or a rank"
                                .into(),
                        ))
                    }
                }
            }
            _ => {
                let (total, kept) = (
                    row.try_get::<Option<i64>, _>("total")?,
                    row.try_get::<Option<i64>, _>("kept")?,
                );
                match (total, kept) {
                    (Some(total), Some(kept)) => run.counts.push(ReasonCount {
                        reason,
                        total,
                        kept,
                    }),
                    _ => {
                        return Err(sqlx::Error::Protocol(
                            "a watchlist reason count came back without its totals".into(),
                        ))
                    }
                }
            }
        }
    }
    run.entries.sort_by_key(|entry| entry.rank);
    run.counts
        .sort_by_key(|count| priority(&count.reason).unwrap_or(REASONS.len()));
    Ok(run)
}

/// The `$n` placeholders a statement uses, in the order they appear. A `$` that
/// is a regex anchor has no digit after it and is not a placeholder.
#[cfg(test)]
fn placeholders(sql: &str) -> Vec<usize> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'$' && bytes.get(index + 1).is_some_and(u8::is_ascii_digit) {
            out.push((bytes[index + 1] - b'0') as usize);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The statement is one constant with positional binds: nothing this file
    /// knows is written into the SQL text, and every placeholder is a value the
    /// command binds.
    #[test]
    fn sql_binds_every_value() {
        let mut used = placeholders(WATCHLIST_SQL);
        used.sort_unstable();
        used.dedup();
        assert_eq!(
            used,
            (1..=PARAMS).collect::<Vec<usize>>(),
            "{WATCHLIST_SQL}"
        );
        for value in ["1200", "30", "7", "'pokemon'", "239324", "900101"] {
            assert!(
                !WATCHLIST_SQL.contains(value),
                "{value} is interpolated into the statement"
            );
        }
        // The only braces in the statement are the length bound of the id
        // guard: a pattern, not a value.
        let braces = WATCHLIST_SQL.replace(ID_GUARD, "");
        assert!(!braces.contains('{') && !braces.contains('}'));
    }

    /// A card gets one reason and it is the strongest one it earned, so the
    /// precedence lives in `REASONS` and the statement applies it as data.
    #[test]
    fn reasons_are_strongest_first_and_one_per_card() {
        assert_eq!(REASONS, ["viewed_member", "listed", "scanned", "viewed"]);
        assert_eq!(priority("viewed_member"), Some(0));
        assert_eq!(priority("listed"), Some(1));
        assert_eq!(priority("scanned"), Some(2));
        assert_eq!(priority("viewed"), Some(3));
        assert_eq!(priority("sold"), None, "an unknown reason is not a reason");
        for reason in REASONS {
            assert!(
                WATCHLIST_SQL.contains(&format!("'{reason}'")),
                "the statement never writes the reason {reason}"
            );
        }
        assert_eq!(WATCHLIST_SQL.matches("distinct on (card_id)").count(), 1);
        assert_eq!(WATCHLIST_SQL.matches("distinct on (id_product)").count(), 1);
        assert_eq!(
            WATCHLIST_SQL
                .matches("array_position($4::text[], reason)")
                .count(),
            3,
            "the card dedup, the product dedup and the rank all order by REASONS"
        );
    }

    /// Text ids are guarded before anything is cast, and the cast never sits on
    /// the indexed column where an index would have to be used.
    #[test]
    fn non_integer_card_ids_are_guarded_not_cast() {
        assert_eq!(
            WATCHLIST_SQL.matches(ID_GUARD).count(),
            3,
            "listings, scans and the unnested product ids"
        );
        assert_eq!(
            WATCHLIST_SQL.matches("card_id::bigint as card_id").count(),
            2,
            "both text sources cast after grouping, once per distinct card"
        );
        for per_row_cast in [
            "l.card_id::bigint ~",
            "s.card_id::bigint ~",
            "where l.card_id::bigint",
            "where s.card_id::bigint",
            "::bigint =",
            "= l.card_id",
            "= s.card_id",
        ] {
            assert!(
                !WATCHLIST_SQL.contains(per_row_cast),
                "{per_row_cast} filters or joins a cast column and defeats its index"
            );
        }
    }

    /// `--cap` is the third value and it is what cuts both the lines and the
    /// kept count, so the two can never disagree.
    #[test]
    fn the_cap_is_bound_where_the_day_is_cut() {
        let list = Watchlist { days: 5, cap: 40 };
        let (days, scan_days, cap, reasons, game) = list.binds();
        assert_eq!((days, scan_days, cap), (5, SCAN_DAYS, 40));
        let want: Vec<String> = REASONS.iter().map(|reason| (*reason).to_string()).collect();
        assert_eq!(reasons, want, "$4 carries the precedence order");
        assert_eq!(game, GAME);
        assert_eq!(
            WATCHLIST_SQL.matches("rank <= $3").count(),
            2,
            "the emitted lines and the kept counts use the same cap"
        );
        assert_eq!(
            Watchlist::default(),
            Watchlist {
                days: DEFAULT_DAYS,
                cap: DEFAULT_CAP
            }
        );
        assert_eq!((DEFAULT_DAYS, DEFAULT_CAP), (7, 1_200));
    }

    /// The file contract with the collector: one JSON object per product line.
    #[test]
    fn one_line_is_one_product() {
        let entry = Entry {
            id_product: 123,
            card_id: "456".into(),
            reason: "listed".into(),
            rank: 17,
        };
        assert_eq!(
            line(&entry),
            r#"{"idProduct":123,"cardId":"456","reason":"listed","rank":17}"#
        );
        let text = body(&[entry.clone(), entry.clone()]);
        assert_eq!(text.matches('\n').count(), 2, "one line per product");
        assert!(text.ends_with('\n'));
        for one in text.lines() {
            let parsed: serde_json::Value = serde_json::from_str(one).unwrap_or_default();
            assert_eq!(parsed["idProduct"], serde_json::json!(123));
            assert_eq!(parsed["cardId"], serde_json::Value::String("456".into()));
            assert_eq!(parsed["reason"], serde_json::json!("listed"));
            assert_eq!(parsed["rank"], serde_json::json!(17));
        }
    }

    /// The dry run prints what the day held before the cap and after it,
    /// strongest reason first, for all four reasons even when one is empty.
    #[test]
    fn the_dry_run_counts_both_sides_of_the_cap() {
        let run = Run {
            entries: (1..=3)
                .map(|rank| Entry {
                    id_product: 900_000 + rank,
                    card_id: rank.to_string(),
                    reason: "viewed_member".into(),
                    rank,
                })
                .collect(),
            counts: vec![
                ReasonCount {
                    reason: "viewed".into(),
                    total: 900,
                    kept: 0,
                },
                ReasonCount {
                    reason: "viewed_member".into(),
                    total: 30,
                    kept: 3,
                },
            ],
        };
        let text = report(&Watchlist::default(), &run);
        assert!(
            text.contains("3 lines kept of 930 ranked"),
            "counts before and after the cap: {text}"
        );
        assert!(text.contains("events 7 days") && text.contains("cap 1200"));
        assert!(text.contains("viewed_member        30        3"), "{text}");
        assert!(text.contains("listed                0        0"), "{text}");
        assert!(
            text.find("viewed_member").unwrap_or(usize::MAX) < text.rfind("viewed").unwrap_or(0),
            "strongest reason first: {text}"
        );
    }
}
