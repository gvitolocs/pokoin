//! Codec `5`, the template column (format `2`).
//!
//! A string column whose values are mostly built from other columns of the
//! same row — `canonicalPath` is `"/marketplace/en/cards/" + {id} + "/card-" +
//! slug{name} + "-" + slug{card_number} + "-" + slug{set}` — is stored as the
//! recipe plus only the parts no other column carries:
//!
//! ```text
//! { "c": 5,
//!   "s": [[col, form], …],      // slots: another column of the row, form 0 = its
//!                               // text, 1 = its ASCII slug
//!   "h": [[slot, …], …],        // shapes: which slots, in order
//!   "x": [shape, …],            // shape per present row; omitted with one shape
//!   "l": [[<column>, …], …],    // per shape, the literal before each slot and
//!                               // after the last one, as ordinary c1 columns
//!                               // (codec 0–3) over that shape's rows
//!   "m": [0|1, …] }             // presence mask, as for every column
//! ```
//!
//! A slot column is never a template itself, nor a reference to one, so a
//! decoder resolves plain columns first, then templates, then references to
//! templates. The text of a cell is the string, or a safe integer in decimal.
//!
//! The encoder keeps a template only when it serialises smaller than the
//! column's own codec-0–4 encoding, so it can never grow a document.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

/// Columns with fewer present rows are never templated.
pub const MIN_ROWS: usize = 8;
/// Most source slots one template may use.
const MAX_SLOTS: usize = 12;
/// Shortest source text worth matching inside a value.
const MIN_SOURCE_LEN: usize = 3;
/// Largest integer a JS number holds exactly.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// ASCII slug: lowercase ASCII alphanumerics; every other run of characters
/// between two alphanumerics becomes one `-` (none leading or trailing).
pub fn slug(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut gap = false;
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            if gap && !out.is_empty() {
                out.push('-');
            }
            gap = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            gap = true;
        }
    }
    out
}

/// The text a cell offers to a template: a string, or a safe integer.
pub fn cell_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => {
            if let Some(unsigned) = number.as_u64() {
                (unsigned <= MAX_SAFE_INTEGER).then(|| unsigned.to_string())
            } else {
                number
                    .as_i64()
                    .filter(|signed| signed.unsigned_abs() <= MAX_SAFE_INTEGER)
                    .map(|signed| signed.to_string())
            }
        }
        _ => None,
    }
}

type Slot = (usize, u8);

struct Sources {
    full: Vec<Vec<Option<String>>>,
    slug: Vec<Vec<Option<String>>>,
}

impl Sources {
    fn text(&self, (column, form): Slot, row: usize) -> Option<&str> {
        let forms = if form == 0 { &self.full } else { &self.slug };
        forms[column][row].as_deref()
    }
}

fn same_column(a: &[Option<&Value>], b: &[Option<&Value>]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x == y)
}

/// Split one value into literal pieces and the slots between them: matches of
/// slot texts, longest first, never overlapping.
fn tokenize<'t>(text: &'t str, row: usize, slots: &[Slot], sources: &Sources) -> (Vec<usize>, Vec<&'t str>) {
    let mut found: Vec<(usize, usize, usize)> = Vec::new();
    for (index, slot) in slots.iter().enumerate() {
        if let Some(source) = sources.text(*slot, row) {
            if source.len() >= MIN_SOURCE_LEN {
                if let Some(at) = text.find(source) {
                    found.push((at, source.len(), index));
                }
            }
        }
    }
    found.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)).then(a.2.cmp(&b.2)));
    let mut taken: Vec<(usize, usize, usize)> = Vec::new();
    for candidate in found {
        if taken
            .iter()
            .all(|t| candidate.0 + candidate.1 <= t.0 || t.0 + t.1 <= candidate.0)
        {
            taken.push(candidate);
        }
    }
    taken.sort_by_key(|t| t.0);
    let mut refs = Vec::with_capacity(taken.len());
    let mut pieces = Vec::with_capacity(taken.len() + 1);
    let mut at = 0;
    for (start, len, slot) in taken {
        pieces.push(&text[at..start]);
        refs.push(slot);
        at = start + len;
    }
    pieces.push(&text[at..]);
    (refs, pieces)
}

fn build(
    texts: &[&str],
    present: &[usize],
    slots: &[Slot],
    sources: &Sources,
    mask: Option<Value>,
    literal_column: &dyn Fn(&[Value]) -> Value,
) -> Value {
    let mut shapes: Vec<Vec<usize>> = Vec::new();
    let mut lookup: HashMap<Vec<usize>, usize> = HashMap::new();
    let mut shape_of: Vec<usize> = Vec::with_capacity(texts.len());
    let mut literals: Vec<Vec<Vec<Value>>> = Vec::new();
    for (text, &row) in texts.iter().zip(present) {
        let (refs, pieces) = tokenize(text, row, slots, sources);
        let index = *lookup.entry(refs.clone()).or_insert_with(|| {
            shapes.push(refs.clone());
            literals.push(vec![Vec::new(); refs.len() + 1]);
            shapes.len() - 1
        });
        shape_of.push(index);
        for (gap, piece) in pieces.into_iter().enumerate() {
            literals[index][gap].push(Value::String(piece.to_string()));
        }
    }
    let mut column = Map::new();
    column.insert("c".into(), Value::from(5u64));
    column.insert(
        "s".into(),
        Value::Array(
            slots
                .iter()
                .map(|(col, form)| Value::Array(vec![Value::from(*col as u64), Value::from(u64::from(*form))]))
                .collect(),
        ),
    );
    column.insert(
        "h".into(),
        Value::Array(
            shapes
                .iter()
                .map(|shape| Value::Array(shape.iter().map(|s| Value::from(*s as u64)).collect()))
                .collect(),
        ),
    );
    if shapes.len() > 1 {
        column.insert(
            "x".into(),
            Value::Array(shape_of.iter().map(|s| Value::from(*s as u64)).collect()),
        );
    }
    column.insert(
        "l".into(),
        Value::Array(
            literals
                .iter()
                .map(|gaps| Value::Array(gaps.iter().map(|values| literal_column(values)).collect()))
                .collect(),
        ),
    );
    if let Some(mask) = mask {
        column.insert("m".into(), mask);
    }
    Value::Object(column)
}

fn serialized_len(value: &Value) -> usize {
    serde_json::to_vec(value).map(|bytes| bytes.len()).unwrap_or(usize::MAX)
}

/// Template columns for one table, by column index. `v1_len[j]` is the size of
/// column `j`'s ordinary encoding; a template must beat it. `literal_column`
/// encodes a run of literal strings as an ordinary column.
pub fn plan(
    cells: &[Vec<Option<&Value>>],
    v1_len: &[usize],
    literal_column: &dyn Fn(&[Value]) -> Value,
) -> HashMap<usize, Value> {
    let mut chosen: HashMap<usize, Value> = HashMap::new();
    let Some(rows) = cells.first().map(Vec::len) else {
        return chosen;
    };
    let full: Vec<Vec<Option<String>>> = cells
        .iter()
        .map(|column| column.iter().map(|cell| cell.and_then(cell_text)).collect())
        .collect();
    let slugs: Vec<Vec<Option<String>>> = full
        .iter()
        .map(|column| column.iter().map(|text| text.as_deref().map(slug)).collect())
        .collect();
    let sources = Sources { full, slug: slugs };
    let mut used_as_source: HashSet<usize> = HashSet::new();

    for target in 0..cells.len() {
        if used_as_source.contains(&target) {
            continue;
        }
        let column = &cells[target];
        let present: Vec<usize> = (0..rows).filter(|&row| column[row].is_some()).collect();
        if present.len() < MIN_ROWS {
            continue;
        }
        let Some(texts) = present
            .iter()
            .map(|&row| column[row].and_then(Value::as_str))
            .collect::<Option<Vec<&str>>>()
        else {
            continue;
        };
        if texts.iter().all(|text| *text == texts[0])
            || texts.iter().map(|text| text.len()).sum::<usize>() < 10 * texts.len()
        {
            continue;
        }
        // An alias of an earlier column is a cheap ref already. A column whose
        // twin feeds another template cannot become one (its twin would turn
        // into a ref to it, which a template cannot read).
        if (0..target).any(|k| same_column(&cells[k], column))
            || used_as_source.iter().any(|&s| same_column(&cells[s], column))
        {
            continue;
        }

        let mut candidates: Vec<Slot> = Vec::new();
        for source in 0..cells.len() {
            if source == target
                || chosen.contains_key(&source)
                || same_column(&cells[source], column)
                || chosen.keys().any(|&t| same_column(&cells[t], &cells[source]))
                || sources.full[source].iter().all(Option::is_none)
            {
                continue;
            }
            candidates.push((source, 0));
            if (0..rows).any(|row| sources.full[source][row] != sources.slug[source][row]) {
                candidates.push((source, 1));
            }
        }
        let mut uses = vec![0usize; candidates.len()];
        for (text, &row) in texts.iter().zip(&present) {
            for slot in tokenize(text, row, &candidates, &sources).0 {
                uses[slot] += 1;
            }
        }
        let floor = (present.len() / 5).max(2);
        let mut kept: Vec<(usize, Slot)> = uses
            .iter()
            .zip(&candidates)
            .filter(|(count, _)| **count >= floor)
            .map(|(count, slot)| (*count, *slot))
            .collect();
        if kept.is_empty() {
            continue;
        }
        kept.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        kept.truncate(MAX_SLOTS);
        let slots: Vec<Slot> = kept.into_iter().map(|(_, slot)| slot).collect();

        let mask = present.len().lt(&rows).then(|| {
            Value::Array(column.iter().map(|cell| Value::from(u64::from(cell.is_some()))).collect())
        });
        let template = build(&texts, &present, &slots, &sources, mask, literal_column);
        if serialized_len(&template) < v1_len[target] {
            used_as_source.extend(slots.iter().map(|(source, _)| *source));
            chosen.insert(target, template);
        }
    }
    chosen
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_matches_the_canonical_path_shape() {
        assert_eq!(slug("Gold Secret Rare | 244/182"), "gold-secret-rare-244-182");
        assert_eq!(slug("  Pokémon: Mega Lucario ex!  "), "pok-mon-mega-lucario-ex");
        assert_eq!(slug("---"), "");
    }

    #[test]
    fn cell_text_is_string_or_safe_integer() {
        assert_eq!(cell_text(&Value::from("a")), Some("a".into()));
        assert_eq!(cell_text(&Value::from(668126)), Some("668126".into()));
        assert_eq!(cell_text(&Value::from(-3)), Some("-3".into()));
        assert_eq!(cell_text(&Value::from(1.5)), None);
        assert_eq!(cell_text(&Value::from(u64::MAX)), None);
        assert_eq!(cell_text(&Value::Null), None);
    }
}
