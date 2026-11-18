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
//! * **One card keeps one reason.** `distinct on (card_id)` over the `REASONS`
//!   array picks the strongest leg that has the card, so a card that is listed
//!   and viewed stays `listed` and is never emitted twice.
//! * **The cut is not strict precedence.** Production answered 53,468 ranked
//!   lines for a 1,200-product day: 7,084 `listed`, 46,384 `viewed`, and
//!   **zero** `viewed_member` and `scanned` — not one event of the last 30 days
//!   carries a `user_uid`, because the site does not record who viewed. Strict
//!   precedence therefore spent the whole day on listings and never priced a
//!   card a thousand people looked at this week. The statement ranks inside each
//!   reason and hands the day's order to `walk`: the head list
//!   (`viewed_member`, `scanned`) first, then `listed` and `viewed` interleaved
//!   so `--viewed-share` percent of the alternation goes to `viewed`. A listed
//!   card also carries its summed view weight, so a listed card that thousands
//!   looked at rises *inside* `listed` rather than losing its reason.
//! * **The product is de-duped by the walk, not by SQL.** Two cards can name
//!   one `idProduct`; whichever gets there first in the day's order owns it, so
//!   the walk never opens a page twice and the cap counts pages, which is what
//!   the collector's budget is measured in.

use sqlx::postgres::{PgConnection, PgPool, PgRow};
use sqlx::Row;

use crate::db;

/// Days of `marketplace_card_events` a card stays on the list for (`--days`).
pub const DEFAULT_DAYS: i32 = 7;

/// Products one day of collecting can afford (`--cap`).
pub const DEFAULT_CAP: i64 = 1_200;

/// The share of the `listed`/`viewed` alternation that goes to `viewed`, in
/// percent (`--viewed-share`). Half the day to each is the default because
/// production's day was entirely listings: 7,084 `listed` lines against 46,384
/// `viewed` ones, with the cap cutting at 1,200.
pub const DEFAULT_SHARE: i64 = 50;

/// The whole alternation, so `--viewed-share` is a percent of it. A list whose
/// share is 0 is given no slot at all — see `viewed_leads`.
pub const SHARE_TOTAL: i64 = 100;

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

/// Which of the three lists the day walks a card joins: the head
/// (`viewed_member` and `scanned`, which keep their place at the front), the
/// listings and the viewers, which interleave after it. The statement stamps the
/// number on every line; `walk` reads it.
pub const LIST_HEAD: i32 = 0;
/// The list of cards the seller has for sale.
pub const LIST_LISTED: i32 = 1;
/// The list of cards only anonymous visitors looked at.
pub const LIST_VIEWED: i32 = 2;

/// The values `WATCHLIST_SQL` takes. The viewed share is not one of them: it
/// mixes the lists after the ranking, in `walk`.
pub const PARAMS: usize = 5;

/// The card-id guard: plain decimal, at most `bigint` worth of digits.
pub const ID_GUARD: &str = "^[0-9]{1,18}$";

/// The read, as one statement. `$1` event days, `$2` scan days, `$3` cap, `$4`
/// reason precedence, `$5` game.
///
/// It returns the day's **turns**, not the day's order: every line carries the
/// list its card belongs to (`list`) and that card's place inside it (`seq`),
/// and a second kind of row carries each reason's total. How the lists are mixed
/// into one day is `walk`'s decision, in Rust, over exactly these rows; the
/// statement is what ranks inside each reason.
pub const WATCHLIST_SQL: &str = r#"
with ev as (
  select e.card_id,
         count(*) filter (where e.user_uid is not null) as member_hits,
         coalesce(sum(e.weight) filter (where e.user_uid is not null), 0) as member_weight,
         max(e.occurred_at) filter (where e.user_uid is not null) as member_at,
         count(*) filter (where e.user_uid is null) as guest_hits,
         coalesce(sum(e.weight) filter (where e.user_uid is null), 0) as guest_weight,
         max(e.occurred_at) filter (where e.user_uid is null) as guest_at,
         coalesce(sum(e.weight), 0) as view_weight,
         max(e.occurred_at) as any_at
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
  -- One row per (card, reason), on one numeric weight scale. A listing carries
  -- the views of its card as `weight` and its own listing count as `secondary`,
  -- so a listed card people looked at rises inside `listed` instead of changing
  -- reason, and `last_at` for a listing is the newest of the two activities.
  select card_id, 'viewed_member' as reason, member_weight as weight,
         0::bigint as secondary, member_at as last_at
    from ev where member_hits > 0
  union all
  select ls.card_id, 'listed', coalesce(v.view_weight, 0), ls.listings,
         greatest(v.any_at, ls.last_at)
    from listed ls left join ev v on v.card_id = ls.card_id
  union all
  select card_id, 'scanned', scans::numeric, 0, last_at from scanned
  union all
  select card_id, 'viewed', guest_weight, 0, guest_at from ev where guest_hits > 0
),
picked as (
  -- One card, one reason: the strongest `REASONS` entry it appears under, which
  -- is why a listed card that is also viewed is `listed` and appears once. That
  -- reason also decides which of the three lists the card joins.
  select distinct on (card_id) card_id, reason, weight, secondary, last_at,
         case when reason = 'listed' then 1
              when reason = 'viewed' then 2
              else 0 end as list
    from reasons
   order by card_id, array_position($4::text[], reason) nulls last,
            weight desc nulls last, last_at desc nulls last
),
offered as (
  -- The products each card can actually be priced as, *before* it is numbered.
  -- The catalog join is inner, so a card with no blueprint row or with an empty
  -- `card_market_ids` cannot be priced and drops out here — and dropping out
  -- before the numbering is what matters: a card that contributes no line must
  -- not spend a turn of its list, or the day would come up short by however many
  -- such cards the window happens to hold.
  -- The jsonb guard means a non-array value yields no rows instead of an error,
  -- and a non-numeric element is dropped by the same `ID_GUARD` the text card
  -- ids use, before `::bigint`.
  select p.card_id, p.reason, p.weight, p.secondary, p.last_at, p.list,
         array_agg(distinct pm.id::bigint order by pm.id::bigint) as products
    from picked p
    join public.marketplace_search_candidates c on c.card_id = p.card_id
    join public.cardtrader_pokemon_blueprints b on b.id = c.ct_id
   cross join lateral jsonb_array_elements_text(
             case when jsonb_typeof(b.card_market_ids) = 'array'
                  then b.card_market_ids else '[]'::jsonb end) pm(id)
    where pm.id ~ '^[0-9]{1,18}$'
   group by p.card_id, p.reason, p.weight, p.secondary, p.last_at, p.list
),
turns as (
  -- Rank *inside* each list, not across the day. The head list is one numbering
  -- across its two reasons — `array_position` puts every member view before
  -- every scan — so a turn is one card and `seq` is comparable inside a list.
  -- What is decided here is order within a reason only; how the lists are mixed
  -- is `walk`, and one global order across them is exactly what left the whole
  -- viewed list behind the listings in production and never reached it.
  select card_id, reason, list, products,
         row_number() over (partition by list
                            order by array_position($4::text[], reason) nulls last,
                                     weight desc nulls last,
                                     secondary desc nulls last,
                                     last_at desc nulls last, card_id) as seq
    from offered
),
counts as (
  -- What each reason holds before the cut, over the whole ranked day: a card
  -- with three products holds three of them, and a product two cards asked for
  -- counts for both, because that is what each reason earned. `turns` is read
  -- twice, so the planner materialises it once and the totals cost no second
  -- pass over the events.
  select reason, sum(cardinality(products)) as total
    from turns
   group by reason
)
-- Two kinds of row in one result set, `kind` naming the shape. `line` rows are
-- one per product and carry the list and that list's own numbering; `reason`
-- rows are the dry run's totals. The transfer is bounded per list at `--cap` —
-- the day's cut is `walk`'s, and a turn deeper than the cap into its own list
-- cannot reach the day whichever way the two lists are mixed.
select 'line' as kind, list, seq, id_product, card_id::text as card_id, reason,
       null::bigint as total
  from turns
  cross join lateral unnest(products) as u(id_product)
 where seq <= $3
union all
select 'reason', null::int, null::bigint, null::bigint, null::text, reason, total
  from counts
 order by 1, 2 nulls last, 3 nulls last, 4
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

/// What the day asks for: `--days` of events, `--cap` products and
/// `--viewed-share` of the alternation for the viewers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Watchlist {
    pub days: i32,
    pub cap: i64,
    pub viewed_share: i64,
}

impl Default for Watchlist {
    fn default() -> Self {
        Self {
            days: DEFAULT_DAYS,
            cap: DEFAULT_CAP,
            viewed_share: DEFAULT_SHARE,
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

/// One product one card asked for, with the list its reason put it in and its
/// place inside that list, both as the statement ranked them. Nothing here is in
/// the order of the day: that is `walk`'s doing, and keeping the two decisions
/// apart is what makes the cut testable without a database.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Line {
    pub list: i32,
    pub seq: i64,
    pub id_product: i64,
    pub card_id: String,
    pub reason: String,
}

/// One card's turn in its list: what it is, why it is on the list, and the
/// products it asked for, in the order the statement gave them.
#[derive(Debug, PartialEq, Eq)]
struct Turn<'a> {
    card_id: &'a str,
    reason: &'a str,
    products: Vec<i64>,
}

/// Collect one list's lines into turns, in the order they are walked. A card's
/// products belong to the same turn because they carry the same `seq`, and a
/// numbering the statement did not keep contiguous is still grouped correctly:
/// the walk follows the server's numbers and never re-sorts inside a list.
fn bucket<'a>(lines: &[&'a Line], list: i32) -> Vec<Turn<'a>> {
    let mut out: Vec<Turn<'a>> = Vec::new();
    let mut seq: Option<i64> = None;
    for line in lines.iter().filter(|line| line.list == list) {
        if seq != Some(line.seq) {
            seq = Some(line.seq);
            out.push(Turn {
                card_id: &line.card_id,
                reason: &line.reason,
                products: vec![line.id_product],
            });
            continue;
        }
        if let Some(turn) = out.last_mut() {
            turn.products.push(line.id_product);
        }
    }
    out
}

/// Whether `viewed`'s turn number `viewed_turn` comes before `listed`'s turn
/// number `listed_turn` when `share` percent of the alternation goes to `viewed`.
///
/// A list that gets `d` percent of the day puts its turn `k` at slot
/// `k * 100 / d`, so the two next turns are compared as `viewed_turn * 100 *
/// listed_den < listed_turn * 100 * viewed_den` — exact integer arithmetic, no
/// floats and no accumulated rounding, and at the sizes here (tens of thousands
/// of turns, denominators up to 100) it cannot overflow an `i64`. Two edges the
/// integers handle that a division would not: a share of 0 gives that list no
/// slot at all, so the other list leads every turn (share 0 is the day of
/// listings alone), and a slot exactly level goes to `listed`, so half-and-half
/// is one listing then one viewed card and never wobbles between the two.
fn viewed_leads(viewed_turn: i64, listed_turn: i64, share: i64) -> bool {
    let listed_den = SHARE_TOTAL - share;
    if share < 1 {
        return false;
    }
    if listed_den < 1 {
        return true;
    }
    viewed_turn * SHARE_TOTAL * listed_den < listed_turn * SHARE_TOTAL * share
}

/// Take one card's turn, claiming the products nobody has claimed yet. False
/// means the day is full and nothing further is walked.
fn emit(
    turn: &Turn<'_>,
    seen: &mut std::collections::HashSet<i64>,
    out: &mut Vec<Entry>,
    cap: i64,
) -> bool {
    for id_product in &turn.products {
        if out.len() as i64 >= cap {
            return false;
        }
        if seen.insert(*id_product) {
            out.push(Entry {
                id_product: *id_product,
                card_id: turn.card_id.to_string(),
                reason: turn.reason.to_string(),
                rank: out.len() as i64 + 1,
            });
        }
    }
    true
}

/// The day, in the order the collector should walk it: the head list first in
/// its own order, then `listed` and `viewed` alternating by `share` until `cap`
/// products are taken, and whichever list still has cards left fills the rest. A
/// product is emitted once, by the first card that asks for it, so a card whose
/// every product somebody else claimed earlier contributes nothing here; `rank`
/// is the position after all of that.
///
/// Pure over the statement's rows: the rows are put in list order first, so the
/// day depends on the server's `list`/`seq` numbers and not on the order the
/// rows happened to arrive in. Same rows, same share, same cap, same file.
pub fn walk(lines: &[Line], share: i64, cap: i64) -> Vec<Entry> {
    let mut ordered: Vec<&Line> = lines.iter().collect();
    ordered.sort_by_key(|line| (line.list, line.seq, line.id_product));
    let head = bucket(&ordered, LIST_HEAD);
    let listed = bucket(&ordered, LIST_LISTED);
    let viewed = bucket(&ordered, LIST_VIEWED);
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<Entry> = Vec::new();
    let mut full = false;
    for turn in &head {
        if !emit(turn, &mut seen, &mut out, cap) {
            full = true;
            break;
        }
    }
    let (mut i, mut j) = (0usize, 0usize);
    while !full && (i < listed.len() || j < viewed.len()) {
        let go_viewed = match (listed.get(i), viewed.get(j)) {
            (None, Some(_)) => true,
            (Some(_), None) | (None, None) => false,
            (Some(_), Some(_)) => viewed_leads(j as i64 + 1, i as i64 + 1, share),
        };
        let turn = if go_viewed { &viewed[j] } else { &listed[i] };
        if !emit(turn, &mut seen, &mut out, cap) {
            full = true;
        }
        if go_viewed {
            j += 1;
        } else {
            i += 1;
        }
    }
    out
}

/// The answer of one run: the walked day and, for each reason, how many products
/// it had before the cut (`total`, from the statement over the whole ranked day)
/// and how many it kept (`kept`, from the walk).
pub fn rank(lines: &[Line], totals: &[ReasonCount], share: i64, cap: i64) -> Run {
    let entries = walk(lines, share, cap);
    let mut counts = totals.to_vec();
    for count in &mut counts {
        count.kept = entries
            .iter()
            .filter(|entry| entry.reason == count.reason)
            .count() as i64;
    }
    counts.sort_by_key(|count| priority(&count.reason).unwrap_or(REASONS.len()));
    Run { entries, counts }
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

/// The counts text: the cut that was applied, then per reason how many products
/// the day had before the cap and how many it kept, strongest reason first.
pub fn report(list: &Watchlist, run: &Run) -> String {
    let ranked: i64 = run.counts.iter().map(|count| count.total).sum();
    let width = REASONS.iter().map(|reason| reason.len()).max().unwrap_or(0);
    let mut out = format!(
        "watchlist: {} lines kept of {} ranked (events {} days, scans {} days, cap {}, viewed share {}%, game {})\n",
        run.entries.len(),
        ranked,
        list.days,
        SCAN_DAYS,
        list.cap,
        list.viewed_share,
        GAME,
    );
    out.push_str(&format!(
        "cut: {} and {} first, then {} and {} interleaved at {}% to {}\n",
        REASONS[0], REASONS[2], REASONS[1], REASONS[3], list.viewed_share, REASONS[3],
    ));
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
    let (lines, totals) = decode(&rows)?;
    Ok(rank(&lines, &totals, list.viewed_share, cap))
}

/// Split the statement's two row kinds into the day's turns and each reason's
/// total. Nothing is ordered, interleaved or capped here: `walk` does that from
/// the `list` and `seq` the server already decided.
fn decode(rows: &[PgRow]) -> Result<(Vec<Line>, Vec<ReasonCount>), sqlx::Error> {
    let mut lines: Vec<Line> = Vec::new();
    let mut totals: Vec<ReasonCount> = Vec::new();
    for row in rows {
        let kind: String = row.try_get("kind")?;
        let reason: String = row.try_get("reason")?;
        match kind.as_str() {
            "line" => {
                let (list, seq, id_product, card_id) = (
                    row.try_get::<Option<i32>, _>("list")?,
                    row.try_get::<Option<i64>, _>("seq")?,
                    row.try_get::<Option<i64>, _>("id_product")?,
                    row.try_get::<Option<String>, _>("card_id")?,
                );
                match (list, seq, id_product, card_id) {
                    (Some(list), Some(seq), Some(id_product), Some(card_id)) => lines.push(Line {
                        list,
                        seq,
                        id_product,
                        card_id,
                        reason,
                    }),
                    _ => return Err(sqlx::Error::Protocol(
                        "a watchlist line came back without a list, a turn, a product or a card id"
                            .into(),
                    )),
                }
            }
            _ => {
                let total = row.try_get::<Option<i64>, _>("total")?;
                match total {
                    Some(total) => totals.push(ReasonCount {
                        reason,
                        total,
                        kept: 0,
                    }),
                    None => {
                        return Err(sqlx::Error::Protocol(
                            "a watchlist reason count came back without its total".into(),
                        ))
                    }
                }
            }
        }
    }
    Ok((lines, totals))
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
    /// precedence lives in `REASONS` and the statement applies it as data. The
    /// reason also stamps which list the card joins; the statement never decides
    /// how the lists are mixed, and never de-dupes a product — that is `walk`.
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
        assert_eq!(
            WATCHLIST_SQL.matches("distinct on (id_product)").count(),
            0,
            "a product claimed by two cards is settled by the walk, not by SQL"
        );
        assert_eq!(
            WATCHLIST_SQL
                .matches("array_position($4::text[], reason)")
                .count(),
            2,
            "the card dedup and the per-list ranking both order by REASONS"
        );
        assert_eq!(
            WATCHLIST_SQL
                .matches("case when reason = 'listed' then 1")
                .count(),
            1,
            "the three lists are assigned from the reason, once"
        );
        assert_eq!(WATCHLIST_SQL.matches("partition by list").count(), 1);
        assert_eq!(
            (LIST_HEAD, LIST_LISTED, LIST_VIEWED),
            (0, 1, 2),
            "the numbers the statement stamps and the ones walk reads"
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

    /// `--cap` is the third value and it is bound once, to bound how deep each
    /// list is fetched. The day's own cut is not in the statement at all: it is
    /// `walk`, so the cap and the rank cannot disagree by construction.
    #[test]
    fn the_cap_is_bound_where_the_day_is_cut() {
        let list = Watchlist {
            days: 5,
            cap: 40,
            viewed_share: 25,
        };
        let (days, scan_days, cap, reasons, game) = list.binds();
        assert_eq!((days, scan_days, cap), (5, SCAN_DAYS, 40));
        let want: Vec<String> = REASONS.iter().map(|reason| (*reason).to_string()).collect();
        assert_eq!(reasons, want, "$4 carries the precedence order");
        assert_eq!(game, GAME);
        assert_eq!(
            WATCHLIST_SQL.matches("seq <= $3").count(),
            1,
            "the transfer is capped per list, and nothing else in SQL uses the cap"
        );
        assert!(
            !WATCHLIST_SQL.contains(" as rank"),
            "the statement no longer numbers across lists"
        );
        assert_eq!(
            Watchlist::default(),
            Watchlist {
                days: DEFAULT_DAYS,
                cap: DEFAULT_CAP,
                viewed_share: DEFAULT_SHARE,
            }
        );
        assert_eq!((DEFAULT_DAYS, DEFAULT_CAP, DEFAULT_SHARE), (7, 1_200, 50));
        assert_eq!(SHARE_TOTAL, 100, "--viewed-share is a percent");
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

    /// The dry run says how the day was cut, prints what each reason held before
    /// the cap and after it, strongest reason first, for all four reasons even
    /// when one is empty.
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
        assert!(
            text.contains("cap 1200, viewed share 50%"),
            "the cut the dry run applied: {text}"
        );
        assert!(text.contains("events 7 days"), "{text}");
        assert!(text.contains("viewed_member        30        3"), "{text}");
        assert!(text.contains("listed                0        0"), "{text}");
        assert!(
            text.find("viewed_member").unwrap_or(usize::MAX) < text.rfind("viewed").unwrap_or(0),
            "strongest reason first: {text}"
        );
        let odd = report(
            &Watchlist {
                days: 7,
                cap: 1200,
                viewed_share: 25,
            },
            &run,
        );
        assert!(odd.contains("viewed share 25%"), "{odd}");
    }

    /// The statement's rows for one card's turn: `products` in list `list` at
    /// place `seq`, under `reason`.
    fn turn(list: i32, seq: i64, reason: &str, card: &str, products: &[i64]) -> Vec<Line> {
        products
            .iter()
            .map(|id_product| Line {
                list,
                seq,
                id_product: *id_product,
                card_id: card.to_string(),
                reason: reason.to_string(),
            })
            .collect()
    }

    fn lines_of(parts: &[&[Line]]) -> Vec<Line> {
        parts.iter().flat_map(|part| part.iter().cloned()).collect()
    }

    fn day(lines: &[Line], share: i64, cap: i64) -> Vec<(i64, String)> {
        walk(lines, share, cap)
            .iter()
            .map(|entry| (entry.id_product, entry.reason.clone()))
            .collect()
    }

    /// Half-and-half is one listing, one viewed card, and it does not wobble:
    /// two equal lists of four come out strictly alternating, listed first.
    #[test]
    fn an_equal_share_alternates_two_lists() {
        let listed: Vec<Line> = (1..=4)
            .flat_map(|seq| turn(LIST_LISTED, seq, "listed", &format!("l{seq}"), &[100 + seq]))
            .collect();
        let viewed: Vec<Line> = (1..=4)
            .flat_map(|seq| turn(LIST_VIEWED, seq, "viewed", &format!("v{seq}"), &[200 + seq]))
            .collect();
        let lines = lines_of(&[&listed, &viewed]);
        assert_eq!(
            day(&lines, 50, 100)
                .iter()
                .map(|(id, _)| *id)
                .collect::<Vec<i64>>(),
            vec![101, 201, 102, 202, 103, 203, 104, 204],
            "one from each, in each list's own order"
        );
        assert_eq!(
            day(&lines, 50, 100)
                .iter()
                .map(|(_, reason)| reason.as_str())
                .collect::<Vec<&str>>(),
            vec!["listed", "viewed", "listed", "viewed", "listed", "viewed", "listed", "viewed"],
            "the reason each line was walked under"
        );
    }

    /// When one list runs out the other takes its turns and the rest of the day,
    /// in its own order: nothing is invented to keep the alternation going.
    #[test]
    fn the_shorter_list_fills_with_the_longer_one() {
        let listed: Vec<Line> = (1..=2)
            .flat_map(|seq| turn(LIST_LISTED, seq, "listed", &format!("l{seq}"), &[100 + seq]))
            .collect();
        let viewed: Vec<Line> = (1..=5)
            .flat_map(|seq| turn(LIST_VIEWED, seq, "viewed", &format!("v{seq}"), &[200 + seq]))
            .collect();
        let lines = lines_of(&[&listed, &viewed]);
        assert_eq!(
            day(&lines, 50, 100),
            vec![
                (101, "listed".to_string()),
                (201, "viewed".to_string()),
                (102, "listed".to_string()),
                (202, "viewed".to_string()),
                (203, "viewed".to_string()),
                (204, "viewed".to_string()),
                (205, "viewed".to_string()),
            ],
            "listed drains, viewed continues"
        );
    }

    /// The two ends of `--viewed-share`: 0 gives the day to the listings (the
    /// behaviour production showed), 100 gives it to the viewers. A list with no
    /// share still contributes once the other one is empty.
    #[test]
    fn a_share_of_zero_or_hundred_gives_the_day_to_one_list() {
        let listed: Vec<Line> = (1..=3)
            .flat_map(|seq| turn(LIST_LISTED, seq, "listed", &format!("l{seq}"), &[100 + seq]))
            .collect();
        let viewed: Vec<Line> = (1..=3)
            .flat_map(|seq| turn(LIST_VIEWED, seq, "viewed", &format!("v{seq}"), &[200 + seq]))
            .collect();
        let lines = lines_of(&[&listed, &viewed]);
        assert_eq!(
            day(&lines, 0, 100),
            vec![
                (101, "listed".to_string()),
                (102, "listed".to_string()),
                (103, "listed".to_string()),
                (201, "viewed".to_string()),
                (202, "viewed".to_string()),
                (203, "viewed".to_string()),
            ],
            "share 0: every listing, then the viewers"
        );
        assert_eq!(
            day(&lines, 100, 100),
            vec![
                (201, "viewed".to_string()),
                (202, "viewed".to_string()),
                (203, "viewed".to_string()),
                (101, "listed".to_string()),
                (102, "listed".to_string()),
                (103, "listed".to_string()),
            ],
            "share 100: every viewed card, then the listings"
        );
    }

    /// A quarter of the day to the viewers is three listings per viewed card,
    /// counted on the turn numbers rather than on a rounded percentage.
    #[test]
    fn a_quarter_share_gives_three_listings_per_viewed_card() {
        let listed: Vec<Line> = (1..=7)
            .flat_map(|seq| turn(LIST_LISTED, seq, "listed", &format!("l{seq}"), &[100 + seq]))
            .collect();
        let viewed: Vec<Line> = (1..=7)
            .flat_map(|seq| turn(LIST_VIEWED, seq, "viewed", &format!("v{seq}"), &[200 + seq]))
            .collect();
        let lines = lines_of(&[&listed, &viewed]);
        assert_eq!(
            day(&lines, 25, 100)
                .iter()
                .map(|(id, _)| *id)
                .collect::<Vec<i64>>(),
            vec![101, 102, 103, 201, 104, 105, 106, 202, 107, 203, 204, 205, 206, 207],
            "LLL V LLL V, then nothing left to alternate with"
        );
        let three_quarters: Vec<i64> = day(&lines, 75, 6).iter().map(|(id, _)| *id).collect();
        assert_eq!(
            three_quarters,
            vec![201, 202, 101, 203, 204, 205],
            "the viewed slots are three times as dense as the listing ones"
        );
    }

    /// `viewed_member` and `scanned` hold their place in front of the cut,
    /// whatever the share and whatever the two interleaved lists hold. The
    /// statement's own numbering is one per head *list* — every member view
    /// before every scan — but what the walk owes the head is that numbering, so
    /// the mixed turns below travel in `seq` order and are not re-sorted here.
    #[test]
    fn the_head_list_keeps_its_place_ahead_of_the_cut() {
        let head = lines_of(&[
            &turn(LIST_HEAD, 1, "viewed_member", "m1", &[301]),
            &turn(LIST_HEAD, 2, "scanned", "s1", &[302, 303]),
            &turn(LIST_HEAD, 3, "viewed_member", "m2", &[304]),
        ]);
        let listed = turn(LIST_LISTED, 1, "listed", "l1", &[101]);
        let viewed = turn(LIST_VIEWED, 1, "viewed", "v1", &[201]);
        let lines = lines_of(&[&head, &listed, &viewed]);
        let want = vec![
            (301, "viewed_member".to_string()),
            (302, "scanned".to_string()),
            (303, "scanned".to_string()),
            (304, "viewed_member".to_string()),
            (101, "listed".to_string()),
            (201, "viewed".to_string()),
        ];
        assert_eq!(day(&lines, 50, 100), want, "the head first, then the cut");
        assert_eq!(
            day(&lines, 0, 100),
            want,
            "a share of 0 does not bury the head"
        );
        assert_eq!(
            day(&lines, 100, 100)[..4],
            want[..4],
            "a share of 100 does not either"
        );
    }

    /// The cap counts products, not cards: a card with three products pays for
    /// three lines, and a product two cards asked for is walked once, by the
    /// card that got there first.
    #[test]
    fn the_cap_counts_products_and_a_product_is_walked_once() {
        let listed = lines_of(&[
            &turn(LIST_LISTED, 1, "listed", "l1", &[101, 102, 103]),
            &turn(LIST_LISTED, 2, "listed", "l2", &[102, 104]),
        ]);
        let viewed = turn(LIST_VIEWED, 1, "viewed", "v1", &[102, 201]);
        let lines = lines_of(&[&listed, &viewed]);
        assert_eq!(
            walk(&lines, 50, 3)
                .iter()
                .map(|entry| (entry.id_product, entry.card_id.as_str(), entry.rank))
                .collect::<Vec<(i64, &str, i64)>>(),
            vec![(101, "l1", 1), (102, "l1", 2), (103, "l1", 3)],
            "one card with three products spends the whole three-line day"
        );
        assert_eq!(
            walk(&lines, 50, 4)
                .iter()
                .map(|entry| (entry.id_product, entry.card_id.as_str()))
                .collect::<Vec<(i64, &str)>>(),
            vec![(101, "l1"), (102, "l1"), (103, "l1"), (201, "v1")],
            "the viewed card's own 102 was taken, so only its second product is left"
        );
        assert_eq!(
            day(&lines, 50, 100),
            vec![
                (101, "listed".to_string()),
                (102, "listed".to_string()),
                (103, "listed".to_string()),
                (201, "viewed".to_string()),
                (104, "listed".to_string()),
            ],
            "the alternation continues by turn, not by line"
        );
    }

    /// Same rows, same share, same cap, same file — and the ranks are the
    /// positions in that file, from 1 up, in order.
    #[test]
    fn the_walk_is_deterministic_and_numbers_itself() {
        let mut lines = Vec::new();
        for seq in 1..=40 {
            lines.extend(turn(
                LIST_LISTED,
                seq,
                "listed",
                &format!("l{seq}"),
                &[1000 + seq],
            ));
            lines.extend(turn(
                LIST_VIEWED,
                seq,
                "viewed",
                &format!("v{seq}"),
                &[2000 + seq],
            ));
        }
        let first = walk(&lines, 50, 37);
        let second = walk(&lines, 50, 37);
        assert_eq!(first, second, "two runs of one day");
        assert_eq!(first.len(), 37, "the cap is the number of lines");
        assert_eq!(
            first.iter().map(|entry| entry.rank).collect::<Vec<i64>>(),
            (1..=37).collect::<Vec<i64>>(),
            "rank is the position in the walked day"
        );
        // The order of the server's rows within a turn is not a decision the
        // walk makes: the day is the same file either way.
        let mut shuffled = lines.clone();
        for chunk in shuffled.chunks_mut(2) {
            chunk.reverse();
        }
        assert_eq!(
            walk(&shuffled, 50, 37),
            first,
            "the day does not depend on row order"
        );
    }

    /// The counts the dry run prints are the statement's totals and the walk's
    /// kept lines, in `REASONS` order whatever order they arrived in.
    #[test]
    fn rank_fills_the_kept_side_of_each_count() {
        let listed = turn(LIST_LISTED, 1, "listed", "l1", &[101, 102]);
        let viewed = turn(LIST_VIEWED, 1, "viewed", "v1", &[201]);
        let lines = lines_of(&[&viewed, &listed]);
        let totals = vec![
            ReasonCount {
                reason: "viewed".into(),
                total: 900,
                kept: 7,
            },
            ReasonCount {
                reason: "listed".into(),
                total: 70,
                kept: 7,
            },
        ];
        let run = rank(&lines, &totals, 50, 2);
        assert_eq!(
            run.counts,
            vec![
                ReasonCount {
                    reason: "listed".into(),
                    total: 70,
                    kept: 2
                },
                ReasonCount {
                    reason: "viewed".into(),
                    total: 900,
                    kept: 0
                },
            ],
            "the totals stand, the kept side is what the walk took, strongest first"
        );
        assert_eq!(run.entries.len(), 2);
        assert_eq!(
            rank(&[], &[], 50, 10).entries,
            Vec::new(),
            "an empty day stays empty"
        );
    }
}
