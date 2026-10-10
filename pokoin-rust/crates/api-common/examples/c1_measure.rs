//! Encode captured API responses as `c1` and report raw sizes and encode time.
//!
//! ```text
//! cargo run --release --example c1_measure -- <out-dir> <fixture.json>...
//! ```
//!
//! For every fixture it writes `<out-dir>/<name>.default.json` (the default
//! body, re-serialised by `serde_json` so the comparison is like for like) and
//! `<out-dir>/<name>.c1.json`, and prints one TSV row per fixture:
//!
//! ```text
//! name<TAB>default_bytes<TAB>c1_bytes<TAB>serialize_us<TAB>encode_us<TAB>decode_us<TAB>rows
//! ```
//!
//! `serialize_us` is what the handler already spends turning its `Value` into
//! the default body, so `encode_us - serialize_us` is what `c1` actually adds.
//!
//! Brotli and zstd sizes come from `docs/handoff/compact-c1/measure-sizes.py`,
//! which runs this and compresses both files.

use std::path::Path;
use std::time::Instant;

use pokoin_api_common::compact::{decode, encode};
use serde_json::Value;

/// Encode and decode this many times per fixture and keep the best, so one
/// unlucky scheduler slice does not dominate a small payload's number.
const PASSES: u32 = 7;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(out_dir) = args.next() else {
        eprintln!("usage: c1_measure <out-dir> <fixture.json>...");
        std::process::exit(2);
    };
    if let Err(error) = std::fs::create_dir_all(&out_dir) {
        eprintln!("cannot create {out_dir}: {error}");
        std::process::exit(1);
    }

    println!("name\tdefault_bytes\tc1_bytes\tserialize_us\tencode_us\tdecode_us\trows");
    let mut failures = 0;
    for path in args {
        match measure(&out_dir, Path::new(&path)) {
            Ok(line) => println!("{line}"),
            Err(error) => {
                eprintln!("{path}: {error}");
                failures += 1;
            }
        }
    }
    if failures > 0 {
        std::process::exit(1);
    }
}

fn measure(out_dir: &str, path: &Path) -> Result<String, String> {
    let name = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or("fixture has no name")?;
    let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let body: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;

    let mut serialize_us = u128::MAX;
    let mut default = Vec::new();
    for _ in 0..PASSES {
        let started = Instant::now();
        default = serde_json::to_vec(&body).map_err(|error| error.to_string())?;
        serialize_us = serialize_us.min(started.elapsed().as_micros());
    }

    let mut encode_us = u128::MAX;
    let mut compact = Vec::new();
    for _ in 0..PASSES {
        let started = Instant::now();
        compact = encode::encode_to_vec(&body);
        encode_us = encode_us.min(started.elapsed().as_micros());
    }

    let document: Value = serde_json::from_slice(&compact).map_err(|error| error.to_string())?;
    let mut decode_us = u128::MAX;
    for _ in 0..PASSES {
        let started = Instant::now();
        let decoded = decode::decode(&document).map_err(|error| error.to_string())?;
        decode_us = decode_us.min(started.elapsed().as_micros());
        // The whole point of the exercise: the decode is the default body.
        let round_tripped = serde_json::to_vec(&decoded).map_err(|error| error.to_string())?;
        if round_tripped != default {
            return Err("c1 round trip did not reproduce the default body".into());
        }
    }

    std::fs::write(format!("{out_dir}/{name}.default.json"), &default)
        .map_err(|error| error.to_string())?;
    std::fs::write(format!("{out_dir}/{name}.c1.json"), &compact)
        .map_err(|error| error.to_string())?;

    let rows = document["t"]
        .as_array()
        .map(|tables| {
            tables
                .iter()
                .filter_map(|table| table["n"].as_u64())
                .sum::<u64>()
        })
        .unwrap_or(0);

    Ok(format!(
        "{name}\t{}\t{}\t{serialize_us}\t{encode_us}\t{decode_us}\t{rows}",
        default.len(),
        compact.len()
    ))
}
