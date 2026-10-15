//! `ctbook stats [--quality Q] <book.json[.gz]>...` — sizes, timings and a round-trip check per book.
//! `ctbook encode [--quality Q] <in.json[.gz]> <out.ctb>` and `ctbook decode <in.ctb>` (compact JSON to stdout).

use std::io::Write;
use std::path::Path;
use std::process::ExitCode;
use std::time::Instant;

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut quality = 9u32;
    if let Some(at) = args.iter().position(|arg| arg == "--quality") {
        quality = args.get(at + 1).and_then(|q| q.parse().ok()).unwrap_or(9);
        args.drain(at..(at + 2).min(args.len()));
    }
    let result = match args.first().map(String::as_str) {
        Some("stats") if args.len() > 1 => stats(&args[1..], quality),
        Some("encode") if args.len() == 3 => encode(&args[1], &args[2], quality),
        Some("decode") if args.len() == 2 => decode(&args[1]),
        _ => Err("usage: ctbook stats|encode|decode [--quality Q] ...".to_string()),
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

fn decode(input: &str) -> Result<(), String> {
    let bytes = std::fs::read(input).map_err(|e| e.to_string())?;
    let book = ctbook::read(&bytes).map_err(|e| e.to_string())?;
    let mut out = std::io::stdout().lock();
    serde_json::to_writer(&mut out, &book).map_err(|e| e.to_string())?;
    out.write_all(b"\n").map_err(|e| e.to_string())
}

fn stats(paths: &[String], quality: u32) -> Result<(), String> {
    println!("name\tgz_bytes\tjson_bytes\tdoc_bytes\tctb_bytes\tparse_s\tencode_s\tbrotli_s\tdecode_s\tround_trip");
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
        let file = ctbook::write(&book, quality).map_err(|e| e.to_string())?;
        let brotli = (started.elapsed().as_secs_f64() - encode).max(0.0);
        let started = Instant::now();
        let back = ctbook::read(&file).map_err(|e| e.to_string())?;
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
    if failed {
        return Err("round trip mismatch".into());
    }
    Ok(())
}
