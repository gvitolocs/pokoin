//! The `c1` encoder: a lossless, structure-driven columnar rewrite of a
//! response body.
//!
//! The encoder is generic over the JSON rather than per-route, which is what
//! makes "decodes back to exactly the default JSON" testable: there is one
//! code path for every target route, and [`super::decode`] is its inverse.
//!
//! # Document
//!
//! ```text
//! { "c1": 1, "dict": "<dictionary version>", "b": <skeleton>, "t": [<table>, …] }
//! ```
//!
//! `b` is the original JSON with every array that was worth columnarising
//! replaced by a `{"$c1": <index into t>}` placeholder. An object in the source
//! that happens to carry a `$c1`-prefixed key is wrapped as `{"$c1x": {…}}` so
//! the placeholder can never be confused with real data.
//!
//! # Tables
//!
//! ```text
//! { "n": <rows>, "k": ["id", …], "c": [<column>, …] }   // array of objects
//! { "n": <len>, "c": [<column>] }                       // array of scalars
//! ```
//!
//! Row `i` is rebuilt by inserting `k[j] -> column[j][i]` in column order, for
//! every column whose presence mask has row `i`. The encoder only builds a
//! table when every row's key sequence is a subsequence of `k`, so that order
//! is the original key order of each row.
//!
//! # Columns
//!
//! A column is an object with codec `c` plus optional modifiers:
//!
//! | field | meaning |
//! | --- | --- |
//! | `m` | presence mask (`0`/`1` per row); omitted when every row has the key |
//! | `ns` | the decoded integers are decimal strings (`668126` -> `"668126"`) |
//! | `prei` / `pre` | prefix to prepend: URL-prefix-table code, then literal |
//! | `sufi` / `suf` | suffix to append: URL-prefix-table code, then literal |
//!
//! | codec | payload | meaning |
//! | --- | --- | --- |
//! | `0` | `v` | every row holds this one value |
//! | `1` | `v: []` | one value per present row |
//! | `2` | `p: []`, `x: []`, `t?` | palette; with `t`, an integer entry is a dictionary code |
//! | `3` | `z`, `d: []` | integer delta: `v[0] = z`, `v[i] = v[i-1] + d[i-1]` |
//! | `4` | `r` | same residuals and mask as column `r` |
//!
//! Codec `4` is where the bulk of the win on Pokoin payloads comes from: after
//! prefix/suffix stripping, `id`/`card_id`, `set`/`set_name`,
//! `artist`/`illustrator`, `canonicalPath`/`canonical_path` and the whole
//! `imageUrl`/`previewImageUrl`/`homepageImageUrl`/`gridImageUrl`/`heroImageUrl`/
//! `tileImageUrl` family collapse onto one stored array.
//!
//! Codec choice is made by serialising each candidate and keeping the shortest,
//! so a codec can never make a column larger than the plain array.

use std::collections::HashMap;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::dict;

/// Arrays of objects shorter than this stay as they are: the per-table header
/// costs more than the repeated keys save.
const TABLE_MIN_ROWS: usize = 4;

/// Arrays of scalars shorter than this stay as they are.
const VECTOR_MIN_LEN: usize = 8;

/// Shortest common prefix/suffix worth hoisting out of a column.
const MIN_AFFIX: usize = 4;

/// The `c1` format version carried by every document.
pub const FORMAT_VERSION: u64 = 1;

/// Encode a response body. The result decodes back to `body` exactly, byte for
/// byte, through [`super::decode::decode`].
pub fn encode(body: &Value) -> Value {
    let mut tables: Vec<Value> = Vec::new();
    let skeleton = walk(body, &mut tables);
    let mut out = Map::new();
    out.insert("c1".into(), Value::from(FORMAT_VERSION));
    out.insert("dict".into(), Value::String(dict::VERSION.to_string()));
    out.insert("b".into(), skeleton);
    out.insert("t".into(), Value::Array(tables));
    Value::Object(out)
}

/// Encode and serialise in one step, streaming through a `serde_json` writer
/// so the compact document is never materialised as an intermediate `String`.
pub fn encode_to_vec(body: &Value) -> Vec<u8> {
    let document = encode(body);
    let mut out = Vec::with_capacity(4096);
    // Infallible for a `Value` into a `Vec`, but never panic on a response path.
    if serde_json::to_writer(&mut out, &document).is_err() {
        out.clear();
        out.extend_from_slice(b"{}");
    }
    out
}

fn walk(value: &Value, tables: &mut Vec<Value>) -> Value {
    match value {
        Value::Array(items) => {
            if let Some(table) = encode_array(items) {
                let index = tables.len();
                tables.push(table);
                let mut placeholder = Map::new();
                placeholder.insert("$c1".into(), Value::from(index as u64));
                return Value::Object(placeholder);
            }
            Value::Array(items.iter().map(|item| walk(item, tables)).collect())
        }
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                out.insert(key.clone(), walk(item, tables));
            }
            let out = Value::Object(out);
            if map.keys().any(|key| key.starts_with("$c1")) {
                let mut escaped = Map::new();
                escaped.insert("$c1x".into(), out);
                return Value::Object(escaped);
            }
            out
        }
        other => other.clone(),
    }
}

/// A table for this array, or `None` to leave the array alone.
fn encode_array(items: &[Value]) -> Option<Value> {
    if items.len() >= TABLE_MIN_ROWS && items.iter().all(Value::is_object) {
        return encode_object_table(items);
    }
    if items.len() >= VECTOR_MIN_LEN && items.iter().all(is_scalar) {
        return encode_vector(items);
    }
    None
}

fn is_scalar(value: &Value) -> bool {
    !matches!(value, Value::Object(_) | Value::Array(_))
}

fn encode_vector(items: &[Value]) -> Option<Value> {
    let mut builder = Builder::new(items.len());
    let cells: Vec<Option<&Value>> = items.iter().map(Some).collect();
    let column = builder.column("", &cells);
    let mut table = Map::new();
    table.insert("n".into(), Value::from(items.len() as u64));
    table.insert("c".into(), Value::Array(vec![column]));
    Some(Value::Object(table))
}

fn encode_object_table(items: &[Value]) -> Option<Value> {
    let rows: Vec<&Map<String, Value>> = items.iter().filter_map(Value::as_object).collect();
    if rows.len() != items.len() {
        return None;
    }

    // Union of keys in first-seen order.
    let mut keys: Vec<&str> = Vec::new();
    for row in &rows {
        for key in row.keys() {
            if !keys.iter().any(|seen| *seen == key.as_str()) {
                keys.push(key);
            }
        }
    }
    if keys.is_empty() {
        return None;
    }
    // A row whose keys run in a different relative order could not be rebuilt
    // from the column order, so such a table is left alone rather than
    // silently reordered.
    if !rows.iter().all(|row| is_subsequence(row.keys(), &keys)) {
        // Rows whose keys are each sorted (list snapshots canonicalise them)
        // still fit the sorted union when an optional key, present only on
        // later rows, sorts before the first row's keys.
        keys.sort_unstable();
        if !rows.iter().all(|row| is_subsequence(row.keys(), &keys)) {
            return None;
        }
    }

    let mut builder = Builder::new(rows.len());
    let mut columns = Vec::with_capacity(keys.len());
    for key in &keys {
        let cells: Vec<Option<&Value>> = rows.iter().map(|row| row.get(*key)).collect();
        columns.push(builder.column(key, &cells));
    }

    let mut table = Map::new();
    table.insert("n".into(), Value::from(rows.len() as u64));
    table.insert(
        "k".into(),
        Value::Array(keys.iter().map(|key| Value::String((*key).into())).collect()),
    );
    table.insert("c".into(), Value::Array(columns));
    Some(Value::Object(table))
}

/// Every key of `row` appears in `keys`, in the same relative order.
fn is_subsequence<'a>(mut row: impl Iterator<Item = &'a String>, keys: &[&str]) -> bool {
    let mut next = row.next();
    for key in keys {
        match next {
            Some(current) if current == key => next = row.next(),
            _ => continue,
        }
    }
    next.is_none()
}

/// Per-table state: the residuals already emitted, so a later column can be a
/// `ref` to an earlier one.
struct Builder {
    rows: usize,
    /// `sha256(mask, residuals) -> candidate column indices`, verified on hit.
    seen: HashMap<[u8; 32], Vec<usize>>,
    /// `(mask, residuals)` of each emitted column, by column index.
    residuals: Vec<(Option<Vec<bool>>, Vec<Value>)>,
}

impl Builder {
    fn new(rows: usize) -> Self {
        Self {
            rows,
            seen: HashMap::new(),
            residuals: Vec::new(),
        }
    }

    fn column(&mut self, key: &str, cells: &[Option<&Value>]) -> Value {
        let index = self.residuals.len();
        let mask: Option<Vec<bool>> = cells
            .iter()
            .any(Option::is_none)
            .then(|| cells.iter().map(Option::is_some).collect());
        let present: Vec<&Value> = cells.iter().filter_map(|cell| *cell).collect();

        // A constant column is already minimal; it neither refs nor is ref-ed.
        if let Some(first) = present.first() {
            if present.iter().all(|value| *value == *first) {
                let mut column = Map::new();
                column.insert("c".into(), Value::from(0u64));
                column.insert("v".into(), (*first).clone());
                self.push_mask(&mut column, &mask);
                self.residuals.push((mask, Vec::new()));
                return Value::Object(column);
            }
        }

        let plan = plan_residuals(&present);
        let hash = fingerprint(&mask, &plan.residuals);
        if let Some(candidates) = self.seen.get(&hash) {
            if let Some(root) = candidates.iter().copied().find(|root| {
                let (root_mask, root_residuals) = &self.residuals[*root];
                *root_mask == mask && *root_residuals == plan.residuals
            }) {
                let mut column = Map::new();
                column.insert("c".into(), Value::from(4u64));
                column.insert("r".into(), Value::from(root as u64));
                plan.push_modifiers(&mut column);
                // The mask comes from the referenced column.
                self.residuals.push((mask, plan.residuals));
                return Value::Object(column);
            }
        }

        let column = self.best_codec(key, &plan, &mask);
        self.seen.entry(hash).or_default().push(index);
        self.residuals.push((mask, plan.residuals));
        column
    }

    fn push_mask(&self, column: &mut Map<String, Value>, mask: &Option<Vec<bool>>) {
        if let Some(mask) = mask {
            debug_assert_eq!(mask.len(), self.rows);
            column.insert(
                "m".into(),
                Value::Array(
                    mask.iter()
                        .map(|present| Value::from(u64::from(*present)))
                        .collect(),
                ),
            );
        }
    }

    /// Serialise every applicable codec and keep the shortest, so a codec can
    /// never make a column bigger than the plain array.
    fn best_codec(&self, key: &str, plan: &Plan, mask: &Option<Vec<bool>>) -> Value {
        let values = &plan.residuals;
        let mut candidates: Vec<Map<String, Value>> = Vec::with_capacity(4);

        let mut raw = Map::new();
        raw.insert("c".into(), Value::from(1u64));
        raw.insert("v".into(), Value::Array(values.clone()));
        candidates.push(raw);

        if let Some(integers) = as_integers(values) {
            if integers.len() >= 2 {
                let mut deltas = Vec::with_capacity(integers.len() - 1);
                let mut fits = true;
                for pair in integers.windows(2) {
                    match pair[1].checked_sub(pair[0]) {
                        Some(delta) => deltas.push(Value::from(delta)),
                        None => {
                            fits = false;
                            break;
                        }
                    }
                }
                if fits {
                    let mut delta = Map::new();
                    delta.insert("c".into(), Value::from(3u64));
                    delta.insert("z".into(), Value::from(integers[0]));
                    delta.insert("d".into(), Value::Array(deltas));
                    candidates.push(delta);
                }
            }
        }

        if let Some((palette, indices)) = palette_of(values) {
            let mut column = Map::new();
            column.insert("c".into(), Value::from(2u64));
            column.insert("p".into(), Value::Array(palette.clone()));
            column.insert("x".into(), Value::Array(indices.clone()));
            candidates.push(column);

            // Dictionary-coded palette: an integer entry is a code in `t`. Only
            // an all-string palette can be coded, so an integer entry is never
            // ambiguous with a value that was genuinely a number.
            let codeable = dict::table_for_key(key)
                .filter(|_| palette.iter().all(Value::is_string))
                .filter(|_| plan.prefix.is_empty() && plan.suffix.is_empty());
            if let Some(table) = codeable {
                let coded: Vec<Value> = palette
                    .iter()
                    .map(|entry| match entry.as_str().and_then(|text| dict::code(table, text)) {
                        Some(code) => Value::from(code),
                        None => entry.clone(),
                    })
                    .collect();
                if coded.iter().any(Value::is_number) {
                    let mut column = Map::new();
                    column.insert("c".into(), Value::from(2u64));
                    column.insert("t".into(), Value::String(table.to_string()));
                    column.insert("p".into(), Value::Array(coded));
                    column.insert("x".into(), Value::Array(indices));
                    candidates.push(column);
                }
            }
        }

        let mut best: Option<(usize, Map<String, Value>)> = None;
        for mut candidate in candidates {
            plan.push_modifiers(&mut candidate);
            self.push_mask(&mut candidate, mask);
            let size = serde_json::to_vec(&Value::Object(candidate.clone()))
                .map(|bytes| bytes.len())
                .unwrap_or(usize::MAX);
            if best.as_ref().is_none_or(|(smallest, _)| size < *smallest) {
                best = Some((size, candidate));
            }
        }
        Value::Object(best.expect("the raw candidate is always present").1)
    }
}

/// The residual values a codec will encode, plus the modifiers that rebuild the
/// original values from them.
struct Plan {
    residuals: Vec<Value>,
    numeric_strings: bool,
    prefix: Affix,
    suffix: Affix,
}

#[derive(Default)]
struct Affix {
    code: Option<u32>,
    literal: String,
}

impl Affix {
    fn is_empty(&self) -> bool {
        self.code.is_none() && self.literal.is_empty()
    }
}

impl Plan {
    fn push_modifiers(&self, column: &mut Map<String, Value>) {
        if self.numeric_strings {
            column.insert("ns".into(), Value::from(1u64));
        }
        for (affix, code_key, literal_key) in [
            (&self.prefix, "prei", "pre"),
            (&self.suffix, "sufi", "suf"),
        ] {
            if let Some(code) = affix.code {
                column.insert(code_key.into(), Value::from(code));
            }
            if !affix.literal.is_empty() {
                column.insert(literal_key.into(), Value::String(affix.literal.clone()));
            }
        }
    }
}

fn plan_residuals(present: &[&Value]) -> Plan {
    let plain = |residuals: Vec<Value>| Plan {
        residuals,
        numeric_strings: false,
        prefix: Affix::default(),
        suffix: Affix::default(),
    };

    let strings: Option<Vec<&str>> = present.iter().map(|value| value.as_str()).collect();
    let Some(strings) = strings else {
        return plain(present.iter().map(|value| (*value).clone()).collect());
    };

    if let Some(integers) = as_decimal_integers(&strings) {
        return Plan {
            residuals: integers.into_iter().map(Value::from).collect(),
            numeric_strings: true,
            prefix: Affix::default(),
            suffix: Affix::default(),
        };
    }

    let prefix_len = common_prefix_len(&strings);
    let suffix_len = common_suffix_len(&strings, prefix_len);
    let prefix_len = if prefix_len >= MIN_AFFIX { prefix_len } else { 0 };
    let suffix_len = if suffix_len >= MIN_AFFIX { suffix_len } else { 0 };
    if prefix_len == 0 && suffix_len == 0 {
        return plain(strings.iter().map(|text| Value::from(*text)).collect());
    }

    let prefix = split_affix(&strings[0][..prefix_len]);
    let suffix = split_affix(&strings[0][strings[0].len() - suffix_len..]);
    let residuals = strings
        .iter()
        .map(|text| Value::from(&text[prefix_len..text.len() - suffix_len]))
        .collect();
    Plan {
        residuals,
        numeric_strings: false,
        prefix,
        suffix,
    }
}

/// Split an affix into "longest URL-prefix-table entry that starts it" plus the
/// remainder, so the shared table carries the repeated part.
fn split_affix(affix: &str) -> Affix {
    if affix.is_empty() {
        return Affix::default();
    }
    let best = dict::URL_PREFIXES
        .iter()
        .filter(|entry| affix.starts_with(**entry))
        .max_by_key(|entry| entry.len());
    match best {
        Some(entry) => Affix {
            code: dict::url_prefix_code(entry),
            literal: affix[entry.len()..].to_string(),
        },
        None => Affix {
            code: None,
            literal: affix.to_string(),
        },
    }
}

fn common_prefix_len(strings: &[&str]) -> usize {
    let Some(first) = strings.first() else {
        return 0;
    };
    let mut len = first.len();
    for text in &strings[1..] {
        let shared = first
            .as_bytes()
            .iter()
            .zip(text.as_bytes())
            .take(len)
            .take_while(|(a, b)| a == b)
            .count();
        len = shared;
        if len == 0 {
            return 0;
        }
    }
    // Never split a multi-byte character.
    while len > 0 && !first.is_char_boundary(len) {
        len -= 1;
    }
    len
}

fn common_suffix_len(strings: &[&str], prefix_len: usize) -> usize {
    let Some(first) = strings.first() else {
        return 0;
    };
    let budget = strings
        .iter()
        .map(|text| text.len().saturating_sub(prefix_len))
        .min()
        .unwrap_or(0);
    let mut len = budget;
    for text in &strings[1..] {
        let shared = first
            .as_bytes()
            .iter()
            .rev()
            .zip(text.as_bytes().iter().rev())
            .take(len)
            .take_while(|(a, b)| a == b)
            .count();
        len = shared;
        if len == 0 {
            return 0;
        }
    }
    while len > 0 && !first.is_char_boundary(first.len() - len) {
        len -= 1;
    }
    len
}

/// Every string is the canonical decimal form of a safe integer, so it can be
/// stored as a number and rebuilt exactly.
fn as_decimal_integers(strings: &[&str]) -> Option<Vec<i64>> {
    const SAFE: i64 = 9_007_199_254_740_991;
    let mut out = Vec::with_capacity(strings.len());
    for text in strings {
        if text.is_empty() || text.len() > 16 {
            return None;
        }
        // Canonical only: no sign, no leading zero, no whitespace, so
        // `value.to_string()` is byte-identical to the original.
        if !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        if text.len() > 1 && text.starts_with('0') {
            return None;
        }
        let value: i64 = text.parse().ok()?;
        if value > SAFE {
            return None;
        }
        out.push(value);
    }
    Some(out)
}

fn as_integers(values: &[Value]) -> Option<Vec<i64>> {
    values.iter().map(|value| value.as_i64()).collect()
}

/// A palette and index array, or `None` when nothing repeats.
fn palette_of(values: &[Value]) -> Option<(Vec<Value>, Vec<Value>)> {
    let mut palette: Vec<Value> = Vec::new();
    let mut lookup: HashMap<String, usize> = HashMap::new();
    let mut indices = Vec::with_capacity(values.len());
    for value in values {
        let key = serde_json::to_string(value).unwrap_or_default();
        let index = match lookup.get(&key) {
            Some(index) => *index,
            None => {
                let index = palette.len();
                palette.push(value.clone());
                lookup.insert(key, index);
                index
            }
        };
        indices.push(Value::from(index as u64));
    }
    (palette.len() < values.len()).then_some((palette, indices))
}

fn fingerprint(mask: &Option<Vec<bool>>, residuals: &[Value]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    match mask {
        Some(mask) => {
            hasher.update([1u8]);
            hasher.update(
                mask.iter()
                    .map(|present| u8::from(*present))
                    .collect::<Vec<u8>>(),
            );
        }
        None => hasher.update([0u8]),
    }
    hasher.update([0xffu8]);
    let mut buffer = Vec::with_capacity(64);
    for value in residuals {
        buffer.clear();
        let _ = serde_json::to_writer(&mut buffer, value);
        hasher.update((buffer.len() as u64).to_le_bytes());
        hasher.update(&buffer);
    }
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn subsequence_check() {
        let keys = ["a", "b", "c"];
        let owned = |list: &[&str]| list.iter().map(|k| k.to_string()).collect::<Vec<_>>();
        assert!(is_subsequence(owned(&["a", "c"]).iter(), &keys));
        assert!(is_subsequence(owned(&["a", "b", "c"]).iter(), &keys));
        assert!(is_subsequence(owned(&[]).iter(), &keys));
        assert!(!is_subsequence(owned(&["c", "a"]).iter(), &keys));
        assert!(!is_subsequence(owned(&["a", "d"]).iter(), &keys));
    }

    #[test]
    fn sorted_rows_with_an_early_optional_key_still_form_a_table() {
        let rows: Vec<Value> = (0..12)
            .map(|i| if i % 3 == 0 {
                serde_json::json!({"emoji": "x", "id": i.to_string(), "name": "Mew"})
            } else {
                serde_json::json!({"id": i.to_string(), "name": "Mew"})
            })
            .collect();
        let rows: Vec<Value> = std::iter::once(serde_json::json!({"id": "99", "name": "Mew"})).chain(rows).collect();
        let body = serde_json::json!({ "cards": rows });
        let encoded = super::encode(&body);
        assert_eq!(encoded["t"].as_array().map(Vec::len), Some(1), "{encoded}");
        assert_eq!(super::super::decode::decode(&encoded).unwrap(), body);
    }

    #[test]
    fn rows_in_a_different_key_order_are_left_alone() {
        let items = vec![
            json!({"a": 1, "b": 2}),
            json!({"b": 3, "a": 4}),
            json!({"a": 5, "b": 6}),
            json!({"a": 7, "b": 8}),
        ];
        assert!(encode_array(&items).is_none());
    }

    #[test]
    fn decimal_integers_are_canonical_only() {
        assert_eq!(as_decimal_integers(&["1", "668126"]), Some(vec![1, 668_126]));
        assert_eq!(as_decimal_integers(&["0"]), Some(vec![0]));
        assert_eq!(as_decimal_integers(&["01"]), None);
        assert_eq!(as_decimal_integers(&["-1"]), None);
        assert_eq!(as_decimal_integers(&[" 1"]), None);
        assert_eq!(as_decimal_integers(&["1.0"]), None);
        assert_eq!(as_decimal_integers(&[""]), None);
        assert_eq!(as_decimal_integers(&["9007199254740992"]), None);
    }

    #[test]
    fn affixes_stop_on_character_boundaries() {
        let strings = ["Pokémon ex", "Pokémon V"];
        let prefix = common_prefix_len(&strings);
        assert!(strings[0].is_char_boundary(prefix));
        assert_eq!(&strings[0][..prefix], "Pokémon ");
    }

    #[test]
    fn suffix_never_overlaps_the_prefix() {
        let strings = ["aaaaaa", "aaaaaa", "aaaaaaaa"];
        let prefix = common_prefix_len(&strings);
        let suffix = common_suffix_len(&strings, prefix);
        assert!(prefix + suffix <= strings.iter().map(|s| s.len()).min().unwrap());
    }

    #[test]
    fn url_prefix_table_carries_the_shared_head() {
        let affix = split_affix("/card-images/previews/");
        assert_eq!(affix.code, dict::url_prefix_code("/card-images/previews/"));
        assert_eq!(affix.literal, "");
        let affix = split_affix("/card-images/odd/");
        assert_eq!(affix.code, dict::url_prefix_code("/card-images/"));
        assert_eq!(affix.literal, "odd/");
        let affix = split_affix("something-else/");
        assert_eq!(affix.code, None);
        assert_eq!(affix.literal, "something-else/");
        assert!(Affix::default().is_empty());
    }

    #[test]
    fn aliased_columns_become_refs() {
        let rows: Vec<Value> = (0..8)
            .map(|index| json!({"id": format!("{}", 100 + index), "card_id": format!("{}", 100 + index)}))
            .collect();
        let table = encode_array(&rows).expect("table");
        assert_eq!(table["c"][1]["c"], json!(4));
        assert_eq!(table["c"][1]["r"], json!(0));
    }

    #[test]
    fn short_arrays_are_left_alone() {
        assert!(encode_array(&[json!({"a": 1})]).is_none());
        assert!(encode_array(&[json!(1), json!(2)]).is_none());
        assert!(encode_array(&[]).is_none());
    }

    #[test]
    fn dollar_c1_keys_in_the_source_are_escaped() {
        let body = json!({"weird": {"$c1": 7}});
        let encoded = encode(&body);
        assert_eq!(encoded["b"]["weird"]["$c1x"]["$c1"], json!(7));
    }
}
