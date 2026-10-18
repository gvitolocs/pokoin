//! Deck mascot stamp plates for the expansion symbol chips.
//!
//! Battle Academy, Trainer Kit and similar deck printings carry a small
//! Pokémon stamp instead of (or next to) the expansion symbol. The desk shows
//! that stamp as the printing's mark (market/src/expansion-stamps.js). Each
//! plate is the D00002C family: a dark rounded plate with a light glyph,
//! square so the 40px chip keeps the silhouette legible.
//!
//!   cargo run --release -- --out /tmp/expansion-stamps
//!   cargo run --release -- --out /tmp/expansion-stamps --only mewtwo,pikachu
//!
//! Then publish both CDN origins with scripts/publish-expansion-stamps.sh.

use anyhow::{bail, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const SIZE: usize = 192;
const PAD: f64 = 22.0;
const RADIUS: f64 = 40.0;
const PLATE: [u8; 3] = [35, 31, 32];
const INK: [u8; 3] = [190, 192, 194];
/// Sub-samples per axis for anti-aliasing.
const SS: usize = 4;
/// Interior artwork pixels darker than this stay plate-coloured, so the
/// silhouette keeps the artwork's line work (eyes, limbs) like the printed stamp.
const LINE_LUMA: f64 = 0.16;

#[derive(Debug, Clone, PartialEq)]
enum Source {
    /// Official artwork (Sugimori style).
    PokeApi(String),
    /// Pokémon HOME render: a calmer front pose for species whose official
    /// artwork pose breaks apart at chip size.
    PokeApiHome(String),
    Draw(String),
    /// A logo stamp that is a letter mark (Team Rocket R): light letters.
    Text(String),
}

#[derive(Debug, Clone, PartialEq)]
struct Stamp {
    key: String,
    source: Source,
}

fn parse_manifest(text: &str) -> Result<Vec<Stamp>> {
    let mut out = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line == "key\tsource" {
            continue;
        }
        let (key, source) = line
            .split_once('\t')
            .with_context(|| format!("stamps.tsv:{}: expected key<TAB>source", n + 1))?;
        let source = match source.split_once(':') {
            Some(("pokeapi", name)) => Source::PokeApi(name.to_string()),
            Some(("pokeapi-home", name)) => Source::PokeApiHome(name.to_string()),
            Some(("draw", shape)) => Source::Draw(shape.to_string()),
            Some(("text", label)) => Source::Text(label.to_string()),
            _ => bail!("stamps.tsv:{}: unknown source {source}", n + 1),
        };
        out.push(Stamp { key: key.to_string(), source });
    }
    Ok(out)
}

/// Straight-alpha RGBA artwork, values 0..1.
struct Art {
    w: usize,
    h: usize,
    px: Vec<[f64; 4]>,
}

impl Art {
    fn at(&self, x: usize, y: usize) -> [f64; 4] {
        self.px[y * self.w + x]
    }
}

fn decode_png(bytes: &[u8]) -> Result<Art> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info()?;
    let mut buf = vec![0; reader.output_buffer_size().context("png too large")?];
    let info = reader.next_frame(&mut buf)?;
    let (w, h) = (info.width as usize, info.height as usize);
    let channels = info.color_type.samples();
    let mut px = Vec::with_capacity(w * h);
    for i in 0..w * h {
        let p = &buf[i * channels..(i + 1) * channels];
        let f = |v: u8| f64::from(v) / 255.0;
        px.push(match channels {
            4 => [f(p[0]), f(p[1]), f(p[2]), f(p[3])],
            3 => [f(p[0]), f(p[1]), f(p[2]), 1.0],
            2 => [f(p[0]), f(p[0]), f(p[0]), f(p[1])],
            _ => [f(p[0]), f(p[0]), f(p[0]), 1.0],
        });
    }
    Ok(Art { w, h, px })
}

/// Glyph coverage over the plate's inner box, 0..1, `SIZE`×`SIZE`.
type Mask = Vec<f64>;

fn luma(p: [f64; 4]) -> f64 {
    0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
}

/// Ink coverage of one artwork pixel: opaque and not dark line work.
fn ink(p: [f64; 4]) -> f64 {
    if p[3] > 0.5 && luma(p) < LINE_LUMA {
        0.0
    } else {
        p[3]
    }
}

fn silhouette_mask(art: &Art) -> Result<Mask> {
    let (mut x0, mut y0, mut x1, mut y1) = (art.w, art.h, 0, 0);
    for y in 0..art.h {
        for x in 0..art.w {
            if art.at(x, y)[3] > 0.04 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
        }
    }
    if x1 <= x0 || y1 <= y0 {
        bail!("artwork has no opaque pixels");
    }
    let (bw, bh) = ((x1 - x0) as f64, (y1 - y0) as f64);
    let inner = SIZE as f64 - 2.0 * PAD;
    let scale = inner / bw.max(bh);
    let (ox, oy) = ((SIZE as f64 - bw * scale) / 2.0, (SIZE as f64 - bh * scale) / 2.0);
    Ok(supersample(|x, y| {
        let sx = (x - ox) / scale + x0 as f64;
        let sy = (y - oy) / scale + y0 as f64;
        if sx < x0 as f64 || sy < y0 as f64 || sx >= x1 as f64 || sy >= y1 as f64 {
            return 0.0;
        }
        ink(art.at(sx as usize, sy as usize))
    }))
}

/// Averages `f` over SS×SS points inside each output pixel.
fn supersample(f: impl Fn(f64, f64) -> f64) -> Mask {
    let mut out = vec![0.0; SIZE * SIZE];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut acc = 0.0;
            for j in 0..SS {
                for i in 0..SS {
                    let px = x as f64 + (i as f64 + 0.5) / SS as f64;
                    let py = y as f64 + (j as f64 + 0.5) / SS as f64;
                    acc += f(px, py);
                }
            }
            out[y * SIZE + x] = acc / (SS * SS) as f64;
        }
    }
    out
}

/// Maps a pixel to glyph space: centre 0,0, inner box radius 1.
fn unit(x: f64, y: f64) -> (f64, f64) {
    let half = SIZE as f64 / 2.0;
    let r = half - PAD;
    ((x - half) / r, (y - half) / r)
}

fn segment_distance(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (vx, vy) = (b.0 - a.0, b.1 - a.1);
    let (wx, wy) = (p.0 - a.0, p.1 - a.1);
    let t = ((wx * vx + wy * vy) / (vx * vx + vy * vy)).clamp(0.0, 1.0);
    let (dx, dy) = (wx - t * vx, wy - t * vy);
    (dx * dx + dy * dy).sqrt()
}

/// Poké Ball: filled top, ring, open band and centre button.
fn poke_ball(x: f64, y: f64) -> f64 {
    let (u, v) = unit(x, y);
    let d = (u * u + v * v).sqrt();
    let band = 0.11;
    let ring = d <= 1.0 && d >= 0.84;
    let top = d <= 1.0 && v < -band;
    let button_gap = d < 0.40;
    let button = d < 0.24 || (d >= 0.31 && d < 0.40 && v.abs() >= band);
    if button {
        return 1.0;
    }
    if button_gap {
        return 0.0;
    }
    if (ring || top) && v.abs() >= band {
        1.0
    } else {
        0.0
    }
}

/// Six-armed snowflake with two branches per arm.
fn snowflake(x: f64, y: f64) -> f64 {
    let p = unit(x, y);
    let width = 0.075;
    for k in 0..6 {
        let a = std::f64::consts::PI / 3.0 * k as f64 - std::f64::consts::FRAC_PI_2;
        let (ca, sa) = (a.cos(), a.sin());
        let tip = (ca, sa);
        if segment_distance(p, (0.0, 0.0), tip) < width {
            return 1.0;
        }
        let base = (0.55 * ca, 0.55 * sa);
        for side in [-1.0f64, 1.0] {
            let b = a + side * std::f64::consts::FRAC_PI_4;
            let end = (base.0 + 0.36 * b.cos(), base.1 + 0.36 * b.sin());
            if segment_distance(p, base, end) < width {
                return 1.0;
            }
        }
    }
    if (p.0 * p.0 + p.1 * p.1).sqrt() < 0.16 {
        return 1.0;
    }
    0.0
}

/// Same face as the D00002C code plates (scripts/export-expansion-code-marks.py).
const FONT: &str = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

fn text_mask(label: &str) -> Result<Mask> {
    use ab_glyph::{Font, FontVec, PxScale, ScaleFont};
    let path = std::env::var("EXPANSION_STAMP_FONT").unwrap_or_else(|_| FONT.to_string());
    let font = FontVec::try_from_vec(fs::read(&path).with_context(|| format!("font {path}"))?)?;
    let inner = SIZE as f64 - 2.0 * PAD;
    // Lay out at a reference size, then scale to fit the inner box.
    let reference = 100.0f32;
    let sf = font.as_scaled(PxScale::from(reference));
    let mut x = 0.0f32;
    let mut glyphs = Vec::new();
    let mut prev = None;
    for ch in label.chars() {
        let id = sf.glyph_id(ch);
        if let Some(p) = prev {
            x += sf.kern(p, id);
        }
        glyphs.push(id.with_scale_and_position(reference, ab_glyph::point(x, sf.ascent())));
        x += sf.h_advance(id);
        prev = Some(id);
    }
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    let outlined: Vec<_> = glyphs.into_iter().filter_map(|g| font.outline_glyph(g)).collect();
    for g in &outlined {
        let b = g.px_bounds();
        x0 = x0.min(b.min.x);
        y0 = y0.min(b.min.y);
        x1 = x1.max(b.max.x);
        y1 = y1.max(b.max.y);
    }
    if outlined.is_empty() {
        bail!("text {label:?} has no glyphs");
    }
    // Letters sit a little smaller than silhouettes: 80 % of the inner box.
    let scale = (inner * 0.8) / f64::from((x1 - x0).max(y1 - y0));
    let (w, h) = (f64::from(x1 - x0) * scale, f64::from(y1 - y0) * scale);
    let (ox, oy) = ((SIZE as f64 - w) / 2.0, (SIZE as f64 - h) / 2.0);
    let (rw, rh) = ((x1 - x0).ceil() as usize + 2, (y1 - y0).ceil() as usize + 2);
    let mut raster = vec![0.0f64; rw * rh];
    for g in &outlined {
        let b = g.px_bounds();
        g.draw(|gx, gy, c| {
            let (px, py) = ((b.min.x - x0) as i64 + i64::from(gx), (b.min.y - y0) as i64 + i64::from(gy));
            if px >= 0 && py >= 0 && (px as usize) < rw && (py as usize) < rh {
                let cell = &mut raster[py as usize * rw + px as usize];
                *cell = (*cell + f64::from(c)).min(1.0);
            }
        });
    }
    Ok(supersample(|x, y| {
        let (sx, sy) = ((x - ox) / scale, (y - oy) / scale);
        if sx < 0.0 || sy < 0.0 || sx >= rw as f64 || sy >= rh as f64 {
            return 0.0;
        }
        raster[sy as usize * rw + sx as usize]
    }))
}

fn drawn_mask(shape: &str) -> Result<Mask> {
    Ok(match shape {
        "poke-ball" => supersample(poke_ball),
        "snowflake" => supersample(snowflake),
        _ => bail!("unknown drawn shape {shape}"),
    })
}

/// Rounded-rect plate coverage.
fn plate_coverage(x: f64, y: f64) -> f64 {
    let half = SIZE as f64 / 2.0 - 2.0;
    let (cx, cy) = ((x - SIZE as f64 / 2.0).abs(), (y - SIZE as f64 / 2.0).abs());
    let (qx, qy) = (cx - (half - RADIUS), cy - (half - RADIUS));
    let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0);
    if outside <= RADIUS {
        1.0
    } else {
        0.0
    }
}

fn render(mask: &Mask) -> Vec<u8> {
    let plate = supersample(plate_coverage);
    let mut rgba = Vec::with_capacity(SIZE * SIZE * 4);
    for i in 0..SIZE * SIZE {
        let a = plate[i];
        let g = mask[i].clamp(0.0, 1.0);
        for c in 0..3 {
            let v = f64::from(PLATE[c]) * (1.0 - g) + f64::from(INK[c]) * g;
            rgba.push(v.round() as u8);
        }
        rgba.push((a * 255.0).round() as u8);
    }
    rgba
}

fn encode_png(rgba: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, SIZE as u32, SIZE as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::High);
        enc.write_header()?.write_image_data(rgba)?;
    }
    Ok(out)
}

fn curl(url: &str, dest: &Path) -> Result<()> {
    if dest.exists() {
        return Ok(());
    }
    let tmp = dest.with_extension("part");
    let status = Command::new("curl")
        .args(["-fsSL", "--retry", "3", "-o"])
        .arg(&tmp)
        .arg(url)
        .status()
        .context("curl")?;
    if !status.success() {
        bail!("curl {url} failed: {status}");
    }
    fs::rename(&tmp, dest)?;
    Ok(())
}

fn pokeapi_art(name: &str, sprite: &str, cache: &Path) -> Result<Art> {
    let json_path = cache.join(format!("{name}.json"));
    curl(&format!("https://pokeapi.co/api/v2/pokemon/{name}"), &json_path)?;
    let json: serde_json::Value = serde_json::from_slice(&fs::read(&json_path)?)?;
    let url = json["sprites"]["other"][sprite]["front_default"]
        .as_str()
        .with_context(|| format!("{name}: no {sprite} sprite"))?;
    let png_path = cache.join(format!("{name}-{sprite}.png"));
    curl(url, &png_path)?;
    decode_png(&fs::read(&png_path)?).with_context(|| format!("{name}: decode"))
}

fn mask_for(stamp: &Stamp, cache: &Path) -> Result<Mask> {
    match &stamp.source {
        Source::PokeApi(name) => silhouette_mask(&pokeapi_art(name, "official-artwork", cache)?),
        Source::PokeApiHome(name) => silhouette_mask(&pokeapi_art(name, "home", cache)?),
        Source::Draw(shape) => drawn_mask(shape),
        Source::Text(label) => text_mask(label),
    }
}

struct Args {
    out: PathBuf,
    cache: PathBuf,
    manifest: PathBuf,
    only: Vec<String>,
}

fn parse_args() -> Result<Args> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut args = Args {
        out: PathBuf::from("/tmp/expansion-stamps"),
        cache: std::env::temp_dir().join("expansion-stamps-art"),
        manifest: root.join("stamps.tsv"),
        only: Vec::new(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().with_context(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--out" => args.out = value()?.into(),
            "--cache" => args.cache = value()?.into(),
            "--manifest" => args.manifest = value()?.into(),
            "--only" => args.only = value()?.split(',').map(str::to_string).collect(),
            _ => bail!("unknown flag {flag} (--out, --cache, --manifest, --only)"),
        }
    }
    Ok(args)
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let stamps = parse_manifest(&fs::read_to_string(&args.manifest)?)?;
    fs::create_dir_all(&args.out)?;
    fs::create_dir_all(&args.cache)?;
    for stamp in &stamps {
        if !args.only.is_empty() && !args.only.contains(&stamp.key) {
            continue;
        }
        let body = encode_png(&render(&mask_for(stamp, &args.cache)?))?;
        let dest = args.out.join(format!("{}.png", stamp.key));
        fs::write(&dest, &body)?;
        println!("{} {}B", dest.display(), body.len());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coverage(mask: &Mask) -> f64 {
        mask.iter().sum::<f64>() / mask.len() as f64
    }

    #[test]
    fn manifest_parses_sources_and_skips_comments() {
        let rows = parse_manifest(
            "# c\nkey\tsource\nmewtwo\tpokeapi:mewtwo\ngreninja\tpokeapi-home:greninja\npoke-ball\tdraw:poke-ball\n",
        )
        .unwrap();
        assert_eq!(
            rows,
            vec![
                Stamp { key: "mewtwo".into(), source: Source::PokeApi("mewtwo".into()) },
                Stamp { key: "greninja".into(), source: Source::PokeApiHome("greninja".into()) },
                Stamp { key: "poke-ball".into(), source: Source::Draw("poke-ball".into()) },
            ]
        );
        assert!(parse_manifest("bad\tftp:x\n").is_err());
    }

    #[test]
    fn shipped_manifest_has_unique_keys() {
        let rows = parse_manifest(include_str!("../stamps.tsv")).unwrap();
        let mut keys: Vec<_> = rows.iter().map(|r| r.key.as_str()).collect();
        let n = keys.len();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), n);
        assert!(keys.contains(&"mewtwo"));
    }

    #[test]
    fn drawn_shapes_are_visible_and_centred() {
        for shape in ["poke-ball", "snowflake"] {
            let mask = drawn_mask(shape).unwrap();
            let c = coverage(&mask);
            assert!(c > 0.08 && c < 0.6, "{shape} coverage {c}");
            assert_eq!(mask[0], 0.0, "{shape} paints the corner");
        }
    }

    #[test]
    fn text_plates_render_centred_letters() {
        if !Path::new(FONT).exists() {
            return;
        }
        let mask = text_mask("R").unwrap();
        let c = coverage(&mask);
        assert!(c > 0.05 && c < 0.5, "coverage {c}");
        assert_eq!(mask[0], 0.0);
    }

    #[test]
    fn silhouette_fits_inside_the_plate_padding() {
        let w = 40;
        let mut px = vec![[0.0; 4]; w * w];
        for y in 10..30 {
            for x in 5..35 {
                px[y * w + x] = [1.0, 1.0, 1.0, 1.0];
            }
        }
        let mask = silhouette_mask(&Art { w, h: w, px }).unwrap();
        let pad = PAD as usize;
        assert!(mask[(SIZE / 2) * SIZE + pad + 2] > 0.99, "left edge reaches the padding");
        assert_eq!(mask[(SIZE / 2) * SIZE + pad - 2], 0.0);
        assert_eq!(mask[(pad + 4) * SIZE + SIZE / 2], 0.0, "wide art is centred vertically");
    }

    #[test]
    fn dark_line_work_stays_plate_coloured() {
        assert_eq!(ink([0.05, 0.05, 0.05, 1.0]), 0.0);
        assert_eq!(ink([0.9, 0.8, 0.2, 1.0]), 1.0);
        assert_eq!(ink([0.0, 0.0, 0.0, 0.0]), 0.0);
    }

    #[test]
    fn render_keeps_corners_transparent_and_plate_opaque() {
        let rgba = render(&vec![0.0; SIZE * SIZE]);
        assert_eq!(rgba[3], 0, "corner alpha");
        let mid = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
        assert_eq!(&rgba[mid..mid + 4], &[PLATE[0], PLATE[1], PLATE[2], 255]);
    }
}
