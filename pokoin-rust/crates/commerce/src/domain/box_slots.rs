//! Storage-box slots (`box·stack·position`) for a seller's stock.
//!
//! One server-side source for "where does the next card go in this box". A box
//! is physical, so every listing that still holds a card there counts: every
//! TCG (a Battle Spirits Saga card sits in the same box as the Pokémon ones),
//! and active, paused or inactive (scan-submitted, not yet purchasable) rows.
//! The web clients used to compute this from `/api/marketplace-listings`,
//! which is scoped to the host's game, capped at 1,000 rows by price, and was
//! then filtered to active/paused, so the cursor skipped other games' cards.

use std::collections::{HashMap, HashSet};

/// Statuses whose card still sits in its box (`sold_out` left it).
pub const SLOT_STATUSES: [&str; 3] = ["active", "paused", "inactive"];

/// One located listing, newest first in the slice the callers pass.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SlotRow {
    pub id: String,
    pub location: String,
    /// `created_at` in epoch ms; `None` sorts first (oldest).
    pub created_ms: Option<i64>,
}

/// Where the next card goes: `stack`/`start_position` for `stack_size`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub stack: i64,
    pub start_position: i64,
    pub stack_size: i64,
}

impl Cursor {
    /// The `·stack` (size 1) or `·stack·position` suffix after the box name.
    pub fn suffix(&self) -> String {
        if self.stack_size <= 1 {
            format!("·{}", self.stack)
        } else {
            format!("·{}·{}", self.stack, self.start_position)
        }
    }
}

const MAX_STACK: i64 = 9999;

fn is_sep(ch: char) -> bool {
    ch == '·' || ch == '•'
}

/// JS `parseInt`: leading digits, `None` unless positive.
fn leading_int(part: &str) -> Option<i64> {
    let digits: String = part.trim_start().chars().take_while(char::is_ascii_digit).collect();
    digits.parse::<i64>().ok().filter(|n| *n > 0)
}

/// `parseListingLocation`: the box and where the slot starts.
pub fn parse_location(raw: &str) -> (String, Option<i64>, Option<i64>) {
    let text = raw.trim();
    let Some(sep) = text.find(is_sep) else {
        return (text.to_string(), None, None);
    };
    let box_name = text[..sep].trim().to_string();
    let sep_len = text[sep..].chars().next().map_or(1, char::len_utf8);
    let tail = &text[sep + sep_len..];
    let numbers: Vec<i64> = tail.split(is_sep).filter_map(leading_int).collect();
    (box_name, numbers.first().copied(), numbers.get(1).copied())
}

/// Case-insensitive box key (a hand-typed box matches across casing).
pub fn box_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// The box a stored location belongs to.
pub fn listing_box(raw: &str) -> String {
    parse_location(raw).0
}

fn numbers(text: &str) -> Vec<i64> {
    text.split(|ch: char| !ch.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse().ok())
        .collect()
}

/// `listingSlotEnd`: `box·3·5-9` ends at 3·9, `box·3·5–9·2` at 9·2,
/// `box·7-9` at stack 9 (no position).
pub fn slot_end(raw: &str) -> (String, Option<i64>, Option<i64>) {
    let (box_name, stack, position) = parse_location(raw);
    if stack.is_none() {
        return (box_name, None, None);
    }
    let text = raw.trim();
    let sep = text.find(is_sep).unwrap_or(0);
    let tail: String = text[sep..].chars().skip(1).filter(|ch| !ch.is_whitespace()).collect();
    let shape: String = tail
        .chars()
        .map(|ch| match ch {
            '0'..='9' => 'N',
            '·' | '•' => '.',
            '–' | '—' => '~',
            other => other,
        })
        .collect::<String>();
    // Collapse digit runs so the shape reads `N.N~N.N`, `N.N-N`, `N-N`.
    let mut compact = String::new();
    for ch in shape.chars() {
        if ch == 'N' && compact.ends_with('N') {
            continue;
        }
        compact.push(ch);
    }
    let n = numbers(&tail);
    match compact.as_str() {
        "N.N~N.N" if n.len() == 4 => (box_name, Some(n[2]), Some(n[3])),
        "N.N-N" if n.len() == 3 => (box_name, Some(n[0]), Some(n[2])),
        "N-N" | "N~N" if n.len() == 2 => (box_name, Some(n[1]), None),
        _ => (box_name, stack, position),
    }
}

fn index_to_stack_pos(index: i64, size: i64) -> (i64, i64) {
    let size = size.max(1);
    let i = index.max(1);
    if size == 1 {
        return (i, 1);
    }
    ((i - 1) / size + 1, (i - 1) % size + 1)
}

fn stack_pos_to_index(stack: i64, position: i64, size: i64) -> i64 {
    let size = size.max(1);
    let s = stack.max(1);
    let p = position.max(1);
    if size == 1 {
        return s.max(p.min(MAX_STACK));
    }
    (s - 1) * size + p.min(size)
}

fn in_box<'a>(rows: &'a [SlotRow], wanted: &'a str) -> impl Iterator<Item = &'a SlotRow> + 'a {
    rows.iter().filter(move |row| {
        let name = listing_box(&row.location);
        !name.is_empty() && box_key(&name) == wanted
    })
}

/// `lastOccupiedIndex`: last absolute slot a box holds (0 = empty).
fn last_occupied_index(rows: &[SlotRow], wanted: &str, size: i64) -> i64 {
    let size = size.max(1);
    let mut max = 0;
    for row in in_box(rows, wanted) {
        let (_, stack, position) = slot_end(&row.location);
        let Some(stack) = stack else { continue };
        let abs = if size == 1 {
            stack
        } else {
            match position {
                None => stack * size,
                Some(position) => stack_pos_to_index(stack, position.min(size), size),
            }
        };
        max = max.max(abs);
    }
    max
}

/// `continueBoxCursor`: the slot after the last card added to the box (same
/// timestamp: the higher position). A size-1 request adopts the fullest
/// earlier stack as the divider size; a position past the divider opens the
/// next stack. Flat `box·7` locations walk past the highest stack.
pub fn continue_cursor(rows: &[SlotRow], box_name: &str, stack_size: i64) -> Option<Cursor> {
    let configured = stack_size.max(1);
    let wanted = box_key(box_name);
    let mut positioned: Vec<(&SlotRow, i64, i64)> = vec![];
    let mut pos_by_stack: HashMap<i64, i64> = HashMap::new();
    for row in in_box(rows, &wanted) {
        let (_, stack, position) = slot_end(&row.location);
        let (Some(stack), Some(position)) = (stack, position) else { continue };
        positioned.push((row, stack, position));
        let max = pos_by_stack.entry(stack).or_insert(0);
        *max = (*max).max(position);
    }
    if positioned.is_empty() {
        let last = last_occupied_index(rows, &wanted, configured);
        if last == 0 {
            return None;
        }
        let (stack, position) = index_to_stack_pos((MAX_STACK * configured).min(last + 1), configured);
        return Some(Cursor { stack, start_position: position, stack_size: configured });
    }
    let open_stack = pos_by_stack.keys().copied().max().unwrap_or(0);
    let earlier_max = pos_by_stack
        .iter()
        .filter(|(stack, _)| **stack != open_stack)
        .map(|(_, position)| *position)
        .max()
        .unwrap_or(0);
    let size = if configured == 1 && earlier_max > 1 { earlier_max } else { configured };
    positioned.sort_by(|a, b| {
        a.0.created_ms
            .unwrap_or(-1)
            .cmp(&b.0.created_ms.unwrap_or(-1))
            .then(a.1.cmp(&b.1))
            .then(a.2.cmp(&b.2))
            .then_with(|| a.0.id.cmp(&b.0.id))
    });
    let (_, last_stack, last_position) = positioned[positioned.len() - 1];
    let mut stack = last_stack;
    let mut start = last_position + 1;
    if size > 1 && start > size {
        stack += 1;
        start = 1;
    }
    Some(Cursor { stack, start_position: start, stack_size: size })
}

/// Every slot the box's rows hold, as absolute indexes for `size`.
fn occupied(rows: &[SlotRow], wanted: &str, size: i64) -> HashSet<i64> {
    let mut taken = HashSet::new();
    for row in in_box(rows, wanted) {
        let (_, start_stack, start_pos) = parse_location(&row.location);
        let (_, end_stack, end_pos) = slot_end(&row.location);
        let (Some(start_stack), Some(end_stack)) = (start_stack, end_stack) else { continue };
        let from = if size == 1 {
            start_stack
        } else {
            stack_pos_to_index(start_stack, start_pos.unwrap_or(1), size)
        };
        let to = if size == 1 {
            end_stack
        } else {
            match end_pos {
                // `box·7` / `box·7-9`: whole stacks.
                None => end_stack * size,
                Some(position) => stack_pos_to_index(end_stack, position, size),
            }
        };
        // A typo like `box·1·1-90000` must not allocate millions of slots.
        for index in from..=to.min(from + 10 * size.max(80)) {
            taken.insert(index);
        }
    }
    taken
}

/// The next free slot of a box: the continue cursor, moved past any slot a
/// row already holds (a card added back into an earlier gap must not make
/// the next card collide with the one after it).
pub fn next_slot(rows: &[SlotRow], box_name: &str, stack_size: i64) -> Option<Cursor> {
    let cursor = continue_cursor(rows, box_name, stack_size)?;
    let size = cursor.stack_size.max(1);
    let taken = occupied(rows, &box_key(box_name), size);
    let mut index = stack_pos_to_index(cursor.stack, cursor.start_position, size);
    let limit = MAX_STACK * size;
    while taken.contains(&index) && index < limit {
        index += 1;
    }
    if index == stack_pos_to_index(cursor.stack, cursor.start_position, size) {
        return Some(cursor);
    }
    let (stack, start_position) = index_to_stack_pos(index, size);
    Some(Cursor { stack, start_position, stack_size: size })
}

/// One box of a seller: display name (casing of its newest row), how many
/// located rows it holds, and the next free slot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoxSlots {
    pub name: String,
    pub rows: usize,
    pub next: Option<Cursor>,
}

/// Boxes newest-first (`rows` must be newest-first), each with its next slot.
pub fn boxes(rows: &[SlotRow], stack_size: i64) -> Vec<BoxSlots> {
    let mut order: Vec<(String, String)> = vec![];
    let mut counts: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let name = listing_box(&row.location);
        if name.is_empty() {
            continue;
        }
        let key = box_key(&name);
        let count = counts.entry(key.clone()).or_insert(0);
        if *count == 0 {
            order.push((key, name));
        }
        *count += 1;
    }
    order
        .into_iter()
        .map(|(key, name)| BoxSlots {
            rows: counts.get(&key).copied().unwrap_or(0),
            next: next_slot(rows, &name, stack_size),
            name,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(location: &str) -> SlotRow {
        SlotRow { id: location.into(), location: location.into(), created_ms: None }
    }
    fn at(id: &str, location: &str, ms: i64) -> SlotRow {
        SlotRow { id: id.into(), location: location.into(), created_ms: Some(ms) }
    }
    fn cur(stack: i64, start_position: i64, stack_size: i64) -> Option<Cursor> {
        Some(Cursor { stack, start_position, stack_size })
    }

    #[test]
    fn parses_like_the_web_helpers() {
        assert_eq!(parse_location("box1·47"), ("box1".into(), Some(47), None));
        assert_eq!(parse_location("megaevoluzionietb·2-4"), ("megaevoluzionietb".into(), Some(2), None));
        assert_eq!(parse_location("box·3·5-9"), ("box".into(), Some(3), Some(5)));
        assert_eq!(parse_location("box·3·5–9·2"), ("box".into(), Some(3), Some(5)));
        assert_eq!(parse_location(" Box A "), ("Box A".into(), None, None));
        assert_eq!(slot_end("box·3·5-9"), ("box".into(), Some(3), Some(9)));
        assert_eq!(slot_end("box·3·5–9·2"), ("box".into(), Some(9), Some(2)));
        assert_eq!(slot_end("box·7-9"), ("box".into(), Some(9), None));
        assert_eq!(slot_end("box•2•4"), ("box".into(), Some(2), Some(4)));
    }

    // The cases `continueBoxCursor` was tested with on the web.
    #[test]
    fn continue_cursor_keeps_the_web_semantics() {
        let rows = vec![
            at("a", "megaevoluzionietb·1·80", 1),
            at("b", "megaevoluzionietb·2·80", 2),
            at("c", "megaevoluzionietb·3·30", 3),
            row("megaevoluzionietb·8"),
            row("other·2·9"),
        ];
        assert_eq!(continue_cursor(&rows, "megaevoluzionietb", 1), cur(3, 31, 80));
        assert_eq!(continue_cursor(&rows, "megaevoluzionietb", 80), cur(3, 31, 80));
        let same_insert = vec![at("x", "box·2·80", 1), at("a", "box·3·30", 2), at("b", "box·3·38", 2)];
        assert_eq!(continue_cursor(&same_insert, "box", 80), cur(3, 39, 80));
        let past = vec![row("megaevoluzionietb·1·79"), row("megaevoluzionietb·2·88")];
        assert_eq!(continue_cursor(&past, "megaevoluzionietb", 80), cur(3, 1, 80));
        assert_eq!(continue_cursor(&[row("box·2·40")], "box", 80), cur(2, 41, 80));
        assert_eq!(continue_cursor(&[row("box·2·80")], "box", 80), cur(3, 1, 80));
        assert_eq!(continue_cursor(&[row("box·7"), row("box·9")], "box", 1), cur(10, 1, 1));
        assert_eq!(continue_cursor(&[], "box", 1), None);
        // `nextFreeSlot` cases: inside a half-full stack, a full stack rolls
        // over, and one card per stack walks the stack number.
        let half = vec![
            row("megaevoluzionietb·1·1-20"),
            row("megaevoluzionietb·2·1-7"),
            row("other·9·3"),
            row("megaevoluzionietb"),
        ];
        assert_eq!(continue_cursor(&half, "megaevoluzionietb", 20), cur(2, 8, 20));
        assert_eq!(continue_cursor(&[row("b·2·1-20")], "b", 20), cur(3, 1, 20));
        assert_eq!(continue_cursor(&[row("b·1-41"), row("b·7")], "b", 1), cur(42, 1, 1));
        assert_eq!(continue_cursor(&half, "empty-box", 20), None);
    }

    #[test]
    fn box_match_ignores_case_and_other_boxes() {
        let rows = vec![at("a", "MegaEvoluzioniETB·4·10", 2), at("b", "box1·9·70", 3)];
        assert_eq!(next_slot(&rows, "megaevoluzionietb", 80), cur(4, 11, 80));
    }

    // Giuseppe's box on 2026-10-18: Pokémon stock up to ·19·…/·20·…, then
    // Battle Spirits Saga cards added on 17/10 at ·22·72 … ·22·76. The slot
    // set is game-agnostic, so the next card goes to ·22·77, not ·19·40.
    #[test]
    fn mixed_game_box_continues_after_the_newest_card_of_any_game() {
        let mut rows = vec![];
        for p in 1..=39 {
            rows.push(at(&format!("pk{p}"), &format!("megaevoluzionietb·19·{p}"), 1_000 + p));
        }
        for p in 72..=76 {
            rows.push(at(&format!("bss{p}"), &format!("megaevoluzionietb·22·{p}"), 9_000 + p));
        }
        let next = next_slot(&rows, "megaevoluzionietb", 80).unwrap();
        assert_eq!(next, Cursor { stack: 22, start_position: 77, stack_size: 80 });
        assert_eq!(next.suffix(), "·22·77");
    }

    // A card put back into an earlier gap is the newest row; the slot after
    // it is already taken, so the cursor moves to the first free slot.
    #[test]
    fn next_slot_skips_slots_already_taken() {
        let rows = vec![
            at("a", "box·5·1-3", 1),
            at("b", "box·5·5", 2),
            at("c", "box·5·6-7", 3),
            at("d", "box·5·4", 4),
        ];
        assert_eq!(continue_cursor(&rows, "box", 80), cur(5, 5, 80));
        assert_eq!(next_slot(&rows, "box", 80), cur(5, 8, 80));
        let flat = vec![at("a", "box·2", 1), at("b", "box·3", 2), at("c", "box·1", 3)];
        assert_eq!(next_slot(&flat, "box", 1), cur(4, 1, 1));
    }

    #[test]
    fn boxes_are_newest_first_with_counts_and_next_slots() {
        let rows = vec![
            at("bss", "megaevoluzionietb·22·76", 30),
            at("pk", "megaevoluzionietb·19·39", 20),
            at("b1", "Box1·3", 10),
            at("nl", "", 5),
        ];
        let out = boxes(&rows, 80);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], BoxSlots { name: "megaevoluzionietb".into(), rows: 2, next: cur(22, 77, 80) });
        assert_eq!(out[1].name, "Box1");
        assert_eq!(out[1].rows, 1);
        assert_eq!(out[1].next, cur(4, 1, 80));
    }
}
