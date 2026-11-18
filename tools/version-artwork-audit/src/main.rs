//! Audit CLIP version sets for members whose leftover artwork is a different painting.
//!
//! A version set (`pokoin_version_sets`, `marketplace_search_candidates.version`) should hold
//! printings of ONE illustration: reprints, stamps, languages, reverse/holo patterns. The CLIP
//! clusterer (pokemon-card-extension `cluster-name-version-sets.py`) sometimes joins two
//! different paintings of the same Pokémon (Pikachu BW54 thunder art + BREAKthrough 48/162
//! forest art: CLIP 0.909, pixels 0.614). This tool re-checks every group with an aligned
//! pixel comparison of the clustering window (0.16 / 0.155 / 0.84 / 0.50 of the leftover JPEG,
//! normalised to 63:88), then renders contact sheets for a human to classify.
//!
//!   version-artwork-audit features --members members.tsv --objects DIR --out feats.bin
//!   version-artwork-audit score --members members.tsv --feats feats.bin --out-dir run/ [--threshold 0.45]
//!   version-artwork-audit sheet --groups run/flagged.tsv --members members.tsv --objects DIR --out-dir sheets/
//!   version-artwork-audit match --cards ids.txt --pool pool.tsv --feats feats.bin --out match.tsv
//!
//! Members TSV columns (header names): version, source, card_id, ct_id, name, expansion_name,
//! card_number, image_url, item_kind. Extra columns are ignored.

use ab_glyph::{Font, FontVec, PxScale, ScaleFont};
use anyhow::{anyhow, bail, Context, Result};
use image::{imageops, imageops::FilterType, Rgb, RgbImage};
use rayon::prelude::*;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

/// Normalised card (63:88).
const W: usize = 108;
const H: usize = 151;
/// Clustering window of cluster-name-version-sets.PIXEL_BOX (left, top, right, bottom).
const WINDOW: (f32, f32, f32, f32) = (0.16, 0.155, 0.84, 0.50);
const TILE_COLS: usize = 4;
const TILE_ROWS: usize = 3;
/// CardTrader `card_uploader` back and the Pokoin missing-card stamp.
const PLACEHOLDER_SIZES: [(u32, u32); 2] = [(186, 260), (630, 880)];

const FLAG_LANDSCAPE: u8 = 1;
const FLAG_PLACEHOLDER: u8 = 2;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first() else {
        bail!("usage: version-artwork-audit features|score|sheet|match ...");
    };
    let flags = Flags::parse(&args[1..])?;
    match cmd.as_str() {
        "features" => features(&flags),
        "score" => score(&flags),
        "sheet" => sheet(&flags),
        "match" => match_cards(&flags),
        "regroup" => regroup(&flags),
        "sql" => write_sql(&flags),
        other => bail!("unknown command {other}"),
    }
}

struct Flags(HashMap<String, Vec<String>>);

impl Flags {
    fn parse(args: &[String]) -> Result<Self> {
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        let mut it = args.iter();
        while let Some(key) = it.next() {
            let key = key.strip_prefix("--").ok_or_else(|| anyhow!("expected --flag, got {key}"))?;
            let value = it.next().ok_or_else(|| anyhow!("--{key} needs a value"))?;
            map.entry(key.to_string()).or_default().push(value.clone());
        }
        Ok(Flags(map))
    }
    fn get(&self, key: &str) -> Result<&str> {
        self.0.get(key).and_then(|v| v.last()).map(|s| s.as_str()).ok_or_else(|| anyhow!("missing --{key}"))
    }
    fn all(&self, key: &str) -> Vec<String> {
        self.0.get(key).cloned().unwrap_or_default()
    }
    fn f32_or(&self, key: &str, default: f32) -> Result<f32> {
        self.0.get(key).and_then(|v| v.last()).map(|s| s.parse::<f32>()).transpose()?.map_or(Ok(default), Ok)
    }
}

#[derive(Clone, Debug)]
struct Member {
    version: String,
    source: String,
    card_id: u64,
    ct_id: u64,
    name: String,
    expansion: String,
    number: String,
    image: String,
    single: bool,
}

fn read_members(path: &str) -> Result<Vec<Member>> {
    let mut rdr = csv::ReaderBuilder::new().delimiter(b'\t').flexible(true).from_path(path).with_context(|| path.to_string())?;
    let headers = rdr.headers()?.clone();
    let col = |names: &[&str]| headers.iter().position(|h| names.contains(&h));
    let need = |names: &[&str]| col(names).ok_or_else(|| anyhow!("{path}: no column {names:?}"));
    let c_card = need(&["card_id"])?;
    let c_image = need(&["image_url", "coalesce"])?;
    let (c_version, c_source, c_ct, c_name, c_exp, c_num, c_kind) = (
        col(&["version"]),
        col(&["source"]),
        col(&["ct_id"]),
        col(&["name"]),
        col(&["expansion_name"]),
        col(&["card_number"]),
        col(&["item_kind"]),
    );
    let mut out = Vec::new();
    for rec in rdr.records() {
        let rec = rec?;
        let get = |c: Option<usize>| c.and_then(|i| rec.get(i)).unwrap_or("").to_string();
        out.push(Member {
            version: get(c_version),
            source: get(c_source),
            card_id: rec.get(c_card).unwrap_or("0").parse()?,
            ct_id: get(c_ct).parse().unwrap_or(0),
            name: get(c_name),
            expansion: get(c_exp),
            number: get(c_num),
            image: rec.get(c_image).unwrap_or("").to_string(),
            single: c_kind.map_or(true, |_| get(c_kind) == "single"),
        });
    }
    Ok(out)
}

/// `https://cdn.pokoin.com/110706_pikachu-48-162-breakthrough.jpg?v=x` → leftover file name.
fn image_basename(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let base = path.rsplit('/').next()?;
    (!base.is_empty()).then(|| base.to_string())
}

/// Every non-homepage leftover JPEG per ct_id, for rows whose image_url is not a leftover key.
fn leftover_index(dirs: &[PathBuf]) -> HashMap<u64, Vec<PathBuf>> {
    let mut out: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.contains("_homepage") || !name.ends_with(".jpg") {
                continue;
            }
            if let Some((id, _)) = name.split_once('_') {
                if let Ok(id) = id.parse::<u64>() {
                    out.entry(id).or_default().push(entry.path());
                }
            }
        }
    }
    out
}

fn resolve(m: &Member, dirs: &[PathBuf], index: &std::sync::OnceLock<HashMap<u64, Vec<PathBuf>>>) -> Option<PathBuf> {
    if let Some(base) = image_basename(&m.image) {
        for dir in dirs {
            let p = dir.join(&base);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let hits = index.get_or_init(|| leftover_index(dirs)).get(&m.ct_id)?;
    // Same preference as the clusterer: the collector slug over generic `full-v4`.
    let num: String = m.number.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase();
    hits.iter()
        .max_by_key(|p| {
            let n = p.file_name().unwrap().to_string_lossy().to_lowercase().replace('-', "");
            ((!num.is_empty() && n.contains(&num)) as i32, -(n.len() as i32))
        })
        .cloned()
}

/// JPEGs go through jpeg-decoder: zune-jpeg (image 0.25) decodes the 2026-10-19 HD leftovers
/// (JFIF, component ids 0/1/2, e.g. 135933 Sandshrew 52/100) as green noise; libjpeg and
/// browsers read them as YCbCr.
fn load_jpeg(bytes: &[u8]) -> Result<RgbImage> {
    let mut dec = jpeg_decoder::Decoder::new(bytes);
    let px = dec.decode()?;
    let info = dec.info().ok_or_else(|| anyhow!("jpeg without header"))?;
    let (w, h) = (info.width as u32, info.height as u32);
    let rgb: Vec<u8> = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => px,
        jpeg_decoder::PixelFormat::L8 => px.iter().flat_map(|&v| [v, v, v]).collect(),
        jpeg_decoder::PixelFormat::L16 => px.chunks(2).flat_map(|c| [c[0], c[0], c[0]]).collect(),
        jpeg_decoder::PixelFormat::CMYK32 => px
            .chunks(4)
            .flat_map(|c| {
                let k = 255 - c[3] as u16;
                [c[0], c[1], c[2]].map(|v| ((255 - v as u16) * k / 255) as u8)
            })
            .collect(),
    };
    RgbImage::from_raw(w, h, rgb).ok_or_else(|| anyhow!("jpeg size mismatch"))
}

fn load_rgb(path: &Path) -> Result<RgbImage> {
    let bytes = std::fs::read(path)?;
    if bytes.starts_with(&[0xFF, 0xD8]) {
        return load_jpeg(&bytes);
    }
    let img = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()?.decode()?;
    Ok(if img.color().has_alpha() {
        let rgba = img.to_rgba8();
        RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
            let p = rgba.get_pixel(x, y);
            let a = p[3] as f32 / 255.0;
            Rgb(std::array::from_fn(|c| (p[c] as f32 * a + 255.0 * (1.0 - a)).round() as u8))
        })
    } else {
        img.to_rgb8()
    })
}

struct Feat {
    flags: u8,
    gray: Vec<u8>,
}

fn feature_of(path: &Path) -> Result<Feat> {
    let rgb = load_rgb(path)?;
    let (w, h) = rgb.dimensions();
    let mut flags = 0;
    if PLACEHOLDER_SIZES.contains(&(w, h)) {
        flags |= FLAG_PLACEHOLDER;
    }
    if w > h {
        flags |= FLAG_LANDSCAPE;
    }
    let small = imageops::resize(&rgb, W as u32, H as u32, FilterType::Triangle);
    let gray = small
        .pixels()
        .map(|p| (0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32).round().clamp(0.0, 255.0) as u8)
        .collect();
    Ok(Feat { flags, gray })
}

fn features(f: &Flags) -> Result<()> {
    let members = read_members(f.get("members")?)?;
    let dirs: Vec<PathBuf> = f.all("objects").into_iter().map(PathBuf::from).collect();
    let out = f.get("out")?;
    let mut seen = HashSet::new();
    let todo: Vec<&Member> = members.iter().filter(|m| seen.insert(m.card_id)).collect();
    let index = std::sync::OnceLock::new();
    let done = std::sync::atomic::AtomicUsize::new(0);
    let feats: Vec<(u64, Result<Feat>, String)> = todo
        .par_iter()
        .map(|m| {
            let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if n % 5000 == 0 {
                eprintln!("features {n}/{}", todo.len());
            }
            match resolve(m, &dirs, &index) {
                Some(p) => (m.card_id, feature_of(&p), p.file_name().unwrap().to_string_lossy().to_string()),
                None => (m.card_id, Err(anyhow!("no leftover for {}", m.image)), String::new()),
            }
        })
        .collect();
    let mut w = BufWriter::new(File::create(out)?);
    w.write_all(b"VAF1")?;
    w.write_all(&(W as u32).to_le_bytes())?;
    w.write_all(&(H as u32).to_le_bytes())?;
    let mut missing = BufWriter::new(File::create(format!("{out}.missing.tsv"))?);
    let mut files = BufWriter::new(File::create(format!("{out}.files.tsv"))?);
    let (mut ok, mut bad) = (0, 0);
    for (id, feat, file) in feats {
        match feat {
            Ok(feat) => {
                w.write_all(&id.to_le_bytes())?;
                w.write_all(&[feat.flags])?;
                w.write_all(&feat.gray)?;
                writeln!(files, "{id}\t{file}")?;
                ok += 1;
            }
            Err(e) => {
                writeln!(missing, "{id}\t{e}")?;
                bad += 1;
            }
        }
    }
    eprintln!("features ok {ok}, missing {bad}");
    Ok(())
}

fn read_feats(path: &str) -> Result<HashMap<u64, Feat>> {
    let mut r = BufReader::new(File::open(path).with_context(|| path.to_string())?);
    let mut head = [0u8; 12];
    r.read_exact(&mut head)?;
    if &head[..4] != b"VAF1" || u32::from_le_bytes(head[4..8].try_into()?) as usize != W {
        bail!("{path}: not a VAF1 {W}x{H} feature file");
    }
    let mut out = HashMap::new();
    let mut id = [0u8; 8];
    loop {
        if r.read_exact(&mut id).is_err() {
            break;
        }
        let mut flag = [0u8; 1];
        r.read_exact(&mut flag)?;
        let mut gray = vec![0u8; W * H];
        r.read_exact(&mut gray)?;
        out.insert(u64::from_le_bytes(id), Feat { flags: flag[0], gray });
    }
    Ok(out)
}

/// Two 3x3 box passes (≈ Gaussian σ 1): halftone, scan noise and holo sparkle are not a painting.
fn blurred(gray: &[u8]) -> Vec<f32> {
    let mut a: Vec<f32> = gray.iter().map(|&v| v as f32).collect();
    for _ in 0..2 {
        let src = a.clone();
        for y in 0..H {
            for x in 0..W {
                let mut s = 0.0;
                let mut n = 0.0;
                for dy in -1i32..=1 {
                    for dx in -1i32..=1 {
                        let (xx, yy) = (x as i32 + dx, y as i32 + dy);
                        if xx >= 0 && yy >= 0 && (xx as usize) < W && (yy as usize) < H {
                            s += src[yy as usize * W + xx as usize];
                            n += 1.0;
                        }
                    }
                }
                a[y * W + x] = s / n;
            }
        }
    }
    a
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

struct Window {
    x0: usize,
    x1: usize,
    y0: usize,
    y1: usize,
    cx: f32,
    cy: f32,
}

fn window() -> Window {
    let (x0, x1) = ((WINDOW.0 * W as f32).round() as usize, (WINDOW.2 * W as f32).round() as usize);
    let (y0, y1) = ((WINDOW.1 * H as f32).round() as usize, (WINDOW.3 * H as f32).round() as usize);
    Window { x0, x1, y0, y1, cx: (x0 + x1) as f32 / 2.0, cy: (y0 + y1) as f32 / 2.0 }
}

#[derive(Clone, Copy, Default)]
struct Xf {
    s: f32,
    dx: f32,
    dy: f32,
}

/// `b` resampled into `a`'s window: scale about the window centre, then shift.
fn warp_window(b: &[f32], win: &Window, t: Xf) -> Vec<f32> {
    let mut out = Vec::with_capacity((win.x1 - win.x0) * (win.y1 - win.y0));
    for y in win.y0..win.y1 {
        for x in win.x0..win.x1 {
            let sx = (x as f32 - win.cx - t.dx) / t.s + win.cx;
            let sy = (y as f32 - win.cy - t.dy) / t.s + win.cy;
            out.push(sample(b, sx, sy));
        }
    }
    out
}

fn crop_window(a: &[f32], win: &Window) -> Vec<f32> {
    let mut out = Vec::with_capacity((win.x1 - win.x0) * (win.y1 - win.y0));
    for y in win.y0..win.y1 {
        out.extend_from_slice(&a[y * W + win.x0..y * W + win.x1]);
    }
    out
}

fn ncc_iter(pairs: impl Iterator<Item = (f32, f32)>) -> f32 {
    let (mut n, mut sa, mut sb, mut saa, mut sbb, mut sab) = (0.0f64, 0.0f64, 0.0, 0.0, 0.0, 0.0);
    for (p, q) in pairs {
        let (p, q) = (p as f64, q as f64);
        n += 1.0;
        sa += p;
        sb += q;
        saa += p * p;
        sbb += q * q;
        sab += p * q;
    }
    if n < 2.0 {
        return 0.0;
    }
    let cov = sab - sa * sb / n;
    let va = saa - sa * sa / n;
    let vb = sbb - sb * sb / n;
    if va <= 1e-6 || vb <= 1e-6 {
        return 0.0;
    }
    (cov / (va * vb).sqrt()) as f32
}

#[derive(Clone, Copy, Default)]
struct Metrics {
    whole: f32,
    tile_med: f32,
    grad: f32,
    t: Xf,
}

impl Metrics {
    /// The whole-window correlation is fooled by layout: two yellow Pikachu in the same spot of
    /// a green background score 0.63 (BW54 vs BREAKthrough 48/162). The median of 4x3 tile
    /// correlations is not (0.27 there, 0.99 for the stamped BW-P 163): a stamp or holo pattern
    /// spoils a few tiles, a different painting spoils most of them.
    fn score(&self) -> f32 {
        pair_score(self.whole, self.tile_med, self.grad)
    }
}

fn pair_score(_whole: f32, tile_med: f32, grad: f32) -> f32 {
    0.5 * (tile_med + grad)
}

fn gradient_mag(v: &[f32], w: usize, h: usize) -> Vec<f32> {
    let mut out = vec![0.0; w * h];
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let gx = v[y * w + x + 1] - v[y * w + x - 1];
            let gy = v[(y + 1) * w + x] - v[(y - 1) * w + x];
            out[y * w + x] = (gx * gx + gy * gy).sqrt();
        }
    }
    out
}

fn compare(a: &[f32], b: &[f32], win: &Window) -> Metrics {
    let ref_win = crop_window(a, win);
    let eval = |t: Xf| ncc_iter(ref_win.iter().copied().zip(warp_window(b, win, t)));
    let mut best = (Xf { s: 1.0, dx: 0.0, dy: 0.0 }, -2.0f32);
    // EN vs JP frames and scan borders move / scale the art box by a few percent.
    for si in 0..9 {
        let s = 0.92 + 0.02 * si as f32;
        for dy in (-6..=6).step_by(2) {
            for dx in (-6..=6).step_by(2) {
                let t = Xf { s, dx: dx as f32, dy: dy as f32 };
                let v = eval(t);
                if v > best.1 {
                    best = (t, v);
                }
            }
        }
    }
    let c = best.0;
    for ds in [-0.01f32, 0.0, 0.01] {
        for dy in [-1.0f32, 0.0, 1.0] {
            for dx in [-1.0f32, 0.0, 1.0] {
                let t = Xf { s: c.s + ds, dx: c.dx + dx, dy: c.dy + dy };
                let v = eval(t);
                if v > best.1 {
                    best = (t, v);
                }
            }
        }
    }
    let warped = warp_window(b, win, best.0);
    let (ww, wh) = (win.x1 - win.x0, win.y1 - win.y0);
    let mut tiles = Vec::with_capacity(TILE_COLS * TILE_ROWS);
    for ty in 0..TILE_ROWS {
        for tx in 0..TILE_COLS {
            let (x0, x1) = (ww * tx / TILE_COLS, ww * (tx + 1) / TILE_COLS);
            let (y0, y1) = (wh * ty / TILE_ROWS, wh * (ty + 1) / TILE_ROWS);
            let idx = (y0..y1).flat_map(|y| (x0..x1).map(move |x| y * ww + x));
            tiles.push(ncc_iter(idx.map(|i| (ref_win[i], warped[i]))));
        }
    }
    tiles.sort_by(|x, y| x.total_cmp(y));
    let mid = tiles.len() / 2;
    let tile_med = if tiles.len() % 2 == 0 { (tiles[mid - 1] + tiles[mid]) / 2.0 } else { tiles[mid] };
    let (ga, gb) = (gradient_mag(&ref_win, ww, wh), gradient_mag(&warped, ww, wh));
    Metrics { whole: best.1, tile_med, grad: ncc_iter(ga.into_iter().zip(gb)), t: best.0 }
}

/// Lower-case name; XY "EX" stays apart from SV "ex" like the clusterer's name_key.
fn name_bucket(name: &str) -> String {
    let ex_upper = name.split_whitespace().any(|w| w == "EX");
    let mut n = name.to_lowercase();
    if ex_upper {
        n.push_str(" #EX");
    }
    n
}

struct GroupResult {
    lines_pairs: Vec<String>,
    lines_members: Vec<String>,
    flagged: Option<String>,
    medoid: Option<u64>,
}

fn components(n: usize, sim: &[Vec<f32>], threshold: f32) -> Vec<usize> {
    let mut comp = vec![usize::MAX; n];
    let mut next = 0;
    for start in 0..n {
        if comp[start] != usize::MAX {
            continue;
        }
        let mut stack = vec![start];
        comp[start] = next;
        while let Some(i) = stack.pop() {
            for j in 0..n {
                if comp[j] == usize::MAX && sim[i][j] >= threshold {
                    comp[j] = next;
                    stack.push(j);
                }
            }
        }
        next += 1;
    }
    comp
}

fn audit_group(version: &str, members: &[&Member], feats: &HashMap<u64, Feat>, win: &Window, threshold: f32) -> GroupResult {
    let usable: Vec<&Member> = members
        .iter()
        .copied()
        .filter(|m| feats.get(&m.card_id).is_some_and(|f| f.flags == 0))
        .collect();
    let skipped: Vec<String> = members
        .iter()
        .filter(|m| !usable.iter().any(|u| u.card_id == m.card_id))
        .map(|m| {
            let why = match feats.get(&m.card_id) {
                None => "no-image",
                Some(f) if f.flags & FLAG_PLACEHOLDER != 0 => "placeholder",
                Some(_) => "landscape",
            };
            format!("{}:{why}", m.card_id)
        })
        .collect();
    let n = usable.len();
    let imgs: Vec<Vec<f32>> = usable.iter().map(|m| blurred(&feats[&m.card_id].gray)).collect();
    let mut sim = vec![vec![1.0f32; n]; n];
    let mut lines_pairs = Vec::new();
    for i in 0..n {
        for j in i + 1..n {
            let m = compare(&imgs[i], &imgs[j], win);
            sim[i][j] = m.score();
            sim[j][i] = m.score();
            lines_pairs.push(format!(
                "{version}\t{}\t{}\t{:.4}\t{:.4}\t{:.4}\t{:.2}\t{:.1}\t{:.1}",
                usable[i].card_id, usable[j].card_id, m.whole, m.tile_med, m.grad, m.t.s, m.t.dx, m.t.dy
            ));
        }
    }
    if n == 0 {
        return GroupResult { lines_pairs, lines_members: vec![], flagged: None, medoid: None };
    }
    let (lines_members, flagged, medoid) = analyse(version, &usable, &sim, threshold, &skipped);
    GroupResult { lines_pairs, lines_members, flagged, medoid: Some(medoid) }
}

/// Medoid, single-linkage components at `threshold`, and the flagged line when a version set
/// falls apart into more than one painting.
fn analyse(
    version: &str,
    usable: &[&Member],
    sim: &[Vec<f32>],
    threshold: f32,
    skipped: &[String],
) -> (Vec<String>, Option<String>, u64) {
    let n = usable.len();
    let mean_sim = |i: usize| -> f32 {
        if n < 2 {
            return 1.0;
        }
        (0..n).filter(|&j| j != i).map(|j| sim[i][j]).sum::<f32>() / (n - 1) as f32
    };
    let medoid = (0..n).max_by(|&a, &b| mean_sim(a).total_cmp(&mean_sim(b))).unwrap();
    let comp = components(n, &sim, threshold);
    let mut sizes: BTreeMap<usize, usize> = BTreeMap::new();
    for &c in &comp {
        *sizes.entry(c).or_default() += 1;
    }
    // Main = the largest component; ties go to the medoid's.
    let main = *sizes
        .iter()
        .max_by_key(|(c, size)| (**size, (**c == comp[medoid]) as u8))
        .unwrap()
        .0;
    let mut lines_members = Vec::new();
    for i in 0..n {
        let max_other = (0..n).filter(|&j| j != i).map(|j| sim[i][j]).fold(f32::NAN, f32::max);
        let m = usable[i];
        lines_members.push(format!(
            "{version}\t{}\t{}\t{}\t{}\t{}\t{}\t{n}\t{}\t{:.4}\t{:.4}\t{}\t{}\t{}",
            m.source,
            m.card_id,
            m.name,
            m.expansion,
            m.number,
            m.ct_id,
            usable[medoid].card_id,
            sim[i][medoid],
            max_other,
            comp[i],
            sizes[&comp[i]],
            (comp[i] == main) as u8
        ));
    }
    let flagged = (sizes.len() > 1).then(|| {
        let parts: Vec<String> = sizes
            .keys()
            .map(|c| {
                let ids: Vec<String> = (0..n).filter(|&i| comp[i] == *c).map(|i| usable[i].card_id.to_string()).collect();
                format!("{}{}", if *c == main { "*" } else { "" }, ids.join(","))
            })
            .collect();
        let worst = (0..n).filter(|&i| comp[i] != main).map(|i| sim[i][medoid]).fold(f32::NAN, f32::max);
        format!(
            "{version}\t{}\t{}\t{n}\t{}\t{:.4}\t{}\t{}",
            usable[0].source,
            usable[0].name,
            sizes.len(),
            worst,
            parts.join(" | "),
            skipped.join(",")
        )
    });
    (lines_members, flagged, usable[medoid].card_id)
}

/// Re-threshold a finished `score` run from its pairs.tsv (pair_score of the stored metrics).
fn regroup(f: &Flags) -> Result<()> {
    let members = read_members(f.get("members")?)?;
    let by_id: HashMap<u64, &Member> = members.iter().map(|m| (m.card_id, m)).collect();
    let threshold = f.f32_or("threshold", 0.45)?;
    let out_dir = PathBuf::from(f.get("out-dir")?);
    std::fs::create_dir_all(&out_dir)?;
    let mut pairs: BTreeMap<String, Vec<(u64, u64, f32)>> = BTreeMap::new();
    let mut rdr = csv::ReaderBuilder::new().delimiter(b'\t').from_path(f.get("pairs")?)?;
    for rec in rdr.records() {
        let rec = rec?;
        let v = |i: usize| rec.get(i).unwrap_or("0").parse::<f32>().unwrap_or(0.0);
        let s = pair_score(v(3), v(4), v(5));
        pairs.entry(rec[0].to_string()).or_default().push((rec[1].parse()?, rec[2].parse()?, s));
    }
    let mut mem = BufWriter::new(File::create(out_dir.join("members.tsv"))?);
    writeln!(
        mem,
        "version\tsource\tcard_id\tname\texpansion\tnumber\tct_id\tn\tmedoid\tsim_medoid\tmax_other\tcomp\tcomp_size\tmain"
    )?;
    let mut flagged = BufWriter::new(File::create(out_dir.join("flagged.tsv"))?);
    writeln!(flagged, "version\tsource\tname\tn\tcomponents\tbest_minority_to_medoid\tparts\tskipped")?;
    let mut count = 0;
    for (version, list) in &pairs {
        let mut ids: Vec<u64> = list.iter().flat_map(|p| [p.0, p.1]).collect();
        ids.sort_unstable();
        ids.dedup();
        let pos: HashMap<u64, usize> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
        let mut sim = vec![vec![1.0f32; ids.len()]; ids.len()];
        for (a, b, s) in list {
            sim[pos[a]][pos[b]] = *s;
            sim[pos[b]][pos[a]] = *s;
        }
        let usable: Vec<&Member> = ids.iter().map(|id| by_id[id]).collect();
        let (lines, flag, _) = analyse(version, &usable, &sim, threshold, &[]);
        for l in lines {
            writeln!(mem, "{l}")?;
        }
        if let Some(l) = flag {
            writeln!(flagged, "{l}")?;
            count += 1;
        }
    }
    eprintln!("flagged {count} of {} groups at threshold {threshold}", pairs.len());
    Ok(())
}

fn score(f: &Flags) -> Result<()> {
    let members = read_members(f.get("members")?)?;
    let feats = read_feats(f.get("feats")?)?;
    let out_dir = PathBuf::from(f.get("out-dir")?);
    std::fs::create_dir_all(&out_dir)?;
    let threshold = f.f32_or("threshold", 0.45)?;
    let only: HashSet<String> = f.all("version").into_iter().collect();
    let mut groups: BTreeMap<&str, Vec<&Member>> = BTreeMap::new();
    for m in members.iter().filter(|m| m.single && !m.version.is_empty()) {
        if only.is_empty() || only.contains(&m.version) {
            groups.entry(m.version.as_str()).or_default().push(m);
        }
    }
    groups.retain(|_, v| v.len() >= 2);
    let win = window();
    eprintln!("groups {} window x {}..{} y {}..{}", groups.len(), win.x0, win.x1, win.y0, win.y1);
    let done = std::sync::atomic::AtomicUsize::new(0);
    let total = groups.len();
    let results: Vec<(&str, GroupResult)> = groups
        .par_iter()
        .map(|(version, ms)| {
            let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if n % 1000 == 0 {
                eprintln!("score {n}/{total}");
            }
            (*version, audit_group(version, ms, &feats, &win, threshold))
        })
        .collect();
    let mut pairs = BufWriter::new(File::create(out_dir.join("pairs.tsv"))?);
    writeln!(pairs, "version\ta\tb\twhole\ttile_med\tgrad\tscale\tdx\tdy")?;
    let mut mem = BufWriter::new(File::create(out_dir.join("members.tsv"))?);
    writeln!(
        mem,
        "version\tsource\tcard_id\tname\texpansion\tnumber\tct_id\tn\tmedoid\tsim_medoid\tmax_other\tcomp\tcomp_size\tmain"
    )?;
    let mut flagged = BufWriter::new(File::create(out_dir.join("flagged.tsv"))?);
    writeln!(flagged, "version\tsource\tname\tn\tcomponents\tbest_minority_to_medoid\tparts\tskipped")?;
    let mut medoids: HashMap<String, Vec<(String, u64)>> = HashMap::new();
    let mut n_flagged = 0;
    for (version, r) in &results {
        for l in &r.lines_pairs {
            writeln!(pairs, "{l}")?;
        }
        for l in &r.lines_members {
            writeln!(mem, "{l}")?;
        }
        if let Some(l) = &r.flagged {
            writeln!(flagged, "{l}")?;
            n_flagged += 1;
        }
        if let Some(m) = r.medoid {
            let name = &groups[version][0].name;
            medoids.entry(name_bucket(name)).or_default().push((version.to_string(), m));
        }
    }
    eprintln!("flagged {n_flagged} of {total} groups at threshold {threshold}");
    // Negatives for calibration: medoids of different version sets of the same name.
    if f.0.contains_key("cross") {
        let cap = f.f32_or("cross", 12.0)? as usize;
        let jobs: Vec<(String, u64, String, u64)> = medoids
            .values()
            .flat_map(|list| {
                let list: Vec<&(String, u64)> = list.iter().take(cap).collect();
                let mut out = Vec::new();
                for i in 0..list.len() {
                    for j in i + 1..list.len() {
                        out.push((list[i].0.clone(), list[i].1, list[j].0.clone(), list[j].1));
                    }
                }
                out
            })
            .collect();
        eprintln!("cross pairs {}", jobs.len());
        let lines: Vec<String> = jobs
            .par_iter()
            .map(|(va, a, vb, b)| {
                let m = compare(&blurred(&feats[a].gray), &blurred(&feats[b].gray), &win);
                format!("{va}\t{a}\t{vb}\t{b}\t{:.4}\t{:.4}\t{:.4}", m.whole, m.tile_med, m.grad)
            })
            .collect();
        let mut cross = BufWriter::new(File::create(out_dir.join("cross.tsv"))?);
        writeln!(cross, "version_a\ta\tversion_b\tb\twhole\ttile_med\tgrad")?;
        for l in lines {
            writeln!(cross, "{l}")?;
        }
    }
    Ok(())
}

/// For each card id, the best-matching other printings of the same name (any version set),
/// to decide where a wrong member belongs.
fn match_cards(f: &Flags) -> Result<()> {
    let pool = read_members(f.get("pool")?)?;
    let feats = read_feats(f.get("feats")?)?;
    let ids: Vec<u64> = std::fs::read_to_string(f.get("cards")?)?
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();
    let top = f.f32_or("top", 5.0)? as usize;
    let by_id: HashMap<u64, &Member> = pool.iter().map(|m| (m.card_id, m)).collect();
    let mut by_name: HashMap<String, Vec<&Member>> = HashMap::new();
    for m in &pool {
        by_name.entry(name_bucket(&m.name)).or_default().push(m);
    }
    let win = window();
    let lines: Vec<String> = ids
        .par_iter()
        .flat_map(|id| {
            let Some(me) = by_id.get(id) else { return vec![format!("{id}\t-\tnot-in-pool")] };
            let Some(fa) = feats.get(id) else { return vec![format!("{id}\t-\tno-feature")] };
            let a = blurred(&fa.gray);
            let mut scored: Vec<(f32, Metrics, &Member)> = by_name[&name_bucket(&me.name)]
                .iter()
                .filter(|o| o.card_id != *id)
                .filter_map(|o| {
                    let fb = feats.get(&o.card_id).filter(|fb| fb.flags == 0)?;
                    let m = compare(&a, &blurred(&fb.gray), &win);
                    Some((m.score(), m, *o))
                })
                .collect();
            scored.sort_by(|x, y| y.0.total_cmp(&x.0));
            scored
                .into_iter()
                .take(top)
                .map(|(s, m, o)| {
                    format!(
                        "{id}\t{}\t{}\t{}\t{}\t{}\t{:.4}\t{:.4}\t{:.4}",
                        me.version, o.card_id, o.version, o.expansion, o.number, s, m.whole, m.tile_med
                    )
                })
                .collect()
        })
        .collect();
    let mut out = BufWriter::new(File::create(f.get("out")?)?);
    writeln!(out, "card_id\tversion\tother\tother_version\tother_expansion\tother_number\tscore\twhole\ttile_med")?;
    for l in lines {
        writeln!(out, "{l}")?;
    }
    Ok(())
}

// ---------- reviewed decisions → migration ----------

struct Move {
    card_id: u64,
    ct_id: u64,
    old_version: String,
    new_version: String,
    name: String,
}

fn sql_text(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// decisions.tsv: version, move (comma card ids = one painting to take out), target (`new`, an
/// existing version key, or `c<card id>` = the key that card ends up in), note. Every resulting key that holds a moved painting
/// becomes `artbox-pin`, so `cluster-name-version-sets.py --all` keeps it apart. When the moved
/// painting is the key's namesake (v221412 = BREAKthrough 48/162), the namesake keeps the key
/// and the rest of the group moves to `v{lowest remaining id}` with the old row's source.
fn write_sql(f: &Flags) -> Result<()> {
    let members = read_members(f.get("members")?)?;
    let tag = f.get("tag")?;
    let mut groups: HashMap<String, Vec<&Member>> = HashMap::new();
    for m in &members {
        groups.entry(m.version.clone()).or_default().push(m);
    }
    let by_id: HashMap<u64, &Member> = members.iter().map(|m| (m.card_id, m)).collect();
    let mut current: HashMap<u64, String> = members.iter().map(|m| (m.card_id, m.version.clone())).collect();
    let mut moves: BTreeMap<u64, Move> = BTreeMap::new();
    let mut created: BTreeMap<String, String> = BTreeMap::new(); // new key -> copy_from
    let mut pins: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let mut rdr = csv::ReaderBuilder::new().delimiter(b'\t').flexible(true).from_path(f.get("decisions")?)?;
    let mut rows: Vec<(String, Vec<u64>, String, String)> = Vec::new();
    for rec in rdr.records() {
        let rec = rec?;
        let ids: Vec<u64> = rec.get(1).unwrap_or("").split(',').filter_map(|s| s.trim().parse().ok()).collect();
        if ids.is_empty() {
            continue;
        }
        rows.push((
            rec.get(0).unwrap_or("").trim().to_string(),
            ids,
            rec.get(2).unwrap_or("new").trim().to_string(),
            rec.get(3).unwrap_or("").trim().to_string(),
        ));
    }
    // New keys first, so a `c<card id>` target ("the painting card X belongs to") resolves to
    // that card's final key even when its own group was split or re-keyed.
    rows.sort_by_key(|r| r.2 != "new");
    for (version, ids, target, note) in rows {
        let target = match target.strip_prefix('c').and_then(|id| id.parse::<u64>().ok()) {
            Some(card) => current.get(&card).cloned().ok_or_else(|| anyhow!("{version}: target card {card} unknown"))?,
            None => target,
        };
        let group: Vec<u64> = current.iter().filter(|(_, v)| **v == version).map(|(id, _)| *id).collect();
        for id in &ids {
            // A target move runs after the new keys, so its card may already sit on the key its
            // group was re-keyed to; it must still come from `version` in the reviewed export.
            let from_here = group.contains(id) || (target != "new" && by_id.get(id).is_some_and(|m| m.version == version));
            if !from_here {
                bail!("{version}: card {id} is not in that version set");
            }
        }
        let mut assign = |id: u64, to: &str, moves: &mut BTreeMap<u64, Move>| {
            let m = by_id[&id];
            let entry = moves.entry(id).or_insert(Move {
                card_id: id,
                ct_id: m.ct_id,
                old_version: m.version.clone(),
                new_version: String::new(),
                name: m.name.clone(),
            });
            entry.new_version = to.to_string();
            current.insert(id, to.to_string());
        };
        if target == "new" {
            let key = format!("v{}", ids.iter().min().unwrap());
            if key == version {
                let rest: Vec<u64> = group.iter().copied().filter(|id| !ids.contains(id)).collect();
                if rest.is_empty() {
                    bail!("{version}: nothing would remain");
                }
                let main_key = format!("v{}", rest.iter().min().unwrap());
                if groups.contains_key(&main_key) && main_key != version {
                    bail!("{version}: {main_key} already exists");
                }
                for id in rest {
                    assign(id, &main_key, &mut moves);
                }
                created.insert(main_key, version.clone());
                pins.push(version.clone());
            } else {
                if groups.contains_key(&key) {
                    bail!("{version}: {key} already exists");
                }
                for id in &ids {
                    assign(*id, &key, &mut moves);
                }
                created.insert(key.clone(), version.clone());
                pins.push(key);
            }
        } else {
            if !groups.contains_key(&target) {
                bail!("{version}: target {target} is not a version set");
            }
            for id in &ids {
                assign(*id, &target, &mut moves);
            }
            pins.push(target.clone());
        }
        notes.push(format!("--   {version}: {} → {target}  {note}", ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",")));
    }
    // A card moved back to where it started is no move.
    moves.retain(|_, m| m.old_version != m.new_version);
    pins.sort();
    pins.dedup();
    let mut touched: Vec<String> = moves.values().flat_map(|m| [m.old_version.clone(), m.new_version.clone()]).collect();
    touched.sort();
    touched.dedup();
    let arr = |v: &[String]| format!("array[{}]::text[]", v.iter().map(|s| sql_text(s)).collect::<Vec<_>>().join(", "));
    let backup = format!("public.version_artwork_split_{tag}");
    let values: Vec<String> = moves
        .values()
        .map(|m| {
            format!(
                "  ({}, {}, {}, {}, {}, {})",
                m.card_id,
                m.ct_id,
                sql_text(&m.old_version),
                sql_text(&m.new_version),
                created.get(&m.new_version).map_or("null".to_string(), |s| sql_text(s)),
                sql_text(&m.name)
            )
        })
        .collect();
    let split_cte = format!(
        "create temp table split (card_id bigint primary key, ct_id bigint not null, old_version text not null,\n  new_version text not null, copy_from text, name text not null) on commit drop;\ninsert into split values\n{};\n",
        values.join(",\n")
    );
    let out_dir = PathBuf::from(f.get("out-dir")?);
    std::fs::create_dir_all(&out_dir)?;
    let forward = format!(
        r#"-- Version sets that joined two different paintings: move each wrong painting out.
-- Generated by tools/version-artwork-audit (sql) from reviewed contact sheets, {tag}.
-- Run on the nezopt writer only (pg_is_in_recovery() = false). The Pi follows replication.
-- Idempotent: a card already at its new key is skipped; a card at any other key aborts.
-- Revert: scripts/sql/{tag}_version_artwork_splits.revert.sql (reads the backup tables below).
--
-- Every key that now holds a moved painting is source artbox-pin, which
-- cluster-name-version-sets.protected_card_ids() keeps out of --all passes.
-- same_artwork illustrator copies that crossed a split are deleted (backed up) and
-- marketplace_copy_same_art_artists() refills them from the right painting.
--
-- Decisions ({n} version sets, {m} cards moved):
{notes}
begin;
set local lock_timeout = '5s';

do $$ begin
  if pg_is_in_recovery() then raise exception 'refusing to run on a replica'; end if;
end $$;

create table if not exists {backup} (
  card_id bigint primary key,
  ct_id bigint not null,
  old_version text not null,
  new_version text not null,
  applied_at timestamptz not null default now()
);
create table if not exists {backup}_sets (
  version text primary key,
  existed boolean not null,
  row jsonb
);
create table if not exists {backup}_artists (
  blueprint_id bigint primary key,
  row jsonb not null
);

{split_cte}
do $$ begin
  if exists (select 1 from split s left join public.marketplace_search_candidates c using (card_id)
             where c.card_id is null or c.ct_id <> s.ct_id or c.version not in (s.old_version, s.new_version)) then
    raise exception 'version_artwork_split: catalog moved since review (card or version changed)';
  end if;
  if exists (select 1 from public.marketplace_search_candidates c
             join (select distinct new_version from split where copy_from is not null) k on c.version = k.new_version
             where c.card_id not in (select card_id from split)) then
    raise exception 'version_artwork_split: a new key already holds other cards';
  end if;
end $$;

-- Backups (first run only).
insert into {backup}_sets (version, existed, row)
select t.version, s.version is not null, to_jsonb(s)
from unnest({touched}) as t(version)
left join public.pokoin_version_sets s on s.version = t.version
on conflict (version) do nothing;

insert into {backup} (card_id, ct_id, old_version, new_version)
select card_id, ct_id, old_version, new_version from split
on conflict (card_id) do nothing;

-- New keys copy the old row (gameplay name, source, art layout). An empty leftover
-- singleton row of that key is overwritten; a key that already holds the moved cards is not.
insert into public.pokoin_version_sets (version, gameplay_name, member_count, source, art_layout, art_layout_source)
select distinct on (s.new_version) s.new_version, coalesce(o.gameplay_name, s.name), 0,
       coalesce(o.source, 'artcut'), coalesce(o.art_layout, ''), coalesce(o.art_layout_source, '')
from split s
left join public.pokoin_version_sets o on o.version = s.copy_from
where s.copy_from is not null
  and not exists (select 1 from public.marketplace_search_candidates c where c.version = s.new_version)
on conflict (version) do update
  set gameplay_name = excluded.gameplay_name, source = excluded.source,
      art_layout = excluded.art_layout, art_layout_source = excluded.art_layout_source, updated_at = now();

-- Illustrator copies whose donor ends up on the other side of a split.
with gone as (
  delete from public.marketplace_blueprint_artists a
  using public.marketplace_search_candidates c
  where a.source = 'same_artwork'
    and c.ct_id = a.blueprint_id
    and c.version = any({touched})
    and (c.card_id in (select card_id from split)
         or (a.raw_metadata->>'donor_blueprint_id')::bigint in (select ct_id from split))
    and coalesce((select coalesce(s.new_version, d.version)
                  from public.marketplace_search_candidates d
                  left join split s on s.card_id = d.card_id
                  where d.ct_id = (a.raw_metadata->>'donor_blueprint_id')::bigint), '')
        is distinct from coalesce((select new_version from split s where s.card_id = c.card_id), c.version)
  returning a.*
)
insert into {backup}_artists (blueprint_id, row)
select blueprint_id, to_jsonb(gone) from gone
on conflict (blueprint_id) do nothing;

update public.marketplace_search_candidates c
set version = s.new_version
from split s
where c.card_id = s.card_id and c.version is distinct from s.new_version;

update public.pokoin_version_sets
set source = 'artbox-pin', updated_at = now()
where version = any({pins}) and source <> 'artbox-pin';

update public.pokoin_version_sets s
set member_count = (select count(*) from public.marketplace_search_candidates c where c.version = s.version),
    updated_at = now()
where s.version = any({touched});

select public.marketplace_copy_same_art_artists(v) from unnest({touched}) as v;
select public.marketplace_refresh_artwork_cluster_sort({touched});

-- Version page snapshots of these keys answer live until build-lists-versions rebuilds them.
delete from public.marketplace_page_snapshots where kind = 'version' and key = any({touched});
commit;
"#,
        n = notes.len(),
        m = moves.len(),
        notes = notes.join("\n"),
        touched = arr(&touched),
        pins = arr(&pins),
    );
    let revert = format!(
        r#"-- Revert of {tag}_version_artwork_splits.sql: puts every moved card back on its old key,
-- restores the touched pokoin_version_sets rows and the deleted same_artwork illustrator rows.
-- Run on the nezopt writer only. Leaves the backup tables in place (drop them by hand).
begin;
set local lock_timeout = '5s';

do $$ begin
  if pg_is_in_recovery() then raise exception 'refusing to run on a replica'; end if;
end $$;

-- Illustrator rows the forward migration's refill wrote for touched cards.
delete from public.marketplace_blueprint_artists a
using public.marketplace_search_candidates c, {backup}_sets t
where a.source = 'same_artwork' and c.ct_id = a.blueprint_id and c.version = t.version
  and a.matched_at >= (select min(applied_at) from {backup});

-- Restore the deleted copies before cards move back, so the version trigger cannot fill them first.
insert into public.marketplace_blueprint_artists
  (blueprint_id, ct_id, artist, illustrator, normalized_artist, source, source_card_id, source_url,
   confidence, match_reason, matched_at, raw_metadata, created_at, updated_at, artist_card_count)
select r.blueprint_id, r.ct_id, r.artist, r.illustrator, r.normalized_artist, r.source, r.source_card_id, r.source_url,
       r.confidence, r.match_reason, r.matched_at, r.raw_metadata, r.created_at, r.updated_at, r.artist_card_count
from {backup}_artists b, jsonb_populate_record(null::public.marketplace_blueprint_artists, b.row) r
on conflict (blueprint_id) do nothing;

-- Old rows (they may have been deleted by a later clustering pass).
insert into public.pokoin_version_sets (version, gameplay_name, member_count, source, art_layout, art_layout_source)
select r.version, r.gameplay_name, r.member_count, r.source, r.art_layout, r.art_layout_source
from {backup}_sets t, jsonb_populate_record(null::public.pokoin_version_sets, t.row) r
where t.existed
on conflict (version) do update
  set gameplay_name = excluded.gameplay_name, source = excluded.source,
      art_layout = excluded.art_layout, art_layout_source = excluded.art_layout_source, updated_at = now();

update public.marketplace_search_candidates c
set version = b.old_version
from {backup} b
where c.card_id = b.card_id and c.version = b.new_version;

update public.pokoin_version_sets s
set member_count = (select count(*) from public.marketplace_search_candidates c where c.version = s.version),
    updated_at = now()
where s.version in (select version from {backup}_sets);

delete from public.pokoin_version_sets s
using {backup}_sets t
where s.version = t.version and not t.existed
  and not exists (select 1 from public.marketplace_search_candidates c where c.version = s.version);

select public.marketplace_refresh_artwork_cluster_sort(array_agg(version)) from {backup}_sets;
delete from public.marketplace_page_snapshots where kind = 'version' and key in (select version from {backup}_sets);
commit;
"#
    );
    std::fs::write(out_dir.join(format!("{tag}_version_artwork_splits.sql")), forward)?;
    std::fs::write(out_dir.join(format!("{tag}_version_artwork_splits.revert.sql")), revert)?;
    eprintln!("{} decisions, {} cards moved, {} keys touched, {} pinned", notes.len(), moves.len(), touched.len(), pins.len());
    Ok(())
}

// ---------- contact sheets ----------

const LABEL_H: u32 = 58;
const PAD: u32 = 8;

fn load_font() -> Result<FontVec> {
    for p in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ] {
        if let Ok(bytes) = std::fs::read(p) {
            return FontVec::try_from_vec(bytes).map_err(|e| anyhow!("{p}: {e}"));
        }
    }
    bail!("no font found")
}

fn draw_text(img: &mut RgbImage, font: &FontVec, size: f32, x: i32, y: i32, text: &str, color: [u8; 3]) {
    let scale = PxScale::from(size);
    let sf = font.as_scaled(scale);
    let mut caret = x as f32;
    let base = y as f32 + sf.ascent();
    for ch in text.chars() {
        let glyph = sf.scaled_glyph(ch);
        let adv = sf.h_advance(glyph.id);
        let positioned = glyph.clone();
        let mut g = positioned;
        g.position = ab_glyph::point(caret, base);
        if let Some(outline) = font.outline_glyph(g) {
            let bb = outline.px_bounds();
            outline.draw(|gx, gy, cov| {
                let (px, py) = (bb.min.x as i32 + gx as i32, bb.min.y as i32 + gy as i32);
                if px >= 0 && py >= 0 && (px as u32) < img.width() && (py as u32) < img.height() {
                    let p = img.get_pixel_mut(px as u32, py as u32);
                    for c in 0..3 {
                        p[c] = (p[c] as f32 * (1.0 - cov) + color[c] as f32 * cov) as u8;
                    }
                }
            });
        }
        caret += adv;
    }
}

fn fit(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        text.chars().take(max - 1).collect::<String>() + "…"
    }
}

/// One row per flagged version set: the main component first (gold frame), other components
/// after (red frame), the dashed window drawn on every card.
fn sheet(f: &Flags) -> Result<()> {
    let members = read_members(f.get("members")?)?;
    let dirs: Vec<PathBuf> = f.all("objects").into_iter().map(PathBuf::from).collect();
    let out_dir = PathBuf::from(f.get("out-dir")?);
    std::fs::create_dir_all(&out_dir)?;
    let rows_per_sheet = f.f32_or("rows", 5.0)? as usize;
    // --thumb 400 --per-row 3 for a close look at a few groups.
    let thumb_w = f.f32_or("thumb", 200.0)? as u32;
    let thumb_h = (thumb_w as f32 * 88.0 / 63.0).round() as u32;
    let per_row = f.f32_or("per-row", 7.0)? as usize;
    let font = load_font()?;
    // flagged.tsv: version, source, name, n, components, best, parts, skipped
    let mut groups: Vec<(String, String, Vec<(bool, Vec<u64>)>)> = Vec::new();
    let mut rdr = csv::ReaderBuilder::new().delimiter(b'\t').flexible(true).from_path(f.get("groups")?)?;
    for rec in rdr.records() {
        let rec = rec?;
        let parts = rec.get(6).unwrap_or("");
        let comps = parts
            .split(" | ")
            .map(|p| {
                let main = p.starts_with('*');
                (main, p.trim_start_matches('*').split(',').filter_map(|s| s.parse().ok()).collect())
            })
            .collect();
        groups.push((rec.get(0).unwrap_or("").to_string(), rec.get(5).unwrap_or("").to_string(), comps));
    }
    let by_id: HashMap<u64, &Member> = members.iter().map(|m| (m.card_id, m)).collect();
    let index = std::sync::OnceLock::new();
    let row_h = thumb_h + LABEL_H + 26 + PAD;
    let width = PAD + per_row as u32 * (thumb_w + PAD);
    let mut index_out = BufWriter::new(File::create(out_dir.join("index.tsv"))?);
    // Four cards of the main painting are enough to judge it; every other component in full.
    let shown = |comps: &Vec<(bool, Vec<u64>)>| -> Vec<(bool, u64)> {
        let mut sorted = comps.clone();
        sorted.sort_by_key(|(main, _)| !*main);
        sorted
            .iter()
            .flat_map(|(main, ids)| ids.iter().take(if *main { 4 } else { usize::MAX }).map(move |id| (*main, *id)))
            .collect()
    };
    for (sheet_no, chunk) in groups.chunks(rows_per_sheet).enumerate() {
        // A group wider than per_row wraps onto extra lines.
        let lines: usize = chunk.iter().map(|(_, _, c)| shown(c).len().div_ceil(per_row)).sum();
        let mut img = RgbImage::from_pixel(width, PAD + lines as u32 * row_h, Rgb([24, 24, 28]));
        let mut line = 0u32;
        for (version, best, comps) in chunk {
            writeln!(index_out, "{sheet_no}\t{version}")?;
            let cards = shown(comps);
            let name = cards.first().and_then(|(_, id)| by_id.get(id)).map_or("", |m| m.name.as_str());
            for (k, (main, id)) in cards.iter().enumerate() {
                let (col, sub) = (k % per_row, k / per_row);
                let x = PAD + col as u32 * (thumb_w + PAD);
                let y = PAD + (line + sub as u32) * row_h;
                if k == 0 {
                    draw_text(&mut img, &font, 17.0, x as i32, y as i32, &format!("{version} · {name} · minority→medoid {best}"), [255, 220, 120]);
                }
                let ty = y + 24;
                let frame = if *main { [212, 170, 40] } else { [230, 50, 50] };
                for yy in ty..ty + thumb_h + 4 {
                    for xx in x..x + thumb_w + 4 {
                        if xx < width && yy < img.height() {
                            img.put_pixel(xx, yy, Rgb(frame));
                        }
                    }
                }
                if let Some(m) = by_id.get(id) {
                    if let Some(rgb) = resolve(m, &dirs, &index).and_then(|p| load_rgb(&p).ok()) {
                        let (w0, h0) = rgb.dimensions();
                        let rgb = if w0 > h0 { imageops::rotate270(&rgb) } else { rgb };
                        let mut t = imageops::resize(&rgb, thumb_w, thumb_h, FilterType::Triangle);
                        // Window outline.
                        let (x0, x1) = ((WINDOW.0 * thumb_w as f32) as u32, (WINDOW.2 * thumb_w as f32) as u32);
                        let (y0, y1) = ((WINDOW.1 * thumb_h as f32) as u32, (WINDOW.3 * thumb_h as f32) as u32);
                        for xx in (x0..x1).step_by(3) {
                            t.put_pixel(xx, y0, Rgb([0, 230, 255]));
                            t.put_pixel(xx, y1, Rgb([0, 230, 255]));
                        }
                        for yy in (y0..y1).step_by(3) {
                            t.put_pixel(x0, yy, Rgb([0, 230, 255]));
                            t.put_pixel(x1, yy, Rgb([0, 230, 255]));
                        }
                        imageops::replace(&mut img, &t, (x + 2) as i64, (ty + 2) as i64);
                    }
                    let ly = (ty + thumb_h + 6) as i32;
                    draw_text(&mut img, &font, 14.0, x as i32, ly, &format!("{} · ct {}", m.card_id, m.ct_id), [235, 235, 235]);
                    draw_text(&mut img, &font, 13.0, x as i32, ly + 17, &fit(&m.expansion, 28), [190, 190, 190]);
                    draw_text(&mut img, &font, 13.0, x as i32, ly + 33, &fit(&m.number, 28), [190, 190, 190]);
                }
            }
            line += cards.len().div_ceil(per_row) as u32;
        }
        let path = out_dir.join(format!("sheet-{sheet_no:03}.jpg"));
        let mut buf = BufWriter::new(File::create(&path)?);
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 85).encode_image(&img)?;
    }
    eprintln!("sheets {}", groups.len().div_ceil(rows_per_sheet));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(f: impl Fn(usize, usize) -> u8) -> Vec<f32> {
        let g: Vec<u8> = (0..H).flat_map(|y| (0..W).map(move |x| (x, y))).map(|(x, y)| f(x, y)).collect();
        blurred(&g)
    }

    #[test]
    fn leftover_name_from_cdn_url() {
        assert_eq!(
            image_basename("https://cdn.pokoin.com/110706_pikachu-48-162-breakthrough.jpg?v=hd1").as_deref(),
            Some("110706_pikachu-48-162-breakthrough.jpg")
        );
        assert_eq!(image_basename(""), None);
    }

    #[test]
    fn xy_ex_stays_apart_from_sv_ex() {
        assert_ne!(name_bucket("Ho-Oh EX"), name_bucket("Ho-Oh ex"));
        assert_eq!(name_bucket("Alolan Exeggutor ex"), name_bucket("Alolan exeggutor ex"));
    }

    #[test]
    fn shifted_copy_is_the_same_painting_and_other_layout_is_not() {
        let win = window();
        let a = card(|x, y| ((x * 7 + y * 13) % 97 + (x / 9) * 11 + (y / 7) * 5) as u8);
        let shifted = card(|x, y| (((x + 2) * 7 + (y + 1) * 13) % 97 + ((x + 2) / 9) * 11 + ((y + 1) / 7) * 5) as u8);
        let other = card(|x, y| ((x * 31 + y * 3) % 89 + (y / 5) * 9) as u8);
        assert!(compare(&a, &shifted, &win).score() > 0.8);
        assert!(compare(&a, &other, &win).score() < 0.45);
    }

    #[test]
    fn components_split_at_threshold() {
        let sim = vec![vec![1.0, 0.9, 0.2], vec![0.9, 1.0, 0.1], vec![0.2, 0.1, 1.0]];
        let comp = components(3, &sim, 0.45);
        assert_eq!(comp[0], comp[1]);
        assert_ne!(comp[0], comp[2]);
    }
}
