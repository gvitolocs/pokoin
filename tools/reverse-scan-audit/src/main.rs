//! Find reverse-holo / stamped scans among the scans we hold for each Pokémon printing.
//!
//! CardTrader has one blueprint per printing; "reverse" is a listing option
//! (`pokemon_reverse`), so a reverse scan of a printing is not its own catalog
//! row. Some of the scans we have held for a printing over time are reverse
//! copies: Wigglytuff 13/100 Crystal Guardians served the set-stamped reverse
//! until token `wg1`. This tool compares every scan we hold for a western
//! printing (the CDN stores, their backups, older copies) with the standard
//! tcgdex scan of that printing and scores the reverse-foil signature:
//!
//! - a reverse is foil outside the artwork window, so the text box gains
//!   texture relative to the artwork (`s_text`, log ratio vs the tcgdex scan),
//! - a reverse of a holo rare also loses the holo artwork (`a_art` < 0),
//! - EX-era reverses carry the set logo stamped on the artwork's lower right (`stamp`).
//!
//!   reverse-scan-audit scan --catalog catalog.tsv --tcgdex-root DIR \
//!       --sources nvme=DIR,hd1=DIR,... --out feats.tsv [--ids ids.txt]
//!   reverse-scan-audit sheet --feats feats.tsv --out DIR [--key s_text] [--top 300] [--ids ids.txt]
//!   reverse-scan-audit compare --pairs pairs.tsv --out feats.tsv
//!   reverse-scan-audit encode --pairs pick.tsv --out DIR
//!
//! `compare` scores given pairs instead of the catalog: a TSV with a header and
//! at least `ct_id`, `path` (the variant scan) and `ref` (our desk scan); every
//! input column is kept. `encode` writes each pick's `path` as `{ct}_{slug}.jpg`
//! (column `file`) at 63:88, its own height, JPEG q92, for `objects/reverse/`.
//!
//! The scores only rank. A person decides from the sheets (left: tcgdex, right: our scan).
//! Catalog TSV: the hd-scan-upgrade `catalog.tsv` (ct_id, card_id, name, card_number,
//! expansion, expansion_id, code, nationality, official_id, ...).

mod font;

use anyhow::{bail, Context, Result};
use image::{imageops, imageops::FilterType, Rgb, RgbImage, Rgba, RgbaImage};
use rayon::prelude::*;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Alignment grid (same as hd-scan-upgrade).
const W: usize = 126;
const H: usize = 176;
/// Texture grid: foil grain needs more pixels than the alignment.
const TW: usize = 252;
const TH: usize = 352;

/// Fractional rectangles (left, right, top, bottom) of a normalised 63:88 card.
const INNER: (f32, f32, f32, f32) = (0.05, 0.95, 0.04, 0.96);
const ART: (f32, f32, f32, f32) = (0.12, 0.88, 0.13, 0.46);
/// Attack text box: printed flat on a regular card, foil on a reverse.
const TEXT: (f32, f32, f32, f32) = (0.10, 0.90, 0.57, 0.85);
/// EX-era reverse set stamp: lower right of the artwork window.
const STAMP_EX: (f32, f32, f32, f32) = (0.66, 0.90, 0.38, 0.49);

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let flags = Flags::parse(&args[2.min(args.len())..]);
    match args.get(1).map(String::as_str) {
        Some("scan") => scan(&flags),
        Some("sheet") => sheet(&flags),
        Some("compare") => compare(&flags),
        Some("encode") => encode(&flags),
        _ => bail!("usage: reverse-scan-audit scan|sheet|compare|encode --flag value ..."),
    }
}

struct Flags(HashMap<String, String>);

impl Flags {
    fn parse(args: &[String]) -> Self {
        let mut map = HashMap::new();
        let mut i = 0;
        while i < args.len() {
            if let Some(key) = args[i].strip_prefix("--") {
                map.insert(key.to_owned(), args.get(i + 1).cloned().unwrap_or_default());
                i += 2;
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

// ---------------------------------------------------------------- normalising (as hd-scan-upgrade)

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

// ---------------------------------------------------------------- inputs

struct Row {
    ct_id: u64,
    card_id: u64,
    name: String,
    card_number: String,
    expansion: String,
    nationality: String,
    official_id: String,
}

fn read_catalog(path: &str) -> Result<Vec<Row>> {
    let mut rows = Vec::new();
    for line in BufReader::new(File::open(path)?).lines() {
        let line = line?;
        let c: Vec<&str> = line.split('\t').collect();
        if c.len() < 9 {
            continue;
        }
        rows.push(Row {
            ct_id: c[0].parse().unwrap_or(0),
            card_id: c[1].parse().unwrap_or(0),
            name: c[2].to_owned(),
            card_number: c[3].to_owned(),
            expansion: c[4].to_owned(),
            nationality: c[7].to_owned(),
            official_id: c[8].to_owned(),
        });
    }
    Ok(rows)
}

fn read_ids(path: Option<&str>) -> Result<Option<HashSet<u64>>> {
    let Some(path) = path else { return Ok(None) };
    let mut out = HashSet::new();
    for line in BufReader::new(File::open(path)?).lines() {
        if let Ok(id) = line?.trim().parse::<u64>() {
            out.insert(id);
        }
    }
    Ok(Some(out))
}

/// tcgdex en manifest → (set, number) → scan path.
fn load_tcgdex_en(root: &Path) -> Result<HashMap<(String, String), PathBuf>> {
    let mut out = HashMap::new();
    for line in BufReader::new(File::open(root.join("tcgdex/manifest/en.jsonl"))?).lines() {
        let v: Value = serde_json::from_str(&line?)?;
        let key = v["key"].as_str().unwrap_or("");
        let parts: Vec<&str> = key.split('/').collect();
        if parts.len() < 5 || parts[2] == "tcgp" {
            continue; // TCG Pocket is digital-only
        }
        let num = fold_num(v["localId"].as_str().unwrap_or(""));
        out.entry((fold_set(parts[3]), num)).or_insert_with(|| root.join(key));
    }
    Ok(out)
}

/// Master scans (`{ct}_{slug}.jpg`, not thumbnails) of one store, by ct_id.
fn index_masters(dir: &Path) -> Result<HashMap<u64, Vec<PathBuf>>> {
    let mut out: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    for e in std::fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
        let name = e?.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".jpg") || name.contains("_homepage") {
            continue;
        }
        if let Some(id) = name.split_once('_').and_then(|(id, _)| id.parse::<u64>().ok()) {
            out.entry(id).or_default().push(dir.join(&name));
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- images

/// JPEGs go through jpeg-decoder: image 0.25's zune-jpeg washes out the hd1 masters.
fn load_rgb(path: &Path) -> Result<RgbImage> {
    let mut bytes = Vec::new();
    File::open(path)?.read_to_end(&mut bytes)?;
    decode(&bytes).with_context(|| format!("decode {}", path.display()))
}

fn decode(bytes: &[u8]) -> Result<RgbImage> {
    if bytes.starts_with(&[0xFF, 0xD8]) {
        let mut d = jpeg_decoder::Decoder::new(bytes);
        let px = d.decode()?;
        let info = d.info().context("jpeg info")?;
        let (w, h) = (info.width as u32, info.height as u32);
        let rgb: Vec<u8> = match info.pixel_format {
            jpeg_decoder::PixelFormat::RGB24 => px,
            jpeg_decoder::PixelFormat::L8 => px.iter().flat_map(|&v| [v, v, v]).collect(),
            jpeg_decoder::PixelFormat::CMYK32 => px
                .chunks_exact(4)
                .flat_map(|p| {
                    let k = 255 - p[3] as u32;
                    [0, 1, 2].map(|c| ((255 - p[c] as u32) * k / 255) as u8)
                })
                .collect(),
            jpeg_decoder::PixelFormat::L16 => px.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0]]).collect(),
        };
        return RgbImage::from_raw(w, h, rgb).context("jpeg buffer");
    }
    let img = image::load_from_memory(bytes)?;
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

/// One float plane per channel at a fixed size.
struct Planes {
    w: usize,
    h: usize,
    c: [Vec<f32>; 3],
}

impl Planes {
    fn of(img: &RgbImage, w: usize, h: usize) -> Self {
        let small = imageops::resize(img, w as u32, h as u32, FilterType::Triangle);
        let mut c: [Vec<f32>; 3] = [vec![0.0; w * h], vec![0.0; w * h], vec![0.0; w * h]];
        for (i, p) in small.pixels().enumerate() {
            for k in 0..3 {
                c[k][i] = p[k] as f32;
            }
        }
        Planes { w, h, c }
    }
    fn gray(&self) -> Vec<f32> {
        (0..self.w * self.h).map(|i| 0.299 * self.c[0][i] + 0.587 * self.c[1][i] + 0.114 * self.c[2][i]).collect()
    }
}

fn rect(r: (f32, f32, f32, f32), w: usize, h: usize) -> (usize, usize, usize, usize) {
    ((r.0 * w as f32) as usize, (r.1 * w as f32) as usize, (r.2 * h as f32) as usize, (r.3 * h as f32) as usize)
}

fn box_blur(g: &[f32], w: usize, h: usize, rad: usize) -> Vec<f32> {
    // Integral image.
    let mut ii = vec![0.0f64; (w + 1) * (h + 1)];
    for y in 0..h {
        let mut row = 0.0f64;
        for x in 0..w {
            row += g[y * w + x] as f64;
            ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
        }
    }
    let mut out = vec![0.0; w * h];
    for y in 0..h {
        let (y0, y1) = (y.saturating_sub(rad), (y + rad + 1).min(h));
        for x in 0..w {
            let (x0, x1) = (x.saturating_sub(rad), (x + rad + 1).min(w));
            let s = ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
            out[y * w + x] = (s / ((y1 - y0) * (x1 - x0)) as f64) as f32;
        }
    }
    out
}

fn sample(g: &[f32], w: usize, h: usize, x: f32, y: f32) -> f32 {
    let x = x.clamp(0.0, (w - 1) as f32 - 0.001);
    let y = y.clamp(0.0, (h - 1) as f32 - 0.001);
    let (x0, y0) = (x as usize, y as usize);
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    let a = g[y0 * w + x0] * (1.0 - fx) + g[y0 * w + x0 + 1] * fx;
    let b = g[(y0 + 1) * w + x0] * (1.0 - fx) + g[(y0 + 1) * w + x0 + 1] * fx;
    a * (1.0 - fy) + b * fy
}

#[derive(Clone, Copy)]
struct Xf {
    s: f32,
    dx: f32,
    dy: f32,
}

/// `g` resampled into the other image's coordinates (shift in pixels of this grid).
fn warp(g: &[f32], w: usize, h: usize, t: Xf) -> Vec<f32> {
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    let mut out = vec![0.0; w * h];
    for y in 0..h {
        for x in 0..w {
            out[y * w + x] = sample(g, w, h, (x as f32 - cx - t.dx) / t.s + cx, (y as f32 - cy - t.dy) / t.s + cy);
        }
    }
    out
}

/// Pearson correlation over a fractional rectangle.
fn ncc(a: &[f32], b: &[f32], w: usize, h: usize, r: (f32, f32, f32, f32)) -> f32 {
    let (x0, x1, y0, y1) = rect(r, w, h);
    let (mut n, mut sa, mut sb, mut saa, mut sbb, mut sab) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for y in y0..y1 {
        for x in x0..x1 {
            let (p, q) = (a[y * w + x] as f64, b[y * w + x] as f64);
            n += 1.0;
            sa += p;
            sb += q;
            saa += p * p;
            sbb += q * q;
            sab += p * q;
        }
    }
    let cov = sab - sa * sb / n;
    let (va, vb) = (saa - sa * sa / n, sbb - sb * sb / n);
    if va <= 1e-6 || vb <= 1e-6 {
        return 0.0;
    }
    (cov / (va * vb).sqrt()) as f32
}

/// Shift/scale that best maps the reference onto our scan (hd-scan-upgrade search).
fn best_xf(cur: &[f32], refg: &[f32]) -> (Xf, f32) {
    let mut best = (Xf { s: 1.0, dx: 0.0, dy: 0.0 }, -2.0);
    for s in [0.94f32, 0.96, 0.98, 1.0, 1.02, 1.04, 1.06] {
        for dy in -4..=4 {
            for dx in -4..=4 {
                let t = Xf { s, dx: dx as f32, dy: dy as f32 };
                let v = ncc(cur, &warp(refg, W, H, t), W, H, INNER);
                if v > best.1 {
                    best = (t, v);
                }
            }
        }
    }
    let c = best.0;
    for ds in [-0.01f32, 0.0, 0.01] {
        for dy in [-0.5f32, 0.0, 0.5] {
            for dx in [-0.5f32, 0.0, 0.5] {
                let t = Xf { s: c.s + ds, dx: c.dx + dx, dy: c.dy + dy };
                let v = ncc(cur, &warp(refg, W, H, t), W, H, INNER);
                if v > best.1 {
                    best = (t, v);
                }
            }
        }
    }
    best
}

fn blur3(g: &[f32]) -> Vec<f32> {
    box_blur(g, W, H, 1)
}

/// Mean absolute high-pass (pixel minus its 5x5 mean) over a region, all channels.
fn grain(p: &[Vec<f32>; 3], w: usize, h: usize, r: (f32, f32, f32, f32)) -> f32 {
    let (x0, x1, y0, y1) = rect(r, w, h);
    let mut s = 0.0f64;
    let mut n = 0.0f64;
    for ch in p {
        let b = box_blur(ch, w, h, 2);
        for y in y0..y1 {
            for x in x0..x1 {
                s += (ch[y * w + x] - b[y * w + x]).abs() as f64;
                n += 1.0;
            }
        }
    }
    (s / n.max(1.0)) as f32
}

/// Mean absolute colour difference over a region after removing each image's mean colour.
fn colour_diff(a: &[Vec<f32>; 3], b: &[Vec<f32>; 3], w: usize, h: usize, r: (f32, f32, f32, f32)) -> f32 {
    let (x0, x1, y0, y1) = rect(INNER, w, h);
    let mean = |p: &Vec<f32>| {
        let mut s = 0.0f64;
        for y in y0..y1 {
            for x in x0..x1 {
                s += p[y * w + x] as f64;
            }
        }
        (s / ((x1 - x0) * (y1 - y0)) as f64) as f32
    };
    let (rx0, rx1, ry0, ry1) = rect(r, w, h);
    let mut s = 0.0f64;
    let mut n = 0.0f64;
    for k in 0..3 {
        let (ma, mb) = (mean(&a[k]), mean(&b[k]));
        for y in ry0..ry1 {
            for x in rx0..rx1 {
                s += ((a[k][y * w + x] - ma) - (b[k][y * w + x] - mb)).abs() as f64;
                n += 1.0;
            }
        }
    }
    (s / n.max(1.0)) as f32
}

fn zscore(a: &[f32]) -> Vec<f32> {
    let n = a.len() as f32;
    let m = a.iter().sum::<f32>() / n;
    let sd = (a.iter().map(|v| (v - m) * (v - m)).sum::<f32>() / n).sqrt().max(1.0);
    a.iter().map(|v| (v - m) / sd).collect()
}

fn mean_abs(a: &[f32], b: &[f32], w: usize, h: usize, r: (f32, f32, f32, f32)) -> f32 {
    let (x0, x1, y0, y1) = rect(r, w, h);
    let mut s = 0.0f32;
    let mut n = 0.0f32;
    for y in y0..y1 {
        for x in x0..x1 {
            s += (a[y * w + x] - b[y * w + x]).abs();
            n += 1.0;
        }
    }
    s / n.max(1.0)
}

struct Feats {
    ncc: f32,
    s_text: f32,
    a_art: f32,
    d_text: f32,
    d_art: f32,
    stamp: f32,
    /// Text-box grain of each image on its own (foil glitter vs flat print).
    g_cand: f32,
    g_ref: f32,
}

fn features(cand: &RgbImage, refimg: &RgbImage) -> Feats {
    let (pc, pr) = (Planes::of(cand, W, H), Planes::of(refimg, W, H));
    let (gc, gr) = (blur3(&pc.gray()), blur3(&pr.gray()));
    let (t, full) = best_xf(&gc, &gr);
    // Texture grid: our scan as is, the reference warped with the same transform at 2x.
    let tc = Planes::of(cand, TW, TH);
    let tr0 = Planes::of(refimg, TW, TH);
    let t2 = Xf { s: t.s, dx: t.dx * 2.0, dy: t.dy * 2.0 };
    let tr: [Vec<f32>; 3] = std::array::from_fn(|k| warp(&tr0.c[k], TW, TH, t2));
    let g = |p: &[Vec<f32>; 3], r| grain(p, TW, TH, r).max(0.25);
    let s_text = (g(&tc.c, TEXT) / g(&tr, TEXT)).ln() - (g(&tc.c, ART) / g(&tr, ART)).ln();
    let a_art = (g(&tc.c, ART) / g(&tr, ART)).ln() - (g(&tc.c, INNER) / g(&tr, INNER)).ln();
    let gray = |p: &[Vec<f32>; 3]| -> Vec<f32> {
        (0..TW * TH).map(|i| 0.299 * p[0][i] + 0.587 * p[1][i] + 0.114 * p[2][i]).collect()
    };
    let (zc, zr) = (zscore(&gray(&tc.c)), zscore(&gray(&tr)));
    let stamp = mean_abs(&zc, &zr, TW, TH, STAMP_EX) - mean_abs(&zc, &zr, TW, TH, ART);
    Feats {
        ncc: full,
        s_text,
        a_art,
        d_text: colour_diff(&tc.c, &tr, TW, TH, TEXT),
        d_art: colour_diff(&tc.c, &tr, TW, TH, ART),
        stamp,
        g_cand: g(&tc.c, TEXT),
        g_ref: g(&tr, TEXT),
    }
}

fn content_hash(path: &Path) -> Option<(u64, u64)> {
    let mut bytes = Vec::new();
    File::open(path).ok()?.read_to_end(&mut bytes).ok()?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    Some((h.finish(), bytes.len() as u64))
}

// ---------------------------------------------------------------- scan

fn scan(f: &Flags) -> Result<()> {
    let rows = read_catalog(f.get("catalog")?)?;
    let only = read_ids(f.opt("ids"))?;
    let tcgdex = load_tcgdex_en(Path::new(f.get("tcgdex-root")?))?;
    let mut sources: Vec<(String, HashMap<u64, Vec<PathBuf>>)> = Vec::new();
    for spec in f.get("sources")?.split(',') {
        let (name, dir) = spec.split_once('=').context("--sources name=dir,...")?;
        let idx = index_masters(Path::new(dir))?;
        eprintln!("source {name}: {} ids", idx.len());
        sources.push((name.to_owned(), idx));
    }
    let work: Vec<(&Row, &PathBuf)> = rows
        .iter()
        .filter(|r| r.nationality == "western" && only.as_ref().map_or(true, |s| s.contains(&r.ct_id)))
        .filter_map(|r| tcgdex.get(&(fold_set(&r.official_id), fold_num(&r.card_number))).map(|p| (r, p)))
        .collect();
    eprintln!("rows with a tcgdex en reference: {}", work.len());
    let done = AtomicUsize::new(0);
    let lines: Vec<String> = work
        .par_iter()
        .flat_map_iter(|(r, refpath)| {
            let n = done.fetch_add(1, Ordering::Relaxed);
            if n % 2000 == 0 {
                eprintln!("{n}/{}", work.len());
            }
            // Distinct scans of this printing across the stores.
            let mut uniq: Vec<((u64, u64), Vec<String>, PathBuf)> = Vec::new();
            for (name, idx) in &sources {
                for p in idx.get(&r.ct_id).into_iter().flatten() {
                    let Some(hash) = content_hash(p) else { continue };
                    if let Some(u) = uniq.iter_mut().find(|u| u.0 == hash) {
                        u.1.push(name.clone());
                    } else {
                        uniq.push((hash, vec![name.clone()], p.clone()));
                    }
                }
            }
            let refimg = match load_rgb(refpath) {
                Ok(i) => i,
                Err(e) => {
                    eprintln!("ref {}: {e:#}", refpath.display());
                    return Vec::new().into_iter();
                }
            };
            let mut out = Vec::new();
            for (_, names, path) in uniq {
                let Ok(cand) = load_rgb(&path) else { continue };
                let m = features(&cand, &refimg);
                out.push(format!(
                    "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{:.4}\t{:.3}\t{:.3}\t{:.2}\t{:.2}\t{:.3}\t{}",
                    r.ct_id,
                    r.card_id,
                    r.name,
                    r.card_number,
                    r.expansion,
                    r.official_id,
                    names.join("+"),
                    cand.width(),
                    cand.height(),
                    path.display(),
                    m.ncc,
                    m.s_text,
                    m.a_art,
                    m.d_text,
                    m.d_art,
                    m.stamp,
                    refpath.display()
                ));
            }
            out.into_iter()
        })
        .collect();
    let mut w = BufWriter::new(File::create(f.get("out")?)?);
    writeln!(w, "ct_id\tcard_id\tname\tcard_number\texpansion\tofficial_id\tsources\tw\th\tpath\tncc\ts_text\ta_art\td_text\td_art\tstamp\tref")?;
    for l in &lines {
        writeln!(w, "{l}")?;
    }
    eprintln!("wrote {} scans", lines.len());
    Ok(())
}

// ---------------------------------------------------------------- sheet

fn sheet(f: &Flags) -> Result<()> {
    let out = PathBuf::from(f.get("out")?);
    std::fs::create_dir_all(&out)?;
    let key = f.opt("key").unwrap_or("s_text");
    let top: usize = f.opt("top").and_then(|v| v.parse().ok()).unwrap_or(300);
    let per: usize = f.opt("per").and_then(|v| v.parse().ok()).unwrap_or(30);
    let min_ncc: f32 = f.opt("min-ncc").and_then(|v| v.parse().ok()).unwrap_or(0.5);
    let only = read_ids(f.opt("ids"))?;
    let mut lines = BufReader::new(File::open(f.get("feats")?)?).lines();
    let header: Vec<String> = lines.next().context("empty feats")??.split('\t').map(str::to_owned).collect();
    let col = |name: &str| header.iter().position(|h| h == name).with_context(|| format!("no column {name}"));
    let (ck, cn, cid, cpath, cref) = (col(key)?, col("ncc")?, col("ct_id")?, col("path")?, col("ref")?);
    let mut rows: Vec<Vec<String>> = Vec::new();
    for l in lines {
        let c: Vec<String> = l?.split('\t').map(str::to_owned).collect();
        if c.len() != header.len() {
            continue;
        }
        let id: u64 = c[cid].parse().unwrap_or(0);
        if only.as_ref().map_or(false, |s| !s.contains(&id)) {
            continue;
        }
        if c[cn].parse::<f32>().unwrap_or(0.0) < min_ncc {
            continue; // misaligned or another card: not a variant question
        }
        rows.push(c);
    }
    rows.sort_by(|a, b| b[ck].parse::<f32>().unwrap_or(0.0).total_cmp(&a[ck].parse::<f32>().unwrap_or(0.0)));
    rows.truncate(top);
    let (iw, ih) = (180u32, 251u32);
    let (cw, chh, cols) = (iw * 2 + 18, ih + 30, 5u32);
    let mut index = BufWriter::new(File::create(out.join("index.tsv"))?);
    writeln!(index, "cell\t{}", header.join("\t"))?;
    for (si, chunk) in rows.chunks(per).enumerate() {
        let nrows = (chunk.len() as u32).div_ceil(cols);
        let mut img = RgbaImage::from_pixel(cw * cols, chh * nrows, Rgba([24, 24, 28, 255]));
        let tiles: Vec<Option<(RgbImage, RgbImage)>> = chunk
            .par_iter()
            .map(|c| {
                let a = load_rgb(Path::new(&c[cref])).ok()?;
                let b = load_rgb(Path::new(&c[cpath])).ok()?;
                Some((
                    imageops::resize(&a, iw, ih, FilterType::Triangle),
                    imageops::resize(&b, iw, ih, FilterType::Triangle),
                ))
            })
            .collect();
        for (i, (c, t)) in chunk.iter().zip(tiles).enumerate() {
            let cell = si * per + i;
            writeln!(index, "{cell}\t{}", c.join("\t"))?;
            let (x, y) = ((i as u32 % cols) * cw, (i as u32 / cols) * chh);
            font::draw_number(&mut img, cell, x + 6, y + 6, 3, Rgba([255, 214, 64, 255]));
            if let Some((a, b)) = t {
                for (dx, part) in [(6u32, a), (iw + 12, b)] {
                    for (px, py, p) in part.enumerate_pixels() {
                        img.put_pixel(x + dx + px, y + 26 + py, Rgba([p[0], p[1], p[2], 255]));
                    }
                }
            }
        }
        let path = out.join(format!("sheet-{si:03}.jpg"));
        image::DynamicImage::ImageRgba8(img).to_rgb8().save(&path)?;
    }
    eprintln!("{} cells in {}", rows.len(), out.display());
    Ok(())
}

// ---------------------------------------------------------------- compare / encode

fn read_table(path: &str) -> Result<(Vec<String>, Vec<Vec<String>>)> {
    let mut lines = BufReader::new(File::open(path)?).lines();
    let header: Vec<String> = lines.next().context("empty table")??.split('\t').map(str::to_owned).collect();
    let mut rows = Vec::new();
    for l in lines {
        let c: Vec<String> = l?.split('\t').map(str::to_owned).collect();
        if c.len() == header.len() {
            rows.push(c);
        }
    }
    Ok((header, rows))
}

fn column(header: &[String], name: &str) -> Result<usize> {
    header.iter().position(|h| h == name).with_context(|| format!("no column {name}"))
}

fn compare(f: &Flags) -> Result<()> {
    let (header, rows) = read_table(f.get("pairs")?)?;
    let (cpath, cref) = (column(&header, "path")?, column(&header, "ref")?);
    let lines: Vec<String> = rows
        .par_iter()
        .filter_map(|c| {
            let cand = load_rgb(Path::new(&c[cpath])).map_err(|e| eprintln!("{e:#}")).ok()?;
            let refimg = load_rgb(Path::new(&c[cref])).map_err(|e| eprintln!("{e:#}")).ok()?;
            let m = features(&cand, &refimg);
            Some(format!(
                "{}\t{}\t{}\t{:.4}\t{:.3}\t{:.3}\t{:.2}\t{:.2}\t{:.3}\t{:.2}\t{:.2}",
                c.join("\t"),
                cand.width(),
                cand.height(),
                m.ncc,
                m.s_text,
                m.a_art,
                m.d_text,
                m.d_art,
                m.stamp,
                m.g_cand,
                m.g_ref
            ))
        })
        .collect();
    let mut w = BufWriter::new(File::create(f.get("out")?)?);
    writeln!(w, "{}\tw\th\tncc\ts_text\ta_art\td_text\td_art\tstamp\tg_path\tg_ref", header.join("\t"))?;
    for l in &lines {
        writeln!(w, "{l}")?;
    }
    eprintln!("compared {} of {} pairs", lines.len(), rows.len());
    Ok(())
}

/// The card at exactly 63:88 at its own height (as hd-scan-upgrade encodes).
fn to_card_shape(img: &RgbImage) -> RgbImage {
    let (w, h) = img.dimensions();
    let want_w = ((h as f64) * 63.0 / 88.0).round() as u32;
    if want_w == w {
        img.clone()
    } else {
        imageops::resize(img, want_w, h, FilterType::Lanczos3)
    }
}

fn encode(f: &Flags) -> Result<()> {
    let (header, rows) = read_table(f.get("pairs")?)?;
    let (cpath, cfile) = (column(&header, "path")?, column(&header, "file")?);
    let out = PathBuf::from(f.get("out")?);
    std::fs::create_dir_all(&out)?;
    let failed = AtomicUsize::new(0);
    rows.par_iter().for_each(|c| {
        let file = &c[cfile];
        let ok = (|| -> Result<()> {
            if file.contains('/') || !file.ends_with(".jpg") {
                bail!("bad file name {file}");
            }
            let img = to_card_shape(&load_rgb(Path::new(&c[cpath]))?);
            let mut buf = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 92).encode_image(&img)?;
            std::fs::write(out.join(file), buf)?;
            Ok(())
        })();
        if let Err(e) = ok {
            eprintln!("{file}: {e:#}");
            failed.fetch_add(1, Ordering::Relaxed);
        }
    });
    let failed = failed.into_inner();
    eprintln!("encoded {} files, {failed} failed", rows.len() - failed);
    if failed > 0 {
        bail!("{failed} files failed");
    }
    Ok(())
}
