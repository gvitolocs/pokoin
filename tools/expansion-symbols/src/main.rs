//! Clean SVG expansion symbols for the set chips (desk, set index, era pages).
//!
//! `symbols.tsv` lists every catalog expansion and how its mark is drawn:
//!
//! - `plate`: no printed mark known. The D00002C dark plate with the set code.
//! - `code`: the card prints a letter/code mark (JP sv8, XY11, CN csv9C,
//!   EN SV/ME MEG). Redrawn as a plate with the printed code; colours are
//!   sampled from the real mark when there is one.
//! - `trace`: a pictorial symbol with a large enough source, traced with
//!   vtracer (white boxes keyed out first).
//! - `promo`: the black star with PROMO.
//! - `png`: only a small raster exists; the SPA keeps loading the PNG.
//!
//! Text is converted to glyph paths, so the SVGs need no fonts, and the
//! output holds only <svg>, <rect> and <path>: no scripts, no external refs.
//!
//!   expansion-symbols init  --catalog catalog.tsv --symbols <objects>/expansions/symbols --overrides overrides.tsv > symbols.tsv
//!   expansion-symbols build --manifest symbols.tsv --symbols <dir> --out /tmp/expansion-symbols
//!
//! Then publish both CDN origins with scripts/publish-expansion-symbols.sh.

use ab_glyph::{Font, FontRef, OutlineCurve};
use anyhow::{bail, Context, Result};
use std::collections::{HashMap, VecDeque};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

const W: f64 = 160.0;
const H: f64 = 92.0;
/// D00002C plate colours (scripts/export-expansion-code-marks.py).
const PLATE: Rgb = Rgb(35, 31, 32);
const LETTER: Rgb = Rgb(190, 192, 194);
/// Code and ring of the SVG plates: the printed SVI mark's white, which
/// reads on the dark theme where the D00002C grey did not.
const PLATE_INK: Rgb = Rgb(244, 244, 244);
const DEFAULT_FONT: &str = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
/// Pictorial marks smaller than this stay raster: tracing a 40 px icon
/// invents its shape.
const TRACE_MIN_SIDE: u32 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rgb(u8, u8, u8);

impl Rgb {
    fn hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.0, self.1, self.2)
    }

    fn parse(text: &str) -> Option<Rgb> {
        let t = text.strip_prefix('#')?;
        if t.len() != 6 {
            return None;
        }
        let v = u32::from_str_radix(t, 16).ok()?;
        Some(Rgb((v >> 16) as u8, (v >> 8) as u8, v as u8))
    }

    fn luma(self) -> f64 {
        (0.2126 * f64::from(self.0) + 0.7152 * f64::from(self.1) + 0.0722 * f64::from(self.2)) / 255.0
    }

    fn dist(self, o: Rgb) -> f64 {
        let d = |a: u8, b: u8| f64::from(a) - f64::from(b);
        (d(self.0, o.0).powi(2) + d(self.1, o.1).powi(2) + d(self.2, o.2).powi(2)).sqrt()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Plate,
    Code,
    Trace,
    Promo,
    Png,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Plate => "plate",
            Kind::Code => "code",
            Kind::Trace => "trace",
            Kind::Promo => "promo",
            Kind::Png => "png",
        }
    }

    fn parse(text: &str) -> Result<Kind> {
        Ok(match text {
            "plate" => Kind::Plate,
            "code" => Kind::Code,
            "trace" => Kind::Trace,
            "promo" => Kind::Promo,
            "png" => Kind::Png,
            _ => bail!("unknown kind {text}"),
        })
    }
}

/// Layout of a code mark. Colours come from the manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Style {
    /// Dark plate, light code, light ring inset (JP sv/s/SM/M, CN, EN SV/ME).
    Ring,
    /// Plate without a ring (the D00002C fallback plate).
    Flat,
    /// XY / BW / CP / L: letters full size, the number smaller on the baseline.
    Sub,
    /// DP / Pt: letters with an outline and no plate.
    Outline,
}

impl Style {
    fn name(self) -> &'static str {
        match self {
            Style::Ring => "ring",
            Style::Flat => "flat",
            Style::Sub => "sub",
            Style::Outline => "outline",
        }
    }

    fn parse(text: &str) -> Result<Style> {
        Ok(match text {
            "ring" => Style::Ring,
            "flat" => Style::Flat,
            "sub" => Style::Sub,
            "outline" => Style::Outline,
            "-" | "" => Style::Flat,
            _ => bail!("unknown style {text}"),
        })
    }
}

#[derive(Debug, Clone)]
struct Entry {
    slug: String,
    kind: Kind,
    text: String,
    style: Style,
    plate: Rgb,
    ink: Rgb,
    note: String,
}

#[derive(Debug, Clone)]
struct CatalogRow {
    slug: String,
    name: String,
    nationality: String,
    code: String,
    official: String,
}

fn read_catalog(path: &Path) -> Result<Vec<CatalogRow>> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let mut rows = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 5 || f[0].is_empty() {
            continue;
        }
        rows.push(CatalogRow {
            slug: f[0].to_string(),
            name: f[1].to_string(),
            nationality: f[2].to_string(),
            code: f[3].trim().to_string(),
            official: f[4].trim().to_string(),
        });
    }
    Ok(rows)
}

const HEADER: &str = "slug\tkind\ttext\tstyle\tplate\tink\tnote";

fn read_manifest(path: &Path) -> Result<Vec<Entry>> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let mut out = Vec::new();
    for (n, line) in text.lines().enumerate() {
        if line.trim().is_empty() || line.starts_with('#') || line == HEADER {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 6 {
            bail!("{}:{}: expected 7 tab-separated fields", path.display(), n + 1);
        }
        let colour = |i: usize, fallback: Rgb| Rgb::parse(f[i]).unwrap_or(fallback);
        out.push(Entry {
            slug: f[0].to_string(),
            kind: Kind::parse(f[1]).with_context(|| format!("{}:{}", path.display(), n + 1))?,
            text: f[2].to_string(),
            style: Style::parse(f[3])?,
            plate: colour(4, PLATE),
            ink: colour(5, LETTER),
            note: f.get(6).unwrap_or(&"").to_string(),
        });
    }
    Ok(out)
}

fn entry_line(e: &Entry) -> String {
    let colours = matches!(e.kind, Kind::Plate | Kind::Code);
    format!(
        "{}\t{}\t{}\t{}\t{}\t{}\t{}",
        e.slug,
        e.kind.name(),
        if e.text.is_empty() { "-" } else { &e.text },
        if colours { e.style.name() } else { "-" },
        if colours { e.plate.hex() } else { "-".into() },
        if colours { e.ink.hex() } else { "-".into() },
        e.note
    )
}

// ---------------------------------------------------------------- codes

const ABBREV_SKIP: [&str; 10] = ["the", "of", "and", "a", "set", "starter", "mega", "ex", "collection", "series"];

/// `setAbbrev` (market/src/identity.js): the fallback plate text.
fn set_abbrev(name: &str) -> String {
    let words: Vec<String> = name
        .split(|c: char| c.is_whitespace() || c == '/')
        .map(|w| w.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>())
        .filter(|w| !w.is_empty() && !ABBREV_SKIP.contains(&w.to_lowercase().as_str()))
        .collect();
    match words.len() {
        0 => String::new(),
        1 => words[0].chars().take(3).collect::<String>().to_uppercase(),
        _ => words.iter().filter_map(|w| w.chars().next()).take(4).collect::<String>().to_uppercase(),
    }
}

/// Letters after the number: `a`/`b` print lowercase (sv8a, SM7b), the rest
/// uppercase (sv4K, s10D, M1L).
fn suffix_case(rest: &str) -> String {
    rest.chars()
        .map(|c| if c == 'a' || c == 'b' { c } else { c.to_ascii_uppercase() })
        .collect()
}

fn split_prefix<'a>(code: &'a str, prefix: &str) -> Option<&'a str> {
    let lower = code.to_ascii_lowercase();
    if lower.starts_with(prefix) && code.len() > prefix.len() {
        Some(&code[prefix.len()..])
    } else {
        None
    }
}

/// The code printed on the cards, or None when the set has no code mark.
/// `style` is the family layout.
fn printed_code(row: &CatalogRow) -> Option<(String, Style)> {
    let nat = row.nationality.as_str();
    let code = row.code.trim();
    if nat == "chinese" {
        // tcgdex ids carry the printed form (CSV7C, CS3.5); CardTrader drops the dot.
        let base = if row.official.is_empty() { code } else { row.official.as_str() };
        let lower = base.to_ascii_lowercase();
        let (prefix, rest) = if let Some(r) = split_prefix(base, "csv") {
            ("csv", r)
        } else if let Some(r) = split_prefix(base, "csm") {
            ("CSM", r)
        } else if let Some(r) = split_prefix(base, "cbb") {
            ("CBB", r)
        } else if let Some(r) = split_prefix(base, "cs") {
            ("cs", r)
        } else {
            return None;
        };
        let _ = lower;
        let mut rest = rest.to_string();
        if !rest.ends_with('C') && !rest.ends_with('c') {
            rest.push('C');
        }
        let body: String = rest[..rest.len() - 1].chars().map(|c| if c.is_ascii_digit() || c == '.' { c } else { c.to_ascii_lowercase() }).collect();
        // CSM1DC / csDC: a capital D stays capital (Dynamax / Deck).
        let body = body.replace('d', "D");
        return Some((format!("{prefix}{body}C"), Style::Ring));
    }
    if nat == "unknown" {
        // New JP Mega-era sets not matched to an official list yet (Aura Seeker m7).
        let lower = code.to_ascii_lowercase();
        if lower.len() > 1 && lower.len() <= 4 && lower.starts_with('m') && lower.as_bytes()[1].is_ascii_digit() {
            return Some((format!("M{}", suffix_case(&code[1..])), Style::Ring));
        }
        return None;
    }
    if nat == "japanese" || nat == "korean" {
        let lower = code.to_ascii_lowercase();
        let digit_after = |p: &str| lower.len() > p.len() && lower.as_bytes()[p.len()].is_ascii_digit();
        let rest = |p: &str| suffix_case(&code[p.len()..]);
        if lower.starts_with("sv") {
            return Some((format!("sv{}", rest("sv")), Style::Ring));
        }
        if lower.starts_with("sm") {
            return Some((format!("SM{}", rest("sm")).replace("PLUS", "+"), Style::Ring));
        }
        // VMAX / VSTAR special sets: SP4, SP6, SPD.
        if lower.starts_with("sp") && (3..=4).contains(&lower.len()) {
            return Some((code.to_ascii_uppercase(), Style::Ring));
        }
        if lower.starts_with('s') && lower.len() <= 5 && (digit_after("s") || lower.len() == 2) {
            return Some((format!("s{}", rest("s")), Style::Ring));
        }
        if lower.starts_with('m') && lower.len() <= 4 {
            let p = if digit_after("m") { "M" } else { "m" };
            return Some((format!("{p}{}", rest("m")), Style::Ring));
        }
        // Collection X/Y, Black/White Collection, Red Flash …: the letter after
        // the number is CardTrader's; the cards print XY1 / BW1.
        let digits = |p: &str| code[p.len()..].chars().take_while(char::is_ascii_digit).collect::<String>();
        if lower.starts_with("xy") && digit_after("xy") {
            return Some((format!("XY{}", digits("xy")), Style::Sub));
        }
        if lower.starts_with("bw") && digit_after("bw") {
            return Some((format!("BW{}", digits("bw")), Style::Sub));
        }
        if lower.starts_with("cp") && digit_after("cp") {
            return Some((format!("CP{}", rest("cp")), Style::Sub));
        }
        if lower.starts_with("dp") && digit_after("dp") {
            return Some((format!("DP{}", rest("dp")), Style::Outline));
        }
        if lower.starts_with("pt") && digit_after("pt") {
            return Some((format!("Pt{}", rest("pt")), Style::Outline));
        }
        if lower.starts_with('l') && digit_after("l") && lower.len() <= 3 {
            return Some((format!("L{}", rest("l")), Style::Sub));
        }
        return None;
    }
    // Western Scarlet & Violet / Mega Evolution cards print a 3-letter code
    // instead of a pictorial symbol.
    let off = row.official.to_ascii_lowercase();
    let era = off.starts_with("sv") || off.starts_with("me") || off.starts_with("zsv") || off.starts_with("rsv");
    if era && code.len() == 3 && code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Some((code.to_ascii_uppercase(), Style::Ring));
    }
    None
}

/// Code for a set with no real mark. CardTrader codes of decks and boxes are
/// often internal (mcmp, dp2-bas), so only a tcgdex/pokemontcg.io official
/// id counts here; otherwise the plate keeps its abbreviation.
fn plate_code(row: &CatalogRow) -> Option<(String, Style)> {
    if row.nationality == "unknown" {
        return printed_code(row);
    }
    if row.official.is_empty() {
        return None;
    }
    if row.nationality == "western" || row.nationality == "chinese" {
        return printed_code(row);
    }
    printed_code(&CatalogRow { code: row.official.clone(), ..row.clone() })
}

/// `black-bolt-master-ball-reverse-holo` → `black-bolt`: set variants show
/// their parent set's mark.
fn variant_stem(slug: &str) -> Option<&str> {
    const TAILS: [&str; 8] = [
        "-master-ball-reverse-holo",
        "-poke-ball-reverse-holo",
        "-ball-and-rocket-reverse-holo",
        "-energy-reverse-holo",
        "-master-ball-reverse",
        "-poke-ball-reverse",
        "-reverse-holo",
        "-reverse",
    ];
    TAILS.iter().find_map(|t| slug.strip_suffix(t))
}

// ---------------------------------------------------------------- raster

struct Raster {
    w: u32,
    h: u32,
    /// RGBA8
    px: Vec<u8>,
}

impl Raster {
    fn at(&self, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * self.w + x) * 4) as usize;
        [self.px[i], self.px[i + 1], self.px[i + 2], self.px[i + 3]]
    }
}

fn decode_png(path: &Path) -> Result<Raster> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info()?;
    let mut buf = vec![0; reader.output_buffer_size().context("png too large")?];
    let info = reader.next_frame(&mut buf)?;
    let (w, h) = (info.width, info.height);
    let ch = info.color_type.samples();
    let mut px = Vec::with_capacity((w * h * 4) as usize);
    for i in 0..(w * h) as usize {
        let p = &buf[i * ch..(i + 1) * ch];
        px.extend_from_slice(&match ch {
            4 => [p[0], p[1], p[2], p[3]],
            3 => [p[0], p[1], p[2], 255],
            2 => [p[0], p[0], p[0], p[1]],
            _ => [p[0], p[0], p[0], 255],
        });
    }
    Ok(Raster { w, h, px })
}

fn png_size(path: &Path) -> Option<(u32, u32)> {
    let file = fs::File::open(path).ok()?;
    let reader = png::Decoder::new(std::io::BufReader::new(file)).read_info().ok()?;
    let info = reader.info();
    Some((info.width, info.height))
}

/// Plate and code colours of a real code mark: the commonest opaque colour
/// inside the outer margin (so a white box or ring does not win), and the
/// common colour farthest from it.
fn sample_colours(r: &Raster) -> (Rgb, Rgb, Option<Rgb>) {
    let mx = (r.w as f64 * 0.12).ceil() as u32;
    let my = (r.h as f64 * 0.16).ceil() as u32;
    let mut buckets: HashMap<(u8, u8, u8), (u64, [u64; 3])> = HashMap::new();
    let mut total = 0u64;
    for y in my..r.h.saturating_sub(my) {
        for x in mx..r.w.saturating_sub(mx) {
            let p = r.at(x, y);
            if p[3] < 200 {
                continue;
            }
            total += 1;
            let e = buckets.entry((p[0] >> 5, p[1] >> 5, p[2] >> 5)).or_insert((0, [0; 3]));
            e.0 += 1;
            e.1[0] += u64::from(p[0]);
            e.1[1] += u64::from(p[1]);
            e.1[2] += u64::from(p[2]);
        }
    }
    if total == 0 {
        return (PLATE, LETTER, None);
    }
    let mean = |v: &(u64, [u64; 3])| Rgb((v.1[0] / v.0) as u8, (v.1[1] / v.0) as u8, (v.1[2] / v.0) as u8);
    let mut list: Vec<_> = buckets.values().collect();
    list.sort_by(|a, b| b.0.cmp(&a.0));
    let common: Vec<Rgb> = list.iter().filter(|v| v.0 * 100 >= total * 4).map(|v| mean(v)).collect();
    let plate = mean(list[0]);
    let ink = common
        .iter()
        .skip(1)
        .copied()
        .max_by(|a, b| a.dist(plate).total_cmp(&b.dist(plate)))
        .unwrap_or(contrast(plate));
    // Saturated plates (XY, BW, CP, L) win over black text and white boxes.
    let vivid = common.iter().copied().filter(|c| vividness(*c) > 0.3).max_by(|a, b| vividness(*a).total_cmp(&vividness(*b)));
    (plate, ink, vivid)
}

/// HSV saturation × value: near-black (4,0,3) is not a colour, and a dark
/// anti-aliased navy loses to the plate's real blue.
fn vividness(c: Rgb) -> f64 {
    let max = f64::from(c.0.max(c.1).max(c.2));
    let min = f64::from(c.0.min(c.1).min(c.2));
    if max < 60.0 { 0.0 } else { (max - min) / max * max / 255.0 }
}

fn contrast(c: Rgb) -> Rgb {
    if c.luma() > 0.62 { Rgb(26, 26, 26) } else { Rgb(250, 250, 250) }
}

/// Plate/ink for a family layout from the sampled colours.
fn style_colours(style: Style, text: &str, sampled: (Rgb, Rgb, Option<Rgb>)) -> (Rgb, Rgb) {
    let (a, b, vivid) = sampled;
    let (dark, light) = if a.luma() <= b.luma() { (a, b) } else { (b, a) };
    match style {
        // Printed ring marks are always a dark plate with light code.
        Style::Ring | Style::Flat => match vivid {
            Some(v) if v.luma() < 0.6 => (v, light),
            _ => (dark, light),
        },
        // DP / Pt: dark letters, light outline.
        Style::Outline => (light, dark),
        Style::Sub => match vivid {
            // XY prints black on colour; BW / CP / L white on colour.
            Some(v) if text.starts_with("XY") => (v, Rgb(26, 26, 26)),
            Some(v) => (v, contrast(v)),
            None => (a, b),
        },
    }
}

/// Make near-white pixels connected to the image edge transparent (the opaque
/// white boxes some scans carry).
fn key_out_white_box(r: &mut Raster) {
    let white = |p: [u8; 4]| p[3] > 0 && p[0] > 232 && p[1] > 232 && p[2] > 232;
    // Only a real box: all four corners opaque white. A white outline that
    // touches the edge of a transparent canvas is part of the symbol.
    let corners = [(0, 0), (r.w - 1, 0), (0, r.h - 1), (r.w - 1, r.h - 1)];
    if !corners.iter().all(|&(x, y)| white(r.at(x, y)) && r.at(x, y)[3] > 200) {
        return;
    }
    let mut seen = vec![false; (r.w * r.h) as usize];
    let mut queue = VecDeque::new();
    for x in 0..r.w {
        queue.push_back((x, 0));
        queue.push_back((x, r.h - 1));
    }
    for y in 0..r.h {
        queue.push_back((0, y));
        queue.push_back((r.w - 1, y));
    }
    while let Some((x, y)) = queue.pop_front() {
        let i = (y * r.w + x) as usize;
        if seen[i] || !white(r.at(x, y)) {
            continue;
        }
        seen[i] = true;
        r.px[i * 4 + 3] = 0;
        if x > 0 {
            queue.push_back((x - 1, y));
        }
        if y > 0 {
            queue.push_back((x, y - 1));
        }
        if x + 1 < r.w {
            queue.push_back((x + 1, y));
        }
        if y + 1 < r.h {
            queue.push_back((x, y + 1));
        }
    }
}

// ---------------------------------------------------------------- text

struct Typeface<'a> {
    font: FontRef<'a>,
    upem: f64,
    cap: f64,
}

impl<'a> Typeface<'a> {
    fn new(bytes: &'a [u8]) -> Result<Self> {
        let font = FontRef::try_from_slice(bytes).context("font")?;
        let upem = f64::from(font.units_per_em().context("units per em")?);
        // From the curve points (y up, like `path` draws them); `bounds` uses
        // another frame.
        let cap = font
            .outline(font.glyph_id('H'))
            .map(|o| {
                o.curves
                    .iter()
                    .flat_map(|c| match c {
                        OutlineCurve::Line(a, b) => vec![a.y, b.y],
                        OutlineCurve::Quad(a, m, b) => vec![a.y, m.y, b.y],
                        OutlineCurve::Cubic(a, m, n, b) => vec![a.y, m.y, n.y, b.y],
                    })
                    .fold(0.0f64, |acc, y| acc.max(f64::from(y)))
            })
            .context("no H outline")?;
        if cap <= 0.0 {
            bail!("font has no cap height");
        }
        Ok(Typeface { font, upem, cap })
    }

    /// Advance width of `text` at 1 unit per em.
    fn width(&self, text: &str) -> f64 {
        let mut w = 0.0;
        let mut prev = None;
        for c in text.chars() {
            let id = self.font.glyph_id(c);
            if let Some(p) = prev {
                w += f64::from(self.font.kern_unscaled(p, id));
            }
            w += f64::from(self.font.h_advance_unscaled(id));
            prev = Some(id);
        }
        w / self.upem
    }

    /// Glyph outlines of `text`; baseline at `y`, `size` px per em, x squeezed
    /// by `sx`. Returns the path data and the pen x after the run.
    fn path(&self, text: &str, mut x: f64, y: f64, size: f64, sx: f64, d: &mut String) -> f64 {
        let k = size / self.upem;
        let mut prev = None;
        for c in text.chars() {
            let id = self.font.glyph_id(c);
            if let Some(p) = prev {
                x += f64::from(self.font.kern_unscaled(p, id)) * k * sx;
            }
            if let Some(outline) = self.font.outline(id) {
                let tx = |px: f32| x + f64::from(px) * k * sx;
                let ty = |py: f32| y - f64::from(py) * k;
                let mut last: Option<ab_glyph::Point> = None;
                for curve in &outline.curves {
                    let (start, end) = match curve {
                        OutlineCurve::Line(a, b) => (*a, *b),
                        OutlineCurve::Quad(a, _, b) => (*a, *b),
                        OutlineCurve::Cubic(a, _, _, b) => (*a, *b),
                    };
                    if last.map_or(true, |l| (l.x - start.x).abs() > 0.01 || (l.y - start.y).abs() > 0.01) {
                        if last.is_some() {
                            d.push('Z');
                        }
                        let _ = write!(d, "M{:.2} {:.2}", tx(start.x), ty(start.y));
                    }
                    match curve {
                        OutlineCurve::Line(_, b) => {
                            let _ = write!(d, "L{:.2} {:.2}", tx(b.x), ty(b.y));
                        }
                        OutlineCurve::Quad(_, c, b) => {
                            let _ = write!(d, "Q{:.2} {:.2} {:.2} {:.2}", tx(c.x), ty(c.y), tx(b.x), ty(b.y));
                        }
                        OutlineCurve::Cubic(_, c1, c2, b) => {
                            let _ = write!(
                                d,
                                "C{:.2} {:.2} {:.2} {:.2} {:.2} {:.2}",
                                tx(c1.x),
                                ty(c1.y),
                                tx(c2.x),
                                ty(c2.y),
                                tx(b.x),
                                ty(b.y)
                            );
                        }
                    }
                    last = Some(end);
                }
                if last.is_some() {
                    d.push('Z');
                }
            }
            x += f64::from(self.font.h_advance_unscaled(id)) * k * sx;
            prev = Some(id);
        }
        x
    }
}

/// Split XY11 into ("XY", "11"): the number prints smaller in the Sub style.
fn split_sub(text: &str) -> (&str, &str) {
    let i = text.find(|c: char| c.is_ascii_digit()).unwrap_or(text.len());
    (&text[..i], &text[i..])
}

/// Code text as glyph paths centred in the box (x0, y0, w, h).
fn code_paths(tf: &Typeface, text: &str, style: Style, bx: (f64, f64, f64, f64)) -> String {
    let (x0, y0, bw, bh) = bx;
    let (head, tail) = if style == Style::Sub || style == Style::Outline {
        split_sub(text)
    } else {
        (text, "")
    };
    // XY/BW print big letters with a small number; the plate is full of text.
    let (small, fill) = if style == Style::Sub { (0.6, 0.78) } else { (0.64, 0.62) };
    // Cap height fills `fill` of the box; long codes condense, then shrink.
    let mut size = bh * fill / (tf.cap / tf.upem);
    let width_em = tf.width(head) + tf.width(tail) * small;
    let mut sx = 1.0;
    if width_em * size > bw {
        sx = (bw / (width_em * size)).max(0.62);
        if width_em * size * sx > bw {
            size = bw / (width_em * sx);
        }
    }
    let total = width_em * size * sx;
    let cap_px = tf.cap / tf.upem * size;
    let baseline = y0 + (bh + cap_px) / 2.0;
    let mut d = String::new();
    let x = tf.path(head, x0 + (bw - total) / 2.0, baseline, size, sx, &mut d);
    if !tail.is_empty() {
        tf.path(tail, x + size * 0.02, baseline, size * small, sx, &mut d);
    }
    d
}

fn svg_open(w: f64, h: f64) -> String {
    format!(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">"#)
}

fn code_svg(tf: &Typeface, e: &Entry) -> String {
    let mut s = svg_open(W, H);
    let text = if e.text.is_empty() || e.text == "-" { "●" } else { e.text.as_str() };
    match e.style {
        Style::Outline => {
            let d = code_paths(tf, text, e.style, (6.0, 6.0, W - 12.0, H - 12.0));
            let _ = write!(
                s,
                r#"<path d="{d}" fill="none" stroke="{}" stroke-width="9" stroke-linejoin="round"/><path d="{d}" fill="{}"/>"#,
                e.plate.hex(),
                e.ink.hex()
            );
        }
        _ => {
            if e.style == Style::Sub {
                // XY / BW plates carry a thin border in the code colour.
                let _ = write!(
                    s,
                    r#"<rect x="3.5" y="3.5" width="153" height="85" rx="14" fill="{}" stroke="{}" stroke-width="3"/>"#,
                    e.plate.hex(),
                    e.ink.hex()
                );
            } else {
                let _ = write!(s, r#"<rect x="2" y="2" width="156" height="88" rx="16" fill="{}"/>"#, e.plate.hex());
            }
            let inner = if e.style == Style::Ring {
                let _ = write!(
                    s,
                    r#"<rect x="8.5" y="8.5" width="143" height="75" rx="11" fill="none" stroke="{}" stroke-width="4"/>"#,
                    e.ink.hex()
                );
                (20.0, 16.0, W - 40.0, H - 32.0)
            } else {
                (14.0, 12.0, W - 28.0, H - 24.0)
            };
            let d = code_paths(tf, text, e.style, inner);
            let _ = write!(s, r#"<path d="{d}" fill="{}"/>"#, e.ink.hex());
        }
    }
    s.push_str("</svg>\n");
    s
}

/// Five-point black star with PROMO across it (Black Star Promos).
fn promo_svg(tf: &Typeface) -> String {
    let (cx, cy, ro, ri) = (50.0f64, 53.0f64, 46.0f64, 21.0f64);
    let mut d = String::new();
    for i in 0..10 {
        let r = if i % 2 == 0 { ro } else { ri };
        let a = -std::f64::consts::FRAC_PI_2 + f64::from(i) * std::f64::consts::PI / 5.0;
        let _ = write!(d, "{}{:.2} {:.2}", if i == 0 { 'M' } else { 'L' }, cx + r * a.cos(), cy + r * a.sin());
    }
    d.push('Z');
    let mut s = svg_open(100.0, 100.0);
    let _ = write!(
        s,
        r##"<path d="{d}" fill="#111" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>"##
    );
    // PROMO runs across the whole star, outlined so it reads over the rim.
    let text = code_paths(tf, "PROMO", Style::Flat, (3.0, 41.0, 94.0, 30.0));
    let _ = write!(
        s,
        r##"<path d="{text}" fill="none" stroke="#111" stroke-width="5" stroke-linejoin="round"/><path d="{text}" fill="#fff"/>"##
    );
    s.push_str("</svg>\n");
    s
}

fn trace_svg(path: &Path) -> Result<String> {
    let mut r = decode_png(path)?;
    key_out_white_box(&mut r);
    let img = vtracer::ColorImage { pixels: r.px.clone(), width: r.w as usize, height: r.h as usize };
    let config = vtracer::Config {
        color_mode: vtracer::ColorMode::Color,
        hierarchical: vtracer::Hierarchical::Stacked,
        filter_speckle: 4,
        color_precision: 6,
        layer_difference: 16,
        mode: visioncortex::PathSimplifyMode::Spline,
        corner_threshold: 60,
        length_threshold: 4.0,
        max_iterations: 10,
        splice_threshold: 45,
        path_precision: Some(1),
    };
    let traced = vtracer::convert(img, config).map_err(|e| anyhow::anyhow!(e))?;
    let mut s = svg_open(f64::from(r.w), f64::from(r.h));
    for p in &traced.paths {
        let (d, off) = p.path.to_svg_string(true, visioncortex::PointF64::default(), Some(1));
        let fill = p.color.to_hex_string();
        let _ = write!(s, r#"<path d="{d}" fill="{fill}""#);
        if off.x != 0.0 || off.y != 0.0 {
            let _ = write!(s, r#" transform="translate({},{})""#, off.x, off.y);
        }
        s.push_str("/>");
    }
    s.push_str("</svg>\n");
    Ok(s)
}

/// Generated SVGs hold only these elements and no references at all.
fn check_clean(svg: &str) -> Result<()> {
    let lower = svg.to_ascii_lowercase();
    for bad in ["<script", "href", "url(", "<image", "<foreignobject", "<style", " on", "@import"] {
        if lower.contains(bad) {
            bail!("unsafe SVG content: {bad}");
        }
    }
    for tag in lower.split('<').skip(1) {
        let name: String = tag.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '/').collect();
        if !["svg", "/svg", "rect", "path"].contains(&name.as_str()) {
            bail!("unexpected SVG element <{name}>");
        }
    }
    Ok(())
}

fn render_png(svg: &str, w: u32, h: u32) -> Result<Vec<u8>> {
    let tree = resvg::usvg::Tree::from_str(svg, &resvg::usvg::Options::default())?;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(w, h).context("pixmap")?;
    let size = tree.size();
    let t = resvg::tiny_skia::Transform::from_scale(w as f32 / size.width(), h as f32 / size.height());
    resvg::render(&tree, t, &mut pixmap.as_mut());
    Ok(pixmap.encode_png()?)
}

// ---------------------------------------------------------------- commands

fn is_generated_plate(size: Option<(u32, u32)>) -> bool {
    size == Some((160, 92))
}

fn propose(row: &CatalogRow, symbols: &Path) -> Result<Entry> {
    let png = symbols.join(format!("{}.png", row.slug));
    let size = png_size(&png);
    let mut e = Entry {
        slug: row.slug.clone(),
        kind: Kind::Plate,
        text: plate_code(row).map(|p| p.0).unwrap_or_else(|| set_abbrev(&row.name)),
        // The SVI look of the printed SV marks: dark plate, light ring and code.
        style: Style::Ring,
        plate: PLATE,
        ink: PLATE_INK,
        note: String::new(),
    };
    let Some((w, h)) = size else {
        e.note = "missing".into();
        return Ok(e);
    };
    if is_generated_plate(size) {
        e.note = "was plate".into();
        return Ok(e);
    }
    e.note = format!("real {w}x{h}");
    if let Some((text, style)) = printed_code(row) {
        let sampled = sample_colours(&decode_png(&png)?);
        let (plate, ink) = style_colours(style, &text, sampled);
        e.kind = Kind::Code;
        e.text = text;
        e.style = style;
        e.plate = plate;
        e.ink = ink;
    } else if row.slug.contains("promo") {
        e.kind = Kind::Promo;
    } else if w.max(h) >= TRACE_MIN_SIDE {
        e.kind = Kind::Trace;
    } else {
        e.kind = Kind::Png;
    }
    Ok(e)
}

/// Hand corrections: `slug<TAB>kind<TAB>text<TAB>style<TAB>plate<TAB>ink`,
/// `.` keeps the proposed value.
fn apply_overrides(entries: &mut [Entry], path: &Path) -> Result<()> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    for (n, line) in text.lines().enumerate() {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        let e = entries
            .iter_mut()
            .find(|e| e.slug == f[0])
            .with_context(|| format!("{}:{}: unknown slug {}", path.display(), n + 1, f[0]))?;
        let keep = |i: usize| f.get(i).map_or(true, |v| *v == "." || v.is_empty());
        if !keep(1) {
            e.kind = Kind::parse(f[1])?;
        }
        if !keep(2) {
            e.text = f[2].to_string();
        }
        if !keep(3) {
            e.style = Style::parse(f[3])?;
        }
        if !keep(4) {
            e.plate = Rgb::parse(f[4]).with_context(|| format!("{}:{}: plate colour", path.display(), n + 1))?;
        }
        if !keep(5) {
            e.ink = Rgb::parse(f[5]).with_context(|| format!("{}:{}: ink colour", path.display(), n + 1))?;
        }
        e.note = format!("{} hand", e.note).trim().to_string();
    }
    Ok(())
}

fn init(catalog: &Path, symbols: &Path, overrides: Option<&Path>) -> Result<()> {
    let rows = read_catalog(catalog)?;
    let mut entries = rows.iter().map(|row| propose(row, symbols)).collect::<Result<Vec<_>>>()?;
    if let Some(path) = overrides {
        apply_overrides(&mut entries, path)?;
    }
    // Reverse-holo / ball variants without a real mark of their own show the
    // parent set's mark (after the parent's hand corrections).
    let parents: HashMap<String, Entry> = entries
        .iter()
        .filter(|e| variant_stem(&e.slug).is_none())
        .map(|e| (e.slug.clone(), e.clone()))
        .collect();
    for e in entries.iter_mut() {
        let Some(stem) = variant_stem(&e.slug) else { continue };
        if e.kind == Kind::Code || e.kind == Kind::Trace || e.note.ends_with("hand") {
            continue;
        }
        let parent = parents.get(stem).or_else(|| {
            let mut hits = parents.values().filter(|p| p.slug.starts_with(&format!("{stem}-")));
            match (hits.next(), hits.next()) {
                (Some(p), None) => Some(p),
                _ => None,
            }
        });
        if let Some(p) = parent {
            let note = format!("{} variant of {}", e.note, p.slug);
            *e = Entry { slug: e.slug.clone(), note: note.trim().to_string(), ..p.clone() };
        }
    }
    println!("{HEADER}");
    for e in &entries {
        println!("{}", entry_line(e));
    }
    Ok(())
}

fn build(manifest: &Path, symbols: &Path, out: &Path, font: &Path, catalog: Option<&Path>) -> Result<()> {
    let entries = read_manifest(manifest)?;
    let bytes = fs::read(font).with_context(|| format!("read {}", font.display()))?;
    let tf = Typeface::new(&bytes)?;
    let names: HashMap<String, String> = match catalog {
        Some(p) => read_catalog(p)?.into_iter().map(|r| (r.slug, r.name)).collect(),
        None => HashMap::new(),
    };
    fs::create_dir_all(out.join("svg"))?;
    fs::create_dir_all(out.join("png"))?;
    let mut png_only = Vec::new();
    let mut repainted = Vec::new();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for e in &entries {
        let svg = match e.kind {
            Kind::Png => {
                png_only.push(e.slug.clone());
                *counts.entry("png").or_default() += 1;
                continue;
            }
            Kind::Plate | Kind::Code => code_svg(&tf, e),
            Kind::Promo => promo_svg(&tf),
            Kind::Trace => match trace_svg(&symbols.join(format!("{}.png", e.slug))) {
                Ok(svg) => svg,
                Err(err) => {
                    eprintln!("trace {} failed: {err:#}; keeping PNG", e.slug);
                    png_only.push(e.slug.clone());
                    continue;
                }
            },
        };
        check_clean(&svg).with_context(|| e.slug.clone())?;
        fs::write(out.join("svg").join(format!("{}.svg", e.slug)), &svg)?;
        *counts.entry(e.kind.name()).or_default() += 1;
        // Generated plates (160×92) are our own drawings: redraw the PNG
        // fallback (the app and the API's defaultSymbolUrl still read PNGs)
        // and draw one where none exists. Real marks keep their PNG.
        let png = symbols.join(format!("{}.png", e.slug));
        let size = png_size(&png);
        if e.kind == Kind::Plate && (size.is_none() || is_generated_plate(size)) {
            let old = names.get(&e.slug).map(|n| set_abbrev(n)).unwrap_or_default();
            fs::write(out.join("png").join(format!("{}.png", e.slug)), render_png(&svg, 160, 92)?)?;
            let state = if size.is_none() { "new" } else if old == e.text { "restyled" } else { "recoded" };
            repainted.push(format!("{}\t{state}\t{old}\t{}", e.slug, e.text));
        }
    }
    png_only.sort();
    fs::write(out.join("png-only.txt"), png_only.join("\n") + "\n")?;
    fs::write(out.join("png-repainted.tsv"), repainted.join("\n") + "\n")?;
    let mut summary: Vec<_> = counts.into_iter().collect();
    summary.sort();
    eprintln!("built {summary:?}; {} plate PNGs redrawn", repainted.len());
    Ok(())
}

/// Write the SPA list of slugs that have no SVG (market/src/expansion-symbols-png.js).
fn emit_js(out: &Path, js: &Path) -> Result<()> {
    let list = fs::read_to_string(out.join("png-only.txt"))?;
    let mut s = String::from(
        "// Generated by tools/expansion-symbols (build, then emit-js). Do not edit.\n\
         // Pokémon expansions whose symbol is only a small raster: every other\n\
         // slug loads /expansions/symbols/{slug}.svg.\n\
         export const PNG_ONLY_SYMBOLS = new Set([\n",
    );
    for slug in list.lines().filter(|l| !l.is_empty()) {
        let _ = writeln!(s, "  '{slug}',");
    }
    s.push_str("]);\n");
    fs::write(js, s)?;
    Ok(())
}

/// Before/after review page: the old PNG next to the new mark, in the 40 px
/// set chip and at 120 px, on the dark and the light theme. Screenshot it
/// with Playwright (scripts/expansion-symbols-sheet.mjs).
fn sheet(manifest: &Path, old: &Path, out: &Path, slugs: &Path, html: &Path) -> Result<()> {
    let entries: HashMap<String, Entry> = read_manifest(manifest)?.into_iter().map(|e| (e.slug.clone(), e)).collect();
    let wanted = fs::read_to_string(slugs)?;
    let abs = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let (old, out) = (abs(old), abs(out));
    let mut s = String::from(
        "<!doctype html><meta charset=utf-8><style>\
         body{margin:0;font:11px system-ui,sans-serif;background:#888}\
         table{border-collapse:collapse}td{padding:3px 6px;border-bottom:1px solid #6668}\
         .d{background:#14161c;color:#ddd}.l{background:#f4f4f2;color:#222}\
         .c{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;overflow:hidden}\
         .c img{width:100%;height:100%;object-fit:contain}\
         .b{width:120px;height:120px;display:grid;place-items:center}.b img{width:100%;height:100%;object-fit:contain}\
         th{font-weight:600;text-align:left;padding:4px 6px;background:#333;color:#eee}\
         </style><table><tr><th>set</th><th>kind</th><th>old</th><th>new</th><th>old</th><th>new</th><th>old 3×</th><th>new 3×</th><th>new 3×</th></tr>",
    );
    for slug in wanted.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let Some(e) = entries.get(slug) else {
            let _ = write!(s, "<tr><td>{slug}</td><td colspan=8>not in manifest</td></tr>");
            continue;
        };
        let before = format!("file://{}/{slug}.png", old.display());
        let after = if e.kind == Kind::Png { before.clone() } else { format!("file://{}/svg/{slug}.svg", out.display()) };
        let cell = |class: &str, size: &str, src: &str| format!("<td class={class}><div class={size}><img src=\"{src}\"></div></td>");
        let _ = write!(
            s,
            "<tr><td>{slug}<br><b>{}</b></td><td>{}</td>{}{}{}{}{}{}{}</tr>",
            e.text,
            e.kind.name(),
            cell("d", "c", &before),
            cell("d", "c", &after),
            cell("l", "c", &before),
            cell("l", "c", &after),
            cell("d", "b", &before),
            cell("d", "b", &after),
            cell("l", "b", &after),
        );
    }
    s.push_str("</table>");
    fs::write(html, s)?;
    Ok(())
}

fn arg(args: &[String], name: &str) -> Option<PathBuf> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(PathBuf::from)
}

fn need(args: &[String], name: &str) -> Result<PathBuf> {
    arg(args, name).with_context(|| format!("missing {name}"))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let font = arg(&args, "--font").unwrap_or_else(|| PathBuf::from(DEFAULT_FONT));
    match args.get(1).map(String::as_str) {
        Some("init") => init(&need(&args, "--catalog")?, &need(&args, "--symbols")?, arg(&args, "--overrides").as_deref()),
        Some("build") => build(
            &need(&args, "--manifest")?,
            &need(&args, "--symbols")?,
            &need(&args, "--out")?,
            &font,
            arg(&args, "--catalog").as_deref(),
        ),
        Some("emit-js") => emit_js(&need(&args, "--out")?, &need(&args, "--js")?),
        Some("sheet") => sheet(
            &need(&args, "--manifest")?,
            &need(&args, "--symbols")?,
            &need(&args, "--out")?,
            &need(&args, "--slugs")?,
            &need(&args, "--html")?,
        ),
        _ => bail!("usage: expansion-symbols init|build|emit-js|sheet (see the module docs)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(nat: &str, code: &str, official: &str) -> CatalogRow {
        CatalogRow {
            slug: String::new(),
            name: String::new(),
            nationality: nat.into(),
            code: code.into(),
            official: official.into(),
        }
    }

    fn text(nat: &str, code: &str, official: &str) -> Option<String> {
        printed_code(&row(nat, code, official)).map(|p| p.0)
    }

    #[test]
    fn printed_codes_follow_the_cards() {
        assert_eq!(text("western", "meg", "me1").as_deref(), Some("MEG"));
        assert_eq!(text("western", "por", "me3").as_deref(), Some("POR"));
        assert_eq!(text("western", "cri", "me4").as_deref(), Some("CRI"));
        assert_eq!(text("western", "pbl", "me5").as_deref(), Some("PBL"));
        assert_eq!(text("western", "scr", "sv7").as_deref(), Some("SCR"));
        assert_eq!(text("western", "fco", "xy10"), None);
        assert_eq!(text("chinese", "csv9", "CSV9C").as_deref(), Some("csv9C"));
        assert_eq!(text("chinese", "csv7", "CSV7C").as_deref(), Some("csv7C"));
        assert_eq!(text("chinese", "cs35", "CS3.5").as_deref(), Some("cs3.5C"));
        assert_eq!(text("japanese", "sv8", "SV8").as_deref(), Some("sv8"));
        assert_eq!(text("japanese", "sv4k", "").as_deref(), Some("sv4K"));
        assert_eq!(text("japanese", "xy11", "xy11").as_deref(), Some("XY11"));
        assert_eq!(text("japanese", "sm7b", "").as_deref(), Some("SM7b"));
        assert_eq!(text("japanese", "m1l", "").as_deref(), Some("M1L"));
        assert_eq!(text("japanese", "dp3", "dp3").as_deref(), Some("DP3"));
        assert_eq!(text("japanese", "sm2plus", "").as_deref(), Some("SM2+"));
        assert_eq!(text("japanese", "xy1y", "").as_deref(), Some("XY1"));
        assert_eq!(text("japanese", "sp6", "SP6").as_deref(), Some("SP6"));
        assert_eq!(text("unknown", "m7", "").as_deref(), Some("M7"));
    }

    #[test]
    fn plates_need_an_official_id() {
        let mut r = row("japanese", "mcmp", "");
        r.name = "McDonald's Pokémon e-Minimum Pack".into();
        assert_eq!(plate_code(&r), None);
        assert_eq!(plate_code(&row("japanese", "svf", "SVF")).map(|p| p.0).as_deref(), Some("svF"));
        assert_eq!(variant_stem("black-bolt-master-ball-reverse-holo"), Some("black-bolt"));
        assert_eq!(variant_stem("csv8-poke-ball-reverse"), Some("csv8"));
    }

    #[test]
    fn abbrev_matches_identity_js() {
        assert_eq!(set_abbrev("Aura Seeker"), "AS");
        assert_eq!(set_abbrev("Jungle"), "JUN");
        assert_eq!(set_abbrev("10th Movie Commemoration Set"), "1MC");
    }

    #[test]
    fn svgs_are_clean() {
        let bytes = fs::read(DEFAULT_FONT).unwrap();
        let tf = Typeface::new(&bytes).unwrap();
        let e = Entry {
            slug: "x".into(),
            kind: Kind::Code,
            text: "XY11".into(),
            style: Style::Sub,
            plate: Rgb(0, 160, 200),
            ink: Rgb(10, 10, 10),
            note: String::new(),
        };
        check_clean(&code_svg(&tf, &e)).unwrap();
        check_clean(&promo_svg(&tf)).unwrap();
        assert!(check_clean(r#"<svg><image href="x"/></svg>"#).is_err());
    }
}
