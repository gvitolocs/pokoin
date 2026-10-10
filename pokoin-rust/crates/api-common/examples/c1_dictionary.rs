//! Print the `GET /api/dictionary` document, for regenerating the snapshot the
//! browser decoder bundles:
//!
//! ```text
//! cd pokoin-rust
//! cargo run --quiet --example c1_dictionary > ../market/src/compact-dictionary.json
//! ```
//!
//! `compact::dict::tests::the_committed_snapshot_matches_the_tables` fails when
//! that file drifts from the Rust tables, and `market/src/compact.test.js`
//! fails when `C1_DICTIONARY` in `compact.js` drifts from the file — so the
//! three stay in step.

fn main() {
    let document = pokoin_api_common::compact::dict::document();
    match serde_json::to_string_pretty(&document) {
        Ok(text) => println!("{text}"),
        Err(error) => {
            eprintln!("cannot serialise the dictionary: {error}");
            std::process::exit(1);
        }
    }
}
