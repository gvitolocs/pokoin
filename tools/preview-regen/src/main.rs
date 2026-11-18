//! Derived card previews on the CDN, rebuilt from the leftover master scans.
//!
//! `audit`   every master `{ct_id}_{slug}.jpg` in one objects directory → its
//!           size and its `_homepage.webp` / `previews/{stem}.webp` siblings:
//!           size, age, and (with `--visual`) whether the thumb is a picture of
//!           this master at all.
//! `encode`  listed masters → `<out>/{stem}{suffix}.webp` (Lanczos3, lossy WebP,
//!           method 6). Never writes into the objects directory.
//!
//! Masters are what the desk serves; the thumbs must follow them. The thumbs
//! are 240 px wide (`_homepage.webp`, q82, as `scripts/ingest-missing-product-images.py`
//! and `tools/hd-scan-upgrade`) and 96 px (`previews/`).

use anyhow::{bail, Context, Result};
use image::{imageops, imageops::FilterType, GrayImage, RgbImage};
use rayon::prelude::*;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let f = Flags::parse(&args[2.min(args.len())..]);
    match args.get(1).map(String::as_str) {
        Some("audit") => audit(&f),
        Some("encode") => encode(&f),
        Some("probe") => {
            let a = probe(Path::new(f.get("a")?))?;
            let b = probe(Path::new(f.get("b")?))?;
            a.save(f.get("out-a")?)?;
            b.save(f.get("out-b")?)?;
            println!("{:.3} {:.3}", ncc(&a, &b, 0.0, 1.0), ncc(&a, &b, 0.10, 0.50));
            Ok(())
        }
        _ => bail!("usage: preview-regen audit|encode --objects DIR ..."),
    }
}

struct Flags(Vec<(String, String)>);

impl Flags {
    fn parse(args: &[String]) -> Self {
        let mut out = Vec::new();
        let mut i = 0;
        while i < args.len() {
            let k = args[i].trim_start_matches("--").to_owned();
            match args.get(i + 1) {
                Some(v) if !v.starts_with("--") => {
                    out.push((k, v.clone()));
                    i += 2;
                }
                _ => {
                    out.push((k, String::new()));
                    i += 1;
                }
            }
        }
        Flags(out)
    }
    fn get(&self, key: &str) -> Result<&str> {
        self.opt(key).with_context(|| format!("--{key} is required"))
    }
    fn opt(&self, key: &str) -> Option<&str> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
    fn has(&self, key: &str) -> bool {
        self.0.iter().any(|(k, _)| k == key)
    }
    fn num(&self, key: &str, default: u32) -> Result<u32> {
        self.opt(key).map_or(Ok(default), |v| v.parse().with_context(|| format!("--{key}")))
    }
}

/// `{digits}_{slug}.jpg` (or `.jpeg`), not itself a thumb.
fn master_stem(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".jpg").or_else(|| name.strip_suffix(".jpeg"))?;
    let (id, rest) = stem.split_once('_')?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) || rest.is_empty() || stem.ends_with("_homepage") {
        return None;
    }
    Some(stem)
}

struct Stat {
    w: u32,
    h: u32,
    mtime: SystemTime,
    bytes: u64,
}

fn stat(path: &Path) -> Option<Stat> {
    let meta = std::fs::metadata(path).ok()?;
    let size = imagesize::size(path).ok()?;
    Some(Stat { w: size.width as u32, h: size.height as u32, mtime: meta.modified().ok()?, bytes: meta.len() })
}

fn secs(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

const CW: u32 = 48;
const CH: u32 = 67;

/// Decodes JPEGs with `jpeg-decoder`: `image` 0.25 (zune-jpeg 0.5) returns a
/// washed-out ghost for the `jpeg-encoder` q92 masters written by
/// `tools/hd-scan-upgrade` (hd1, 2026-10-19), which libjpeg and browsers read fine.
/// Other formats are sniffed from their bytes, not the extension.
fn load_rgb(path: &Path) -> Result<RgbImage> {
    let bytes = std::fs::read(path).with_context(|| path.display().to_string())?;
    if bytes.starts_with(&[0xFF, 0xD8]) {
        let mut dec = jpeg_decoder::Decoder::new(bytes.as_slice());
        let px = dec.decode().with_context(|| path.display().to_string())?;
        let info = dec.info().context("jpeg info")?;
        let (w, h) = (info.width as u32, info.height as u32);
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
        return RgbImage::from_raw(w, h, rgb).context("jpeg buffer size");
    }
    let img = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()?.decode()?;
    Ok(img.to_rgb8())
}

/// Grayscale 48×67 of the whole card, for a thumb ↔ master identity check.
fn probe(path: &Path) -> Result<GrayImage> {
    let img = imageops::grayscale(&load_rgb(path)?);
    Ok(imageops::resize(&img, CW, CH, FilterType::Triangle))
}

/// Normalised cross-correlation over rows `y0..y1` (fractions of the height).
fn ncc(a: &GrayImage, b: &GrayImage, y0: f32, y1: f32) -> f32 {
    let (r0, r1) = ((y0 * CH as f32) as u32, (y1 * CH as f32) as u32);
    let px = |g: &GrayImage| -> Vec<f32> { (r0..r1).flat_map(|y| (0..CW).map(move |x| (x, y))).map(|(x, y)| g.get_pixel(x, y)[0] as f32).collect() };
    let (a, b) = (px(a), px(b));
    let n = a.len() as f32;
    let (ma, mb) = (a.iter().sum::<f32>() / n, b.iter().sum::<f32>() / n);
    let (mut sab, mut saa, mut sbb) = (0f32, 0f32, 0f32);
    for (x, y) in a.iter().zip(&b) {
        let (dx, dy) = (x - ma, y - mb);
        sab += dx * dy;
        saa += dx * dx;
        sbb += dy * dy;
    }
    if saa < 1e-3 || sbb < 1e-3 {
        return 1.0;
    }
    sab / (saa * sbb).sqrt()
}

fn width_bucket(w: u32) -> &'static str {
    match w {
        0..=239 => "<240",
        240..=399 => "240-399",
        400..=599 => "400-599",
        600..=799 => "600-799",
        800..=1099 => "800-1099",
        _ => ">=1100",
    }
}

// ---------------------------------------------------------------- audit

fn audit(f: &Flags) -> Result<()> {
    let objects = PathBuf::from(f.get("objects")?);
    let previews = f.opt("previews").map(PathBuf::from);
    let target = f.num("width", 240)?;
    let visual = f.has("visual");
    let mut names: Vec<String> = std::fs::read_dir(&objects)?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| master_stem(n).is_some())
        .collect();
    names.sort();
    eprintln!("{} masters in {}", names.len(), objects.display());

    let rows: Vec<(String, Vec<&'static str>, String)> = names
        .par_iter()
        .map(|name| {
            let stem = master_stem(name).unwrap();
            let mpath = objects.join(name);
            let hpath = objects.join(format!("{stem}_homepage.webp"));
            let ppath = previews.as_ref().map(|p| p.join(format!("{stem}.webp")));
            let m = stat(&mpath);
            let h = stat(&hpath);
            let p = ppath.as_deref().and_then(stat);
            let mut flags = Vec::new();
            let mut ncc_home = String::new();
            let mut ncc_prev = String::new();
            let Some(m) = m else {
                return (name.clone(), vec!["unreadable_master"], String::new());
            };
            flags.push(width_bucket(m.w));
            if m.w < target {
                flags.push("small_master");
            }
            let aspect = |s: &Stat| s.w as f64 / s.h.max(1) as f64;
            match &h {
                None => flags.push("no_home"),
                Some(h) => {
                    if secs(m.mtime) > secs(h.mtime) + 5 {
                        flags.push("home_older");
                    }
                    if h.w != target.min(m.w) {
                        flags.push("home_width");
                    }
                    if (aspect(h) / aspect(&m) - 1.0).abs() > 0.02 {
                        flags.push("home_aspect");
                    }
                }
            }
            if previews.is_some() {
                match &p {
                    None => flags.push("no_prev"),
                    Some(p) => {
                        if secs(m.mtime) > secs(p.mtime) + 5 {
                            flags.push("prev_older");
                        }
                    }
                }
            }
            if visual {
                if let Ok(mg) = probe(&mpath) {
                    if h.is_some() {
                        if let Ok(hg) = probe(&hpath) {
                            let (all, art) = (ncc(&mg, &hg, 0.0, 1.0), ncc(&mg, &hg, 0.10, 0.50));
                            ncc_home = format!("{all:.3}/{art:.3}");
                            if all < 0.90 || art < 0.85 {
                                flags.push("home_mismatch");
                            }
                        }
                    }
                    if let (Some(_), Some(pp)) = (&p, &ppath) {
                        if let Ok(pg) = probe(pp) {
                            let (all, art) = (ncc(&mg, &pg, 0.0, 1.0), ncc(&mg, &pg, 0.10, 0.50));
                            ncc_prev = format!("{all:.3}/{art:.3}");
                            if all < 0.90 || art < 0.85 {
                                flags.push("prev_mismatch");
                            }
                        }
                    }
                } else {
                    flags.push("undecodable_master");
                }
            }
            let line = format!(
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                m.w,
                m.h,
                m.bytes,
                secs(m.mtime),
                h.as_ref().map_or(String::new(), |h| format!("{}x{}", h.w, h.h)),
                h.as_ref().map_or(String::new(), |h| h.bytes.to_string()),
                h.as_ref().map_or(String::new(), |h| secs(h.mtime).to_string()),
                ncc_home,
                p.as_ref().map_or(String::new(), |p| format!("{}x{}", p.w, p.h)),
                p.as_ref().map_or(String::new(), |p| secs(p.mtime).to_string()),
                ncc_prev,
            );
            (name.clone(), flags, line)
        })
        .collect();

    let mut out = BufWriter::new(File::create(f.get("out")?)?);
    writeln!(out, "master\tflags\tw\th\tbytes\tmtime\thome_wh\thome_bytes\thome_mtime\thome_ncc\tprev_wh\tprev_mtime\tprev_ncc")?;
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for (name, flags, line) in &rows {
        for fl in flags {
            *counts.entry(fl).or_default() += 1;
        }
        writeln!(out, "{name}\t{}\t{line}", flags.join(","))?;
    }
    out.flush()?;
    for (k, v) in counts {
        println!("{k}\t{v}");
    }
    Ok(())
}

// ---------------------------------------------------------------- encode

fn webp_bytes(img: &RgbImage, quality: f32) -> Result<Vec<u8>> {
    let mut c = webp::WebPConfig::new().map_err(|_| anyhow::anyhow!("webp config"))?;
    c.quality = quality;
    c.method = 6;
    let mem = webp::Encoder::from_rgb(img.as_raw(), img.width(), img.height())
        .encode_advanced(&c)
        .map_err(|e| anyhow::anyhow!("webp {e:?}"))?;
    Ok(mem.to_vec())
}

/// `--keys` lists master file names (or stems); each → `<out>/{stem}{suffix}.webp`
/// at `min(--width, master width)`. `--suffix` defaults to `_homepage`; use
/// `--suffix none` for `previews/`.
fn encode(f: &Flags) -> Result<()> {
    let objects = PathBuf::from(f.get("objects")?);
    let out = PathBuf::from(f.get("out")?);
    let width = f.num("width", 240)?;
    let quality = f.num("quality", 82)? as f32;
    let suffix = match f.opt("suffix") {
        None => "_homepage",
        Some("none") | Some("") => "",
        Some(s) => s,
    };
    std::fs::create_dir_all(&out)?;
    let keys: Vec<String> = std::fs::read_to_string(f.get("keys")?)?
        .lines()
        .map(|l| l.split('\t').next().unwrap_or("").trim().to_owned())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    let done: Vec<String> = keys
        .par_iter()
        .filter_map(|key| {
            let name = if master_stem(key).is_some() { key.clone() } else { format!("{key}.jpg") };
            let run = || -> Result<String> {
                let stem = master_stem(&name).context("not a master name")?;
                let src = objects.join(&name);
                let img = load_rgb(&src)?;
                let (w, h) = img.dimensions();
                let tw = width.min(w);
                let th = ((h as f64) * tw as f64 / w as f64).round().max(1.0) as u32;
                let small = imageops::resize(&img, tw, th, FilterType::Lanczos3);
                let bytes = webp_bytes(&small, quality)?;
                let dest = out.join(format!("{stem}{suffix}.webp"));
                std::fs::write(&dest, &bytes)?;
                Ok(format!("{name}\t{w}x{h}\t{tw}x{th}\t{}", bytes.len()))
            };
            match run() {
                Ok(line) => Some(line),
                Err(e) => {
                    eprintln!("encode {name}: {e:#}");
                    None
                }
            }
        })
        .collect();
    let mut m = BufWriter::new(File::create(out.join("_encoded.tsv"))?);
    writeln!(m, "master\tsource\tout\tbytes")?;
    for l in &done {
        writeln!(m, "{l}")?;
    }
    eprintln!("encoded {}/{}", done.len(), keys.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn master_names() {
        assert_eq!(master_stem("370761_gastly.jpg"), Some("370761_gastly"));
        assert_eq!(master_stem("1_x.jpeg"), Some("1_x"));
        assert_eq!(master_stem("370761_gastly_homepage.webp"), None);
        assert_eq!(master_stem("370761_gastly_homepage.jpg"), None);
        assert_eq!(master_stem("370761_gastly.png"), None);
        assert_eq!(master_stem("previews.jpg"), None);
        assert_eq!(master_stem("x1_gastly.jpg"), None);
    }

    #[test]
    fn ncc_is_one_for_the_same_picture() {
        let g = GrayImage::from_fn(CW, CH, |x, y| image::Luma([((x * 5 + y * 3) % 251) as u8]));
        assert!((ncc(&g, &g, 0.0, 1.0) - 1.0).abs() < 1e-4);
        let inv = GrayImage::from_fn(CW, CH, |x, y| image::Luma([255 - g.get_pixel(x, y)[0]]));
        assert!(ncc(&g, &inv, 0.0, 1.0) < -0.99);
    }
}
