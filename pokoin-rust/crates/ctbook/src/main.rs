//! `ctbook stats [--quality Q] <book.json[.gz]>...` — sizes, timings and a round-trip check per book
//!   (books share one in-memory seller dictionary, as in a nightly folder).
//! `ctbook encode [--quality Q] <in.json[.gz]> <out.ctb>` — self-contained `CTB1`.
//! `ctbook decode <in.ctb>` — compact JSON to stdout (`CTB2` reads `sellers.jsonl` next to it).
//! `ctbook convert [--quality Q] [--jobs N] [--delete] <book.json.gz>...` — write `<book>.ctb` next to
//!   each book with the folder's `sellers.jsonl`, read it back from disk and compare it byte for byte
//!   with the original; with `--delete` the `.json.gz` is removed only after that check passed. A
//!   mismatch removes the `.ctb` and keeps the original. Exit 1 if any book was not converted.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::Instant;

use ctbook::{Sellers, SELLERS_FILE};

fn take_option(args: &mut Vec<String>, name: &str) -> Option<String> {
    let at = args.iter().position(|arg| arg == name)?;
    let value = args.get(at + 1).cloned();
    args.drain(at..(at + 2).min(args.len()));
    value
}

fn take_flag(args: &mut Vec<String>, name: &str) -> bool {
    match args.iter().position(|arg| arg == name) {
        Some(at) => {
            args.remove(at);
            true
        }
        None => false,
    }
}

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let quality = take_option(&mut args, "--quality").and_then(|q| q.parse().ok()).unwrap_or(9u32);
    let jobs = take_option(&mut args, "--jobs").and_then(|n| n.parse().ok()).unwrap_or(4usize).max(1);
    let delete = take_flag(&mut args, "--delete");
    let result = match args.first().map(String::as_str) {
        Some("stats") if args.len() > 1 => stats(&args[1..], quality),
        Some("encode") if args.len() == 3 => encode(&args[1], &args[2], quality),
        Some("decode") if args.len() == 2 => decode(&args[1]),
        Some("convert") if args.len() > 1 => convert(&args[1..], quality, jobs, delete),
        _ => Err("usage: ctbook stats|encode|decode|convert [--quality Q] [--jobs N] [--delete] ...".to_string()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("ctbook: {error}");
            ExitCode::FAILURE
        }
    }
}

fn encode(input: &str, output: &str, quality: u32) -> Result<(), String> {
    let book = ctbook::read_json_book(Path::new(input)).map_err(|e| e.to_string())?;
    let file = ctbook::write(&book, quality).map_err(|e| e.to_string())?;
    ctbook::write_atomic(Path::new(output), &file).map_err(|e| e.to_string())
}

fn sellers_next_to(book: &Path) -> PathBuf {
    book.parent().unwrap_or_else(|| Path::new(".")).join(SELLERS_FILE)
}

fn decode(input: &str) -> Result<(), String> {
    let bytes = std::fs::read(input).map_err(|e| e.to_string())?;
    let header = ctbook::read_header(&bytes).map_err(|e| e.to_string())?;
    let book = if header.needs_sellers {
        let sellers = Sellers::load(&sellers_next_to(Path::new(input))).map_err(|e| e.to_string())?;
        ctbook::read_with_sellers(&bytes, &sellers)
    } else {
        ctbook::read(&bytes)
    }
    .map_err(|e| e.to_string())?;
    let mut out = std::io::stdout().lock();
    serde_json::to_writer(&mut out, &book).map_err(|e| e.to_string())?;
    out.write_all(b"\n").map_err(|e| e.to_string())
}

fn stats(paths: &[String], quality: u32) -> Result<(), String> {
    println!("name\tgz_bytes\tjson_bytes\tdoc_bytes\tctb_bytes\tparse_s\tencode_s\tbrotli_s\tdecode_s\tround_trip");
    let sellers = RwLock::new(Sellers::in_memory());
    let mut total = [0f64; 8];
    let mut failed = false;
    for path in paths {
        let gz = std::fs::metadata(path).map_err(|e| e.to_string())?.len() as f64;
        let started = Instant::now();
        let book = ctbook::read_json_book(Path::new(path)).map_err(|e| e.to_string())?;
        let parse = started.elapsed().as_secs_f64();
        let json = serde_json::to_vec(&book).map_err(|e| e.to_string())?;
        let started = Instant::now();
        let doc = ctbook::encode_doc(&book).map_err(|e| e.to_string())?;
        let encode = started.elapsed().as_secs_f64();
        let started = Instant::now();
        let file = ctbook::write_with_sellers(&book, quality, &sellers).map_err(|e| e.to_string())?;
        let brotli = (started.elapsed().as_secs_f64() - encode).max(0.0);
        let started = Instant::now();
        let back = ctbook::read_with_sellers(&file, &sellers.read().unwrap()).map_err(|e| e.to_string())?;
        let decode = started.elapsed().as_secs_f64();
        let ok = serde_json::to_vec(&back).map_err(|e| e.to_string())? == json;
        failed |= !ok;
        let name = Path::new(path).file_name().unwrap_or_default().to_string_lossy();
        println!(
            "{name}\t{gz:.0}\t{}\t{}\t{}\t{parse:.3}\t{encode:.3}\t{brotli:.3}\t{decode:.3}\t{}",
            json.len(),
            doc.len(),
            file.len(),
            if ok { "ok" } else { "MISMATCH" }
        );
        for (slot, value) in total.iter_mut().zip([
            gz,
            json.len() as f64,
            doc.len() as f64,
            file.len() as f64,
            parse,
            encode,
            brotli,
            decode,
        ]) {
            *slot += value;
        }
    }
    let sellers = sellers.into_inner().unwrap();
    let records: usize = (0..sellers.len() as u64).filter_map(|i| sellers.get(i)).map(|r| r.len() + 1).sum();
    let compressed = ctbook::brotli_compress(
        &(0..sellers.len() as u64)
            .filter_map(|i| sellers.get(i))
            .flat_map(|r| r.iter().copied().chain(*b"\n"))
            .collect::<Vec<u8>>(),
        9,
    )
    .map(|c| c.len())
    .unwrap_or(0);
    println!(
        "TOTAL\t{:.0}\t{:.0}\t{:.0}\t{:.0}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{}",
        total[0],
        total[1],
        total[2],
        total[3],
        total[4],
        total[5],
        total[6],
        total[7],
        if failed { "MISMATCH" } else { "ok" }
    );
    println!("SELLERS\t{} records\t{records} bytes\t{compressed} bytes brotli", sellers.len());
    if failed {
        return Err("round trip mismatch".into());
    }
    Ok(())
}

#[derive(Default)]
struct Tally {
    converted: AtomicU64,
    already: AtomicU64,
    failed: AtomicU64,
    gz_bytes: AtomicU64,
    ctb_bytes: AtomicU64,
}

enum Outcome {
    Converted { gz: u64, ctb: u64 },
    Already { gz: u64, ctb: u64 },
}

/// Convert one `.json.gz` book next to itself, verify from disk, maybe delete the original.
fn convert_one(gz: &Path, sellers: &RwLock<Sellers>, quality: u32, delete: bool) -> Result<Outcome, String> {
    let name = gz.to_string_lossy();
    let stem = name
        .strip_suffix(".json.gz")
        .ok_or_else(|| format!("{name}: not a .json.gz book"))?;
    let ctb = PathBuf::from(format!("{stem}.ctb"));
    let gz_len = std::fs::metadata(gz).map_err(|e| format!("{name}: {e}"))?.len();
    let book = ctbook::read_json_book(gz).map_err(|e| format!("unreadable: {e}"))?;
    let expected = serde_json::to_vec(&book).map_err(|e| e.to_string())?;
    let verify = |path: &Path| -> Result<u64, String> {
        let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let back = ctbook::read_with_sellers(&bytes, &sellers.read().unwrap()).map_err(|e| e.to_string())?;
        if serde_json::to_vec(&back).map_err(|e| e.to_string())? != expected {
            return Err(format!("{}: MISMATCH", path.display()));
        }
        Ok(bytes.len() as u64)
    };
    let (outcome, ctb_len) = if ctb.exists() {
        // A book stored in both formats (a run that switched dumps): keep the .ctb only if it is identical.
        let len = verify(&ctb).map_err(|e| format!("{e} (existing .ctb kept, .json.gz kept)"))?;
        ("already", len)
    } else {
        let file = ctbook::write_with_sellers(&book, quality, sellers).map_err(|e| format!("{name}: {e}"))?;
        drop(book);
        ctbook::write_atomic(&ctb, &file).map_err(|e| format!("{}: {e}", ctb.display()))?;
        match verify(&ctb) {
            Ok(len) => ("converted", len),
            Err(error) => {
                let _ = std::fs::remove_file(&ctb);
                return Err(format!("{error} (.ctb removed, .json.gz kept)"));
            }
        }
    };
    if delete {
        std::fs::remove_file(gz).map_err(|e| format!("{name}: {e}"))?;
    }
    Ok(match outcome {
        "converted" => Outcome::Converted { gz: gz_len, ctb: ctb_len },
        _ => Outcome::Already { gz: gz_len, ctb: ctb_len },
    })
}

fn convert(paths: &[String], quality: u32, jobs: usize, delete: bool) -> Result<(), String> {
    let mut folders: BTreeMap<PathBuf, Vec<PathBuf>> = BTreeMap::new();
    for path in paths {
        let path = PathBuf::from(path);
        let folder = path.parent().unwrap_or_else(|| Path::new(".")).to_path_buf();
        folders.entry(folder).or_default().push(path);
    }
    let mut any_failed = false;
    for (folder, books) in folders {
        let started = Instant::now();
        let sellers_path = folder.join(SELLERS_FILE);
        let sellers = RwLock::new(Sellers::open(&sellers_path).map_err(|e| e.to_string())?);
        let queue = Mutex::new(books.into_iter());
        let tally = Tally::default();
        std::thread::scope(|scope| {
            for _ in 0..jobs {
                scope.spawn(|| loop {
                    let Some(gz) = queue.lock().unwrap().next() else { return };
                    match convert_one(&gz, &sellers, quality, delete) {
                        Ok(Outcome::Converted { gz, ctb }) => {
                            tally.converted.fetch_add(1, Ordering::Relaxed);
                            tally.gz_bytes.fetch_add(gz, Ordering::Relaxed);
                            tally.ctb_bytes.fetch_add(ctb, Ordering::Relaxed);
                        }
                        Ok(Outcome::Already { gz, ctb }) => {
                            tally.already.fetch_add(1, Ordering::Relaxed);
                            tally.gz_bytes.fetch_add(gz, Ordering::Relaxed);
                            tally.ctb_bytes.fetch_add(ctb, Ordering::Relaxed);
                        }
                        Err(error) => {
                            tally.failed.fetch_add(1, Ordering::Relaxed);
                            eprintln!("ctbook convert: {error}");
                        }
                    }
                });
            }
        });
        // The dictionary on disk must hold exactly what the books reference.
        let in_memory = sellers.into_inner().unwrap();
        let on_disk = Sellers::load(&sellers_path).map_err(|e| e.to_string())?;
        let same = on_disk.len() == in_memory.len()
            && (0..in_memory.len() as u64).all(|i| on_disk.get(i) == in_memory.get(i));
        if !same {
            return Err(format!("{}: dictionary on disk differs from memory", sellers_path.display()));
        }
        let failed = tally.failed.load(Ordering::Relaxed);
        any_failed |= failed > 0;
        let sellers_bytes = std::fs::metadata(&sellers_path).map(|m| m.len()).unwrap_or(0);
        println!(
            "{}\tconverted {}\talready {}\tfailed {failed}\tjson.gz {} B\tctb {} B\tsellers {} records {sellers_bytes} B\t{:.0} s",
            folder.display(),
            tally.converted.load(Ordering::Relaxed),
            tally.already.load(Ordering::Relaxed),
            tally.gz_bytes.load(Ordering::Relaxed),
            tally.ctb_bytes.load(Ordering::Relaxed),
            on_disk.len(),
            started.elapsed().as_secs_f64()
        );
    }
    if any_failed {
        return Err("some books were not converted (their .json.gz is kept)".into());
    }
    Ok(())
}
