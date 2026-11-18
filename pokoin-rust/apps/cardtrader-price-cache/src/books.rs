//! One listing book at a time. A book that does not decode is counted and
//! left out of scope; expansions named in the dump status errors are too.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::Path;

use ctbook::Sellers;
use serde_json::Value;

use crate::eligibility::eligible_cardtrader;
use crate::money::Rat;
use crate::rank::Tally;

pub struct Ingest {
    pub books_read: u64,
    pub books_failed: u64,
    pub expansions: BTreeSet<i64>,
    pub dir_error: Option<String>,
    tallies: HashMap<i64, Tally>,
}

impl Ingest {
    pub fn tallies(&self) -> &HashMap<i64, Tally> {
        &self.tallies
    }

    pub fn tallies_mut(&mut self) -> &mut HashMap<i64, Tally> {
        &mut self.tallies
    }

    pub fn winners(&self) -> Vec<crate::rank::Winner> {
        let mut winners: Vec<_> = self.tallies.values().map(Tally::winner).collect();
        winners.sort_by_key(|winner| winner.blueprint_id);
        winners
    }
}

struct BookFile {
    expansion_id: i64,
    path: std::path::PathBuf,
}

pub fn ingest_books(
    dir: &Path,
    game_id: i64,
    skip: &HashSet<i64>,
    rate: Rat,
    progress: bool,
) -> Ingest {
    let mut ingest = Ingest {
        books_read: 0,
        books_failed: 0,
        expansions: BTreeSet::new(),
        dir_error: None,
        tallies: HashMap::new(),
    };
    let books = match list_books(dir, game_id) {
        Ok(books) => books,
        Err(error) => {
            ingest.dir_error = Some(error);
            return ingest;
        }
    };
    let sellers = Sellers::load(&dir.join(ctbook::SELLERS_FILE)).ok();
    let total = books.len();
    for (index, book) in books.into_iter().enumerate() {
        if skip.contains(&book.expansion_id) {
            continue;
        }
        match read_listing_book(&book.path, sellers.as_ref()) {
            Ok(value) => {
                absorb(&value, rate, &mut ingest.tallies);
                ingest.books_read += 1;
                ingest.expansions.insert(book.expansion_id);
            }
            Err(error) => {
                ingest.books_failed += 1;
                if progress {
                    eprintln!(
                        "pokoin-cardtrader-price-cache: skipped {}: {error}",
                        book.path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("book")
                    );
                }
            }
        }
        if progress && total > 50 && (index + 1) % 100 == 0 {
            eprintln!(
                "pokoin-cardtrader-price-cache: game {game_id} books {}/{total}",
                index + 1
            );
        }
    }
    ingest
}

pub fn read_listing_book(path: &Path, sellers: Option<&Sellers>) -> Result<Value, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if name.ends_with(".json.gz") || name.ends_with(".json") {
        return ctbook::read_json_book(path).map_err(|error| error.to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let header = ctbook::read_header(&bytes).map_err(|error| error.to_string())?;
    if header.needs_sellers {
        let sellers =
            sellers.ok_or_else(|| format!("{} needs {}", path.display(), ctbook::SELLERS_FILE))?;
        ctbook::read_with_sellers(&bytes, sellers).map_err(|error| error.to_string())
    } else {
        ctbook::read(&bytes).map_err(|error| error.to_string())
    }
}

fn absorb(book: &Value, rate: Rat, tallies: &mut HashMap<i64, Tally>) {
    let Some(map) = book.as_object() else { return };
    for (key, products) in map {
        let Some(products) = products.as_array() else {
            continue;
        };
        for product in products {
            let Some(offer) = eligible_cardtrader(product, key, rate) else {
                continue;
            };
            match tallies.entry(offer.blueprint_id) {
                std::collections::hash_map::Entry::Vacant(slot) => {
                    slot.insert(Tally::from_first(offer));
                }
                std::collections::hash_map::Entry::Occupied(mut slot) => slot.get_mut().push(offer),
            }
        }
    }
}

fn list_books(dir: &Path, game_id: i64) -> Result<Vec<BookFile>, String> {
    let mut ctb = std::collections::BTreeMap::<i64, std::path::PathBuf>::new();
    let mut gzip = std::collections::BTreeMap::<i64, std::path::PathBuf>::new();
    let entries = fs::read_dir(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("{}: {error}", dir.display()))?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if let Some((game, expansion)) = split_book_name(name, ".ctb") {
            if game == game_id {
                ctb.insert(expansion, path);
            }
        } else if let Some((game, expansion)) = split_book_name(name, ".json.gz") {
            if game == game_id {
                gzip.insert(expansion, path);
            }
        }
    }
    let mut ids: BTreeSet<i64> = ctb.keys().copied().collect();
    ids.extend(gzip.keys().copied());
    let mut books = Vec::with_capacity(ids.len());
    for expansion in ids {
        // A `.ctb` book replaces a leftover `.json.gz` for the same expansion.
        let Some(path) = ctb.remove(&expansion).or_else(|| gzip.remove(&expansion)) else {
            continue;
        };
        books.push(BookFile {
            expansion_id: expansion,
            path,
        });
    }
    Ok(books)
}

fn split_book_name(name: &str, suffix: &str) -> Option<(i64, i64)> {
    let stem = name.strip_suffix(suffix)?;
    let (game, expansion) = stem.split_once('-')?;
    if expansion.contains('-') {
        return None;
    }
    Some((game.parse().ok()?, expansion.parse().ok()?))
}
