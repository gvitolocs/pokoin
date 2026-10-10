//! The inverse of [`super::encode`].
//!
//! The decoder exists for two reasons: it is the Rust half of the round-trip
//! test that proves a `c1` payload rebuilds the default JSON exactly, and it is
//! the reference `market/src/compact.js` is written against. It is deliberately
//! defensive — every index is bounds-checked and every reference must point
//! backwards — so a malformed document is an error rather than a panic.

use serde_json::{Map, Value};

use super::dict;

/// Why a document could not be decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError(pub String);

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "c1 decode failed: {}", self.0)
    }
}

impl std::error::Error for DecodeError {}

type Result<T> = std::result::Result<T, DecodeError>;

fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(DecodeError(message.into()))
}

/// Rebuild the original response body from a `c1` document.
pub fn decode(document: &Value) -> Result<Value> {
    let Some(map) = document.as_object() else {
        return fail("document is not an object");
    };
    match map.get("c1").and_then(Value::as_u64) {
        Some(version) if version == super::encode::FORMAT_VERSION => {}
        Some(version) => return fail(format!("unsupported c1 version {version}")),
        None => return fail("missing c1 version"),
    }
    let tables = match map.get("t") {
        Some(Value::Array(tables)) => tables.as_slice(),
        None => &[],
        Some(_) => return fail("t is not an array"),
    };
    let decoded: Vec<Value> = tables
        .iter()
        .map(decode_table)
        .collect::<Result<Vec<Value>>>()?;
    let Some(skeleton) = map.get("b") else {
        return fail("missing body");
    };
    rebuild(skeleton, &decoded)
}

fn rebuild(value: &Value, tables: &[Value]) -> Result<Value> {
    match value {
        Value::Array(items) => Ok(Value::Array(
            items
                .iter()
                .map(|item| rebuild(item, tables))
                .collect::<Result<Vec<Value>>>()?,
        )),
        Value::Object(map) => {
            if map.len() == 1 {
                if let Some(index) = map.get("$c1") {
                    let Some(index) = index.as_u64().and_then(|i| usize::try_from(i).ok()) else {
                        return fail("table placeholder is not an index");
                    };
                    return tables
                        .get(index)
                        .cloned()
                        .ok_or_else(|| DecodeError(format!("table {index} is out of range")));
                }
                // An escaped object: its own keys are literal data (one of them
                // looks like a marker), but its values still hold placeholders.
                if let Some(Value::Object(inner)) = map.get("$c1x") {
                    let mut out = Map::new();
                    for (key, item) in inner {
                        out.insert(key.clone(), rebuild(item, tables)?);
                    }
                    return Ok(Value::Object(out));
                }
            }
            let mut out = Map::new();
            for (key, item) in map {
                out.insert(key.clone(), rebuild(item, tables)?);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

fn decode_table(table: &Value) -> Result<Value> {
    let Some(map) = table.as_object() else {
        return fail("table is not an object");
    };
    let Some(rows) = map.get("n").and_then(Value::as_u64).and_then(|n| usize::try_from(n).ok())
    else {
        return fail("table has no row count");
    };
    let Some(Value::Array(columns)) = map.get("c") else {
        return fail("table has no columns");
    };

    // Columns are decoded left to right; a `ref` may only point backwards, so
    // one pass resolves every reference.
    let mut decoded: Vec<Column> = Vec::with_capacity(columns.len());
    for column in columns {
        let column = decode_column(column, rows, &decoded)?;
        decoded.push(column);
    }

    match map.get("k") {
        None => {
            let [column] = decoded.as_slice() else {
                return fail("a vector table needs exactly one column");
            };
            let mut out = Vec::with_capacity(rows);
            for row in 0..rows {
                match column.at(row) {
                    Some(value) => out.push(value.clone()),
                    None => return fail("a vector table cannot have absent cells"),
                }
            }
            Ok(Value::Array(out))
        }
        Some(Value::Array(keys)) => {
            if keys.len() != decoded.len() {
                return fail("key count does not match column count");
            }
            let names: Vec<&str> = keys
                .iter()
                .map(|key| key.as_str().unwrap_or_default())
                .collect();
            let mut out = Vec::with_capacity(rows);
            for row in 0..rows {
                let mut object = Map::new();
                for (name, column) in names.iter().zip(&decoded) {
                    if let Some(value) = column.at(row) {
                        object.insert((*name).to_string(), value.clone());
                    }
                }
                out.push(Value::Object(object));
            }
            Ok(Value::Array(out))
        }
        Some(_) => fail("k is not an array"),
    }
}

/// A decoded column: the residuals it stores, the values they expand to, and
/// which rows carry a value.
struct Column {
    mask: Option<Vec<bool>>,
    /// `row -> index into values`, or `None` for a row without this key.
    /// Precomputed so rebuilding a table stays linear in the cell count.
    slots: Option<Vec<Option<usize>>>,
    residuals: Vec<Value>,
    values: Vec<Value>,
}

impl Column {
    fn new(mask: Option<Vec<bool>>, residuals: Vec<Value>, values: Vec<Value>) -> Self {
        let slots = mask.as_ref().map(|mask| {
            let mut next = 0;
            mask.iter()
                .map(|present| {
                    present.then(|| {
                        let slot = next;
                        next += 1;
                        slot
                    })
                })
                .collect()
        });
        Self {
            mask,
            slots,
            residuals,
            values,
        }
    }

    /// The value at a row, or `None` when the row does not carry this key.
    fn at(&self, row: usize) -> Option<&Value> {
        match &self.slots {
            None => self.values.get(row),
            Some(slots) => self.values.get((*slots.get(row)?)?),
        }
    }
}

fn decode_column(column: &Value, rows: usize, earlier: &[Column]) -> Result<Column> {
    let Some(map) = column.as_object() else {
        return fail("column is not an object");
    };
    let Some(codec) = map.get("c").and_then(Value::as_u64) else {
        return fail("column has no codec");
    };

    let own_mask: Option<Vec<bool>> = match map.get("m") {
        None => None,
        Some(Value::Array(flags)) => {
            if flags.len() != rows {
                return fail("presence mask length does not match the row count");
            }
            Some(
                flags
                    .iter()
                    .map(|flag| flag.as_u64().unwrap_or(0) != 0)
                    .collect(),
            )
        }
        Some(_) => return fail("m is not an array"),
    };

    let (mask, residuals) = match codec {
        4 => {
            let Some(root) = map.get("r").and_then(Value::as_u64).and_then(|r| usize::try_from(r).ok())
            else {
                return fail("ref column has no target");
            };
            let Some(root) = earlier.get(root) else {
                return fail("ref column points forward or out of range");
            };
            (root.mask.clone(), root.residuals.clone())
        }
        other => {
            let present = match &own_mask {
                Some(mask) => mask.iter().filter(|present| **present).count(),
                None => rows,
            };
            (own_mask, residuals_for(other, map, present)?)
        }
    };

    let mut values = residuals.clone();

    if map.get("ns").and_then(Value::as_u64).unwrap_or(0) != 0 {
        for value in &mut values {
            let Some(number) = value.as_i64() else {
                return fail("ns column holds a non-integer");
            };
            *value = Value::String(number.to_string());
        }
    }

    let prefix = affix(map, "prei", "pre")?;
    let suffix = affix(map, "sufi", "suf")?;
    if !prefix.is_empty() || !suffix.is_empty() {
        for value in &mut values {
            let Some(text) = value.as_str() else {
                return fail("affix column holds a non-string");
            };
            *value = Value::String(format!("{prefix}{text}{suffix}"));
        }
    }

    Ok(Column::new(mask, residuals, values))
}

fn residuals_for(codec: u64, map: &Map<String, Value>, present: usize) -> Result<Vec<Value>> {
    match codec {
        0 => {
            let Some(value) = map.get("v") else {
                return fail("const column has no value");
            };
            Ok(vec![value.clone(); present])
        }
        1 => match map.get("v") {
            Some(Value::Array(values)) => {
                if values.len() != present {
                    return fail("raw column length does not match the presence count");
                }
                Ok(values.clone())
            }
            _ => fail("raw column has no values"),
        },
        2 => {
            let Some(Value::Array(palette)) = map.get("p") else {
                return fail("palette column has no palette");
            };
            let Some(Value::Array(indices)) = map.get("x") else {
                return fail("palette column has no indices");
            };
            if indices.len() != present {
                return fail("palette index count does not match the presence count");
            }
            let table = map.get("t").and_then(Value::as_str);
            let mut entries = Vec::with_capacity(palette.len());
            for entry in palette {
                match (table, entry.as_u64()) {
                    // With a table, an integer entry is a dictionary code and a
                    // string entry is a literal the table does not carry.
                    (Some(table), Some(code)) => {
                        let code = u32::try_from(code)
                            .ok()
                            .and_then(|code| dict::entry(table, code));
                        match code {
                            Some(text) => entries.push(Value::String(text.to_string())),
                            None => {
                                return fail(format!(
                                    "dictionary {table} has no code {entry}; refetch /api/dictionary"
                                ))
                            }
                        }
                    }
                    _ => entries.push(entry.clone()),
                }
            }
            let mut values = Vec::with_capacity(indices.len());
            for index in indices {
                let Some(entry) = index
                    .as_u64()
                    .and_then(|i| usize::try_from(i).ok())
                    .and_then(|i| entries.get(i))
                else {
                    return fail("palette index is out of range");
                };
                values.push(entry.clone());
            }
            Ok(values)
        }
        3 => {
            let Some(first) = map.get("z").and_then(Value::as_i64) else {
                return fail("delta column has no first value");
            };
            let Some(Value::Array(deltas)) = map.get("d") else {
                return fail("delta column has no deltas");
            };
            if deltas.len() + 1 != present {
                return fail("delta count does not match the presence count");
            }
            let mut values = Vec::with_capacity(present);
            let mut current = first;
            values.push(Value::from(current));
            for delta in deltas {
                let Some(delta) = delta.as_i64() else {
                    return fail("delta is not an integer");
                };
                let Some(next) = current.checked_add(delta) else {
                    return fail("delta overflows");
                };
                current = next;
                values.push(Value::from(current));
            }
            Ok(values)
        }
        other => fail(format!("unknown codec {other}")),
    }
}

fn affix(map: &Map<String, Value>, code_key: &str, literal_key: &str) -> Result<String> {
    let mut out = String::new();
    if let Some(code) = map.get(code_key) {
        let Some(prefix) = code
            .as_u64()
            .and_then(|code| u32::try_from(code).ok())
            .and_then(dict::url_prefix)
        else {
            return fail(format!(
                "url prefix {code} is unknown; refetch /api/dictionary"
            ));
        };
        out.push_str(prefix);
    }
    if let Some(literal) = map.get(literal_key) {
        let Some(literal) = literal.as_str() else {
            return fail("affix literal is not a string");
        };
        out.push_str(literal);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_a_foreign_document() {
        assert!(decode(&json!({"cards": []})).is_err());
        assert!(decode(&json!(7)).is_err());
        assert!(decode(&json!({"c1": 99, "b": {}, "t": []})).is_err());
    }

    #[test]
    fn rejects_a_forward_reference() {
        let document = json!({
            "c1": 1,
            "b": {"$c1": 0},
            "t": [{"n": 2, "k": ["a", "b"], "c": [
                {"c": 4, "r": 1},
                {"c": 1, "v": ["x", "y"]},
            ]}],
        });
        let error = decode(&document).expect_err("forward ref");
        assert!(error.0.contains("points forward"), "{error}");
    }

    #[test]
    fn rejects_an_unknown_dictionary_code() {
        let document = json!({
            "c1": 1,
            "b": {"$c1": 0},
            "t": [{"n": 2, "k": ["nationality"], "c": [
                {"c": 2, "t": "nationalities", "p": [9999], "x": [0, 0]},
            ]}],
        });
        let error = decode(&document).expect_err("unknown code");
        assert!(error.0.contains("refetch /api/dictionary"), "{error}");
    }

    #[test]
    fn rejects_a_length_mismatch() {
        let document = json!({
            "c1": 1,
            "b": {"$c1": 0},
            "t": [{"n": 3, "k": ["a"], "c": [{"c": 1, "v": ["x", "y"]}]}],
        });
        assert!(decode(&document).is_err());
    }

    #[test]
    fn mask_places_values_on_the_rows_that_have_them() {
        let document = json!({
            "c1": 1,
            "b": {"$c1": 0},
            "t": [{"n": 3, "k": ["a"], "c": [
                {"c": 1, "v": ["x", "z"], "m": [1, 0, 1]},
            ]}],
        });
        assert_eq!(
            decode(&document).expect("decode"),
            json!([{"a": "x"}, {}, {"a": "z"}])
        );
    }
}
