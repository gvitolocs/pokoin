//! Upgrade Pokemon leftover CDN scans to larger scans of the same printing.
//!
//! `ap-index`  artofpkm catalog.jsonl → printings TSV (set, number, name, original asset).
//! `match`     catalog TSV × (tcgdex en/ja, artofpkm) → pairs.tsv with metrics and a verdict.
//! `render`    before | after | difference panels for review sheets.
//! `encode`    accepted pairs → JPEG q92 at the source size + `_homepage.webp` (480 px, q82).
//!
//! The visual check is the guard against wrong printings: both scans are
//! normalised to 63:88, aligned (small shift/scale search), and compared on
//! the whole card, the artwork window, a tile grid, and the WOTC edition-stamp
//! corner. The candidate must also be larger and not blurrier.

use anyhow::{bail, Context, Result};
use image::{imageops, imageops::FilterType, GrayImage, Rgb, RgbImage, RgbaImage};
use rayon::prelude::*;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

const CARD_ASPECT: f64 = 63.0 / 88.0;
const W: usize = 126;
const H: usize = 176;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let flags = Flags::parse(&args[2.min(args.len())..]);
    match args.get(1).map(String::as_str) {
        Some("ap-index") => ap_index(&flags),
        Some("match") => run_match(&flags),
        Some("decide") => decide(&flags),
        Some("remeasure") => remeasure(&flags),
        Some("render") => render(&flags),
        Some("encode") => encode(&flags),
        _ => bail!("usage: hd-scan-upgrade ap-index|match|decide|render|encode --flag value ..."),
    }
}

struct Flags(HashMap<String, String>);

impl Flags {
    fn parse(args: &[String]) -> Self {
        let mut map = HashMap::new();
        let mut i = 0;
        while i < args.len() {
            if let Some(key) = args[i].strip_prefix("--") {
                // A switch (`--no-tcgdex`) has no value: the next word is another flag.
                match args.get(i + 1).filter(|v| !v.starts_with("--")) {
                    Some(value) => {
                        map.insert(key.to_owned(), value.clone());
                        i += 2;
                    }
                    None => {
                        map.insert(key.to_owned(), String::new());
                        i += 1;
                    }
                }
            } else {
                i += 1;
            }
        }
        Flags(map)
    }
    fn get(&self, key: &str) -> Result<&str> {
        self.0.get(key).map(String::as_str).with_context(|| format!("missing --{key}"))
    }
    fn opt(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(String::as_str)
    }
}

// ---------------------------------------------------------------- normalising

/// tcgdex / pokemontcg.io set ids: `swsh05` == `swsh5`, `sv3pt5` == `sv3.5`.
fn fold_set(s: &str) -> String {
    let s = s.to_lowercase().replace("pt", ".");
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '0' && i > 0 && c[i - 1].is_ascii_alphabetic() {
            let mut j = i;
            while j < c.len() && c[j] == '0' {
                j += 1;
            }
            if j < c.len() && c[j].is_ascii_digit() {
                i = j;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

/// Collector number before `/`, upper case, leading zeros dropped per digit run.
fn fold_num(s: &str) -> String {
    let s = s.rsplit('|').next().unwrap_or("").trim();
    let s = s.split('/').next().unwrap_or("").trim().to_uppercase();
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        let run_start = c[i] == '0' && (i == 0 || !c[i - 1].is_ascii_digit());
        if run_start {
            let mut j = i;
            while j < c.len() && c[j] == '0' {
                j += 1;
            }
            if j < c.len() && c[j].is_ascii_digit() {
                i = j;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

fn compact(s: &str) -> String {
    s.to_lowercase()
        .replace('é', "e")
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn tokens(s: &str) -> HashSet<String> {
    s.to_lowercase()
        .replace('é', "e")
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 2)
        .map(str::to_owned)
        .collect()
}

/// 2 = same name, 1 = shares a word (translation drift: Icy Sky's / Ice Sky Shaymin), 0 = different.
fn name_score(a: &str, b: &str) -> u8 {
    let (ca, cb) = (compact(a), compact(b));
    if ca.is_empty() || cb.is_empty() {
        return 0;
    }
    if ca == cb {
        return 2;
    }
    let (ta, tb) = (tokens(a), tokens(b));
    let shared = ta.intersection(&tb).filter(|t| t.len() >= 4).count();
    if shared > 0 {
        1
    } else {
        0
    }
}

/// `{id}_{slug}.jpg` → slug, as the CDN server's leftoverImageSlug.
fn leftover_slug(name: &str) -> String {
    let file = name.rsplit('/').next().unwrap_or("");
    let file = file.split(['?', '#']).next().unwrap_or("");
    let mut stem = file.to_lowercase();
    for ext in [".jpg", ".jpeg", ".png", ".webp"] {
        if let Some(s) = stem.strip_suffix(ext) {
            stem = s.to_owned();
            break;
        }
    }
    let stem = stem.strip_suffix("_homepage").unwrap_or(&stem).to_owned();
    match stem.split_once('_') {
        Some((id, rest)) if id.chars().all(|c| c.is_ascii_digit()) => rest.to_owned(),
        _ => stem,
    }
}

fn slug_compatible(want: &str, dump_name: &str) -> bool {
    let dump = leftover_slug(dump_name);
    if dump.is_empty() {
        return false;
    }
    want.is_empty() || want == dump || dump.starts_with(&format!("{want}-")) || want.starts_with(&format!("{dump}-"))
}

// ---------------------------------------------------------------- artofpkm

fn ap_index(f: &Flags) -> Result<()> {
    let input = BufReader::with_capacity(1 << 24, File::open(f.get("catalog")?)?);
    let mut printings = BufWriter::new(File::create(f.get("out")?)?);
    let mut sets = BufWriter::new(File::create(f.get("sets")?)?);
    let (mut n, mut kept) = (0u64, 0u64);
    for line in input.lines() {
        let line = line?;
        n += 1;
        let printing = line.contains("\"kind\":\"printing\"");
        let set = line.contains("\"kind\":\"sets\"");
        if !printing && !set {
            continue;
        }
        let r: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = &r["identity"];
        let kind = id["kind"].as_str().unwrap_or("");
        if kind == "sets" {
            let path = id["path"].as_str().unwrap_or("");
            let Some(set_id) = path.strip_prefix("/sets/").filter(|s| s.chars().all(|c| c.is_ascii_digit())) else {
                continue;
            };
            let ja = r["localized_text"].as_array().and_then(|a| a.first()).and_then(|x| x["text"].as_str()).unwrap_or("");
            writeln!(sets, "{set_id}\t{}\t{}", clean(id["name"].as_str().unwrap_or("")), clean(ja))?;
            continue;
        }
        if kind != "printing" {
            continue;
        }
        let assets: HashMap<&str, &Value> = r["assets"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| Some((x["url"].as_str()?, x))).collect())
            .unwrap_or_default();
        let original = r["image_references"].as_array().and_then(|refs| {
            refs.iter().find(|x| x["role"] == "original" && x["attribute"] == "data-lightbox-src")
        });
        let Some(original) = original else { continue };
        let url = original["url"].as_str().unwrap_or("");
        let Some(asset) = assets.get(url) else { continue };
        let label = original["attributes"]["aria-label"].as_str().unwrap_or("");
        let set_label = label.split_once(", ").map(|(_, s)| s).unwrap_or("");
        writeln!(
            printings,
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            id["set_id"].as_str().unwrap_or(""),
            clean(set_label),
            clean(id["collector_number"].as_str().unwrap_or("")),
            clean(id["name"].as_str().unwrap_or("")),
            asset["width"].as_u64().unwrap_or(0),
            asset["height"].as_u64().unwrap_or(0),
            asset["path"].as_str().unwrap_or(""),
            r["url"].as_str().unwrap_or(""),
        )?;
        kept += 1;
    }
    eprintln!("lines={n} printings={kept}");
    Ok(())
}

fn clean(s: &str) -> String {
    s.replace(['\t', '\n', '\r'], " ").trim().to_owned()
}

// ---------------------------------------------------------------- inputs

#[derive(Clone)]
struct Row {
    ct_id: u64,
    card_id: u64,
    name: String,
    card_number: String,
    expansion: String,
    expansion_id: u64,
    nationality: String,
    official_id: String,
    official_source: String,
    kind: String,
    art_layout: String,
    image_url: String,
}

fn read_catalog(path: &str) -> Result<Vec<Row>> {
    let mut rows = Vec::new();
    for line in BufReader::new(File::open(path)?).lines() {
        let line = line?;
        let c: Vec<&str> = line.split('\t').collect();
        if c.len() < 15 {
            continue;
        }
        rows.push(Row {
            ct_id: c[0].parse().unwrap_or(0),
            card_id: c[1].parse().unwrap_or(0),
            name: c[2].to_owned(),
            card_number: c[3].to_owned(),
            expansion: c[4].to_owned(),
            expansion_id: c[5].parse().unwrap_or(0),
            nationality: c[7].to_owned(),
            official_id: c[8].to_owned(),
            official_source: c[9].to_owned(),
            kind: c[10].to_owned(),
            art_layout: c[11].to_owned(),
            image_url: c[14].to_owned(),
        });
    }
    Ok(rows)
}

#[derive(Clone)]
struct Cand {
    source: &'static str,
    path: PathBuf,
    name: String,
    /// tcgdex ja names are Japanese: no name check is possible.
    name_comparable: bool,
    ref_id: String,
}

struct Sources {
    tcgdex: HashMap<(&'static str, String, String), Vec<Cand>>,
    ap: HashMap<(String, String), Vec<Cand>>,
    /// artofpkm western sets only (no Japanese name), keyed by `ap_west_key`; empty without `--ap-western`.
    ap_west: HashMap<(String, String), Vec<Cand>>,
}

/// Pokoin western expansion name → artofpkm western set name, compacted.
fn ap_west_key(expansion: &str) -> String {
    let e = expansion.trim().to_lowercase();
    let alias = match e.as_str() {
        "sm black star promos" => "sun & moon promos",
        "swsh black star promos" => "sword & shield promos",
        "dp black star promos" => "diamond & pearl promos",
        "bw black star promos" => "black & white promos",
        "xy black star promos" => "xy promos",
        "hgss black star promos" => "heartgold & soulsilver promos",
        "151" => "scarlet & violet 151",
        "pok mon rumble" | "pokemon rumble" => "rumble",
        "platinum arceus" => "arceus",
        other => other.strip_prefix("ex ").unwrap_or(other),
    };
    compact(alias)
}

fn load_tcgdex(root: &Path, lang: &'static str, into: &mut HashMap<(&'static str, String, String), Vec<Cand>>) -> Result<usize> {
    let manifest = root.join("tcgdex/manifest").join(format!("{lang}.jsonl"));
    let mut n = 0;
    for line in BufReader::new(File::open(&manifest)?).lines() {
        let v: Value = serde_json::from_str(&line?)?;
        let key = v["key"].as_str().unwrap_or("");
        let parts: Vec<&str> = key.split('/').collect();
        if parts.len() < 5 || parts[2] == "tcgp" {
            continue; // TCG Pocket is digital-only
        }
        let set = fold_set(parts[3]);
        let num = fold_num(v["localId"].as_str().unwrap_or(""));
        into.entry((lang, set, num)).or_default().push(Cand {
            source: if lang == "en" { "tcgdex-en" } else { "tcgdex-ja" },
            path: root.join(key),
            name: v["name"].as_str().unwrap_or("").to_owned(),
            name_comparable: lang == "en",
            ref_id: v["id"].as_str().unwrap_or("").to_owned(),
        });
        n += 1;
    }
    Ok(n)
}

type ApIndex = HashMap<(String, String), Vec<Cand>>;

/// (every set by English name, western sets only by English name).
fn load_ap(printings: &str, sets: &str, assets_root: &Path) -> Result<(ApIndex, ApIndex)> {
    let mut set_names: HashMap<String, String> = HashMap::new();
    let mut western: HashSet<String> = HashSet::new();
    for line in BufReader::new(File::open(sets)?).lines() {
        let line = line?;
        let c: Vec<&str> = line.split('\t').collect();
        if c.len() >= 2 {
            set_names.insert(c[0].to_owned(), c[1].to_owned());
            if c.get(2).map_or(true, |ja| ja.trim().is_empty()) {
                western.insert(c[0].to_owned());
            }
        }
    }
    let mut out: ApIndex = HashMap::new();
    let mut west: ApIndex = HashMap::new();
    let mut seen = HashSet::new();
    for line in BufReader::new(File::open(printings)?).lines() {
        let line = line?;
        let c: Vec<&str> = line.split('\t').collect();
        if c.len() < 8 || c[2].is_empty() || !seen.insert(c[7].to_owned()) {
            continue;
        }
        let set_name = set_names.get(c[0]).cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| c[1].to_owned());
        let cand = Cand {
            source: "artofpkm",
            path: assets_root.join(c[6]),
            name: c[3].to_owned(),
            name_comparable: true,
            ref_id: c[7].to_owned(),
        };
        // Western sets are keyed by the printing label: `Mega Evolution · Reverse Holo`
        // (set 873) is its own artofpkm set and must not match the regular print.
        if western.contains(c[0]) {
            let label = if c[1].is_empty() { set_name.as_str() } else { c[1] };
            west.entry((compact(label), fold_num(c[2]))).or_default().push(cand.clone());
        }
        out.entry((compact(&set_name), fold_num(c[2]))).or_default().push(cand);
    }
    Ok((out, west))
}

fn load_id_list(path: &Path) -> HashSet<u64> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<u64>>(&t).ok())
        .unwrap_or_default()
        .into_iter()
        .collect()
}

/// Ids pinned by hand in catalog-image-cache.json (`ids` rules): never touch them.
fn hand_fixed_ids(path: &Path) -> HashSet<u64> {
    let mut out = HashSet::new();
    if let Some(v) = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        for rule in v["rules"].as_array().into_iter().flatten() {
            for id in rule["ids"].as_array().into_iter().flatten() {
                if let Some(id) = id.as_u64() {
                    out.insert(id);
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------- images

/// JPEGs go through `jpeg-decoder`: `image` 0.25 (zune-jpeg 0.5) decodes the
/// hd1 masters this tool wrote with `jpeg-encoder` as a washed-out ghost.
fn load_rgb(path: &Path) -> Result<RgbImage> {
    let bytes = std::fs::read(path)?;
    if bytes.starts_with(&[0xFF, 0xD8]) {
        let mut dec = jpeg_decoder::Decoder::new(bytes.as_slice());
        let px = dec.decode()?;
        let info = dec.info().context("jpeg info")?;
        let rgb: Vec<u8> = match info.pixel_format {
            jpeg_decoder::PixelFormat::RGB24 => px,
            jpeg_decoder::PixelFormat::L8 => px.iter().flat_map(|&v| [v, v, v]).collect(),
            jpeg_decoder::PixelFormat::L16 => px.chunks(2).flat_map(|c| [c[0], c[0], c[0]]).collect(),
            jpeg_decoder::PixelFormat::CMYK32 => px
                .chunks(4)
                .flat_map(|c| {
                    let k = c[3] as u32;
                    [(c[0] as u32 * k / 255) as u8, (c[1] as u32 * k / 255) as u8, (c[2] as u32 * k / 255) as u8]
                })
                .collect(),
        };
        return RgbImage::from_raw(info.width as u32, info.height as u32, rgb).context("jpeg buffer size");
    }
    let img = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()?.decode()?;
    Ok(if img.color().has_alpha() { flatten(&img.to_rgba8()) } else { img.to_rgb8() })
}

/// Composite transparent corners onto the card's own border colour (median of
/// the opaque ring a little inside the edge, corners excluded), never white.
fn flatten(img: &RgbaImage) -> RgbImage {
    let (w, h) = img.dimensions();
    let mut samples: [Vec<u8>; 3] = [vec![], vec![], vec![]];
    let inset = |n: u32, f: f64| ((n as f64) * f).round() as u32;
    let (x0, x1, y0, y1) = (inset(w, 0.12), inset(w, 0.88), inset(h, 0.12), inset(h, 0.88));
    let ring = inset(w, 0.012).max(1)..=inset(w, 0.025).max(2);
    let mut push = |p: &image::Rgba<u8>| {
        if p[3] == 255 {
            for c in 0..3 {
                samples[c].push(p[c]);
            }
        }
    };
    for d in ring {
        for x in x0..x1 {
            push(img.get_pixel(x, d.min(h - 1)));
            push(img.get_pixel(x, (h - 1).saturating_sub(d)));
        }
        for y in y0..y1 {
            push(img.get_pixel(d.min(w - 1), y));
            push(img.get_pixel((w - 1).saturating_sub(d), y));
        }
    }
    let border: [u8; 3] = std::array::from_fn(|c| {
        let s = &mut samples[c];
        s.sort_unstable();
        s.get(s.len() / 2).copied().unwrap_or(255)
    });
    RgbImage::from_fn(w, h, |x, y| {
        let p = img.get_pixel(x, y);
        let a = p[3] as f32 / 255.0;
        Rgb(std::array::from_fn(|c| (p[c] as f32 * a + border[c] as f32 * (1.0 - a)).round() as u8))
    })
}

/// The upgrade itself: card at exactly 63:88 at the source height.
fn to_card_shape(img: &RgbImage) -> RgbImage {
    let (w, h) = img.dimensions();
    let want_w = ((h as f64) * CARD_ASPECT).round() as u32;
    if want_w == w {
        img.clone()
    } else {
        imageops::resize(img, want_w, h, FilterType::Lanczos3)
    }
}

fn aspect_dev(w: u32, h: u32) -> f64 {
    ((w as f64 / h as f64) / CARD_ASPECT - 1.0).abs()
}

struct Prepped {
    gray: Vec<f32>,
    rgb: RgbImage,
}

fn prep(img: &RgbImage) -> Prepped {
    let small = imageops::resize(img, W as u32, H as u32, FilterType::Triangle);
    let mut gray: Vec<f32> = small
        .pixels()
        .map(|p| 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32)
        .collect();
    // 3x3 box blur: scan noise and halftone are not a printing difference.
    let src = gray.clone();
    for y in 1..H - 1 {
        for x in 1..W - 1 {
            let mut s = 0.0;
            for dy in 0..3 {
                for dx in 0..3 {
                    s += src[(y + dy - 1) * W + x + dx - 1];
                }
            }
            gray[y * W + x] = s / 9.0;
        }
    }
    Prepped { gray, rgb: small }
}

fn sample(g: &[f32], x: f32, y: f32) -> f32 {
    let x = x.clamp(0.0, (W - 1) as f32 - 0.001);
    let y = y.clamp(0.0, (H - 1) as f32 - 0.001);
    let (x0, y0) = (x as usize, y as usize);
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    let a = g[y0 * W + x0] * (1.0 - fx) + g[y0 * W + x0 + 1] * fx;
    let b = g[(y0 + 1) * W + x0] * (1.0 - fx) + g[(y0 + 1) * W + x0 + 1] * fx;
    a * (1.0 - fy) + b * fy
}

#[derive(Clone, Copy)]
struct Xf {
    s: f32,
    dx: f32,
    dy: f32,
}

/// Candidate gray resampled into current-image coordinates.
fn warp(g: &[f32], t: Xf) -> Vec<f32> {
    let (cx, cy) = (W as f32 / 2.0, H as f32 / 2.0);
    let mut out = vec![0.0; W * H];
    for y in 0..H {
        for x in 0..W {
            let sx = (x as f32 - cx - t.dx) / t.s + cx;
            let sy = (y as f32 - cy - t.dy) / t.s + cy;
            out[y * W + x] = sample(g, sx, sy);
        }
    }
    out
}

/// Pearson correlation over a fractional rectangle.
fn ncc(a: &[f32], b: &[f32], r: (f32, f32, f32, f32)) -> f32 {
    let (x0, x1) = ((r.0 * W as f32) as usize, (r.1 * W as f32) as usize);
    let (y0, y1) = ((r.2 * H as f32) as usize, (r.3 * H as f32) as usize);
    let mut n = 0.0f64;
    let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0.0f64, 0.0, 0.0, 0.0, 0.0);
    for y in y0..y1 {
        for x in x0..x1 {
            let (p, q) = (a[y * W + x] as f64, b[y * W + x] as f64);
            n += 1.0;
            sa += p;
            sb += q;
            saa += p * p;
            sbb += q * q;
            sab += p * q;
        }
    }
    let cov = sab - sa * sb / n;
    let va = saa - sa * sa / n;
    let vb = sbb - sb * sb / n;
    if va <= 1e-6 || vb <= 1e-6 {
        return 0.0;
    }
    (cov / (va * vb).sqrt()) as f32
}

const INNER: (f32, f32, f32, f32) = (0.05, 0.95, 0.04, 0.96);
const ART: (f32, f32, f32, f32) = (0.10, 0.90, 0.11, 0.48);
/// WOTC 1st Edition stamp: left edge just under the artwork frame.
const STAMP: (f32, f32, f32, f32) = (0.04, 0.24, 0.50, 0.60);

fn zscore(a: &[f32]) -> Vec<f32> {
    let n = a.len() as f32;
    let m = a.iter().sum::<f32>() / n;
    let sd = (a.iter().map(|v| (v - m) * (v - m)).sum::<f32>() / n).sqrt().max(1.0);
    a.iter().map(|v| (v - m) / sd).collect()
}

fn mean_abs(a: &[f32], b: &[f32], r: (f32, f32, f32, f32)) -> f32 {
    let (x0, x1) = ((r.0 * W as f32) as usize, (r.1 * W as f32) as usize);
    let (y0, y1) = ((r.2 * H as f32) as usize, (r.3 * H as f32) as usize);
    let mut s = 0.0f32;
    let mut n = 0.0f32;
    for y in y0..y1 {
        for x in x0..x1 {
            s += (a[y * W + x] - b[y * W + x]).abs();
            n += 1.0;
        }
    }
    s / n.max(1.0)
}

#[derive(Default, Clone)]
struct Metrics {
    ncc_full: f32,
    ncc_art: f32,
    tile_max: f32,
    tile_p90: f32,
    stamp: f32,
    color: f32,
    sharp: f32,
    scale: f32,
    dx: f32,
    dy: f32,
    ed: f32,
    ed_ref: f32,
}

fn best_xf(cur: &[f32], cand: &[f32]) -> (Xf, f32) {
    let mut best = (Xf { s: 1.0, dx: 0.0, dy: 0.0 }, -2.0);
    for s in [0.94f32, 0.96, 0.98, 1.0, 1.02, 1.04, 1.06] {
        for dy in -4..=4 {
            for dx in -4..=4 {
                let t = Xf { s, dx: dx as f32, dy: dy as f32 };
                let v = ncc(cur, &warp(cand, t), INNER);
                if v > best.1 {
                    best = (t, v);
                }
            }
        }
    }
    // Half-pixel refinement around the coarse optimum.
    let c = best.0;
    for ds in [-0.01f32, 0.0, 0.01] {
        for dy in [-0.5f32, 0.0, 0.5] {
            for dx in [-0.5f32, 0.0, 0.5] {
                let t = Xf { s: c.s + ds, dx: c.dx + dx, dy: c.dy + dy };
                let v = ncc(cur, &warp(cand, t), INNER);
                if v > best.1 {
                    best = (t, v);
                }
            }
        }
    }
    best
}

/// Laplacian energy: detail per pixel.
fn sharpness(img: &GrayImage) -> f64 {
    let (w, h) = img.dimensions();
    let mut s = 0.0f64;
    let mut n = 0.0f64;
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let c = img.get_pixel(x, y)[0] as f64 * 4.0;
            let l = c
                - img.get_pixel(x - 1, y)[0] as f64
                - img.get_pixel(x + 1, y)[0] as f64
                - img.get_pixel(x, y - 1)[0] as f64
                - img.get_pixel(x, y + 1)[0] as f64;
            s += l * l;
            n += 1.0;
        }
    }
    s / n.max(1.0)
}

fn compare(cur: &RgbImage, cand: &RgbImage) -> Metrics {
    let (pc, pd) = (prep(cur), prep(cand));
    let (t, full) = best_xf(&pc.gray, &pd.gray);
    let warped = warp(&pd.gray, t);
    let (za, zb) = (zscore(&pc.gray), zscore(&warped));
    let mut tiles = Vec::new();
    let (cols, rows) = (6, 8);
    for ty in 0..rows {
        for tx in 0..cols {
            let r = (
                INNER.0 + (INNER.1 - INNER.0) * tx as f32 / cols as f32,
                INNER.0 + (INNER.1 - INNER.0) * (tx + 1) as f32 / cols as f32,
                INNER.2 + (INNER.3 - INNER.2) * ty as f32 / rows as f32,
                INNER.2 + (INNER.3 - INNER.2) * (ty + 1) as f32 / rows as f32,
            );
            tiles.push(mean_abs(&za, &zb, r));
        }
    }
    tiles.sort_by(|a, b| a.total_cmp(b));
    // Colour: mean abs difference of per-cell RGB means (holo / foil / different print colour).
    let cell = |img: &RgbImage| -> Vec<f32> {
        let (cw, ch) = (W / 9, H / 11);
        let mut out = Vec::new();
        for gy in 0..11 {
            for gx in 0..9 {
                let mut s = [0.0f32; 3];
                for y in gy * ch..(gy + 1) * ch {
                    for x in gx * cw..(gx + 1) * cw {
                        let p = img.get_pixel(x as u32, y as u32);
                        for c in 0..3 {
                            s[c] += p[c] as f32;
                        }
                    }
                }
                out.extend(s.map(|v| v / (cw * ch) as f32));
            }
        }
        out
    };
    let (ca, cb) = (cell(&pc.rgb), cell(&pd.rgb));
    let color = ca.iter().zip(&cb).map(|(a, b)| (a - b).abs()).sum::<f32>() / ca.len() as f32;
    // Sharpness at the current image's own size: is the candidate really more detailed?
    let cur_gray = imageops::grayscale(cur);
    let cand_down = imageops::grayscale(&imageops::resize(cand, cur.width(), cur.height(), FilterType::Triangle));
    let sharp = (sharpness(&cand_down) / sharpness(&cur_gray).max(1e-6)) as f32;
    let (ed, ed_ref) = (edition_mark(cur), edition_mark(cand));
    Metrics {
        ncc_full: full,
        ncc_art: ncc(&pc.gray, &warped, ART),
        tile_max: *tiles.last().unwrap_or(&0.0),
        tile_p90: tiles[(tiles.len() * 9) / 10],
        stamp: mean_abs(&za, &zb, STAMP),
        color,
        sharp,
        scale: t.s,
        dx: t.dx,
        dy: t.dy,
        ed,
        ed_ref,
    }
}

/// "1 EDITION" marks (Japanese DP–XY first print runs) at half of an 868 x 1212 card:
/// DP style from Beat of the Frontier Medicham Lv.48, BW style from Plasma Gale Elgyem.
static ED_TEMPLATES: std::sync::LazyLock<Vec<(usize, usize, Vec<f32>)>> = std::sync::LazyLock::new(|| {
    let mut out = Vec::new();
    for bytes in [&include_bytes!("../templates/ed-dp.png")[..], &include_bytes!("../templates/ed-bw.png")[..]] {
        let t = image::load_from_memory(bytes).expect("template").to_luma8();
        for s in [0.85f32, 1.0, 1.15] {
            let (w, h) = (((t.width() as f32) * s).round() as u32, ((t.height() as f32) * s).round() as u32);
            let r = imageops::blur(&imageops::resize(&t, w, h, FilterType::Triangle), 0.6);
            let v: Vec<f32> = r.pixels().map(|p| p[0] as f32).collect();
            out.push((w as usize, h as usize, zscore(&v)));
        }
    }
    out
});

/// Best normalised cross-correlation of a 1st Edition mark in the bottom-left corner.
fn edition_mark(img: &RgbImage) -> f32 {
    let (w, h) = (434usize, 606usize);
    let g = imageops::blur(&imageops::grayscale(&imageops::resize(img, w as u32, h as u32, FilterType::Triangle)), 0.6);
    let px: Vec<f32> = g.pixels().map(|p| p[0] as f32).collect();
    let mut best = -1.0f32;
    for (tw, th, tz) in ED_TEMPLATES.iter() {
        let n = (tw * th) as f32;
        for y0 in 530..(h - th) {
            for x0 in 4..(80usize).min(w - tw) {
                let (mut s, mut ss, mut st) = (0.0f32, 0.0f32, 0.0f32);
                for y in 0..*th {
                    let row = (y0 + y) * w + x0;
                    for x in 0..*tw {
                        let v = px[row + x];
                        s += v;
                        ss += v * v;
                        st += v * tz[y * tw + x];
                    }
                }
                let var = ss / n - (s / n) * (s / n);
                if var < 25.0 {
                    continue; // flat border: no mark, no match
                }
                let ncc = st / (n * var.sqrt());
                best = best.max(ncc);
            }
        }
    }
    best
}

// ---------------------------------------------------------------- match

struct Pair {
    row: Row,
    served: String,
    cur_w: u32,
    cur_h: u32,
    cand: Option<Cand>,
    cand_w: u32,
    cand_h: u32,
    name_score: u8,
    m: Metrics,
    verdict: &'static str,
    reason: String,
    bucket: String,
    /// Every JPEG of this ct_id the upgrade replaces (served first); each passed the core check on its own.
    targets: Vec<String>,
    /// Other JPEGs of this ct_id left alone, with why.
    kept: Vec<String>,
}

fn bucket(r: &Row) -> String {
    let lower = format!("{} {} {}", r.name, r.card_number, r.expansion).to_lowercase();
    let mut b = Vec::new();
    let oid = r.official_id.to_lowercase();
    if r.kind == "promo" || lower.contains("promo") || oid.ends_with('p') {
        b.push("promo");
    }
    if ["deck", "starter", "start "].iter().any(|k| lower.contains(k)) {
        b.push("deck");
    }
    if ["base", "gym", "neo", "ecard", "si1", "lc"].iter().any(|p| oid.starts_with(p)) || r.expansion_id == 1472 {
        b.push("wotc");
    }
    if r.art_layout == "bleed"
        || ["full art", "illustration", "secret", "hyper", "ultra rare", "special art"].iter().any(|k| lower.contains(k))
    {
        b.push("fullart");
    }
    let name = r.name.to_lowercase();
    if name.contains(" legend") || name.contains(" break") {
        b.push("landscape");
    }
    bucket_text(&format!("{} {} {}", r.name, r.card_number, r.expansion), &b.join(","))
}

fn run_match(f: &Flags) -> Result<()> {
    let rows = read_catalog(f.get("catalog")?)?;
    let objects = PathBuf::from(f.get("objects")?);
    let data = PathBuf::from(f.get("data")?); // market/src/data
    let cdn_root = PathBuf::from(f.get("tcgdex-root")?);
    let out_dir = PathBuf::from(f.get("out")?);
    std::fs::create_dir_all(&out_dir)?;
    let min_gain: f64 = f.opt("min-gain").and_then(|v| v.parse().ok()).unwrap_or(1.3);
    let limit: usize = f.opt("limit").and_then(|v| v.parse().ok()).unwrap_or(usize::MAX);

    let placeholders = load_id_list(&data.join("pokoin-placeholder-leftovers.json"));
    let hand_fixed = hand_fixed_ids(&data.join("catalog-image-cache.json"));

    // `--no-tcgdex`: artofpkm only (2026-10-20: tcgdex renders are not scans).
    let mut tcgdex = HashMap::new();
    let (n_en, n_ja) = if f.opt("no-tcgdex").is_some() {
        (0, 0)
    } else {
        (load_tcgdex(&cdn_root, "en", &mut tcgdex)?, load_tcgdex(&cdn_root, "ja", &mut tcgdex)?)
    };
    let (ap, ap_west) = load_ap(f.get("ap-printings")?, f.get("ap-sets")?, Path::new(f.get("ap-root")?))?;
    let ap_west = if f.opt("ap-western").is_some() { ap_west } else { HashMap::new() };
    let sources = Sources { tcgdex, ap, ap_west };
    eprintln!("tcgdex en={n_en} ja={n_ja} artofpkm keys={} western keys={}", sources.ap.len(), sources.ap_west.len());

    // Objects index, as the CDN server builds it.
    let mut by_id: HashMap<u64, Vec<String>> = HashMap::new();
    for e in std::fs::read_dir(&objects)? {
        let name = e?.file_name().to_string_lossy().into_owned();
        if let Some((id, _)) = name.split_once('_') {
            if let Ok(id) = id.parse::<u64>() {
                by_id.entry(id).or_default().push(name);
            }
        }
    }
    eprintln!("objects ids={}", by_id.len());

    let only: Option<HashSet<u64>> = f
        .opt("only-ids")
        .map(|p| std::fs::read_to_string(p).map(|t| t.lines().filter_map(|l| l.trim().parse().ok()).collect()))
        .transpose()?;
    let rows: Vec<Row> = rows.into_iter().filter(|r| only.as_ref().map_or(true, |o| o.contains(&r.ct_id))).take(limit).collect();
    let pairs: Vec<Pair> = rows
        .par_iter()
        .map(|r| evaluate(r, &sources, &by_id, &objects, &placeholders, &hand_fixed, min_gain))
        .collect();

    let mut all = BufWriter::new(File::create(out_dir.join("pairs.tsv"))?);
    writeln!(
        all,
        "verdict\treason\tct_id\tcard_id\tname\tcard_number\texpansion\tnationality\tofficial_id\tbucket\tserved\tcur_w\tcur_h\tsource\tcand_ref\tcand_name\tcand_path\tcand_w\tcand_h\tname_score\tncc_full\tncc_art\ttile_max\ttile_p90\tstamp\tcolor\tsharp\tscale\tdx\tdy\ttargets\tkept\ted\ted_ref"
    )?;
    let mut counts: HashMap<String, usize> = HashMap::new();
    for p in &pairs {
        *counts.entry(format!("{}\t{}", p.verdict, p.reason.split(':').next().unwrap_or(""))).or_default() += 1;
        let (src, cref, cname, cpath) = p
            .cand
            .as_ref()
            .map(|c| (c.source, c.ref_id.as_str(), c.name.as_str(), c.path.to_string_lossy().into_owned()))
            .unwrap_or(("", "", "", String::new()));
        let m = &p.m;
        writeln!(
            all,
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{:.4}\t{:.4}\t{:.3}\t{:.3}\t{:.3}\t{:.2}\t{:.3}\t{:.3}\t{:.1}\t{:.1}\t{}\t{}\t{:.4}\t{:.4}",
            p.verdict, p.reason, p.row.ct_id, p.row.card_id, p.row.name, p.row.card_number, p.row.expansion, p.row.nationality,
            p.row.official_id, p.bucket, p.served, p.cur_w, p.cur_h, src, cref, cname, cpath, p.cand_w, p.cand_h, p.name_score,
            m.ncc_full, m.ncc_art, m.tile_max, m.tile_p90, m.stamp, m.color, m.sharp, m.scale, m.dx, m.dy,
            p.targets.join(","), p.kept.join("|"), m.ed, m.ed_ref
        )?;
    }
    let mut counts: Vec<_> = counts.into_iter().collect();
    counts.sort();
    for (k, v) in counts {
        println!("{v}\t{k}");
    }
    Ok(())
}

fn evaluate(
    r: &Row,
    s: &Sources,
    by_id: &HashMap<u64, Vec<String>>,
    objects: &Path,
    placeholders: &HashSet<u64>,
    hand_fixed: &HashSet<u64>,
    min_gain: f64,
) -> Pair {
    let mut p = Pair {
        row: r.clone(),
        served: String::new(),
        cur_w: 0,
        cur_h: 0,
        cand: None,
        cand_w: 0,
        cand_h: 0,
        name_score: 0,
        m: Metrics::default(),
        verdict: "skip",
        reason: String::new(),
        bucket: bucket(r),
        targets: Vec::new(),
        kept: Vec::new(),
    };
    macro_rules! out {
        ($verdict:expr, $($arg:tt)*) => {{ p.verdict = $verdict; p.reason = format!($($arg)*); return p; }};
    }

    // Candidate lookup.
    let num = fold_num(&r.card_number);
    let mut cands: Vec<Cand> = Vec::new();
    let western = r.nationality == "western" || r.nationality == "american";
    if western && (r.official_source == "pokemontcg.io" || r.official_source == "tcgdex-en") && !r.official_id.is_empty() {
        if let Some(v) = s.tcgdex.get(&("en", fold_set(&r.official_id), num.clone())) {
            cands.extend(v.iter().cloned());
        }
    }
    if western {
        if let Some(v) = s.ap_west.get(&(ap_west_key(&r.expansion), num.clone())) {
            cands.extend(v.iter().cloned());
        }
    }
    if r.nationality == "japanese" {
        if r.official_source == "tcgdex-ja" && !r.official_id.is_empty() {
            if let Some(v) = s.tcgdex.get(&("ja", fold_set(&r.official_id), num.clone())) {
                cands.extend(v.iter().cloned());
            }
        }
        if let Some(v) = s.ap.get(&(compact(&r.expansion), num.clone())) {
            cands.extend(v.iter().cloned());
        }
    }
    if num.is_empty() {
        out!("skip", "no-collector");
    }
    if cands.is_empty() {
        out!("skip", "no-candidate");
    }

    // What the CDN serves for the catalog URL: shortest slug-compatible JPEG of this ct_id.
    let file = r.image_url.rsplit('/').next().unwrap_or("");
    let want = if file.starts_with(&format!("{}_", r.ct_id)) { leftover_slug(file) } else { String::new() };
    let files = by_id.get(&r.ct_id).cloned().unwrap_or_default();
    if files.is_empty() {
        out!("skip", "no-cdn-object");
    }
    // Two slug families for one card (`togetic-39-147-aquapolis` and `togetic-full-v4`):
    // the CDN serves whichever matches the requested slug, so each JPEG is checked on its own below.
    let all_jpgs: Vec<&String> = files.iter().filter(|n| n.ends_with(".jpg") || n.ends_with(".jpeg")).collect();
    let mut jpgs: Vec<&String> = all_jpgs.iter().copied().filter(|n| slug_compatible(&want, n)).collect();
    jpgs.sort_by(|a, b| a.len().cmp(&b.len()).then(a.cmp(b)));
    let Some(served) = jpgs.first() else { out!("skip", "no-cdn-jpeg") };
    p.served = (*served).clone();
    if placeholders.contains(&r.ct_id) {
        out!("skip", "placeholder");
    }
    if hand_fixed.contains(&r.ct_id) {
        out!("skip", "hand-fixed-token");
    }
    if r.expansion_id == 1472 {
        out!("skip", "base-set-unlimited");
    }
    let Ok((cw, ch)) = image::image_dimensions(objects.join(served)) else { out!("skip", "cdn-unreadable") };
    p.cur_w = cw;
    p.cur_h = ch;

    // Name agreement + size gain per candidate; keep the eligible ones.
    let mut eligible: Vec<(Cand, u32, u32, u8)> = Vec::new();
    let mut why = Vec::new();
    for c in &cands {
        let ns = if c.name_comparable { name_score(&r.name, &c.name) } else { 2 };
        if c.name_comparable && ns == 0 {
            why.push(format!("name:{}", c.name));
            continue;
        }
        let Ok((w, h)) = image::image_dimensions(&c.path) else {
            why.push("cand-unreadable".into());
            continue;
        };
        if aspect_dev(w, h) > 0.04 {
            why.push(format!("cand-aspect:{w}x{h}"));
            continue;
        }
        let gain = h as f64 / ch as f64;
        if gain < min_gain || w <= cw {
            why.push(format!("small-gain:{gain:.2}"));
            continue;
        }
        eligible.push((c.clone(), w, h, ns));
    }
    if eligible.is_empty() {
        let first = why.first().cloned().unwrap_or_default();
        let kind = first.split(':').next().unwrap_or("").to_owned();
        out!("reject", "{kind}:{}", why.join("|"));
    }
    if aspect_dev(cw, ch) > 0.06 {
        out!("reject", "cur-aspect:{cw}x{ch}");
    }
    let Ok(cur) = load_rgb(&objects.join(served)) else { out!("skip", "cdn-decode") };

    // Visual check; best candidate wins.
    let mut best: Option<(Cand, u32, u32, u8, Metrics)> = None;
    for (c, w, h, ns) in eligible {
        let Ok(img) = load_rgb(&c.path) else { continue };
        let m = compare(&cur, &to_card_shape(&img));
        let better = best.as_ref().map_or(true, |b| m.ncc_full > b.4.ncc_full + 0.01 || (m.ncc_full >= b.4.ncc_full - 0.01 && h > b.2));
        if better {
            best = Some((c, w, h, ns, m));
        }
    }
    let Some((c, w, h, ns, m)) = best else { out!("skip", "cand-decode") };
    let multiple = cands.len() > 1;
    p.cand = Some(c);
    p.cand_w = w;
    p.cand_h = h;
    p.name_score = ns;
    p.m = m.clone();

    let _ = multiple; // the visual check picks between same-number candidates
    let (verdict, reason) = decide_verdict(&p.bucket, p.cand.as_ref().map_or("", |c| c.source), &m);
    if verdict == "accept" || verdict == "review" {
        p.targets.push(p.served.clone());
        if all_jpgs.len() > 1 {
            if let Ok(img) = load_rgb(&p.cand.as_ref().unwrap().path).map(|i| to_card_shape(&i)) {
                for other in all_jpgs.iter().filter(|n| ***n != p.served) {
                    let note = match image::image_dimensions(objects.join(other)) {
                        Ok((_, oh)) if (h as f64) / (oh as f64) < min_gain => format!("{other}=larger:{oh}"),
                        Ok(_) => match load_rgb(&objects.join(other)) {
                            Ok(o) => {
                                let om = compare(&o, &img);
                                if om.ncc_full >= 0.98 && om.ncc_art >= 0.97 && om.tile_max <= 0.30 && edition_conflict(om.ed, om.ed_ref).is_none() {
                                    p.targets.push((*other).clone());
                                    continue;
                                }
                                format!("{other}=differs:{:.3}/{:.3}/{:.2}/ed{:.2}-{:.2}", om.ncc_full, om.ncc_art, om.tile_max, om.ed, om.ed_ref)
                            }
                            Err(_) => format!("{other}=undecodable"),
                        },
                        Err(_) => format!("{other}=unreadable"),
                    };
                    p.kept.push(note);
                }
            }
        }
    }
    out!(verdict, "{reason}")
}

/// Acceptance rules, tuned on the review sheets (run1, 2026-10-19):
/// same printings sit in a tight cluster (whole card ≥ 0.98, artwork ≥ 0.97,
/// worst tile ≤ 0.30 of a z-score); anything looser is held for review, not
/// written. Sharpness is logged only: the small CDN scans' JPEG noise scored
/// "sharper" than real detail.
fn decide_verdict(bucket: &str, source: &str, m: &Metrics) -> (&'static str, String) {
    if source == "tcgdex-en" && bucket.contains("wotc") {
        // tcgdex WOTC images include 1st Edition prints (Gym Challenge Rocket's Mewtwo 14/132).
        return ("reject", "wotc-edition-risk".into());
    }
    if let Some(why) = edition_conflict(m.ed, m.ed_ref) {
        let v = if why == "edition" { "reject" } else { "review" };
        return (v, format!("{why}:{:.2}/{:.2}", m.ed, m.ed_ref));
    }
    let core = m.ncc_full >= 0.98 && m.ncc_art >= 0.97 && m.tile_max <= 0.30;
    let near = m.ncc_full >= 0.95 && m.ncc_art >= 0.95 && m.tile_max <= 0.50;
    if !core && !near {
        let r = if m.ncc_full < 0.95 {
            format!("visual-full:{:.3}", m.ncc_full)
        } else if m.ncc_art < 0.95 {
            format!("visual-art:{:.3}", m.ncc_art)
        } else {
            format!("visual-tile:{:.3}", m.tile_max)
        };
        return ("reject", r);
    }
    if !core {
        return ("review", format!("near:{:.3}/{:.3}/{:.2}", m.ncc_full, m.ncc_art, m.tile_max));
    }
    if m.color >= 16.0 {
        // Holo / foil / reprint colour variants of the same number.
        return ("review", format!("color:{:.1}", m.color));
    }
    if bucket.contains("stamped") {
        return ("review", "stamped".into());
    }
    ("accept", "ok".into())
}

/// 1st Edition mark scores (edition_mark) of two scans of one number: a mark
/// scores ≥ 0.80, no mark < 0.72 (calibrated on 403 Japanese pairs, 2026-10-19).
fn edition_conflict(a: f32, b: f32) -> Option<&'static str> {
    let (has, lacks) = (|x: f32| x >= 0.80, |x: f32| x < 0.72);
    if (has(a) && lacks(b)) || (has(b) && lacks(a)) {
        Some("edition")
    } else if has(a) != has(b) {
        Some("edition-unsure")
    } else {
        None
    }
}

/// Re-apply `decide_verdict` to a pairs.tsv without recomputing metrics.
fn decide(f: &Flags) -> Result<()> {
    let mut lines = BufReader::new(File::open(f.get("pairs")?)?).lines();
    let header_line = lines.next().context("empty pairs")??;
    let header: Vec<&str> = header_line.split('\t').collect();
    let col = |name: &str| header.iter().position(|h| *h == name).with_context(|| format!("no column {name}"));
    let (cv, cr, cb, cs) = (col("verdict")?, col("reason")?, col("bucket")?, col("source")?);
    let (cf, ca, ct, cc) = (col("ncc_full")?, col("ncc_art")?, col("tile_max")?, col("color")?);
    let (cn, cnum, cexp) = (col("name")?, col("card_number")?, col("expansion")?);
    let (ced, cedr) = (header.iter().position(|h| *h == "ed"), header.iter().position(|h| *h == "ed_ref"));
    let mut out = BufWriter::new(File::create(f.get("out")?)?);
    writeln!(out, "{header_line}")?;
    let mut counts: HashMap<String, usize> = HashMap::new();
    for line in lines {
        let line = line?;
        let mut c: Vec<String> = line.split('\t').map(str::to_owned).collect();
        let full: f32 = c[cf].parse().unwrap_or(0.0);
        if full > 0.0 {
            let m = Metrics {
                ncc_full: full,
                ncc_art: c[ca].parse().unwrap_or(0.0),
                tile_max: c[ct].parse().unwrap_or(9.0),
                color: c[cc].parse().unwrap_or(99.0),
                ed: ced.and_then(|i| c.get(i)).and_then(|v| v.parse().ok()).unwrap_or(0.0),
                ed_ref: cedr.and_then(|i| c.get(i)).and_then(|v| v.parse().ok()).unwrap_or(0.0),
                ..Default::default()
            };
            let bucket = bucket_text(&format!("{} {} {}", c[cn], c[cnum], c[cexp]), &c[cb]);
            let (v, r) = decide_verdict(&bucket, &c[cs], &m);
            c[cv] = v.to_owned();
            c[cr] = r;
            c[cb] = bucket;
        }
        *counts.entry(format!("{}\t{}\t{}", c[cv], c[cr].split(':').next().unwrap_or(""), c[cs])).or_default() += 1;
        writeln!(out, "{}", c.join("\t"))?;
    }
    let mut counts: Vec<_> = counts.into_iter().collect();
    counts.sort();
    for (k, v) in counts {
        println!("{v}\t{k}");
    }
    Ok(())
}

/// Stamped / special-issue printings share a set number with the plain card.
fn bucket_text(text: &str, base: &str) -> String {
    let lower = text.to_lowercase();
    let stamped = ["stamp", "prerelease", "staff", "league", "cosmos", "winner", "championship", "pokemon center", "1st edition", "first edition"]
        .iter()
        .any(|k| lower.contains(k));
    let mut parts: Vec<&str> = base.split(',').filter(|s| !s.is_empty() && *s != "stamped").collect();
    if stamped {
        parts.push("stamped");
    }
    parts.join(",")
}

/// Recompute the visual metrics (with the edition corner) for accept/review rows
/// of a pairs.tsv, appending `ed`/`ed_ref` columns when the file predates them.
fn remeasure(f: &Flags) -> Result<()> {
    let objects = PathBuf::from(f.get("objects")?);
    let text = std::fs::read_to_string(f.get("pairs")?)?;
    let mut lines = text.lines();
    let mut header: Vec<String> = lines.next().context("empty pairs")?.split('\t').map(str::to_owned).collect();
    for extra in ["ed", "ed_ref"] {
        if !header.iter().any(|h| h == extra) {
            header.push(extra.to_owned());
        }
    }
    let col = |name: &str| header.iter().position(|h| h == name).unwrap();
    let rows: Vec<Vec<String>> = lines
        .map(|l| {
            let mut c: Vec<String> = l.split('\t').map(str::to_owned).collect();
            c.resize(header.len(), String::new());
            c
        })
        .collect();
    let (cv, cs, cp) = (col("verdict"), col("served"), col("cand_path"));
    let set = |c: &mut Vec<String>, name: &str, v: String| c[col(name)] = v;
    let dropped = std::sync::Mutex::new(Vec::<(String, usize)>::new());
    let rows: Vec<Vec<String>> = rows
        .into_par_iter()
        .map(|mut c| {
            if c[cv] != "accept" && c[cv] != "review" {
                return c;
            }
            let mut run = || -> Result<Metrics> {
                let cur = load_rgb(&objects.join(&c[cs]))?;
                let cand = to_card_shape(&load_rgb(Path::new(&c[cp]))?);
                let m = compare(&cur, &cand);
                // Extra slug-family targets must still pass on their own, edition mark included.
                if let Some(ct) = header.iter().position(|h| h == "targets") {
                    let mut keep = Vec::new();
                    for t in c[ct].split(',').filter(|t| !t.is_empty()) {
                        if *t == c[cs] {
                            keep.push(t.to_owned());
                            continue;
                        }
                        let ok = load_rgb(&objects.join(t)).map(|o| compare(&o, &cand)).map(|om| {
                            om.ncc_full >= 0.98 && om.ncc_art >= 0.97 && om.tile_max <= 0.30 && edition_conflict(om.ed, om.ed_ref).is_none()
                        });
                        if ok.unwrap_or(false) {
                            keep.push(t.to_owned());
                        }
                    }
                    dropped.lock().unwrap().push((c[col("ct_id")].clone(), c[ct].split(',').count() - keep.len()));
                    c[ct] = keep.join(",");
                }
                Ok(m)
            };
            match run() {
                Ok(m) => {
                    set(&mut c, "ncc_full", format!("{:.4}", m.ncc_full));
                    set(&mut c, "ncc_art", format!("{:.4}", m.ncc_art));
                    set(&mut c, "tile_max", format!("{:.3}", m.tile_max));
                    set(&mut c, "tile_p90", format!("{:.3}", m.tile_p90));
                    set(&mut c, "color", format!("{:.2}", m.color));
                    set(&mut c, "scale", format!("{:.3}", m.scale));
                    set(&mut c, "dx", format!("{:.1}", m.dx));
                    set(&mut c, "dy", format!("{:.1}", m.dy));
                    set(&mut c, "ed", format!("{:.4}", m.ed));
                    set(&mut c, "ed_ref", format!("{:.4}", m.ed_ref));
                }
                Err(e) => eprintln!("remeasure {}: {e}", c[col("ct_id")]),
            }
            c
        })
        .collect();
    let dropped: usize = dropped.into_inner().unwrap().iter().map(|(_, n)| n).sum();
    eprintln!("extra targets dropped: {dropped}");
    let mut out = BufWriter::new(File::create(f.get("out")?)?);
    writeln!(out, "{}", header.join("\t"))?;
    for c in rows {
        writeln!(out, "{}", c.join("\t"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------- render

/// For each `ct_id` in --ids (one per line), write `<out>/<ct_id>.jpg`:
/// current | upgrade (as encoded) | aligned difference, each 440 px tall.
fn render(f: &Flags) -> Result<()> {
    let pairs = read_pairs(f.get("pairs")?)?;
    let objects = PathBuf::from(f.get("objects")?);
    let out = PathBuf::from(f.get("out")?);
    std::fs::create_dir_all(&out)?;
    let ids: Vec<String> = std::fs::read_to_string(f.get("ids")?)?.lines().map(|l| l.trim().to_owned()).filter(|l| !l.is_empty()).collect();
    ids.par_iter().try_for_each(|id| -> Result<()> {
        let Some(p) = pairs.get(id) else { return Ok(()) };
        let cur = load_rgb(&objects.join(&p["served"]))?;
        let cand = to_card_shape(&load_rgb(Path::new(&p["cand_path"]))?);
        let th = 440u32;
        let tw = (th as f64 * CARD_ASPECT).round() as u32;
        let a = imageops::resize(&cur, tw, th, FilterType::Lanczos3);
        let b = imageops::resize(&cand, tw, th, FilterType::Lanczos3);
        // Difference panel at the comparison alignment, upscaled.
        let (pc, pd) = (prep(&cur), prep(&cand));
        let t = Xf { s: p["scale"].parse().unwrap_or(1.0), dx: p["dx"].parse().unwrap_or(0.0), dy: p["dy"].parse().unwrap_or(0.0) };
        let (za, zb) = (zscore(&pc.gray), zscore(&warp(&pd.gray, t)));
        let diff = GrayImage::from_fn(W as u32, H as u32, |x, y| {
            let i = y as usize * W + x as usize;
            image::Luma([((za[i] - zb[i]).abs() * 120.0).min(255.0) as u8])
        });
        let diff = imageops::resize(&diff, tw, th, FilterType::Nearest);
        let mut sheet = RgbImage::from_pixel(tw * 3 + 8, th, Rgb([24, 24, 24]));
        imageops::overlay(&mut sheet, &a, 0, 0);
        imageops::overlay(&mut sheet, &b, (tw + 4) as i64, 0);
        let diff_rgb = RgbImage::from_fn(tw, th, |x, y| {
            let v = diff.get_pixel(x, y)[0];
            Rgb([v, v / 3, v / 3])
        });
        imageops::overlay(&mut sheet, &diff_rgb, (tw * 2 + 8) as i64, 0);
        write_jpeg(&sheet, &out.join(format!("{id}.jpg")), 85)?;
        Ok(())
    })?;
    Ok(())
}

fn read_pairs(path: &str) -> Result<HashMap<String, HashMap<String, String>>> {
    let mut lines = BufReader::new(File::open(path)?).lines();
    let header: Vec<String> = lines.next().context("empty pairs")??.split('\t').map(str::to_owned).collect();
    let mut out = HashMap::new();
    for line in lines {
        let line = line?;
        let row: HashMap<String, String> = header.iter().cloned().zip(line.split('\t').map(str::to_owned)).collect();
        out.insert(row["ct_id"].clone(), row);
    }
    Ok(out)
}

fn write_jpeg(img: &RgbImage, path: &Path, quality: u8) -> Result<()> {
    let mut enc = jpeg_encoder::Encoder::new_file(path, quality)?;
    enc.set_optimized_huffman_tables(true);
    enc.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_2_0);
    enc.encode(img.as_raw(), img.width() as u16, img.height() as u16, jpeg_encoder::ColorType::Rgb)?;
    Ok(())
}

// ---------------------------------------------------------------- encode

/// Accepted pairs → `<out>/<served>.jpg` (q92, source size, 63:88) and
/// `<out>/<served stem>_homepage.webp` (480 px wide, q82, as the ingest script).
fn encode(f: &Flags) -> Result<()> {
    let pairs = read_pairs(f.get("pairs")?)?;
    let out = PathBuf::from(f.get("out")?);
    std::fs::create_dir_all(&out)?;
    let ids: Vec<String> = std::fs::read_to_string(f.get("ids")?)?.lines().map(|l| l.trim().to_owned()).filter(|l| !l.is_empty()).collect();
    let done: Vec<String> = ids
        .par_iter()
        .filter_map(|id| {
            let p = pairs.get(id)?;
            if p["verdict"] != "accept" {
                return None;
            }
            let targets: Vec<&str> = p["targets"].split(',').filter(|t| !t.is_empty()).collect();
            let run = || -> Result<String> {
                let img = to_card_shape(&load_rgb(Path::new(&p["cand_path"]))?);
                let first = *targets.first().context("no targets")?;
                write_jpeg(&img, &out.join(first), 92)?;
                let (w, h) = img.dimensions();
                let hw = 480u32.min(w);
                let hh = ((h as f64) * hw as f64 / w as f64).round().max(1.0) as u32;
                let small = imageops::resize(&img, hw, hh, FilterType::Lanczos3);
                let webp = webp::Encoder::from_rgb(small.as_raw(), hw, hh).encode_advanced(&{
                    let mut c = webp::WebPConfig::new().map_err(|_| anyhow::anyhow!("webp config"))?;
                    c.quality = 82.0;
                    c.method = 6;
                    c
                });
                let webp = webp.map_err(|e| anyhow::anyhow!("webp {e:?}"))?;
                for t in &targets {
                    if *t != first {
                        std::fs::copy(out.join(first), out.join(t))?;
                    }
                    let stem = t.strip_suffix(".jpg").or_else(|| t.strip_suffix(".jpeg")).unwrap_or(t);
                    std::fs::write(out.join(format!("{stem}_homepage.webp")), &*webp)?;
                }
                Ok(format!("{id}\t{}\t{w}\t{h}", targets.join(",")))
            };
            match run() {
                Ok(line) => Some(line),
                Err(e) => {
                    eprintln!("encode {id}: {e}");
                    None
                }
            }
        })
        .collect();
    let mut m = BufWriter::new(File::create(out.join("_encoded.tsv"))?);
    for l in &done {
        writeln!(m, "{l}")?;
    }
    eprintln!("encoded {}/{}", done.len(), ids.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_set_ids_and_numbers() {
        assert_eq!(fold_set("swsh05"), "swsh5");
        assert_eq!(fold_set("me03"), "me3");
        assert_eq!(fold_set("sv3pt5"), "sv3.5");
        assert_eq!(fold_num("Illustration Rare | 095/088"), "95");
        assert_eq!(fold_num("SV086"), "SV86");
        assert_eq!(fold_num("TG05/TG30"), "TG5");
        assert_eq!(fold_num("001/009"), "1");
        assert_eq!(fold_num("100"), "100");
    }

    #[test]
    fn slug_rules_match_the_cdn_server() {
        assert_eq!(leftover_slug("274190_espathra-ex_homepage.webp"), "espathra-ex");
        assert!(slug_compatible("espathra-ex-006-091-paldean-fates", "274190_espathra-ex.jpg"));
        assert!(!slug_compatible("gloom-2-98-ancient-origins", "109851_gloom-full-v4.jpg"));
    }

    #[test]
    fn names() {
        assert_eq!(name_score("Espurr", "Espurr"), 2);
        assert_eq!(name_score("Icy Sky's Shaymin Lv.62", "Ice Sky Shaymin"), 1);
        assert_eq!(name_score("Bulbasaur", "Pikachu"), 0);
    }
}
