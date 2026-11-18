//! Survey card scans for printed stamps.
//!
//! `sheet`: one review cell per sample scan (whole card + a zoom of the lower
//! right, where deck stamps and set-symbol replacements sit), numbered, 20 per
//! sheet, with an index TSV mapping cell numbers back to the printing.
//!
//!   stamp-survey sheet --samples samples.tsv --objects ~/data/pokoin-leftovers/objects --out /tmp/survey
//!
//! samples.tsv columns: set, card_id, name, number, image url, stamped flag.

mod font;
mod matching;

use anyhow::{bail, Context, Result};
use image::imageops::{self, FilterType};
use image::{DynamicImage, Rgba, RgbaImage};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const CARD_W: u32 = 260;
pub const CARD_H: u32 = 363;
const LABEL_H: u32 = 30;
const COLS: u32 = 4;
const ROWS: u32 = 5;
const BG: Rgba<u8> = Rgba([20, 20, 22, 255]);
const INK: Rgba<u8> = Rgba([255, 211, 61, 255]);

#[derive(Debug, Clone, PartialEq)]
pub struct Sample {
    pub set: String,
    pub card_id: String,
    pub name: String,
    pub number: String,
    pub image: String,
}

pub fn parse_samples(text: &str) -> Vec<Sample> {
    text.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split('\t').collect();
            if cols.len() < 5 || cols[4].trim().is_empty() {
                return None;
            }
            Some(Sample {
                set: cols[0].to_string(),
                card_id: cols[1].to_string(),
                name: cols[2].to_string(),
                number: cols[3].to_string(),
                image: cols[4].trim().to_string(),
            })
        })
        .collect()
}

/// Local object-store file for a CDN URL, else a cached download.
pub fn load_scan(url: &str, objects: &Path, cache: &Path) -> Result<DynamicImage> {
    let base = url.split('?').next().unwrap_or(url).rsplit('/').next().unwrap_or(url);
    let local = objects.join(base);
    let path = if url.contains("cdn.pokoin.com") && local.exists() {
        local
    } else {
        let dest = cache.join(base);
        if !dest.exists() {
            let status = Command::new("curl")
                .args(["-fsSL", "--retry", "2", "-o"])
                .arg(&dest)
                .arg(url)
                .status()
                .context("curl")?;
            if !status.success() {
                bail!("curl {url}: {status}");
            }
        }
        dest
    };
    // Some leftover `.jpg` objects are WebP: trust the bytes, not the name.
    image::ImageReader::open(&path)?
        .with_guessed_format()?
        .decode()
        .with_context(|| format!("decode {}", path.display()))
}

/// Whole card plus a zoom of the lower right (x 40–100 %, y 55–100 %).
fn cell(scan: &DynamicImage, index: usize) -> RgbaImage {
    let card = scan.resize_exact(CARD_W, CARD_H, FilterType::Triangle).to_rgba8();
    let (w, h) = (scan.width(), scan.height());
    let (x0, y0) = (w * 40 / 100, h * 55 / 100);
    let zoom = scan
        .crop_imm(x0, y0, w - x0, h - y0)
        .resize(CARD_W, CARD_H, FilterType::Lanczos3)
        .to_rgba8();
    let mut out = RgbaImage::from_pixel(CARD_W * 2 + 6, CARD_H + LABEL_H, BG);
    font::draw_number(&mut out, index, 6, 5, 4, INK);
    imageops::overlay(&mut out, &card, 0, i64::from(LABEL_H));
    imageops::overlay(&mut out, &zoom, i64::from(CARD_W + 6), i64::from(LABEL_H));
    out
}

fn sheet(samples: &[Sample], objects: &Path, cache: &Path, out: &Path) -> Result<()> {
    fs::create_dir_all(out)?;
    fs::create_dir_all(cache)?;
    let per = (COLS * ROWS) as usize;
    let cell_w = CARD_W * 2 + 6;
    let cell_h = CARD_H + LABEL_H;
    let mut index = String::from("cell\tsheet\tset\tcard_id\tname\tnumber\tstatus\n");
    for (s, chunk) in samples.chunks(per).enumerate() {
        let mut page = RgbaImage::from_pixel(COLS * (cell_w + 12), ROWS * (cell_h + 12), BG);
        for (i, sample) in chunk.iter().enumerate() {
            let n = s * per + i + 1;
            let status = match load_scan(&sample.image, objects, cache) {
                Ok(scan) => {
                    let (cx, cy) = (i as u32 % COLS, i as u32 / COLS);
                    let tile = cell(&scan, n);
                    imageops::overlay(&mut page, &tile, i64::from(cx * (cell_w + 12)), i64::from(cy * (cell_h + 12)));
                    "ok".to_string()
                }
                Err(err) => format!("error: {err:#}"),
            };
            index.push_str(&format!(
                "{n}\t{}\t{}\t{}\t{}\t{}\t{status}\n",
                s + 1,
                sample.set,
                sample.card_id,
                sample.name,
                sample.number
            ));
        }
        let path = out.join(format!("sheet-{:03}.jpg", s + 1));
        DynamicImage::ImageRgba8(page).to_rgb8().save(&path)?;
        println!("{}", path.display());
    }
    fs::write(out.join("index.tsv"), index)?;
    Ok(())
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let path = |name: &str, default: &str| PathBuf::from(flag(&args, name).unwrap_or_else(|| default.to_string()));
    let objects = path("--objects", "/home/nez/data/pokoin-leftovers/objects");
    let cache = path("--cache", "/tmp/stamp-survey-cache");
    let out = path("--out", "/tmp/stamp-survey");
    match args.get(1).map(String::as_str) {
        Some("sheet") => {
            let samples = parse_samples(&fs::read_to_string(path("--samples", "samples.tsv"))?);
            sheet(&samples, &objects, &cache, &out)
        }
        Some("match") => matching::run(&args, &objects, &cache, &out),
        _ => bail!("usage: stamp-survey sheet|match [--samples f] [--objects dir] [--cache dir] [--out dir]"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_skip_rows_without_an_image() {
        let rows = parse_samples("A\t1\tPikachu\t019/068\thttps://cdn.pokoin.com/1_p.jpg\tt\nB\t2\tX\t1\t\tf\n");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].set, "A");
        assert_eq!(rows[0].image, "https://cdn.pokoin.com/1_p.jpg");
    }

    #[test]
    fn cell_has_card_and_zoom_side_by_side() {
        let scan = DynamicImage::ImageRgba8(RgbaImage::from_pixel(630, 880, Rgba([200, 10, 10, 255])));
        let c = cell(&scan, 7);
        assert_eq!(c.dimensions(), (CARD_W * 2 + 6, CARD_H + LABEL_H));
        assert_eq!(c.get_pixel(10, LABEL_H + 10)[0], 200);
        assert_eq!(c.get_pixel(CARD_W + 20, LABEL_H + 10)[0], 200);
        assert_eq!(*c.get_pixel(CARD_W + 2, LABEL_H + 10), BG, "gutter");
    }
}
