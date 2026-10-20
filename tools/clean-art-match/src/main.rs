//! Match artofpkm clean artworks (no card text) to Pokoin CLIP versions, then
//! carry figure masks cut on the clean painting into each leftover scan's frame.
//!
//! `match`: CLIP art-box kNN (clean-clip.npy vs artbox-clip.npz) plus name/number
//! candidates propose versions; each one is verified by ORB + RANSAC registration
//! of the clean painting onto the scan its figure mask is drawn on (the Qwen
//! `image_key`). A homography that is a clean similarity, with enough inliers and
//! pixel agreement (NCC) after warping, is the same painting. Every verified
//! version is matched; weak evidence is ambiguous; nothing verified is unmatched.
//!
//! `prompts`: SAM box prompts in clean-art pixels (Qwen boxes mapped through H⁻¹).
//! `warp`: clean-frame alpha masks → `{version}.webp` at the scan's size.

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use image::{GrayImage, ImageBuffer, Luma, Rgb, RgbImage, Rgba, RgbaImage};
use pokoin_artwork_matcher::{homography, orb};
use rayon::prelude::*;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

type Mat3 = [f64; 9];

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Propose and geometrically verify versions for every clean artwork.
    Match(MatchArgs),
    /// Write SAM box prompts in clean-art pixel coordinates for matched versions.
    Prompts {
        #[arg(long)]
        matches: PathBuf,
        #[arg(long)]
        qwen: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
    /// Warp clean-frame masks into each scan frame and write lossless WebP masks.
    /// Paint each clean artwork into its scan's frame (upscaled to ~1024 px tall)
    /// so SAM sees the card's framing and Qwen boxes, minus the card text.
    Composite {
        #[arg(long)]
        prompts: PathBuf,
        #[arg(long)]
        dump: PathBuf,
        #[arg(long, default_value = "/home/nez/data/pokoin-leftovers/objects")]
        objects: PathBuf,
        /// Composite PNGs land here; the rewritten prompts go to OUT/prompts.jsonl.
        #[arg(long)]
        out: PathBuf,
    },
    /// Before/after: production mask vs warped clean-art mask on the same scan.
    Compare {
        #[arg(long)]
        prompts: PathBuf,
        #[arg(long, default_value = "/home/nez/data/pokoin-leftovers/objects")]
        objects: PathBuf,
        #[arg(
            long,
            default_value = "/home/nez/data/pokoin-leftovers/objects/figure-masks-clean"
        )]
        old: PathBuf,
        #[arg(long)]
        new: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
    Warp {
        /// Cut the mask where opaque card UI covers the painting (composite frame only).
        #[arg(long)]
        ui_clip_objects: Option<PathBuf>,
        #[arg(long)]
        prompts: PathBuf,
        /// Directory with `{version}.png` masks in clean-art pixels (from SAM).
        #[arg(long)]
        clean_masks: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
}

#[derive(Parser)]
struct MatchArgs {
    /// artofpkm catalog dump (artworks.jsonl + assets/).
    #[arg(long)]
    dump: PathBuf,
    /// Folder with clean-clip.npy/.jsonl and candidates.tsv; outputs land here.
    #[arg(long)]
    work: PathBuf,
    #[arg(
        long,
        default_value = "/home/nez/Projects/pokemon-card-extension/scripts/out/artbox-clip.npz"
    )]
    gallery: PathBuf,
    #[arg(
        long,
        default_value = "/home/nez/Projects/pokoin-web/scripts/out/qwen-artwork-figures.jsonl"
    )]
    qwen: PathBuf,
    #[arg(long, default_value = "/home/nez/data/pokoin-leftovers/objects")]
    objects: PathBuf,
    /// CLIP neighbours (printings) whose versions are verified.
    #[arg(long, default_value_t = 40)]
    knn: usize,
    /// Most versions verified per artwork.
    #[arg(long, default_value_t = 10)]
    max_versions: usize,
    /// Also register every other printing of a matched version (frame drift report).
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    all_printings: bool,
    /// Write review PNGs (clean | scan | overlay) under WORK/review/.
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    review: bool,
    #[arg(long)]
    limit: Option<usize>,
}

// ---------- small numerics ----------

fn mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut r = [0.0; 9];
    for i in 0..3 {
        for j in 0..3 {
            r[i * 3 + j] = (0..3).map(|k| a[i * 3 + k] * b[k * 3 + j]).sum();
        }
    }
    r
}

fn inv(m: &Mat3) -> Option<Mat3> {
    let [a, b, c, d, e, f, g, h, i] = *m;
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if det.abs() < 1e-12 {
        return None;
    }
    let r = [
        e * i - f * h,
        c * h - b * i,
        b * f - c * e,
        f * g - d * i,
        a * i - c * g,
        c * d - a * f,
        d * h - e * g,
        b * g - a * h,
        a * e - b * d,
    ];
    Some(r.map(|v| v / det))
}

fn scale(sx: f64, sy: f64) -> Mat3 {
    [sx, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 1.0]
}

fn apply(h: &Mat3, x: f64, y: f64) -> (f64, f64) {
    let w = h[6] * x + h[7] * y + h[8];
    (
        (h[0] * x + h[1] * y + h[2]) / w,
        (h[3] * x + h[4] * y + h[5]) / w,
    )
}

fn normalized(h: &Mat3) -> Mat3 {
    h.map(|v| v / h[8])
}

// ---------- io ----------

struct Npy {
    shape: Vec<usize>,
    descr: String,
    data: Vec<u8>,
}

fn parse_npy(bytes: &[u8]) -> Result<Npy> {
    if !bytes.starts_with(b"\x93NUMPY") {
        bail!("not an npy file");
    }
    let major = bytes[6];
    let (hlen, start) = if major == 1 {
        (u16::from_le_bytes([bytes[8], bytes[9]]) as usize, 10)
    } else {
        (
            u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize,
            12,
        )
    };
    let header = std::str::from_utf8(&bytes[start..start + hlen])?;
    if header.contains("'fortran_order': True") {
        bail!("fortran order unsupported");
    }
    let descr = header
        .split("'descr':")
        .nth(1)
        .and_then(|s| s.split('\'').nth(1))
        .ok_or_else(|| anyhow!("npy descr"))?;
    let shape_s = header
        .split("'shape':")
        .nth(1)
        .and_then(|s| s.split('(').nth(1))
        .and_then(|s| s.split(')').next())
        .ok_or_else(|| anyhow!("npy shape"))?;
    let shape = shape_s
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<usize>())
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Npy {
        shape,
        descr: descr.to_string(),
        data: bytes[start + hlen..].to_vec(),
    })
}

fn f32s(n: &Npy) -> Result<Vec<f32>> {
    if n.descr != "<f4" {
        bail!("expected <f4, got {}", n.descr);
    }
    Ok(n.data
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect())
}

fn i64s(n: &Npy) -> Result<Vec<i64>> {
    match n.descr.as_str() {
        "<i8" => Ok(n
            .data
            .as_chunks::<8>()
            .0
            .iter()
            .map(|c| i64::from_le_bytes(*c))
            .collect()),
        "<i4" => Ok(n
            .data
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| i32::from_le_bytes(*c) as i64)
            .collect()),
        d => bail!("unsupported id dtype {d}"),
    }
}

fn npz_member(path: &Path, name: &str) -> Result<Npy> {
    let mut z = zip::ZipArchive::new(fs::File::open(path)?)?;
    let mut f = z.by_name(name)?;
    let mut b = Vec::new();
    f.read_to_end(&mut b)?;
    parse_npy(&b)
}

fn jsonl(path: &Path) -> Result<Vec<Value>> {
    let f = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    BufReader::new(f)
        .lines()
        .filter(|l| l.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(true))
        .map(|l| Ok(serde_json::from_str(&l?)?))
        .collect()
}

fn load_rgb(path: &Path) -> Result<RgbImage> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    if bytes.starts_with(&[0xff, 0xd8]) {
        // jpeg-decoder: image 0.25's zune path ghosts some leftover JPEGs.
        let mut d = jpeg_decoder::Decoder::new(&bytes[..]);
        let px = d.decode()?;
        let info = d.info().ok_or_else(|| anyhow!("jpeg info"))?;
        let (w, h) = (info.width as u32, info.height as u32);
        let rgb = match info.pixel_format {
            jpeg_decoder::PixelFormat::RGB24 => px,
            jpeg_decoder::PixelFormat::L8 => px.iter().flat_map(|&v| [v, v, v]).collect(),
            jpeg_decoder::PixelFormat::CMYK32 => px
                .as_chunks::<4>()
                .0
                .iter()
                .flat_map(|c| {
                    let k = 255 - c[3] as u32;
                    [
                        (255 - c[0] as u32) * k / 255,
                        (255 - c[1] as u32) * k / 255,
                        (255 - c[2] as u32) * k / 255,
                    ]
                    .map(|v| v as u8)
                })
                .collect(),
            f => bail!("jpeg pixel format {f:?}"),
        };
        return RgbImage::from_raw(w, h, rgb).ok_or_else(|| anyhow!("jpeg buffer"));
    }
    Ok(image::load_from_memory(&bytes)?.to_rgb8())
}

fn gray(img: &RgbImage) -> GrayImage {
    image::imageops::grayscale(img)
}

// ---------- catalogue ----------

#[derive(Clone)]
struct Cand {
    card_id: i64,
    ct_id: i64,
    version: String,
    name: String,
    set_name: String,
    number: String,
    art_layout: String,
    artist: String,
    image: String,
}

fn norm(s: &str) -> String {
    let base = s.split('(').next().unwrap_or(s);
    let lower = base.to_lowercase();
    let base = match lower.find(" lv.").or_else(|| lower.find(" lv ")) {
        Some(i) => &base[..i],
        None => base,
    };
    base.chars()
        .map(|c| match c {
            'é' | 'É' | 'è' => 'e',
            '♀' => 'f',
            '♂' => 'm',
            c => c.to_ascii_lowercase(),
        })
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

/// "Rare | 082/071" → Some((82, "071")): printed number and set total.
fn collector(s: &str) -> Option<(u32, String)> {
    let tok = s.rsplit(['|', ' ']).find(|t| t.contains('/'))?;
    let (n, m) = tok.trim().split_once('/')?;
    let digits: String = n.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || n.chars().any(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    Some((
        digits.parse().ok()?,
        m.trim().trim_start_matches('0').to_ascii_lowercase(),
    ))
}

fn load_candidates(path: &Path) -> Result<Vec<Cand>> {
    let mut out = Vec::new();
    for line in BufReader::new(fs::File::open(path)?).lines() {
        let line = line?;
        let c: Vec<&str> = line.split('\t').collect();
        if c.len() < 11 {
            continue;
        }
        out.push(Cand {
            card_id: c[0].parse()?,
            ct_id: c[1].parse()?,
            version: c[2].to_string(),
            name: c[3].to_string(),
            set_name: c[4].to_string(),
            number: c[6].to_string(),
            art_layout: c[7].to_string(),
            artist: if c[9].is_empty() {
                c[8].to_string()
            } else {
                c[9].to_string()
            },
            image: c[10]
                .rsplit('/')
                .next()
                .unwrap_or("")
                .split('?')
                .next()
                .unwrap_or("")
                .to_string(),
        });
    }
    Ok(out)
}

// ---------- registration ----------

struct Feats {
    pts: Vec<(f32, f32)>,
    desc: Vec<[u64; 4]>,
}

fn orb_feats(g: &GrayImage, n: usize) -> Feats {
    let p = orb::Params {
        nfeatures: n,
        scale_factor: 1.2,
        nlevels: 8,
        edge_threshold: 31,
        patch_size: 31,
        fast_threshold: 12,
    };
    let (kps, desc) = orb::detect_and_compute(
        g.as_raw(),
        g.width() as usize,
        g.height() as usize,
        None,
        &p,
        1,
    );
    Feats {
        pts: kps.iter().map(|k| (k.x, k.y)).collect(),
        desc: desc
            .iter()
            .map(|d| {
                std::array::from_fn(|i| u64::from_le_bytes(d[i * 8..i * 8 + 8].try_into().unwrap()))
            })
            .collect(),
    }
}

fn ham(a: &[u64; 4], b: &[u64; 4]) -> u32 {
    (0..4).map(|i| (a[i] ^ b[i]).count_ones()).sum()
}

/// Mutual nearest neighbours that also pass Lowe's ratio test.
fn match_feats(a: &Feats, b: &Feats) -> Vec<(usize, usize)> {
    let best = |q: &[u64; 4], set: &[[u64; 4]]| {
        let (mut b1, mut b2, mut bi) = (u32::MAX, u32::MAX, 0usize);
        for (i, d) in set.iter().enumerate() {
            let h = ham(q, d);
            if h < b1 {
                b2 = b1;
                b1 = h;
                bi = i;
            } else if h < b2 {
                b2 = h;
            }
        }
        (bi, b1, b2)
    };
    let back: Vec<usize> = b.desc.iter().map(|d| best(d, &a.desc).0).collect();
    a.desc
        .iter()
        .enumerate()
        .filter_map(|(i, d)| {
            let (j, d1, d2) = best(d, &b.desc);
            (back[j] == i && (d1 as f32) < 0.85 * d2 as f32 && d1 < 80).then_some((i, j))
        })
        .collect()
}

struct Reg {
    h: Mat3, // clean original px → scan original px
    inliers: usize,
    interior_inliers: usize,
    matches: usize,
    ncc: f64,
    ncc_edge: f64,
    geom_ok: bool,
    geom: Value,
}

struct Prepared {
    img: RgbImage,
    work: GrayImage,
    to_work: f64,
    feats: Feats,
}

fn prepare(img: RgbImage, target_w: f64, n: usize) -> Prepared {
    let to_work = (target_w / img.width() as f64).min(1.0);
    let (w, h) = (
        (img.width() as f64 * to_work).round() as u32,
        (img.height() as f64 * to_work).round() as u32,
    );
    let small = if to_work < 1.0 {
        image::imageops::resize(&img, w, h, image::imageops::FilterType::Triangle)
    } else {
        img.clone()
    };
    let work = gray(&small);
    let feats = orb_feats(&work, n);
    Prepared {
        img,
        work,
        to_work,
        feats,
    }
}

/// Clean painting at the scale it should have on a scan `scan_w` wide.
fn prep_clean<'a>(
    cache: &'a mut HashMap<u32, Prepared>,
    img: &RgbImage,
    portrait: bool,
    scan_w: u32,
) -> &'a Prepared {
    let target = if portrait {
        scan_w as f64
    } else {
        scan_w as f64 * 0.88
    };
    cache
        .entry(scan_w)
        .or_insert_with(|| prepare(img.clone(), target, 4000))
}

fn bilinear(g: &GrayImage, x: f64, y: f64) -> Option<f64> {
    let (w, h) = (g.width() as f64, g.height() as f64);
    if x < 0.0 || y < 0.0 || x > w - 1.0 || y > h - 1.0 {
        return None;
    }
    let (x0, y0) = (x.floor() as u32, y.floor() as u32);
    let (x1, y1) = ((x0 + 1).min(g.width() - 1), (y0 + 1).min(g.height() - 1));
    let (fx, fy) = (x - x0 as f64, y - y0 as f64);
    let p = |xx, yy| g.get_pixel(xx, yy)[0] as f64;
    Some(
        p(x0, y0) * (1.0 - fx) * (1.0 - fy)
            + p(x1, y0) * fx * (1.0 - fy)
            + p(x0, y1) * (1.0 - fx) * fy
            + p(x1, y1) * fx * fy,
    )
}

fn sobel(g: &GrayImage) -> GrayImage {
    let (w, h) = g.dimensions();
    ImageBuffer::from_fn(w, h, |x, y| {
        if x == 0 || y == 0 || x + 1 >= w || y + 1 >= h {
            return Luma([0]);
        }
        let p = |dx: i32, dy: i32| {
            g.get_pixel((x as i32 + dx) as u32, (y as i32 + dy) as u32)[0] as i32
        };
        let gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
        let gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
        Luma([(((gx * gx + gy * gy) as f64).sqrt() / 4.0).min(255.0) as u8])
    })
}

fn ncc_pairs(pairs: &[(f64, f64)]) -> f64 {
    let n = pairs.len() as f64;
    if n < 100.0 {
        return 0.0;
    }
    let (ma, mb) = (
        pairs.iter().map(|p| p.0).sum::<f64>() / n,
        pairs.iter().map(|p| p.1).sum::<f64>() / n,
    );
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for (a, b) in pairs {
        sab += (a - ma) * (b - mb);
        saa += (a - ma) * (a - ma);
        sbb += (b - mb) * (b - mb);
    }
    if saa <= 0.0 || sbb <= 0.0 {
        0.0
    } else {
        sab / (saa * sbb).sqrt()
    }
}

/// Clean painting → scan. The homography must stay a near-rectangle (upright,
/// no shear, mild keystone) that keeps the painting on the card.
fn register(clean: &Prepared, scan: &Prepared) -> Option<Reg> {
    let m = match_feats(&clean.feats, &scan.feats);
    if m.len() < 8 {
        return None;
    }
    let src: Vec<(f32, f32)> = m.iter().map(|&(i, _)| clean.feats.pts[i]).collect();
    let dst: Vec<(f32, f32)> = m.iter().map(|&(_, j)| scan.feats.pts[j]).collect();
    let (hw, mask) = homography::find_homography_ransac(&src, &dst, 3.0, 0.999, 5000)?;
    let inliers = mask.iter().filter(|&&v| v != 0).count();
    // Portrait "clean" artworks of V/VMAX cards keep the card frame (corner stripes,
    // bottom bars). Frame features match any card of that frame, so evidence only
    // counts inside the painting.
    let (cw0, ch0) = (clean.work.width() as f32, clean.work.height() as f32);
    let ib = interior(clean.img.height() > clean.img.width());
    let inside = |(x, y): (f32, f32)| {
        x >= ib.0 as f32 * cw0
            && x <= ib.2 as f32 * cw0
            && y >= ib.1 as f32 * ch0
            && y <= ib.3 as f32 * ch0
    };
    let interior_inliers = mask
        .iter()
        .zip(&src)
        .filter(|(&v, &p)| v != 0 && inside(p))
        .count();
    // Work → original coordinates on both sides.
    let h = normalized(&mul(
        &mul(&scale(1.0 / scan.to_work, 1.0 / scan.to_work), &hw),
        &scale(clean.to_work, clean.to_work),
    ));
    let (cw, ch) = (clean.img.width() as f64, clean.img.height() as f64);
    let (sw, sh) = (scan.img.width() as f64, scan.img.height() as f64);
    let c = [(0.0, 0.0), (cw, 0.0), (cw, ch), (0.0, ch)].map(|(x, y)| apply(&h, x, y));
    let len = |a: (f64, f64), b: (f64, f64)| ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt();
    let (top, right, bottom, left) = (
        len(c[0], c[1]),
        len(c[1], c[2]),
        len(c[2], c[3]),
        len(c[3], c[0]),
    );
    let sx = (top + bottom) / 2.0 / cw;
    let sy = (left + right) / 2.0 / ch;
    let tilt = ((c[1].1 - c[0].1) / (c[1].0 - c[0].0)).atan().to_degrees();
    let center = apply(&h, cw / 2.0, ch / 2.0);
    // Leftover scans are photos, often keystoned (older cards up to ~12%), so allow
    // perspective but no rotation or shear. V-UNION paintings span four cards, so
    // the painting may overhang the card as long as it covers a good part of it.
    let xs = c.map(|p| p.0 / sw);
    let ys = c.map(|p| p.1 / sh);
    let ix = (xs.iter().cloned().fold(f64::MIN, f64::max).min(1.0)
        - xs.iter().cloned().fold(f64::MAX, f64::min).max(0.0))
    .max(0.0);
    let iy = (ys.iter().cloned().fold(f64::MIN, f64::max).min(1.0)
        - ys.iter().cloned().fold(f64::MAX, f64::min).max(0.0))
    .max(0.0);
    let geom_ok = (top / bottom - 1.0).abs() < 0.15
        && (left / right - 1.0).abs() < 0.15
        && (sx / sy - 1.0).abs() < 0.12
        && tilt.abs() < 3.0
        && ix * iy > 0.2
        && top / sw > 0.4
        && top / sw < 2.2;
    let _ = center;
    let geom = json!({"sx": sx, "sy": sy, "tilt_deg": tilt, "width_frac": top / sw, "corners": c.map(|p| [p.0 / sw, p.1 / sh])});
    // Pixel agreement: warp clean into scan frame (scan work resolution, step 2).
    let hinv = inv(&h)?;
    let clean_g = gray(&clean.img);
    let clean_e = sobel(&clean_g);
    let scan_e = sobel(&scan.work);
    let (mut lum, mut edge) = (Vec::new(), Vec::new());
    for y in (0..scan.work.height()).step_by(2) {
        for x in (0..scan.work.width()).step_by(2) {
            let (ox, oy) = (x as f64 / scan.to_work, y as f64 / scan.to_work);
            let (qx, qy) = apply(&hinv, ox, oy);
            let (cwo, cho) = (clean.img.width() as f64, clean.img.height() as f64);
            if qx < ib.0 * cwo || qx > ib.2 * cwo || qy < ib.1 * cho || qy > ib.3 * cho {
                continue;
            }
            if let Some(v) = bilinear(&clean_g, qx, qy) {
                lum.push((v, scan.work.get_pixel(x, y)[0] as f64));
                if let Some(e) = bilinear(&clean_e, qx, qy) {
                    edge.push((e, scan_e.get_pixel(x, y)[0] as f64));
                }
            }
        }
    }
    Some(Reg {
        h,
        inliers,
        interior_inliers,
        matches: m.len(),
        ncc: ncc_pairs(&lum),
        ncc_edge: ncc_pairs(&edge),
        geom_ok,
        geom,
    })
}

/// Painting interior of a clean artwork, as fractions (left, top, right, bottom).
fn interior(portrait: bool) -> (f64, f64, f64, f64) {
    if portrait {
        (0.10, 0.10, 0.90, 0.80)
    } else {
        (0.03, 0.03, 0.97, 0.97)
    }
}

fn verified(r: &Reg) -> bool {
    // Foil and recoloured printings lower NCC; a large geometric consensus suffices.
    r.geom_ok
        && r.interior_inliers >= 25
        && (r.ncc >= 0.35 || (r.interior_inliers >= 100 && r.ncc >= 0.2))
}

fn weak(r: &Reg) -> bool {
    r.geom_ok && r.interior_inliers >= 12
}

// ---------- review sheet ----------

fn fit_h(img: &RgbImage, h: u32) -> RgbImage {
    let w = (img.width() as f64 * h as f64 / img.height() as f64)
        .round()
        .max(1.0) as u32;
    image::imageops::resize(img, w, h, image::imageops::FilterType::Triangle)
}

fn review_png(path: &Path, clean: &RgbImage, scan: &RgbImage, h: &Mat3) -> Result<()> {
    const H: u32 = 420;
    let a = fit_h(clean, H);
    let b = fit_h(scan, H);
    // Overlay: scan with the warped clean painting's edges in magenta.
    let hinv = inv(h).ok_or_else(|| anyhow!("singular"))?;
    let ce = sobel(&gray(clean));
    let k = scan.height() as f64 / H as f64;
    let mut o = b.clone();
    for y in 0..o.height() {
        for x in 0..o.width() {
            let (qx, qy) = apply(&hinv, x as f64 * k, y as f64 * k);
            if let Some(e) = bilinear(&ce, qx, qy) {
                if e > 60.0 {
                    o.put_pixel(x, y, Rgb([255, 0, 255]));
                }
            } else {
                let p = o.get_pixel(x, y).0;
                o.put_pixel(x, y, Rgb(p.map(|v| v / 3)));
            }
        }
    }
    let w = a.width() + b.width() + o.width() + 16;
    let mut sheet = RgbImage::from_pixel(w, H, Rgb([20, 20, 24]));
    image::imageops::overlay(&mut sheet, &a, 0, 0);
    image::imageops::overlay(&mut sheet, &b, (a.width() + 8) as i64, 0);
    image::imageops::overlay(&mut sheet, &o, (a.width() + b.width() + 16) as i64, 0);
    if let Some(p) = path.parent() {
        fs::create_dir_all(p)?;
    }
    sheet.save(path)?;
    Ok(())
}

// ---------- match ----------

fn scan_path(objects: &Path, key: &str) -> Option<PathBuf> {
    let p = objects.join(key);
    p.exists().then_some(p)
}

fn run_match(a: MatchArgs) -> Result<()> {
    let arts = jsonl(&a.dump.join("artworks.jsonl"))?;
    let rows = jsonl(&a.work.join("clean-clip.jsonl"))?;
    let clean_vecs = f32s(&parse_npy(&fs::read(a.work.join("clean-clip.npy"))?)?)?;
    let gid = i64s(&npz_member(&a.gallery, "ids.npy")?)?;
    let gnpy = npz_member(&a.gallery, "vecs.npy")?;
    let dim = gnpy.shape[1];
    let gvec = f32s(&gnpy)?;
    let cands = load_candidates(&a.work.join("candidates.tsv"))?;
    eprintln!(
        "{} artworks, {} clean vectors, gallery {}×{dim}, {} candidates",
        arts.len(),
        rows.len(),
        gid.len(),
        cands.len()
    );
    let by_card: HashMap<i64, usize> = cands
        .iter()
        .enumerate()
        .map(|(i, c)| (c.card_id, i))
        .collect();
    let mut by_version: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_number: HashMap<(u32, String), Vec<usize>> = HashMap::new();
    for (i, c) in cands.iter().enumerate() {
        if !c.version.is_empty() {
            by_version.entry(c.version.clone()).or_default().push(i);
        }
        if let Some(k) = collector(&c.number) {
            by_number.entry(k).or_default().push(i);
        }
    }
    let mut qwen: HashMap<String, Value> = HashMap::new();
    for r in jsonl(&a.qwen)? {
        if let Some(v) = r["version"].as_str() {
            qwen.insert(v.to_string(), r);
        }
    }
    let mut vec_rows: HashMap<i64, Vec<usize>> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        vec_rows
            .entry(r["artwork_id"].as_i64().unwrap_or(-1))
            .or_default()
            .push(i);
    }

    let arts: Vec<Value> = arts
        .into_iter()
        .take(a.limit.unwrap_or(usize::MAX))
        .collect();
    let results: Vec<Value> = arts
        .par_iter()
        .map(|art| -> Value {
            let id = art["artwork_id"].as_i64().unwrap_or(-1);
            match match_one(&a, art, id, &vec_rows, &clean_vecs, &gid, &gvec, dim, &cands, &by_card, &by_version, &by_number, &qwen) {
                Ok(v) => v,
                Err(e) => json!({"artwork_id": id, "title": art["title"], "status": "error", "error": e.to_string()}),
            }
        })
        .collect();

    let mut out = String::new();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut versions = BTreeSet::new();
    for r in &results {
        *counts
            .entry(r["status"].as_str().unwrap_or("?").to_string())
            .or_default() += 1;
        for v in r["versions"].as_array().into_iter().flatten() {
            versions.insert(v.as_str().unwrap_or("").to_string());
        }
        out.push_str(&serde_json::to_string(r)?);
        out.push('\n');
    }
    fs::write(a.work.join("match.jsonl"), out)?;
    let summary =
        json!({"artworks": results.len(), "status": counts, "matched_versions": versions.len()});
    fs::write(
        a.work.join("match-summary.json"),
        serde_json::to_vec_pretty(&summary)?,
    )?;
    println!("{summary}");
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn match_one(
    a: &MatchArgs,
    art: &Value,
    id: i64,
    vec_rows: &HashMap<i64, Vec<usize>>,
    clean_vecs: &[f32],
    gid: &[i64],
    gvec: &[f32],
    dim: usize,
    cands: &[Cand],
    by_card: &HashMap<i64, usize>,
    by_version: &HashMap<String, Vec<usize>>,
    by_number: &HashMap<(u32, String), Vec<usize>>,
    qwen: &HashMap<String, Value>,
) -> Result<Value> {
    // 1. CLIP neighbours: best score over this artwork's crops.
    let mine = vec_rows.get(&id).cloned().unwrap_or_default();
    let mut scores: Vec<(f32, usize)> = (0..gid.len())
        .map(|g| {
            let gv = &gvec[g * dim..(g + 1) * dim];
            let best = mine
                .iter()
                .map(|&r| {
                    clean_vecs[r * dim..(r + 1) * dim]
                        .iter()
                        .zip(gv)
                        .map(|(x, y)| x * y)
                        .sum::<f32>()
                })
                .fold(f32::MIN, f32::max);
            (best, g)
        })
        .collect();
    scores.sort_by(|x, y| y.0.total_cmp(&x.0));
    let top: Vec<(f32, i64)> = scores
        .iter()
        .take(a.knn)
        .map(|&(s, g)| (s, gid[g]))
        .collect();

    // 2. Candidate versions: CLIP + name/number from the artwork and its linked card pages.
    let name = norm(art["name"].as_str().unwrap_or(""));
    let mut numbers: BTreeSet<(u32, String)> = BTreeSet::new();
    if let Some(k) = art["collector_number"].as_str().and_then(collector) {
        numbers.insert(k);
    }
    for c in art["cards"].as_array().into_iter().flatten() {
        if let Some(k) = c["meta"]["identity"]["collector_number"]
            .as_str()
            .and_then(collector)
        {
            numbers.insert(k);
        }
    }
    let illustrator = norm(art["illustrator"]["name"].as_str().unwrap_or(""));
    let mut proposed: Vec<(String, &'static str, f32)> = Vec::new();
    let add =
        |v: &str, src: &'static str, s: f32, proposed: &mut Vec<(String, &'static str, f32)>| {
            if v.is_empty() {
                return;
            }
            if let Some(p) = proposed.iter_mut().find(|p| p.0 == v) {
                if p.1 != src {
                    p.1 = "both";
                }
                p.2 = p.2.max(s);
            } else {
                proposed.push((v.to_string(), src, s));
            }
        };
    for &(s, cid) in &top {
        if let Some(&i) = by_card.get(&cid) {
            add(&cands[i].version, "clip", s, &mut proposed);
        }
    }
    proposed.truncate(a.max_versions);
    for k in &numbers {
        for &i in by_number.get(k).into_iter().flatten() {
            let n = norm(&cands[i].name);
            if !name.is_empty() && (n == name || n.starts_with(&name) || name.starts_with(&n)) {
                add(&cands[i].version, "meta", 0.0, &mut proposed);
            }
        }
    }

    // 3. Register the clean painting on each version's mask scan.
    let asset = art["assets"]
        .as_array()
        .and_then(|x| x.first())
        .ok_or_else(|| anyhow!("no asset"))?;
    let clean_img = load_rgb(&a.dump.join(asset["path"].as_str().unwrap_or("")))?;
    let portrait = clean_img.height() > clean_img.width();
    let mut clean_cache: HashMap<u32, Prepared> = HashMap::new();
    let mut checked = Vec::new();
    let mut best: Option<(f64, String)> = None;
    for (v, src, clip) in &proposed {
        let members = by_version.get(v).cloned().unwrap_or_default();
        let key = qwen
            .get(v)
            .and_then(|q| q["image_key"].as_str())
            .map(str::to_string);
        let rep_i = key
            .as_ref()
            .and_then(|k| members.iter().copied().find(|&i| cands[i].image == *k))
            .or_else(|| {
                members
                    .iter()
                    .copied()
                    .find(|&i| scan_path(&a.objects, &cands[i].image).is_some())
            });
        let scan_key = key
            .clone()
            .or_else(|| rep_i.map(|i| cands[i].image.clone()));
        let Some(scan_file) = scan_key.as_deref().and_then(|k| scan_path(&a.objects, k)) else {
            checked
                .push(json!({"version": v, "source": src, "clip": clip, "error": "no local scan"}));
            continue;
        };
        let scan_img = load_rgb(&scan_file)?;
        let scan = prepare(scan_img, 900.0, 4000);
        let clean = prep_clean(&mut clean_cache, &clean_img, portrait, scan.work.width());
        let rep = rep_i.map(|i| &cands[i]);
        let meta = rep.map(|c| {
            let n = norm(&c.name);
            json!({
                "card_id": c.card_id, "ct_id": c.ct_id, "name": c.name, "set": c.set_name, "number": c.number,
                "art_layout": c.art_layout, "artist": c.artist,
                "name_ok": !name.is_empty() && (n == name || n.starts_with(&name) || name.starts_with(&n)),
                "number_ok": collector(&c.number).is_some_and(|k| numbers.contains(&k)),
                "artist_ok": !illustrator.is_empty() && norm(&c.artist) == illustrator,
            })
        });
        let entry = match register(clean, &scan) {
            None => {
                json!({"version": v, "source": src, "clip": clip, "scan": scan_key, "rep": meta, "inliers": 0, "verified": false})
            }
            Some(r) => {
                if a.review && (verified(&r) || weak(&r)) {
                    review_png(
                        &a.work.join("review").join(format!("{id}_{v}.png")),
                        &clean_img,
                        &scan.img,
                        &r.h,
                    )?;
                }
                let score = r.interior_inliers as f64 * r.ncc.max(0.0);
                if verified(&r) && best.as_ref().is_none_or(|b| score > b.0) {
                    best = Some((score, v.clone()));
                }
                json!({
                    "version": v, "source": src, "clip": clip, "scan": scan_key, "scan_size": [scan.img.width(), scan.img.height()],
                    "has_qwen": key.is_some(), "rep": meta, "inliers": r.inliers, "interior_inliers": r.interior_inliers, "matches": r.matches,
                    "ncc": r.ncc, "ncc_edge": r.ncc_edge, "geom_ok": r.geom_ok, "geom": r.geom, "h": r.h,
                    "verified": verified(&r), "weak": weak(&r),
                })
            }
        };
        checked.push(entry);
    }

    // 4. Other printings of each verified version: per-printing frames and drift.
    if a.all_printings {
        for c in checked.iter_mut().filter(|c| c["verified"] == json!(true)) {
            let v = c["version"].as_str().unwrap_or("").to_string();
            let rep_corners = c["geom"]["corners"].clone();
            let mut printings = Vec::new();
            for &i in by_version.get(&v).into_iter().flatten() {
                let p = &cands[i];
                if Some(p.image.as_str()) == c["scan"].as_str() {
                    continue;
                }
                let Some(f) = scan_path(&a.objects, &p.image) else {
                    printings.push(
                        json!({"card_id": p.card_id, "image": p.image, "error": "no local scan"}),
                    );
                    continue;
                };
                let Ok(img) = load_rgb(&f) else { continue };
                let scan = prepare(img, 900.0, 4000);
                let clean = prep_clean(&mut clean_cache, &clean_img, portrait, scan.work.width());
                let row = match register(clean, &scan) {
                    Some(r) => {
                        let drift = r.geom["corners"]
                            .as_array()
                            .zip(rep_corners.as_array())
                            .map(|(x, y)| {
                                x.iter()
                                    .zip(y)
                                    .map(|(p, q)| {
                                        let dx = p[0].as_f64().unwrap_or(0.0)
                                            - q[0].as_f64().unwrap_or(0.0);
                                        let dy = p[1].as_f64().unwrap_or(0.0)
                                            - q[1].as_f64().unwrap_or(0.0);
                                        (dx * dx + dy * dy).sqrt()
                                    })
                                    .fold(0.0, f64::max)
                            });
                        json!({"card_id": p.card_id, "image": p.image, "set": p.set_name, "number": p.number,
                            "inliers": r.inliers, "interior_inliers": r.interior_inliers, "ncc": r.ncc, "verified": verified(&r), "corner_drift_vs_rep": drift})
                    }
                    None => {
                        json!({"card_id": p.card_id, "image": p.image, "set": p.set_name, "number": p.number, "inliers": 0, "verified": false})
                    }
                };
                printings.push(row);
            }
            c["printings"] = json!(printings);
        }
    }

    // A verified version is confident when its name agrees with the artwork, or
    // when the painting evidence alone is overwhelming (art reused under another
    // card name, catalogue spelling slips). Everything else stays out.
    for c in checked.iter_mut() {
        let strong = c["interior_inliers"].as_u64().unwrap_or(0) >= 60
            && c["ncc"].as_f64().unwrap_or(0.0) >= 0.6;
        let confident =
            c["verified"] == json!(true) && (c["rep"]["name_ok"] == json!(true) || strong);
        c["confident"] = json!(confident);
    }
    let ok: Vec<String> = checked
        .iter()
        .filter(|c| c["confident"] == json!(true))
        .map(|c| c["version"].as_str().unwrap_or("").to_string())
        .collect();
    let doubtful = checked.iter().any(|c| {
        c["confident"] != json!(true) && (c["verified"] == json!(true) || c["weak"] == json!(true))
    });
    let status = if !ok.is_empty() {
        "matched"
    } else if doubtful {
        "ambiguous"
    } else {
        "unmatched"
    };
    Ok(json!({
        "artwork_id": id, "title": art["title"], "name": art["name"], "collector_number": art["collector_number"],
        "linked_numbers": numbers.iter().map(|(n, m)| format!("{n}/{m}")).collect::<Vec<_>>(),
        "illustrator": art["illustrator"]["name"], "asset": asset["path"], "clean_size": [clean_img.width(), clean_img.height()],
        "shape": if portrait { "portrait" } else { "landscape" },
        "clip_top": top.iter().take(8).map(|(s, cid)| {
            let c = by_card.get(cid).map(|&i| &cands[i]);
            json!({"card_id": cid, "score": s, "version": c.map(|c| c.version.clone()), "name": c.map(|c| c.name.clone()), "set": c.map(|c| c.set_name.clone()), "number": c.map(|c| c.number.clone())})
        }).collect::<Vec<_>>(),
        "checked": checked, "status": status, "versions": ok, "best": best.as_ref().map(|b| b.1.clone()),
    }))
}

// ---------- prompts / warp ----------

fn run_prompts(matches: &Path, qwen_path: &Path, out: &Path) -> Result<()> {
    let mut qwen: HashMap<String, Value> = HashMap::new();
    for r in jsonl(qwen_path)? {
        if let Some(v) = r["version"].as_str() {
            qwen.insert(v.to_string(), r);
        }
    }
    // Two artworks can verify the same version (a promo and its reprint art);
    // keep the registration with the most interior inliers.
    let mut best: BTreeMap<String, (u64, Value)> = BTreeMap::new();
    for m in jsonl(matches)? {
        for c in m["checked"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["confident"] == json!(true))
        {
            let v = c["version"].as_str().unwrap_or("");
            let Some(q) = qwen.get(v) else { continue };
            if q["image_key"].as_str() != c["scan"].as_str() {
                continue; // mask frame must be the scan we registered on
            }
            let h: Mat3 = serde_json::from_value(c["h"].clone())?;
            let hinv = inv(&h).ok_or_else(|| anyhow!("singular H for {v}"))?;
            let sw = c["scan_size"][0].as_f64().unwrap_or(0.0);
            let sh = c["scan_size"][1].as_f64().unwrap_or(0.0);
            let cw = m["clean_size"][0].as_f64().unwrap_or(0.0);
            let ch = m["clean_size"][1].as_f64().unwrap_or(0.0);
            let figures: Vec<Value> = q["figures"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|f| {
                    let b: Vec<f64> = f["box"]
                        .as_array()?
                        .iter()
                        .filter_map(Value::as_f64)
                        .collect();
                    if b.len() != 4 {
                        return None;
                    }
                    let pts = [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])]
                        .map(|(x, y)| apply(&hinv, x * sw / 1000.0, y * sh / 1000.0));
                    let xs = pts.map(|p| p.0);
                    let ys = pts.map(|p| p.1);
                    let bx = [
                        xs.iter().cloned().fold(f64::MAX, f64::min).clamp(0.0, cw),
                        ys.iter().cloned().fold(f64::MAX, f64::min).clamp(0.0, ch),
                        xs.iter().cloned().fold(f64::MIN, f64::max).clamp(0.0, cw),
                        ys.iter().cloned().fold(f64::MIN, f64::max).clamp(0.0, ch),
                    ];
                    // A box that lies outside the painting (card UI) prompts nothing.
                    ((bx[2] - bx[0]) > 4.0 && (bx[3] - bx[1]) > 4.0)
                        .then(|| json!({"label": f["label"], "box": f["box"], "box_clean_px": bx}))
                })
                .collect();
            if figures.is_empty() {
                continue;
            }
            let row = json!({
                "version": v, "artwork_id": m["artwork_id"], "clean_asset": m["asset"], "clean_size": m["clean_size"],
                "scan": c["scan"], "scan_size": c["scan_size"], "h": h, "figures": figures,
                "name": c["rep"]["name"], "art_layout": c["rep"]["art_layout"],
                "interior_inliers": c["interior_inliers"], "ncc": c["ncc"],
            });
            let score = c["interior_inliers"].as_u64().unwrap_or(0);
            if best.get(v).is_none_or(|b| score > b.0) {
                best.insert(v.to_string(), (score, row));
            }
        }
    }
    let mut lines = String::new();
    for (_, row) in best.values() {
        lines.push_str(&serde_json::to_string(row)?);
        lines.push('\n');
    }
    let n = best.len();
    fs::write(out, lines)?;
    println!("{n} prompt rows → {}", out.display());
    Ok(())
}

/// Islands that survive `clean_mask` on the 918 px painting shrink to specks on a
/// 314 px scan. Drop alpha components under max(50 px, 0.2% of the largest),
/// the same rule the QA gate and `clean_mask` apply.
fn drop_specks(mut img: RgbaImage) -> RgbaImage {
    let (w, h) = img.dimensions();
    let mut label = vec![0u32; (w * h) as usize];
    let mut sizes = vec![0usize];
    for start in 0..(w * h) {
        if label[start as usize] != 0 || img.as_raw()[start as usize * 4 + 3] == 0 {
            continue;
        }
        let id = sizes.len() as u32;
        let mut stack = vec![start];
        label[start as usize] = id;
        let mut n = 0;
        while let Some(p) = stack.pop() {
            n += 1;
            let (x, y) = ((p % w) as i64, (p / w) as i64);
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let (nx, ny) = (x + dx, y + dy);
                    if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                        continue;
                    }
                    let q = (ny as u32 * w + nx as u32) as usize;
                    if label[q] == 0 && img.as_raw()[q * 4 + 3] != 0 {
                        label[q] = id;
                        stack.push(q as u32);
                    }
                }
            }
        }
        sizes.push(n);
    }
    let largest = sizes.iter().copied().max().unwrap_or(0);
    let min = 50usize.max((largest as f64 * 0.002) as usize);
    for (i, px) in img.pixels_mut().enumerate() {
        if label[i] != 0 && sizes[label[i] as usize] < min {
            px[3] = 0;
        }
    }
    img
}

fn alpha_of(path: &Path) -> Option<image::GrayImage> {
    let img = image::open(path).ok()?.to_rgba8();
    let (w, h) = img.dimensions();
    Some(ImageBuffer::from_fn(w, h, |x, y| {
        Luma([img.get_pixel(x, y)[3]])
    }))
}

/// Scan dimmed outside the mask, mask edge in magenta.
fn overlay(scan: &RgbImage, alpha: Option<&GrayImage>) -> RgbImage {
    let (w, h) = scan.dimensions();
    let Some(a) = alpha else {
        return ImageBuffer::from_fn(w, h, |x, y| Rgb(scan.get_pixel(x, y).0.map(|v| v / 4)));
    };
    let a = if a.dimensions() != (w, h) {
        image::imageops::resize(a, w, h, image::imageops::FilterType::Triangle)
    } else {
        a.clone()
    };
    let on = |x: u32, y: u32| a.get_pixel(x, y)[0] > 127;
    ImageBuffer::from_fn(w, h, |x, y| {
        let p = scan.get_pixel(x, y).0;
        let edge = on(x, y)
            && [(-1i64, 0i64), (1, 0), (0, -1), (0, 1)]
                .iter()
                .any(|(dx, dy)| {
                    let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                    nx < 0
                        || ny < 0
                        || nx >= w as i64
                        || ny >= h as i64
                        || !on(nx as u32, ny as u32)
                });
        if edge {
            Rgb([255, 0, 255])
        } else if on(x, y) {
            Rgb(p)
        } else {
            Rgb(p.map(|v| v / 4))
        }
    })
}

/// Old production mask vs new clean-art mask on the same scan: IoU, coverage,
/// and a side-by-side PNG per version (before | after).
fn run_compare(prompts: &Path, objects: &Path, old: &Path, new: &Path, out: &Path) -> Result<()> {
    fs::create_dir_all(out.join("img"))?;
    let rows = jsonl(prompts)?;
    let res: Vec<Value> = rows
        .par_iter()
        .filter_map(|p| -> Option<Value> {
            let v = p["version"].as_str()?;
            let scan = load_rgb(&objects.join(p["scan"].as_str()?)).ok()?;
            let a_old = alpha_of(&old.join(format!("{v}.webp")));
            let a_new = alpha_of(&new.join(format!("{v}.webp")));
            let (mut inter, mut uni, mut n_old, mut n_new) = (0u64, 0u64, 0u64, 0u64);
            if let (Some(o), Some(n)) = (&a_old, &a_new) {
                let o = if o.dimensions() != n.dimensions() { image::imageops::resize(o, n.width(), n.height(), image::imageops::FilterType::Triangle) } else { o.clone() };
                for (a, b) in o.pixels().zip(n.pixels()) {
                    let (x, y) = (a[0] > 127, b[0] > 127);
                    inter += (x && y) as u64;
                    uni += (x || y) as u64;
                    n_old += x as u64;
                    n_new += y as u64;
                }
            }
            // Boundary pixels per sqrt(area): text bites and specks make edges ragged.
            let ragged = |a: &Option<GrayImage>| -> f64 {
                let Some(a) = a else { return 0.0 };
                let on = |x: i64, y: i64| x >= 0 && y >= 0 && x < a.width() as i64 && y < a.height() as i64 && a.get_pixel(x as u32, y as u32)[0] > 127;
                let (mut edge, mut area) = (0u64, 0u64);
                for y in 0..a.height() as i64 {
                    for x in 0..a.width() as i64 {
                        if on(x, y) {
                            area += 1;
                            if !(on(x - 1, y) && on(x + 1, y) && on(x, y - 1) && on(x, y + 1)) {
                                edge += 1;
                            }
                        }
                    }
                }
                if area == 0 { 0.0 } else { edge as f64 / (area as f64).sqrt() }
            };
            let (rag_old, rag_new) = (ragged(&a_old), ragged(&a_new));
            let k = 2u32.max(600 / scan.height().max(1));
            let big = image::imageops::resize(&scan, scan.width() * k, scan.height() * k, image::imageops::FilterType::CatmullRom);
            let up = |a: &Option<GrayImage>| a.as_ref().map(|a| image::imageops::resize(a, big.width(), big.height(), image::imageops::FilterType::Triangle));
            let (l, r) = (overlay(&big, up(&a_old).as_ref()), overlay(&big, up(&a_new).as_ref()));
            let mut sheet = RgbImage::from_pixel(l.width() * 2 + 8, l.height(), Rgb([20, 20, 24]));
            image::imageops::overlay(&mut sheet, &l, 0, 0);
            image::imageops::overlay(&mut sheet, &r, (l.width() + 8) as i64, 0);
            sheet.save(out.join("img").join(format!("{v}.png"))).ok()?;
            let px = (scan.width() * scan.height()) as f64;
            Some(json!({
                "version": v, "name": p["name"], "art_layout": p["art_layout"], "artwork_id": p["artwork_id"],
                "had_old": a_old.is_some(), "iou": if uni > 0 { inter as f64 / uni as f64 } else { 0.0 },
                "coverage_old": n_old as f64 / px, "coverage_new": n_new as f64 / px,
                "ragged_old": rag_old, "ragged_new": rag_new,
            }))
        })
        .collect();
    let mut lines = String::new();
    for r in &res {
        lines.push_str(&serde_json::to_string(r)?);
        lines.push('\n');
    }
    fs::write(out.join("compare.jsonl"), lines)?;
    println!("{} compared → {}", res.len(), out.display());
    Ok(())
}

/// SAM on the bare clean painting gets boxes that span the whole picture and
/// then picks a part (one Unown, Electrode's white half). Painting the clean art
/// over the scan keeps the old framing: same boxes, same context, no card text.
fn run_composite(prompts: &Path, dump: &Path, objects: &Path, out: &Path) -> Result<()> {
    fs::create_dir_all(out.join("img"))?;
    let rows = jsonl(prompts)?;
    let done: Vec<Result<Value>> = rows
        .par_iter()
        .map(|p| -> Result<Value> {
            let v = safe_name(p["version"].as_str().unwrap_or(""))?;
            let scan = load_rgb(&objects.join(p["scan"].as_str().unwrap_or("")))?;
            let clean = load_rgb(&dump.join(p["clean_asset"].as_str().unwrap_or("")))?;
            let h: Mat3 = serde_json::from_value(p["h"].clone())?;
            let k = (1024.0 / scan.height() as f64).max(1.0);
            let (w, hh) = ((scan.width() as f64 * k).round() as u32, (scan.height() as f64 * k).round() as u32);
            let big = image::imageops::resize(&scan, w, hh, image::imageops::FilterType::CatmullRom);
            // composite px → scan px → clean px
            let hinv = inv(&mul(&scale(k, k), &h)).ok_or_else(|| anyhow!("singular"))?;
            let (cw, ch) = (clean.width() as f64, clean.height() as f64);
            let comp: RgbImage = ImageBuffer::from_fn(w, hh, |x, y| {
                let (qx, qy) = apply(&hinv, x as f64, y as f64);
                if qx < 0.0 || qy < 0.0 || qx > cw - 1.0 || qy > ch - 1.0 {
                    return *big.get_pixel(x, y);
                }
                let (x0, y0) = (qx.floor() as u32, qy.floor() as u32);
                let (x1, y1) = ((x0 + 1).min(clean.width() - 1), (y0 + 1).min(clean.height() - 1));
                let (fx, fy) = (qx - x0 as f64, qy - y0 as f64);
                let px = |a: u32, b: u32, c: usize| clean.get_pixel(a, b)[c] as f64;
                Rgb(std::array::from_fn(|c| {
                    (px(x0, y0, c) * (1.0 - fx) * (1.0 - fy) + px(x1, y0, c) * fx * (1.0 - fy)
                        + px(x0, y1, c) * (1.0 - fx) * fy + px(x1, y1, c) * fx * fy).round() as u8
                }))
            });
            let path = out.join("img").join(format!("{v}.png"));
            comp.save(&path)?;
            let figures: Vec<Value> = p["figures"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|f| {
                    let b: Vec<f64> = f["box"].as_array()?.iter().filter_map(Value::as_f64).collect();
                    (b.len() == 4).then(|| json!({"label": f["label"], "box": f["box"],
                        "box_clean_px": [b[0] * w as f64 / 1000.0, b[1] * hh as f64 / 1000.0, b[2] * w as f64 / 1000.0, b[3] * hh as f64 / 1000.0]}))
                })
                .collect();
            let mut row = p.clone();
            row["clean_asset"] = json!(path.display().to_string());
            row["clean_size"] = json!([w, hh]);
            row["h"] = json!(scale(1.0 / k, 1.0 / k)); // composite px → scan px
            row["figures"] = json!(figures);
            row["frame"] = json!("composite");
            Ok(row)
        })
        .collect();
    let mut lines = String::new();
    for d in done {
        lines.push_str(&serde_json::to_string(&d?)?);
        lines.push('\n');
    }
    fs::write(out.join("prompts.jsonl"), lines)?;
    println!("{} composites → {}", rows.len(), out.display());
    Ok(())
}

fn safe_name(v: &str) -> Result<&str> {
    if v.is_empty()
        || !v
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        bail!("unsafe version {v:?}");
    }
    Ok(v)
}

fn alpha_fallback(_p: &Value, m: &GrayImage, hinv: &Mat3, sw: u32, sh: u32) -> RgbaImage {
    ImageBuffer::from_fn(sw, sh, |x, y| {
        let (qx, qy) = apply(hinv, x as f64, y as f64);
        Rgba([
            255,
            255,
            255,
            bilinear(m, qx, qy).unwrap_or(0.0).round() as u8,
        ])
    })
}

/// The clean silhouette continues under opaque card UI (GX/attack bars, ability
/// boxes); lifting it would lift a chunk of that bar. Where the scan departs from
/// the clean painting in a solid region (an opening removes thin text strokes),
/// the card covers the painting, so the mask is cut there. Foil-wide differences
/// (rainbow / gold recolours) are not UI: then nothing is cut.
fn clip_card_ui(mut alpha: RgbaImage, p: &Value, objects: &Path) -> Result<RgbaImage> {
    let (sw, sh) = alpha.dimensions();
    let scan = load_rgb(&objects.join(p["scan"].as_str().unwrap_or("")))?;
    let comp = load_rgb(Path::new(p["clean_asset"].as_str().unwrap_or("")))?;
    if scan.dimensions() != (sw, sh) {
        bail!("scan size changed");
    }
    let comp = image::imageops::resize(&comp, sw, sh, image::imageops::FilterType::Triangle);
    // Per-channel linear fit scan ≈ a·clean + b (print vs digital colour), then residual.
    let n = (sw * sh) as usize;
    let mut res = vec![0f32; n];
    for c in 0..3 {
        let (mut sx, mut sy, mut sxx, mut sxy) = (0f64, 0f64, 0f64, 0f64);
        for (a, b) in comp.pixels().zip(scan.pixels()) {
            let (x, y) = (a[c] as f64, b[c] as f64);
            sx += x;
            sy += y;
            sxx += x * x;
            sxy += x * y;
        }
        let nn = n as f64;
        let var = sxx / nn - (sx / nn).powi(2);
        let k = if var > 1e-6 {
            (sxy / nn - sx / nn * sy / nn) / var
        } else {
            1.0
        };
        let b0 = sy / nn - k * sx / nn;
        for (i, (a, b)) in comp.pixels().zip(scan.pixels()).enumerate() {
            let d = b[c] as f64 - (k * a[c] as f64 + b0);
            res[i] += (d * d) as f32;
        }
    }
    let ui: Vec<bool> = res.iter().map(|v| v.sqrt() > 60.0).collect();
    // Opening (erode then dilate) with a square wider than a text stroke keeps solid
    // UI only; a closing then folds the lettering printed on a bar ("GX") into it.
    let r = (sh as i64 / 110).max(2);
    let morph = |src: &[bool], keep_if_all: bool, r: i64| -> Vec<bool> {
        let mut out = vec![false; n];
        for y in 0..sh as i64 {
            for x in 0..sw as i64 {
                let mut all = true;
                let mut any = false;
                for dy in -r..=r {
                    for dx in -r..=r {
                        let (nx, ny) = (x + dx, y + dy);
                        let v = nx >= 0
                            && ny >= 0
                            && nx < sw as i64
                            && ny < sh as i64
                            && src[(ny * sw as i64 + nx) as usize];
                        all &= v;
                        any |= v;
                    }
                }
                out[(y * sw as i64 + x) as usize] = if keep_if_all { all } else { any };
            }
        }
        out
    };
    let opened = morph(&morph(&ui, true, r), false, r);
    let solid = morph(&morph(&opened, false, 2 * r), true, 2 * r);
    let on: Vec<bool> = alpha.pixels().map(|p| p[3] > 127).collect();
    let mask_area = on.iter().filter(|&&v| v).count().max(1);
    let cut = on.iter().zip(&solid).filter(|(&a, &b)| a && b).count();
    if cut as f64 > 0.25 * mask_area as f64 {
        return Ok(alpha); // recoloured print, not card UI
    }
    // Only cut UI that reaches the silhouette's outside (bars across the body).
    // Icons wholly inside the body (energy costs) would leave holes: keep them.
    let kept: Vec<bool> = on.iter().zip(&solid).map(|(&a, &b)| a && !b).collect();
    let mut outside = vec![false; n];
    let mut stack: Vec<usize> = (0..sw as usize)
        .flat_map(|x| [x, (sh as usize - 1) * sw as usize + x])
        .chain((0..sh as usize).flat_map(|y| [y * sw as usize, y * sw as usize + sw as usize - 1]))
        .filter(|&i| !kept[i])
        .collect();
    for &i in &stack {
        outside[i] = true;
    }
    while let Some(i) = stack.pop() {
        let (x, y) = ((i % sw as usize) as i64, (i / sw as usize) as i64);
        for (dx, dy) in [(-1i64, 0i64), (1, 0), (0, -1), (0, 1)] {
            let (nx, ny) = (x + dx, y + dy);
            if nx < 0 || ny < 0 || nx >= sw as i64 || ny >= sh as i64 {
                continue;
            }
            let j = (ny * sw as i64 + nx) as usize;
            if !outside[j] && !kept[j] {
                outside[j] = true;
                stack.push(j);
            }
        }
    }
    for (i, px) in alpha.pixels_mut().enumerate() {
        if solid[i] && on[i] && outside[i] {
            px[3] = 0;
        }
    }
    Ok(alpha)
}

fn run_warp(
    prompts: &Path,
    clean_masks: &Path,
    out: &Path,
    ui_objects: Option<&Path>,
) -> Result<()> {
    fs::create_dir_all(out)?;
    let rows = jsonl(prompts)?;
    let done: Vec<Result<String>> = rows
        .par_iter()
        .map(|p| -> Result<String> {
            let v = p["version"].as_str().unwrap_or("");
            let src = clean_masks.join(format!("{v}.png"));
            if !src.exists() {
                return Ok(format!("{v}\tmissing"));
            }
            let m = image::open(&src)?.to_luma8();
            let h: Mat3 = serde_json::from_value(p["h"].clone())?;
            let hinv = inv(&h).ok_or_else(|| anyhow!("singular"))?;
            let (sw, sh) = (
                p["scan_size"][0].as_u64().unwrap_or(0) as u32,
                p["scan_size"][1].as_u64().unwrap_or(0) as u32,
            );
            // 4× supersampled inverse warp keeps the edge antialiased.
            let alpha: RgbaImage = ImageBuffer::from_fn(sw, sh, |x, y| {
                let mut acc = 0.0;
                for sy in 0..4 {
                    for sx in 0..4 {
                        let (qx, qy) = apply(
                            &hinv,
                            x as f64 + (sx as f64 + 0.5) / 4.0 - 0.5,
                            y as f64 + (sy as f64 + 0.5) / 4.0 - 0.5,
                        );
                        acc += bilinear(&m, qx, qy).unwrap_or(0.0);
                    }
                }
                Rgba([255, 255, 255, (acc / 16.0).round().clamp(0.0, 255.0) as u8])
            });
            let alpha = match (ui_objects, p["frame"].as_str()) {
                (Some(objects), Some("composite")) => clip_card_ui(alpha, p, objects)
                    .unwrap_or_else(|e| {
                        eprintln!("{v}: ui clip skipped: {e}");
                        alpha_fallback(p, &m, &hinv, sw, sh)
                    }),
                _ => alpha,
            };
            let alpha = drop_specks(alpha);
            let mut buf = Vec::new();
            image::codecs::webp::WebPEncoder::new_lossless(&mut buf).encode(
                alpha.as_raw(),
                sw,
                sh,
                image::ExtendedColorType::Rgba8,
            )?;
            fs::write(out.join(format!("{v}.webp")), buf)?;
            Ok(format!("{v}\twritten"))
        })
        .collect();
    let mut written = 0;
    for d in done {
        let d = d?;
        if d.ends_with("written") {
            written += 1;
        } else {
            eprintln!("{d}");
        }
    }
    println!("{written} masks → {}", out.display());
    Ok(())
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Match(a) => run_match(a),
        Cmd::Prompts { matches, qwen, out } => run_prompts(&matches, &qwen, &out),
        Cmd::Warp {
            prompts,
            clean_masks,
            out,
            ui_clip_objects,
        } => run_warp(&prompts, &clean_masks, &out, ui_clip_objects.as_deref()),
        Cmd::Compare {
            prompts,
            objects,
            old,
            new,
            out,
        } => run_compare(&prompts, &objects, &old, &new, &out),
        Cmd::Composite {
            prompts,
            dump,
            objects,
            out,
        } => run_composite(&prompts, &dump, &objects, &out),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collector_numbers_parse_like_the_catalogue() {
        assert_eq!(collector("Rare | 082/071"), Some((82, "71".into())));
        assert_eq!(collector("044/078"), Some((44, "78".into())));
        assert_eq!(collector("CS5aC | 059/127"), Some((59, "127".into())));
        assert_eq!(collector("SWSH001"), None);
        assert_eq!(collector("193/SV-P"), Some((193, "sv-p".into())));
    }

    #[test]
    fn names_normalise_brackets_and_accents() {
        assert_eq!(
            norm("Professor's Research (Professor Willow)"),
            "professorsresearch"
        );
        assert_eq!(norm("Pokémon Center Lady"), "pokemoncenterlady");
        assert_eq!(norm("Origin Forme Palkia V"), "originformepalkiav");
        assert_eq!(norm("Ho-Oh Lv.44"), "hooh");
        assert_eq!(norm("Flying Pikachu LV.12"), "flyingpikachu");
    }

    #[test]
    fn homography_helpers_roundtrip() {
        let h = [1.5, 0.0, 10.0, 0.0, 1.5, -4.0, 0.0, 0.0, 1.0];
        let hi = inv(&h).unwrap();
        let (x, y) = apply(&h, 3.0, 7.0);
        let (bx, by) = apply(&hi, x, y);
        assert!((bx - 3.0).abs() < 1e-9 && (by - 7.0).abs() < 1e-9);
    }

    #[test]
    fn npy_header_parses() {
        let mut b = b"\x93NUMPY\x01\x00".to_vec();
        let header = "{'descr': '<f4', 'fortran_order': False, 'shape': (2, 2), }";
        let pad = 64 - (10 + header.len() + 1) % 64;
        let header = format!("{header}{}\n", " ".repeat(pad));
        b.extend((header.len() as u16).to_le_bytes());
        b.extend(header.as_bytes());
        for v in [1.0f32, 2.0, 3.0, 4.0] {
            b.extend(v.to_le_bytes());
        }
        let n = parse_npy(&b).unwrap();
        assert_eq!(n.shape, vec![2, 2]);
        assert_eq!(f32s(&n).unwrap(), vec![1.0, 2.0, 3.0, 4.0]);
    }
}
