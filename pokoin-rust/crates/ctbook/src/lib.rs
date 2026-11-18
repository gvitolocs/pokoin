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
//! magic    b"CTB1" (self-contained) or b"CTB2" (needs the folder's sellers.jsonl)
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
//!  "sellers":[ids of the columns that hold seller references]   (CTB2 only)
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
//!
//! **Sellers.** The same few thousand sellers appear in every book of a night,
//! so with a [`Sellers`] dictionary a listing's `user` object is stored once
//! per night in `sellers.jsonl` (one compact JSON record per line, append
//! only, line number = reference) and the book keeps only the reference, in a
//! column listed under `"sellers"`. Every distinct record is kept (a seller's
//! flags can change during the night), so this stays lossless. A `user` that
//! is not an object stays an ordinary leaf.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde_json::{Map, Value};

pub const MAGIC: &[u8; 4] = b"CTB1";
pub const MAGIC_SELLERS: &[u8; 4] = b"CTB2";
pub const HEADER_LEN: usize = 24;
/// The seller dictionary next to the books of one night.
pub const SELLERS_FILE: &str = "sellers.jsonl";
/// Listing key whose object values go to the seller dictionary.
const SELLER_KEY: &str = "user";
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
    /// `CTB2`: decoding needs the folder's `sellers.jsonl`.
    pub needs_sellers: bool,
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

// ----------------------------------------------------------------- sellers

/// Append-only seller dictionary: one compact JSON record per line, the line
/// number is the reference. With a file, new records are appended and synced
/// before [`Sellers::intern_all`] returns, so a book is only written after the
/// records it references are on disk.
pub struct Sellers {
    records: Vec<Vec<u8>>,
    index: HashMap<Vec<u8>, u32>,
    file: Option<File>,
    path: Option<PathBuf>,
}

impl Sellers {
    /// A dictionary that lives only in memory (tests, `ctbook stats`).
    pub fn in_memory() -> Self {
        Self {
            records: Vec::new(),
            index: HashMap::new(),
            file: None,
            path: None,
        }
    }

    /// Open (or create) `path`. A last line without its newline (a crash
    /// mid-append) is cut off: no stored book can reference it.
    pub fn open(path: &Path) -> Result<Self, Error> {
        let io = |error: std::io::Error| Error::new(format!("{}: {error}", path.display()));
        let mut file = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .open(path)
            .map_err(io)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(io)?;
        let complete = bytes.iter().rposition(|&byte| byte == b'\n').map_or(0, |at| at + 1);
        if complete < bytes.len() {
            file.set_len(complete as u64).map_err(io)?;
        }
        let mut sellers = Self::in_memory();
        for line in bytes[..complete].split(|&byte| byte == b'\n') {
            if line.is_empty() {
                continue;
            }
            let id = sellers.records.len() as u32;
            sellers.index.insert(line.to_vec(), id);
            sellers.records.push(line.to_vec());
        }
        sellers.file = Some(file);
        sellers.path = Some(path.to_path_buf());
        Ok(sellers)
    }

    /// Load `path` read-only (decoding): nothing is created or changed, and a
    /// torn last line is ignored.
    pub fn load(path: &Path) -> Result<Self, Error> {
        let bytes = std::fs::read(path).map_err(|error| Error::new(format!("{}: {error}", path.display())))?;
        let complete = bytes.iter().rposition(|&byte| byte == b'\n').map_or(0, |at| at + 1);
        let mut sellers = Self::in_memory();
        for line in bytes[..complete].split(|&byte| byte == b'\n').filter(|line| !line.is_empty()) {
            let id = sellers.records.len() as u32;
            sellers.index.insert(line.to_vec(), id);
            sellers.records.push(line.to_vec());
        }
        sellers.path = Some(path.to_path_buf());
        Ok(sellers)
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// The serialised record behind a reference.
    pub fn get(&self, reference: u64) -> Option<&[u8]> {
        self.records.get(reference as usize).map(Vec::as_slice)
    }

    /// References for serialised records, appending (and syncing) new ones.
    pub fn intern_all(&mut self, records: &[Vec<u8>]) -> Result<Vec<u32>, Error> {
        let mut references = Vec::with_capacity(records.len());
        let mut appended = Vec::new();
        for record in records {
            let reference = match self.index.get(record) {
                Some(&reference) => reference,
                None => {
                    let reference = self.records.len() as u32;
                    self.index.insert(record.clone(), reference);
                    self.records.push(record.clone());
                    appended.extend_from_slice(record);
                    appended.push(b'\n');
                    reference
                }
            };
            references.push(reference);
        }
        if let (Some(file), false) = (self.file.as_mut(), appended.is_empty()) {
            file.write_all(&appended)
                .and_then(|()| file.sync_data())
                .map_err(|error| Error::new(format!("sellers: {error}")))?;
        }
        Ok(references)
    }
}

// ----------------------------------------------------------------- files

/// Encode a book to a complete self-contained `.ctb` file (`CTB1`).
pub fn write(book: &Value, quality: u32) -> Result<Vec<u8>, Error> {
    write_with(book, quality, None)
}

/// Encode a book, moving `user` objects to the seller dictionary (`CTB2`
/// when the book has any).
pub fn write_with_sellers(book: &Value, quality: u32, sellers: &RwLock<Sellers>) -> Result<Vec<u8>, Error> {
    write_with(book, quality, Some(sellers))
}

fn write_with(book: &Value, quality: u32, sellers: Option<&RwLock<Sellers>>) -> Result<Vec<u8>, Error> {
    let (doc, uses_sellers) = encode_doc_with(book, sellers)?;
    let payload = brotli_compress(&doc, quality)?;
    let counts = counts(book);
    let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
    out.extend_from_slice(if uses_sellers { MAGIC_SELLERS } else { MAGIC });
    out.extend_from_slice(&(counts.blueprints as u32).to_le_bytes());
    out.extend_from_slice(&counts.listings.to_le_bytes());
    out.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

/// Decode a self-contained `.ctb` file.
pub fn read(bytes: &[u8]) -> Result<Value, Error> {
    read_with(bytes, None)
}

/// Decode a `.ctb` file, `CTB2` ones through the night's seller dictionary.
pub fn read_with_sellers(bytes: &[u8], sellers: &Sellers) -> Result<Value, Error> {
    read_with(bytes, Some(sellers))
}

fn read_with(bytes: &[u8], sellers: Option<&Sellers>) -> Result<Value, Error> {
    let header = read_header(bytes)?;
    if header.needs_sellers && sellers.is_none() {
        return Err(Error::new(format!("this book needs its {SELLERS_FILE}")));
    }
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
    decode_doc_with(&doc, sellers)
}

/// The fixed header of a `.ctb` file (needs at least `HEADER_LEN` bytes).
pub fn read_header(bytes: &[u8]) -> Result<Header, Error> {
    if bytes.len() < HEADER_LEN {
        return Err(Error::new("not a ctb file"));
    }
    let needs_sellers = match &bytes[..4] {
        magic if magic == MAGIC => false,
        magic if magic == MAGIC_SELLERS => true,
        _ => return Err(Error::new("not a ctb file")),
    };
    let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    let u64_at = |at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
    Ok(Header {
        counts: Counts {
            blueprints: u32_at(4) as u64,
            listings: u64_at(8),
        },
        payload_len: u64_at(16),
        needs_sellers,
    })
}

/// Header of a stored file, checking that the file is as long as the header
/// says (a crash can leave a renamed but truncated file behind).
pub fn check_file(path: &Path) -> Result<Header, Error> {
    let mut file = File::open(path).map_err(|error| Error::new(error.to_string()))?;
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
    /// Seller references: the column, and per listing the book-local record.
    sellers_enabled: bool,
    seller_column: Option<usize>,
    seller_locals: Vec<u32>,
    seller_records: Vec<Vec<u8>>,
    seller_seen: HashMap<Vec<u8>, u32>,
    record_scratch: Vec<u8>,
}

impl<'a> Encoder<'a> {
    fn new(sellers_enabled: bool) -> Self {
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
            sellers_enabled,
            seller_column: None,
            seller_locals: Vec::new(),
            seller_records: Vec::new(),
            seller_seen: HashMap::new(),
            record_scratch: Vec::with_capacity(256),
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

    /// A `user` object: stored once in the seller dictionary, referenced here.
    fn seller(&mut self, record: &Value) -> usize {
        let column = *self.seller_column.get_or_insert_with(|| {
            self.columns.push(Vec::new());
            self.columns.len() - 1
        });
        self.record_scratch.clear();
        serde_json::to_writer(&mut self.record_scratch, record).expect("vec write");
        let local = match self.seller_seen.get(self.record_scratch.as_slice()) {
            Some(&local) => local,
            None => {
                let local = self.seller_records.len() as u32;
                self.seller_records.push(self.record_scratch.clone());
                self.seller_seen.insert(self.record_scratch.clone(), local);
                local
            }
        };
        self.seller_locals.push(local);
        column
    }

    /// Append this value's shape to `scratch` and its leaves to their columns.
    fn walk(&mut self, node: usize, value: &'a Value, root: bool) {
        match value {
            Value::Object(map) => {
                self.scratch.push(b'{');
                for (index, (key, child_value)) in map.iter().enumerate() {
                    if index > 0 {
                        self.scratch.push(b',');
                    }
                    serde_json::to_writer(&mut self.scratch, key).expect("vec write");
                    self.scratch.push(b':');
                    if root && self.sellers_enabled && key == SELLER_KEY && child_value.is_object() {
                        let column = self.seller(child_value);
                        push_uint(&mut self.scratch, column as u64);
                        continue;
                    }
                    let child = self.child(node, key);
                    self.walk(child, child_value, false);
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
        self.walk(0, listing, true);
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

/// Encode a book to the (uncompressed) `doc` JSON, without a seller dictionary.
pub fn encode_doc(book: &Value) -> Result<Vec<u8>, Error> {
    encode_doc_with(book, None).map(|(doc, _)| doc)
}

/// Encode a book to the `doc` JSON; also says whether it references sellers.
pub fn encode_doc_with(book: &Value, sellers: Option<&RwLock<Sellers>>) -> Result<(Vec<u8>, bool), Error> {
    let map = book
        .as_object()
        .ok_or_else(|| Error::new("a listing book must be a JSON object"))?;
    let mut encoder = Encoder::new(sellers.is_some());
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

    // Book-local seller records → dictionary references (one lock per book).
    let seller_values: Vec<Value> = match (sellers, encoder.seller_column) {
        (Some(sellers), Some(_)) => {
            let references = sellers
                .write()
                .map_err(|_| Error::new("seller dictionary lock poisoned"))?
                .intern_all(&encoder.seller_records)?;
            encoder
                .seller_locals
                .iter()
                .map(|&local| Value::from(references[local as usize]))
                .collect()
        }
        _ => Vec::new(),
    };

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
    if let Some(column) = encoder.seller_column {
        doc.extend_from_slice(b",\"sellers\":[");
        push_uint(&mut doc, column as u64);
        doc.push(b']');
    }
    doc.extend_from_slice(b",\"cols\":[");
    for (index, column) in encoder.columns.iter().enumerate() {
        if index > 0 {
            doc.push(b',');
        }
        if Some(index) == encoder.seller_column {
            write_column(&mut doc, &seller_values.iter().collect::<Vec<_>>());
        } else {
            write_column(&mut doc, column);
        }
    }
    doc.extend_from_slice(b"]}");
    Ok((doc, encoder.seller_column.is_some()))
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

struct Decoder<'s> {
    columns: Vec<Column>,
    seller_columns: HashSet<usize>,
    sellers: Option<&'s Sellers>,
    /// Parsed seller records, by reference.
    seller_cache: HashMap<u64, Value>,
}

impl Decoder<'_> {
    fn build(&mut self, shape: &Value) -> Result<Value, Error> {
        match shape {
            Value::Number(number) => {
                let column = number
                    .as_u64()
                    .ok_or_else(|| Error::new("bad column id"))? as usize;
                let value = self
                    .columns
                    .get_mut(column)
                    .ok_or_else(|| Error::new("column id out of range"))?
                    .next()?;
                if !self.seller_columns.contains(&column) {
                    return Ok(value);
                }
                let reference = value
                    .as_u64()
                    .ok_or_else(|| Error::new("bad seller reference"))?;
                if let Some(record) = self.seller_cache.get(&reference) {
                    return Ok(record.clone());
                }
                let bytes = self
                    .sellers
                    .ok_or_else(|| Error::new(format!("this book needs its {SELLERS_FILE}")))?
                    .get(reference)
                    .ok_or_else(|| Error::new(format!("seller {reference} missing from {SELLERS_FILE}")))?;
                let record: Value =
                    serde_json::from_slice(bytes).map_err(|error| Error::new(format!("seller {reference}: {error}")))?;
                self.seller_cache.insert(reference, record.clone());
                Ok(record)
            }
            Value::Object(map) => {
                let mut out = Map::with_capacity(map.len());
                for (key, child) in map {
                    out.insert(key.clone(), self.build(child)?);
                }
                Ok(Value::Object(out))
            }
            _ => Err(Error::new("bad shape")),
        }
    }
}

/// Decode a `doc` JSON document back to the book (no seller dictionary).
pub fn decode_doc(doc: &[u8]) -> Result<Value, Error> {
    decode_doc_with(doc, None)
}

/// Decode a `doc` JSON document back to the book.
pub fn decode_doc_with(doc: &[u8], sellers: Option<&Sellers>) -> Result<Value, Error> {
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
    let seller_columns = match root.remove("sellers") {
        Some(Value::Array(ids)) => ids
            .iter()
            .map(|id| id.as_u64().map(|id| id as usize).ok_or_else(|| Error::new("bad seller column")))
            .collect::<Result<HashSet<_>, _>>()?,
        Some(_) => return Err(Error::new("bad doc.sellers")),
        None => HashSet::new(),
    };
    let columns = take_array(&mut root, "cols")?
        .into_iter()
        .map(Column::parse)
        .collect::<Result<Vec<_>, _>>()?;
    if keys.len() != runs.len() {
        return Err(Error::new("keys and runs differ in length"));
    }
    let mut decoder = Decoder {
        columns,
        seller_columns,
        sellers,
        seller_cache: HashMap::new(),
    };
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
                listings.push(decoder.build(shape)?);
            }
            Value::Array(listings)
        };
        book.insert(key, value);
    }
    Ok(Value::Object(book))
}

/// Read a `.json` or `.json.gz` book (CLI and tests).
pub fn read_json_book(path: &Path) -> Result<Value, Error> {
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
pub fn write_atomic(dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut part = dest.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
    {
        let mut file = File::create(&part)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&part, dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bytes(value: &Value) -> Vec<u8> {
        serde_json::to_vec(value).unwrap()
    }

    fn round_trip(book: Value) {
        let file = write(&book, 9).expect("encode");
        let back = read(&file).expect("decode");
        assert_eq!(bytes(&back), bytes(&book), "round trip changed the book");
        let header = read_header(&file).unwrap();
        assert_eq!(header.counts, counts(&book));
        assert_eq!(header.payload_len as usize, file.len() - HEADER_LEN);
        assert!(!header.needs_sellers);
        round_trip_with_sellers(&book);
    }

    fn round_trip_with_sellers(book: &Value) {
        let sellers = RwLock::new(Sellers::in_memory());
        let file = write_with_sellers(book, 9, &sellers).expect("encode with sellers");
        let sellers = sellers.into_inner().unwrap();
        let back = read_with_sellers(&file, &sellers).expect("decode with sellers");
        assert_eq!(bytes(&back), bytes(book), "seller round trip changed the book");
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
    fn sellers_are_shared_across_books_and_need_their_dictionary() {
        let seller = json!({"id": 7, "username": "shop", "flags": [true]});
        let other = json!({"id": 8, "username": "shop2", "flags": [false]});
        let book_a = json!({"1": [{"id": 1, "user": seller}, {"id": 2, "user": other}, {"id": 3, "user": seller}]});
        let book_b = json!({"2": [{"id": 4, "user": other}, {"id": 5, "user": null}]});
        let sellers = RwLock::new(Sellers::in_memory());
        let file_a = write_with_sellers(&book_a, 9, &sellers).unwrap();
        let file_b = write_with_sellers(&book_b, 9, &sellers).unwrap();
        let sellers = sellers.into_inner().unwrap();
        assert_eq!(sellers.len(), 2, "each distinct seller record once");
        assert!(read_header(&file_a).unwrap().needs_sellers);
        assert!(read(&file_a).is_err(), "a CTB2 book must not decode without its sellers");
        assert_eq!(bytes(&read_with_sellers(&file_a, &sellers).unwrap()), bytes(&book_a));
        assert_eq!(bytes(&read_with_sellers(&file_b, &sellers).unwrap()), bytes(&book_b));
        // A book without object sellers stays self-contained.
        let plain = json!({"3": [{"id": 6, "user": 7}]});
        let file = write_with_sellers(&plain, 9, &RwLock::new(Sellers::in_memory())).unwrap();
        assert!(!read_header(&file).unwrap().needs_sellers);
        assert_eq!(bytes(&read(&file).unwrap()), bytes(&plain));
    }

    #[test]
    fn the_seller_file_survives_a_reopen_and_drops_a_torn_last_line() {
        let dir = std::env::temp_dir().join(format!("ctbook-sellers-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SELLERS_FILE);
        let _ = std::fs::remove_file(&path);
        let book = json!({"1": [{"id": 1, "user": {"id": 7}}, {"id": 2, "user": {"id": 8}}]});
        let sellers = RwLock::new(Sellers::open(&path).unwrap());
        let file = write_with_sellers(&book, 9, &sellers).unwrap();
        drop(sellers);
        // A crash mid-append leaves half a record.
        OpenOptions::new().append(true).open(&path).unwrap().write_all(b"{\"id\":9").unwrap();
        let reopened = Sellers::open(&path).unwrap();
        assert_eq!(reopened.len(), 2);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"id\":7}\n{\"id\":8}\n");
        assert_eq!(bytes(&read_with_sellers(&file, &reopened).unwrap()), bytes(&book));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn real_samples_round_trip() {
        let Ok(paths) = std::env::var("CTBOOK_SAMPLES") else { return };
        for path in paths.split(':').filter(|path| !path.is_empty()) {
            let book = read_json_book(Path::new(path)).unwrap();
            round_trip(book);
        }
    }
}
