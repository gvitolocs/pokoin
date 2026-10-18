//! Classify deck printings whose catalog number does not name their stamp.
//!
//! Inside one stamped deck product every card shares the layout, so the stamp
//! sits in the same place. Copies of the same card that carry different
//! stamps (Everyone's Exciting Battle 045/047 exists with eight) differ only
//! there: the per-pixel variance across those copies locates the stamp box.
//! Labeled printings then give each stamp a model: its ink colour (median of
//! the saturated exemplar pixels) and the mean ink mask. Each unlabeled
//! printing takes the stamp whose ink mask correlates best, searched a few
//! pixels around the box, so a red Fennekin on an orange Fire card still
//! reads as Fennekin and not as background.
//!
//!   stamp-survey match --rows rows.tsv --out /tmp/stamp-match
//!
//! rows.tsv: set, card_id, name, number, image url, stamp key (empty = unlabeled;
//! "=key" marks a printing confirmed by eye, used as an exemplar).
//! Writes matches.tsv (set, card_id, name, number, key, score, margin) and one
//! review sheet per set: each unlabeled patch beside its best exemplar.

use crate::{font, load_scan};
use anyhow::{bail, Context, Result};
use image::imageops::{self, FilterType};
use image::{DynamicImage, Rgba, RgbaImage};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

/// Working resolution: half of a 630×880 scan keeps the stamp ~20 px wide.
pub const W: u32 = 315;
pub const H: u32 = 440;
/// Pixels searched around the located box for print/scan misalignment.
const SEARCH: i32 = 6;
/// Stamp box shared by the deck products whose labeled copies locate it
/// (Battle Academy, Beginning Sets, deck kits): x 253–297, y 340–375 at 315×440.
pub const FALLBACK_BOX: BBox = BBox { x: 252, y: 338, w: 46, h: 40 };
/// Below this best correlation the printing is reported as unmatched.
pub const MIN_SCORE: f64 = 0.25;

#[derive(Debug, Clone)]
pub struct Row {
    pub set: String,
    pub card_id: String,
    pub name: String,
    pub number: String,
    pub image: String,
    pub key: String,
}

pub fn parse_rows(text: &str) -> Vec<Row> {
    text.lines()
        .filter_map(|line| {
            let c: Vec<&str> = line.split('\t').collect();
            if c.len() < 5 || c[4].trim().is_empty() {
                return None;
            }
            Some(Row {
                set: c[0].into(),
                card_id: c[1].into(),
                name: c[2].into(),
                number: c[3].into(),
                image: c[4].trim().into(),
                key: c.get(5).map(|s| s.trim().trim_start_matches('=').to_string()).unwrap_or_default(),
            })
        })
        .collect()
}

/// Collector part shared by every stamp of one card ("089/214 | Mewtwo Stamp" → "089/214").
pub fn base_number(number: &str) -> String {
    let mut best = String::new();
    for token in number.split(|c: char| c == '|' || c.is_whitespace()) {
        let t = token.trim();
        if t.contains('/') && t.chars().any(|c| c.is_ascii_digit()) {
            return t.to_string();
        }
        if best.is_empty() && !t.is_empty() && t.chars().all(|c| c.is_ascii_digit()) {
            best = t.to_string();
        }
    }
    best
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BBox {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

fn rgb(img: &RgbaImage, x: u32, y: u32) -> [f64; 3] {
    let p = img.get_pixel(x, y);
    [f64::from(p[0]), f64::from(p[1]), f64::from(p[2])]
}

/// Sum of per-pixel RGB variance across groups of same-card, different-stamp copies.
pub fn variance_map(groups: &[Vec<&RgbaImage>]) -> Vec<f64> {
    let mut acc = vec![0.0; (W * H) as usize];
    for group in groups.iter().filter(|g| g.len() >= 2) {
        let n = group.len() as f64;
        for y in 0..H {
            for x in 0..W {
                let mut sum = [0.0; 3];
                let mut sq = [0.0; 3];
                for img in group {
                    let p = rgb(img, x, y);
                    for c in 0..3 {
                        sum[c] += p[c];
                        sq[c] += p[c] * p[c];
                    }
                }
                let var: f64 = (0..3).map(|c| sq[c] / n - (sum[c] / n).powi(2)).sum();
                acc[(y * W + x) as usize] += var;
            }
        }
    }
    acc
}

/// Deck stamps sit in the lower right (attack box / set-symbol corner); scan
/// edges and crop jitter elsewhere must not win the variance peak.
const ZONE_X: (f64, f64) = (0.55, 0.98);
const ZONE_Y: (f64, f64) = (0.55, 0.95);

/// Box around the strongest variance blob inside the stamp zone: 5×5 box
/// blur, then the connected pixels above 35 % of the peak that contain it.
pub fn locate(var: &[f64]) -> Option<BBox> {
    let (w, h) = (W as i32, H as i32);
    let mut blur = vec![0.0; var.len()];
    for y in 0..h {
        for x in 0..w {
            let mut s = 0.0;
            for dy in -2..=2 {
                for dx in -2..=2 {
                    let (xx, yy) = ((x + dx).clamp(0, w - 1), (y + dy).clamp(0, h - 1));
                    s += var[(yy * w + xx) as usize];
                }
            }
            blur[(y * w + x) as usize] = s / 25.0;
        }
    }
    let zx = ((f64::from(W) * ZONE_X.0) as i32, (f64::from(W) * ZONE_X.1) as i32);
    let zy = ((f64::from(H) * ZONE_Y.0) as i32, (f64::from(H) * ZONE_Y.1) as i32);
    let in_zone = |x: i32, y: i32| x >= zx.0 && x <= zx.1 && y >= zy.0 && y <= zy.1;
    for y in 0..h {
        for x in 0..w {
            if !in_zone(x, y) {
                blur[(y * w + x) as usize] = 0.0;
            }
        }
    }
    let (peak_i, peak) = blur
        .iter()
        .enumerate()
        .fold((0, 0.0), |b, (i, &v)| if v > b.1 { (i, v) } else { b });
    if peak <= 0.0 {
        return None;
    }
    let cut = peak * 0.35;
    let mut seen = vec![false; blur.len()];
    let mut stack = vec![peak_i];
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    seen[peak_i] = true;
    while let Some(i) = stack.pop() {
        let (x, y) = ((i as i32) % w, (i as i32) / w);
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (xx, yy) = (x + dx, y + dy);
            if xx < 0 || yy < 0 || xx >= w || yy >= h {
                continue;
            }
            let j = (yy * w + xx) as usize;
            if !seen[j] && blur[j] >= cut {
                seen[j] = true;
                stack.push(j);
            }
        }
    }
    let pad = 2;
    let (x0, y0) = ((x0 - pad).max(SEARCH), (y0 - pad).max(SEARCH));
    let (x1, y1) = ((x1 + pad).min(w - 1 - SEARCH), (y1 + pad).min(h - 1 - SEARCH));
    if x1 <= x0 + 3 || y1 <= y0 + 3 {
        return None;
    }
    Some(BBox { x: x0 as u32, y: y0 as u32, w: (x1 - x0) as u32, h: (y1 - y0) as u32 })
}

/// Distance (RGB) at which a pixel stops counting as stamp ink.
const INK_TOL: f64 = 70.0;

/// Stamp pixels: the strongest half of the variance inside the box, where
/// copies of one card with different stamps actually differ.
pub fn stamp_pixels(var: &[f64], b: BBox) -> Vec<(u32, u32)> {
    let at = |x: u32, y: u32| var[(y * W + x) as usize];
    let mut peak = 0.0f64;
    for y in b.y..b.y + b.h {
        for x in b.x..b.x + b.w {
            peak = peak.max(at(x, y));
        }
    }
    let mut out = Vec::new();
    for y in b.y..b.y + b.h {
        for x in b.x..b.x + b.w {
            if at(x, y) >= peak * 0.5 {
                out.push((x, y));
            }
        }
    }
    out
}

/// Median colour of the exemplars at the stamp pixels: the stamp ink.
/// Coloured stamps (Froakie blue on a white card) use only their saturated
/// pixels, so the card background between the strokes does not grey the ink;
/// white or grey stamps (Tornadus, Togekiss) fall back to every stamp pixel.
pub fn ink_color(imgs: &[&RgbaImage], sel: &[(u32, u32)]) -> Option<[f64; 3]> {
    let all: Vec<[f64; 3]> = imgs.iter().flat_map(|img| sel.iter().map(|&(x, y)| rgb(img, x, y))).collect();
    if all.len() < 8 {
        return None;
    }
    let chroma = |p: &[f64; 3]| p.iter().cloned().fold(f64::MIN, f64::max) - p.iter().cloned().fold(f64::MAX, f64::min);
    let vivid: Vec<[f64; 3]> = all.iter().filter(|p| chroma(p) > 60.0).copied().collect();
    let px = if vivid.len() * 4 >= all.len() { vivid } else { all };
    let med = |c: usize| {
        let mut v: Vec<f64> = px.iter().map(|p| p[c]).collect();
        v.sort_by(f64::total_cmp);
        v[v.len() / 2]
    };
    Some([med(0), med(1), med(2)])
}

/// Zero-mean, unit-norm mask of pixels close to `ink`.
pub fn ink_mask(img: &RgbaImage, b: BBox, dx: i32, dy: i32, ink: [f64; 3]) -> Vec<f64> {
    let mut v = Vec::with_capacity((b.w * b.h) as usize);
    for y in 0..b.h {
        for x in 0..b.w {
            let p = rgb(img, (b.x as i32 + x as i32 + dx) as u32, (b.y as i32 + y as i32 + dy) as u32);
            let d = ((p[0] - ink[0]).powi(2) + (p[1] - ink[1]).powi(2) + (p[2] - ink[2]).powi(2)).sqrt();
            v.push((1.0 - d / INK_TOL).clamp(0.0, 1.0));
        }
    }
    unit(v)
}

fn unit(mut v: Vec<f64>) -> Vec<f64> {
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    v.iter_mut().for_each(|x| *x -= mean);
    let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
    if norm < 1e-6 {
        return vec![0.0; v.len()];
    }
    v.iter_mut().for_each(|x| *x /= norm);
    v
}

/// One stamp: its ink colour and the mean ink mask of its exemplars.
pub struct Model {
    pub ink: [f64; 3],
    pub shape: Vec<f64>,
}

pub fn model(imgs: &[&RgbaImage], b: BBox, sel: &[(u32, u32)]) -> Option<Model> {
    let ink = ink_color(imgs, sel)?;
    let mut shape = vec![0.0; (b.w * b.h) as usize];
    for img in imgs {
        let m = ink_mask(img, b, 0, 0, ink);
        shape.iter_mut().zip(&m).for_each(|(s, x)| *s += x);
    }
    Some(Model { ink, shape: unit(shape) })
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Best mask correlation of `img` against a stamp model over the search window.
pub fn model_score(img: &RgbaImage, b: BBox, m: &Model) -> f64 {
    let mut best = f64::MIN;
    for dy in -SEARCH..=SEARCH {
        for dx in -SEARCH..=SEARCH {
            best = best.max(dot(&ink_mask(img, b, dx, dy, m.ink), &m.shape));
        }
    }
    best
}

pub struct Verdict {
    pub key: String,
    pub score: f64,
    pub margin: f64,
}

/// Highest-scoring stamp key; `margin` is the gap to the best other key.
pub fn classify(img: &RgbaImage, b: BBox, models: &BTreeMap<String, Model>) -> Verdict {
    let mut per_key: Vec<(String, f64)> =
        models.iter().map(|(k, m)| (k.clone(), model_score(img, b, m))).collect();
    per_key.sort_by(|a, b| b.1.total_cmp(&a.1));
    let (key, score) = per_key.first().cloned().unwrap_or_default();
    let margin = per_key.get(1).map_or(score, |s| score - s.1);
    Verdict { key, score, margin }
}

fn normalized(scan: &DynamicImage) -> RgbaImage {
    scan.resize_exact(W, H, FilterType::Triangle).to_rgba8()
}

fn crop_big(img: &RgbaImage, b: BBox) -> RgbaImage {
    let pad = 10;
    let x = b.x.saturating_sub(pad);
    let y = b.y.saturating_sub(pad);
    let w = (b.w + 2 * pad).min(W - x);
    let h = (b.h + 2 * pad).min(H - y);
    let c = imageops::crop_imm(img, x, y, w, h).to_image();
    imageops::resize(&c, w * 3, h * 3, FilterType::Lanczos3)
}

pub fn run(args: &[String], objects: &Path, cache: &Path, out: &Path) -> Result<()> {
    let rows_path = args
        .iter()
        .position(|a| a == "--rows")
        .and_then(|i| args.get(i + 1))
        .context("--rows rows.tsv")?;
    let rows = parse_rows(&fs::read_to_string(rows_path)?);
    fs::create_dir_all(out)?;
    fs::create_dir_all(cache)?;
    let mut by_set: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    for r in rows {
        by_set.entry(r.set.clone()).or_default().push(r);
    }
    let mut report = String::from("set\tcard_id\tname\tnumber\tkey\tscore\tmargin\n");
    for (set, rows) in &by_set {
        let mut imgs = Vec::new();
        for r in rows {
            match load_scan(&r.image, objects, cache) {
                Ok(s) => imgs.push(Some(normalized(&s))),
                Err(err) => {
                    eprintln!("{set} {}: {err:#}", r.card_id);
                    imgs.push(None);
                }
            }
        }
        // Same card, different stamps → variance groups.
        let mut groups: BTreeMap<(String, String), Vec<usize>> = BTreeMap::new();
        for (i, r) in rows.iter().enumerate() {
            if !r.key.is_empty() && imgs[i].is_some() {
                groups.entry((r.name.clone(), base_number(&r.number))).or_default().push(i);
            }
        }
        let var_groups: Vec<Vec<&RgbaImage>> = groups
            .values()
            .filter(|ix| ix.iter().map(|&i| &rows[i].key).collect::<BTreeSet<_>>().len() >= 2)
            .map(|ix| ix.iter().map(|&i| imgs[i].as_ref().unwrap()).collect())
            .collect();
        let var = variance_map(&var_groups);
        // Decks with no labeled copies: the box every other deck agreed on.
        let bbox = locate(&var).unwrap_or(FALLBACK_BOX);
        eprintln!("{set}: stamp box {bbox:?} from {} groups", var_groups.len());
        let mut by_key: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        for (i, r) in rows.iter().enumerate() {
            if !r.key.is_empty() && imgs[i].is_some() {
                by_key.entry(r.key.clone()).or_default().push(i);
            }
        }
        let sel = stamp_pixels(&var, bbox);
        let mut exemplars: BTreeMap<String, Model> = BTreeMap::new();
        let mut exemplar_img: BTreeMap<String, usize> = BTreeMap::new();
        for (key, ix) in &by_key {
            let members: Vec<&RgbaImage> = ix.iter().map(|&i| imgs[i].as_ref().unwrap()).collect();
            if let Some(m) = model(&members, bbox, &sel) {
                eprintln!("  {key}: ink {:?} from {}", m.ink.map(|c| c as u8), ix.len());
                exemplars.insert(key.clone(), m);
                exemplar_img.insert(key.clone(), ix[0]);
            }
        }
        let todo: Vec<usize> = (0..rows.len()).filter(|&i| rows[i].key.is_empty() && imgs[i].is_some()).collect();
        if todo.is_empty() {
            continue;
        }
        let cell_w = (bbox.w + 20) * 3;
        let cell_h = (bbox.h + 20) * 3;
        let cols = 6u32;
        let lines = (todo.len() as u32).div_ceil(cols);
        let mut sheet = RgbaImage::from_pixel(cols * (cell_w * 2 + 16), lines * (cell_h + 28), Rgba([20, 20, 22, 255]));
        for (n, &i) in todo.iter().enumerate() {
            let img = imgs[i].as_ref().unwrap();
            let v = classify(img, bbox, &exemplars);
            let key = if v.score < MIN_SCORE { "none".to_string() } else { v.key.clone() };
            let r = &rows[i];
            report.push_str(&format!(
                "{set}\t{}\t{}\t{}\t{key}\t{:.3}\t{:.3}\n",
                r.card_id, r.name, r.number, v.score, v.margin
            ));
            let (cx, cy) = ((n as u32 % cols) * (cell_w * 2 + 16), (n as u32 / cols) * (cell_h + 28));
            font::draw_number(&mut sheet, n + 1, cx + 2, cy + 4, 3, Rgba([255, 211, 61, 255]));
            imageops::overlay(&mut sheet, &crop_big(img, bbox), i64::from(cx), i64::from(cy + 24));
            if let Some(&e) = exemplar_img.get(&v.key) {
                imageops::overlay(&mut sheet, &crop_big(imgs[e].as_ref().unwrap(), bbox), i64::from(cx + cell_w + 4), i64::from(cy + 24));
            }
        }
        let slug: String = set.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
        DynamicImage::ImageRgba8(sheet).to_rgb8().save(out.join(format!("match-{slug}.jpg")))?;
    }
    fs::write(out.join("matches.tsv"), &report)?;
    if report.lines().count() <= 1 {
        bail!("nothing classified");
    }
    println!("{}", out.join("matches.tsv").display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_number_strips_the_stamp_text() {
        assert_eq!(base_number("089/214 | Mewtwo Stamp"), "089/214");
        assert_eq!(base_number("Pawniard Stampad | 045/053"), "045/053");
        assert_eq!(base_number("109 | Pikachu 28"), "109");
        assert_eq!(base_number("Unnumbered | Bulbasaur Stamp"), "");
    }

    fn card(stamp: Option<(u32, u32, [u8; 3])>) -> RgbaImage {
        let mut img = RgbaImage::from_pixel(W, H, Rgba([200, 220, 120, 255]));
        for y in 0..H {
            for x in 0..W {
                // Some layout texture shared by every copy.
                if (x / 7 + y / 11) % 3 == 0 {
                    img.put_pixel(x, y, Rgba([90, 120, 60, 255]));
                }
            }
        }
        if let Some((sx, sy, c)) = stamp {
            for y in sy..sy + 18 {
                for x in sx..sx + 14 {
                    let on = (x - sx) < 4 || (y - sy) % 6 < 2;
                    if on {
                        img.put_pixel(x, y, Rgba([c[0], c[1], c[2], 255]));
                    }
                }
            }
        }
        img
    }

    #[test]
    fn variance_finds_the_stamp_and_ncc_tells_stamps_apart() {
        let red = card(Some((250, 300, [220, 30, 30])));
        let blue = card(Some((250, 300, [30, 60, 220])));
        let var = variance_map(&[vec![&red, &blue]]);
        let b = locate(&var).expect("box");
        assert!(b.x <= 250 && b.x + b.w >= 263, "{b:?}");
        assert!(b.y <= 300 && b.y + b.h >= 317, "{b:?}");
        let mut ex = BTreeMap::new();
        let sel = stamp_pixels(&var, b);
        ex.insert("red".to_string(), model(&[&red], b, &sel).unwrap());
        ex.insert("blue".to_string(), model(&[&blue], b, &sel).unwrap());
        // Same stamp printed 3 px off.
        let shifted = card(Some((253, 302, [30, 60, 220])));
        let v = classify(&shifted, b, &ex);
        assert_eq!(v.key, "blue");
        assert!(v.score > 0.5 && v.margin > 0.3, "{} {}", v.score, v.margin);
    }
}
