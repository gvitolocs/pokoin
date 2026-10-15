//! `ctbook`: a lossless columnar file format for CardTrader listing books.
//!
//! A listing book is what `GET /marketplace/products?expansion_id=` returns:
//! `{"<blueprint id>": [listing, ...], ...}`. Listings repeat the same keys,
//! the same expansion, a few thousand sellers and a few hundred prices, so
//! storing them column by column and then brotli-compressing the result is
//! much smaller than gzip JSON, and still decodes to the exact same document.
//!
//! File layout (integers little-endian):
//!
//! ```text
//! magic    b"CTB1"
//! u32      blueprints   number of top-level keys
//! u64      listings     sum of the top-level array lengths
//! u64      payload      length of the brotli stream that follows
//! [u8]     brotli(doc)
//! ```
//!
//! The fixed header lets a resuming dump count a stored book and spot a
//! truncated file without decompressing it.
//!
//! `doc` is a JSON document:
//!
//! ```text
//! {"ctb":1,
//!  "keys":[top-level keys, in order],
//!  "runs":[for each key: its array length, or -1 when the value is not an array],
//!  "other":[the values whose run is -1, in order],
//!  "shapes":[shape, ...],
//!  "shape":<column: the shape index of every listing, in book order>,
//!  "cols":[<column>, ...]}
//! ```
//!
//! A *shape* is a listing's key structure: an object listing becomes an
//! object with the same keys in the same order, where every non-object value
//! is replaced by its column id and nested objects become nested shapes. A
//! listing that is not an object has its bare column id as its shape. Leaves
//! are grouped into columns by their key path from the listing root, so the
//! decoder walks each listing's shape and takes the next value from each
//! leaf's column: key order, missing keys and value types all round-trip.
//!
//! A column is the shortest of `{"v":[values]}` (plain),
//! `{"t":[distinct values in first-appearance order],"c":[codes]}`
//! (dictionary) and, when every value is an i64, `{"d":[first, delta, ...]}`.
//! First-appearance codes make correlated columns (`user.id` and
//! `user.username`, `price_cents` and `price.cents`) produce identical code
//! sequences, which brotli removes almost for free.

use std::collections::HashMap;
use std::fmt;
use std::io::{Read, Write};

use serde_json::{Map, Value};

pub const MAGIC: &[u8; 4] = b"CTB1";
pub const HEADER_LEN: usize = 24;
/// Brotli window: books reach ~50 MB, a 16 MB window finds repeats across blueprints.
const LGWIN: i32 = 24;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(String);

impl Error {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counts {
    pub blueprints: u64,
    pub listings: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub counts: Counts,
    pub payload_len: u64,
}

/// Top-level key count and the total of the array lengths, as the dump reports them.
pub fn counts(book: &Value) -> Counts {
    match book.as_object() {
        Some(map) => Counts {
            blueprints: map.len() as u64,
            listings: map
                .values()
                .filter_map(Value::as_array)
                .map(|rows| rows.len() as u64)
                .sum(),
        },
        None => Counts::default(),
    }
}

/// Encode a book to a complete `.ctb` file (header + brotli payload).
pub fn write(book: &Value, quality: u32) -> Result<Vec<u8>, Error> {
    let doc = encode_doc(book)?;
    let payload = brotli_compress(&doc, quality)?;
    let counts = counts(book);
    let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(counts.blueprints as u32).to_le_bytes());
    out.extend_from_slice(&counts.listings.to_le_bytes());
    out.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

/// Decode a complete `.ctb` file back to the book.
pub fn read(bytes: &[u8]) -> Result<Value, Error> {
    let header = read_header(bytes)?;
    let total = HEADER_LEN as u64 + header.payload_len;
    if bytes.len() as u64 != total {
        return Err(Error::new(format!(
            "ctb file is {} bytes, header says {total}",
            bytes.len()
        )));
    }
    let mut doc = Vec::new();
    brotli::BrotliDecompress(&mut &bytes[HEADER_LEN..], &mut doc)
        .map_err(|error| Error::new(format!("brotli: {error}")))?;
    decode_doc(&doc)
}

/// The fixed header of a `.ctb` file (needs at least `HEADER_LEN` bytes).
pub fn read_header(bytes: &[u8]) -> Result<Header, Error> {
    if bytes.len() < HEADER_LEN || &bytes[..4] != MAGIC {
        return Err(Error::new("not a ctb file"));
    }
    let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    let u64_at = |at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
    Ok(Header {
        counts: Counts {
            blueprints: u32_at(4) as u64,
            listings: u64_at(8),
        },
        payload_len: u64_at(16),
    })
}

/// Header of a stored file, checking that the file is as long as the header
/// says (a crash can leave a renamed but truncated file behind).
pub fn check_file(path: &std::path::Path) -> Result<Header, Error> {
    let mut file = std::fs::File::open(path).map_err(|error| Error::new(error.to_string()))?;
    let mut head = [0u8; HEADER_LEN];
    file.read_exact(&mut head)
        .map_err(|_| Error::new("ctb file shorter than its header"))?;
    let header = read_header(&head)?;
    let len = file
        .metadata()
        .map_err(|error| Error::new(error.to_string()))?
        .len();
    if len != HEADER_LEN as u64 + header.payload_len {
        return Err(Error::new(format!(
            "ctb file is {len} bytes, header says {}",
            HEADER_LEN as u64 + header.payload_len
        )));
    }
    Ok(header)
}

pub fn brotli_compress(doc: &[u8], quality: u32) -> Result<Vec<u8>, Error> {
    let params = brotli::enc::BrotliEncoderParams {
        quality: quality.min(11) as i32,
        lgwin: LGWIN,
        ..Default::default()
    };
    let mut out = Vec::with_capacity(doc.len() / 8);
    brotli::BrotliCompress(&mut &doc[..], &mut out, &params)
        .map_err(|error| Error::new(format!("brotli: {error}")))?;
    Ok(out)
}

// ---------------------------------------------------------------- encoding

/// Key-path trie: each node may own the leaf column for its path.
struct Node {
    leaf: Option<usize>,
    children: HashMap<String, usize>,
}

struct Encoder<'a> {
    nodes: Vec<Node>,
    columns: Vec<Vec<&'a Value>>,
    shapes: Vec<Vec<u8>>,
    shape_ids: HashMap<Vec<u8>, u32>,
    shape_column: Vec<u32>,
    scratch: Vec<u8>,
}

impl<'a> Encoder<'a> {
    fn new() -> Self {
        Self {
            nodes: vec![Node {
                leaf: None,
                children: HashMap::new(),
            }],
            columns: Vec::new(),
            shapes: Vec::new(),
            shape_ids: HashMap::new(),
            shape_column: Vec::new(),
            scratch: Vec::with_capacity(512),
        }
    }

    fn leaf(&mut self, node: usize, value: &'a Value) -> usize {
        let column = match self.nodes[node].leaf {
            Some(column) => column,
            None => {
                self.columns.push(Vec::new());
                let column = self.columns.len() - 1;
                self.nodes[node].leaf = Some(column);
                column
            }
        };
        self.columns[column].push(value);
        column
    }

    fn child(&mut self, node: usize, key: &str) -> usize {
        if let Some(&child) = self.nodes[node].children.get(key) {
            return child;
        }
        self.nodes.push(Node {
            leaf: None,
            children: HashMap::new(),
        });
        let child = self.nodes.len() - 1;
        self.nodes[node].children.insert(key.to_owned(), child);
        child
    }

    /// Append this value's shape to `scratch` and its leaves to their columns.
    fn walk(&mut self, node: usize, value: &'a Value) {
        match value {
            Value::Object(map) => {
                self.scratch.push(b'{');
                for (index, (key, child_value)) in map.iter().enumerate() {
                    if index > 0 {
                        self.scratch.push(b',');
                    }
                    serde_json::to_writer(&mut self.scratch, key).expect("vec write");
                    self.scratch.push(b':');
                    let child = self.child(node, key);
                    self.walk(child, child_value);
                }
                self.scratch.push(b'}');
            }
            leaf => {
                let column = self.leaf(node, leaf);
                push_uint(&mut self.scratch, column as u64);
            }
        }
    }

    fn listing(&mut self, listing: &'a Value) {
        self.scratch.clear();
        self.walk(0, listing);
        let id = match self.shape_ids.get(self.scratch.as_slice()) {
            Some(&id) => id,
            None => {
                let id = self.shapes.len() as u32;
                self.shapes.push(self.scratch.clone());
                self.shape_ids.insert(self.scratch.clone(), id);
                id
            }
        };
        self.shape_column.push(id);
    }
}

/// Encode a book to the (uncompressed) `doc` JSON.
pub fn encode_doc(book: &Value) -> Result<Vec<u8>, Error> {
    let map = book
        .as_object()
        .ok_or_else(|| Error::new("a listing book must be a JSON object"))?;
    let mut encoder = Encoder::new();
    let mut runs: Vec<i64> = Vec::with_capacity(map.len());
    let mut other: Vec<&Value> = Vec::new();
    for value in map.values() {
        match value {
            Value::Array(listings) => {
                runs.push(listings.len() as i64);
                for listing in listings {
                    encoder.listing(listing);
                }
            }
            other_value => {
                runs.push(-1);
                other.push(other_value);
            }
        }
    }

    let mut doc = Vec::with_capacity(1 << 20);
    doc.extend_from_slice(b"{\"ctb\":1,\"keys\":");
    serde_json::to_writer(&mut doc, &map.keys().collect::<Vec<_>>()).expect("vec write");
    doc.extend_from_slice(b",\"runs\":");
    serde_json::to_writer(&mut doc, &runs).expect("vec write");
    doc.extend_from_slice(b",\"other\":");
    serde_json::to_writer(&mut doc, &other).expect("vec write");
    doc.extend_from_slice(b",\"shapes\":[");
    for (index, shape) in encoder.shapes.iter().enumerate() {
        if index > 0 {
            doc.push(b',');
        }
        doc.extend_from_slice(shape);
    }
    doc.extend_from_slice(b"],\"shape\":");
    let shape_values: Vec<Value> = encoder
        .shape_column
        .iter()
        .map(|&id| Value::from(id))
        .collect();
    write_column(&mut doc, &shape_values.iter().collect::<Vec<_>>());
    doc.extend_from_slice(b",\"cols\":[");
    for (index, column) in encoder.columns.iter().enumerate() {
        if index > 0 {
            doc.push(b',');
        }
        write_column(&mut doc, column);
    }
    doc.extend_from_slice(b"]}");
    Ok(doc)
}

fn uint_len(mut value: u64) -> usize {
    let mut digits = 1;
    while value >= 10 {
        value /= 10;
        digits += 1;
    }
    digits
}

fn int_len(value: i64) -> usize {
    uint_len(value.unsigned_abs()) + usize::from(value < 0)
}

fn push_uint(out: &mut Vec<u8>, value: u64) {
    let mut buffer = itoa::Buffer::new();
    out.extend_from_slice(buffer.format(value).as_bytes());
}

fn push_int(out: &mut Vec<u8>, value: i64) {
    let mut buffer = itoa::Buffer::new();
    out.extend_from_slice(buffer.format(value).as_bytes());
}

/// Write the shortest of the plain, dictionary and delta encodings.
fn write_column(out: &mut Vec<u8>, values: &[&Value]) {
    let n = values.len();
    let separators = n.saturating_sub(1);

    // Dictionary codes over the serialised values (needed by both plain and dict).
    let mut distinct: Vec<Vec<u8>> = Vec::new();
    let mut ids: HashMap<Vec<u8>, u32> = HashMap::new();
    let mut codes: Vec<u32> = Vec::with_capacity(n);
    let mut scratch = Vec::with_capacity(64);
    let mut plain_len = 0usize;
    for value in values {
        scratch.clear();
        serde_json::to_writer(&mut scratch, value).expect("vec write");
        plain_len += scratch.len();
        let code = match ids.get(scratch.as_slice()) {
            Some(&code) => code,
            None => {
                let code = distinct.len() as u32;
                distinct.push(scratch.clone());
                ids.insert(scratch.clone(), code);
                code
            }
        };
        codes.push(code);
    }
    plain_len += separators + "{\"v\":[]}".len();
    let dict_len = distinct.iter().map(Vec::len).sum::<usize>()
        + distinct.len().saturating_sub(1)
        + codes.iter().map(|&code| uint_len(code as u64)).sum::<usize>()
        + separators
        + "{\"t\":[],\"c\":[]}".len();

    // Delta: every value an i64 (u64 above i64::MAX and floats are excluded).
    let mut deltas: Option<Vec<i64>> = Some(Vec::with_capacity(n));
    let mut previous = 0i64;
    for (index, value) in values.iter().enumerate() {
        let Some(list) = deltas.as_mut() else { break };
        let integer = match value {
            Value::Number(number) if number.is_i64() || number.is_u64() => number.as_i64(),
            _ => None,
        };
        match integer {
            Some(current) if index == 0 => {
                list.push(current);
                previous = current;
            }
            Some(current) => match current.checked_sub(previous) {
                Some(delta) => {
                    list.push(delta);
                    previous = current;
                }
                None => deltas = None,
            },
            None => deltas = None,
        }
    }
    let delta_len = deltas.as_ref().map(|list| {
        list.iter().map(|&delta| int_len(delta)).sum::<usize>()
            + separators
            + "{\"d\":[]}".len()
    });

    match delta_len {
        Some(len) if len < plain_len && len <= dict_len => {
            out.extend_from_slice(b"{\"d\":[");
            for (index, &delta) in deltas.as_ref().unwrap().iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                push_int(out, delta);
            }
            out.extend_from_slice(b"]}");
        }
        _ if dict_len < plain_len => {
            out.extend_from_slice(b"{\"t\":[");
            for (index, value) in distinct.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                out.extend_from_slice(value);
            }
            out.extend_from_slice(b"],\"c\":[");
            for (index, &code) in codes.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                push_uint(out, code as u64);
            }
            out.extend_from_slice(b"]}");
        }
        _ => {
            out.extend_from_slice(b"{\"v\":[");
            for (index, &code) in codes.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                out.extend_from_slice(&distinct[code as usize]);
            }
            out.extend_from_slice(b"]}");
        }
    }
}

// ---------------------------------------------------------------- decoding

enum Column {
    Plain(std::vec::IntoIter<Value>),
    Dict { table: Vec<Value>, codes: std::vec::IntoIter<u64> },
    Delta { deltas: std::vec::IntoIter<i64>, current: i64, started: bool },
}

impl Column {
    fn parse(value: Value) -> Result<Self, Error> {
        let Value::Object(mut map) = value else {
            return Err(Error::new("column is not an object"));
        };
        if let Some(Value::Array(values)) = map.remove("v") {
            return Ok(Column::Plain(values.into_iter()));
        }
        if let (Some(Value::Array(table)), Some(Value::Array(codes))) = (map.remove("t"), map.remove("c")) {
            let codes = codes
                .iter()
                .map(|code| code.as_u64().ok_or_else(|| Error::new("bad dictionary code")))
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(Column::Dict {
                table,
                codes: codes.into_iter(),
            });
        }
        if let Some(Value::Array(deltas)) = map.remove("d") {
            let deltas = deltas
                .iter()
                .map(|delta| delta.as_i64().ok_or_else(|| Error::new("bad delta")))
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(Column::Delta {
                deltas: deltas.into_iter(),
                current: 0,
                started: false,
            });
        }
        Err(Error::new("unknown column encoding"))
    }

    fn next(&mut self) -> Result<Value, Error> {
        let exhausted = || Error::new("column exhausted");
        match self {
            Column::Plain(values) => values.next().ok_or_else(exhausted),
            Column::Dict { table, codes } => {
                let code = codes.next().ok_or_else(exhausted)? as usize;
                table
                    .get(code)
                    .cloned()
                    .ok_or_else(|| Error::new("dictionary code out of range"))
            }
            Column::Delta {
                deltas,
                current,
                started,
            } => {
                let delta = deltas.next().ok_or_else(exhausted)?;
                *current = if *started {
                    current
                        .checked_add(delta)
                        .ok_or_else(|| Error::new("delta overflow"))?
                } else {
                    delta
                };
                *started = true;
                Ok(Value::from(*current))
            }
        }
    }
}

fn build(shape: &Value, columns: &mut [Column]) -> Result<Value, Error> {
    match shape {
        Value::Number(number) => {
            let column = number
                .as_u64()
                .ok_or_else(|| Error::new("bad column id"))? as usize;
            columns
                .get_mut(column)
                .ok_or_else(|| Error::new("column id out of range"))?
                .next()
        }
        Value::Object(map) => {
            let mut out = Map::with_capacity(map.len());
            for (key, child) in map {
                out.insert(key.clone(), build(child, columns)?);
            }
            Ok(Value::Object(out))
        }
        _ => Err(Error::new("bad shape")),
    }
}

/// Decode a `doc` JSON document back to the book.
pub fn decode_doc(doc: &[u8]) -> Result<Value, Error> {
    let Value::Object(mut root) =
        serde_json::from_slice::<Value>(doc).map_err(|error| Error::new(format!("doc: {error}")))?
    else {
        return Err(Error::new("doc is not an object"));
    };
    if root.get("ctb") != Some(&Value::from(1)) {
        return Err(Error::new("unsupported ctb version"));
    }
    let take_array = |root: &mut Map<String, Value>, key: &str| match root.remove(key) {
        Some(Value::Array(values)) => Ok(values),
        _ => Err(Error::new(format!("doc.{key} missing"))),
    };
    let keys = take_array(&mut root, "keys")?;
    let runs = take_array(&mut root, "runs")?;
    let other = take_array(&mut root, "other")?;
    let shapes = take_array(&mut root, "shapes")?;
    let mut shape_column = Column::parse(root.remove("shape").ok_or_else(|| Error::new("doc.shape missing"))?)?;
    let mut columns = take_array(&mut root, "cols")?
        .into_iter()
        .map(Column::parse)
        .collect::<Result<Vec<_>, _>>()?;
    if keys.len() != runs.len() {
        return Err(Error::new("keys and runs differ in length"));
    }
    let mut other = other.into_iter();
    let mut book = Map::with_capacity(keys.len());
    for (key, run) in keys.into_iter().zip(runs) {
        let Value::String(key) = key else {
            return Err(Error::new("key is not a string"));
        };
        let run = run.as_i64().ok_or_else(|| Error::new("bad run"))?;
        let value = if run < 0 {
            other.next().ok_or_else(|| Error::new("other exhausted"))?
        } else {
            let mut listings = Vec::with_capacity(run as usize);
            for _ in 0..run {
                let index = shape_column
                    .next()?
                    .as_u64()
                    .ok_or_else(|| Error::new("bad shape index"))? as usize;
                let shape = shapes
                    .get(index)
                    .ok_or_else(|| Error::new("shape index out of range"))?;
                listings.push(build(shape, &mut columns)?);
            }
            Value::Array(listings)
        };
        book.insert(key, value);
    }
    Ok(Value::Object(book))
}

/// Read a `.json` or `.json.gz` book (CLI and tests).
pub fn read_json_book(path: &std::path::Path) -> Result<Value, Error> {
    let bytes = std::fs::read(path).map_err(|error| Error::new(format!("{}: {error}", path.display())))?;
    let raw = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::with_capacity(bytes.len() * 8);
        flate2::read::GzDecoder::new(&bytes[..])
            .read_to_end(&mut out)
            .map_err(|error| Error::new(format!("{}: {error}", path.display())))?;
        out
    } else {
        bytes
    };
    serde_json::from_slice(&raw).map_err(|error| Error::new(format!("{}: {error}", path.display())))
}

/// Write `bytes` to `dest` atomically: `.part` file, fsync, rename.
pub fn write_atomic(dest: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut part = dest.as_os_str().to_owned();
    part.push(".part");
    let part = std::path::PathBuf::from(part);
    {
        let mut file = std::fs::File::create(&part)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&part, dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn round_trip(book: Value) {
        let file = write(&book, 9).expect("encode");
        let back = read(&file).expect("decode");
        assert_eq!(
            serde_json::to_vec(&back).unwrap(),
            serde_json::to_vec(&book).unwrap(),
            "round trip changed the book"
        );
        let header = read_header(&file).unwrap();
        assert_eq!(header.counts, counts(&book));
        assert_eq!(header.payload_len as usize, file.len() - HEADER_LEN);
    }

    #[test]
    fn empty_book_and_empty_array() {
        round_trip(json!({}));
        round_trip(json!({"1": []}));
    }

    #[test]
    fn top_level_value_that_is_not_an_array() {
        round_trip(json!({"1": [{"id": 1}], "meta": {"x": 1}, "n": null, "2": [{"id": 2}]}));
    }

    #[test]
    fn key_orders_missing_keys_and_types_survive() {
        round_trip(json!({
            "10": [
                {"id": 1, "user": {"id": 7, "name": "a"}, "price_cents": 100},
                {"user": {"name": "b", "id": 8}, "id": 2},
                {"id": 3, "user": null, "price_cents": 1.5},
                {"id": 4, "user": "text", "tags": [1, "x", {"y": 2}]},
                {}
            ],
            "11": [{"id": -5, "big": 18446744073709551615u64, "s": "é \"q\" \\ \n 😀"}]
        }));
    }

    #[test]
    fn non_object_listings() {
        round_trip(json!({"1": [1, "two", null, [3], {"id": 4}, {"nested": {}}]}));
    }

    #[test]
    fn each_column_encoding_is_chosen() {
        let listings: Vec<Value> = (0..200)
            .map(|i| {
                let condition = ["NM", "SP"][i as usize % 2];
                json!({
                    "id": 1_000_000 + i,                       // delta
                    "condition": condition,                    // dictionary
                    "description": format!("unique text {i}"), // plain
                })
            })
            .collect();
        let book = json!({"5": listings});
        let doc = String::from_utf8(encode_doc(&book).unwrap()).unwrap();
        assert!(doc.contains("{\"d\":["), "{doc}");
        assert!(doc.contains("{\"t\":["), "{doc}");
        assert!(doc.contains("{\"v\":["), "{doc}");
        round_trip(book);
    }

    #[test]
    fn a_truncated_or_foreign_file_is_rejected() {
        let file = write(&json!({"1": [{"id": 1}]}), 5).unwrap();
        assert!(read(&file[..file.len() - 1]).is_err());
        assert!(read(b"{\"1\":[]}").is_err());
        assert!(read_header(b"CTB1").is_err());
    }

    #[test]
    fn non_object_book_is_an_error_not_a_panic() {
        assert!(write(&json!([1, 2]), 5).is_err());
        assert!(decode_doc(b"not json").is_err());
        assert!(decode_doc(br#"{"ctb":1,"keys":["a"],"runs":[2],"other":[],"shapes":[0],"shape":{"v":[0]},"cols":[{"v":[1]}]}"#).is_err());
    }

    #[test]
    fn real_samples_round_trip() {
        let Ok(paths) = std::env::var("CTBOOK_SAMPLES") else { return };
        for path in paths.split(':').filter(|path| !path.is_empty()) {
            let book = read_json_book(std::path::Path::new(path)).unwrap();
            round_trip(book);
        }
    }
}
