//! Western leftover printing -> language -> TCGdex scan key (docs/CARD_LANGUAGE_SCANS.md).
//!
//! A western CardTrader blueprint is one printing for every western language;
//! TCGdex holds that same card per language under
//! `tcgdex/{lang}/{serie}/{set}/{localId}.webp` on cdn.pokoin.com. This tool
//! joins the two on set + collector number and keeps a pair only when the
//! TCGdex English name of that slot folds to the leftover's name. TCGdex
//! Pocket (`tcgp`) is never used. Japanese / Korean / Chinese print families
//! are separate printings (Codevira D000065, D000084) and are not inputs.
//!
//! ```text
//! lang-scans --cards cards.tsv --manifests DIR [--langs it,fr,de,es,pt]
//!            [--out mapping.tsv] [--rejects rejects.tsv]
//!            [--sample N --sample-out sample.tsv]
//! ```
//! `cards.tsv` is the psql export in docs/CARD_LANGUAGE_SCANS.md (header row:
//! ct_id, nationality, official_id, official_source, name, card_number).
//! `DIR/{lang}.jsonl` are the TCGdex upload manifests (`id`, `localId`,
//! `name`, `key`). `mapping.tsv` (ct_id, language, scan_path) is what
//! tools/lang-scans/load.sql loads into the scripts/sql/129 table.
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use unicode_normalization::UnicodeNormalization;

#[derive(Deserialize)]
struct ManifestRow {
    #[serde(rename = "localId")]
    local_id: String,
    name: String,
    key: String,
}

/// One TCGdex slot: the manifest key and that language's card name.
#[derive(Clone)]
struct Slot {
    name: String,
    key: String,
}

/// pokemontcg.io set ids whose TCGdex id is not the folded form.
/// Gallery subsets (`..tg`, `..gg`, `..sv`) live inside the main TCGdex set
/// with a letter-prefixed localId (TG01, GG01, SV001), see [`set_candidates`].
const SET_ALIASES: &[(&str, &str)] = &[
    ("swsh45", "swsh4.5"),
    ("swsh45sv", "swsh4.5"),
    // CardTrader's Hidden Fates SV expansion also holds the main 1-68 cards.
    ("sma", "sm115"),
    ("sm35", "sm3.5"),
    ("sm75", "sm7.5"),
    ("swsh35", "swsh3.5"),
    ("pgo", "swsh10.5"),
    ("base6", "lc"),
    ("hsp", "hgssp"),
    ("rsv10pt5", "sv10.5w"),
    ("zsv10pt5", "sv10.5b"),
];

/// Promo sets whose TCGdex localId carries the prefix CardTrader drops
/// (`Holo Promo | 045` is TCGdex swshp `SWSH045`).
const PROMO_PREFIXES: &[(&str, &str)] = &[("swshp", "SWSH"), ("smp", "SM"), ("xyp", "XY"), ("bwp", "BW"), ("hsp", "HGSS")];

/// Black Star promo families: the same promo number is often handed out
/// again with an event stamp the catalog does not name, so their scans are
/// compared with the leftover's artwork window ([`art_blocks`]).
const PROMO_FAMILIES: &[&str] = &["basep", "np", "dpp", "hsp", "bwp", "xyp", "smp", "swshp", "svp", "mep"];

/// Catalog words that mark an event / store / league stamped printing. A
/// stamped leftover keeps its own scan: the TCGdex scan is the plain card.
const STAMP_WORDS: &[&str] = &[
    "stamp", "stamped", "prerelease", "staff", "league", "world", "worlds", "championship", "championships",
    "place", "winner", "top", "finalist", "semifinalist", "quarterfinalist", "pokemonday", "comiccon",
    "generalmills", "originsgame", "illustrationcontest", "pokemontogether", "pokemoncenter", "gamestop",
    "buildabear", "wizardworld", "scrye", "regional", "regionals", "nationals", "battleroad", "e3",
];

/// Default [`stamp_contrast`] above which a promo scan is not trusted to be
/// the same printing. Calibrated 2026-10-19 on 1,336 promo pairs: catalog-
/// stamped pairs have median 0.37 (p10 0.15), plain pairs median 0.04 (p75
/// 0.22). Kept pairs just under 0.15 were checked by eye on a contact sheet.
/// Low on purpose: a dropped promo keeps its English scan, a wrong stamp is a
/// wrong card.
const PROMO_MAX_DIFFERENCE: f32 = 0.15;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |name: &str| -> Option<String> {
        args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
    };
    let cards = arg("--cards").context("--cards cards.tsv is required")?;
    let manifests = arg("--manifests").context("--manifests DIR is required")?;
    let langs: Vec<String> = arg("--langs")
        .unwrap_or_else(|| "it,fr,de,es,pt".into())
        .split(',')
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    if langs.iter().any(|l| l == "en") {
        bail!("en is the leftover scan itself; --langs lists the other languages");
    }
    let out = arg("--out").unwrap_or_else(|| "mapping.tsv".into());
    let keep_stamped = args.iter().any(|a| a == "--keep-stamped");
    let mut stamp_of: HashMap<String, &'static str> = HashMap::new();
    let stamped = match arg("--stamps") {
        Some(path) => load_stamped(&path)?,
        None => Default::default(),
    };
    let english = load_manifest(&format!("{manifests}/en.jsonl"))?;
    let mut by_lang = BTreeMap::new();
    for lang in &langs {
        by_lang.insert(lang.clone(), load_manifest(&format!("{manifests}/{lang}.jsonl"))?);
    }

    let mut writer = BufWriter::new(File::create(&out)?);
    let mut rejects = match arg("--rejects") {
        Some(path) => Some(BufWriter::new(File::create(path)?)),
        None => None,
    };
    let mut stats: BTreeMap<String, usize> = BTreeMap::new();
    let mut missing_sets: BTreeMap<String, usize> = BTreeMap::new();
    let mut samples = Vec::new();
    let mut matched = Vec::new();
    for (index, line) in BufReader::new(File::open(&cards)?).lines().enumerate() {
        let line = line?;
        let cols: Vec<&str> = line.split('\t').collect();
        if index == 0 || cols.len() < 6 || !cols[0].bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let (ct_id, set, name, number) = (cols[0], cols[2], cols[4], cols[5]);
        let (image_url, set_name) = (cols.get(6).copied().unwrap_or(""), cols.get(7).copied().unwrap_or(""));
        *stats.entry("cards".into()).or_default() += 1;
        let file = image_url.rsplit('/').next().unwrap_or("").replace(['-', '_'], " ");
        let word = stamp_word(&[number, name, set_name, &file]);
        if let Some(word) = word.filter(|_| keep_stamped) {
            // Calibration only: keep the pair, name the stamp in the promo report.
            stamp_of.insert(ct_id.to_owned(), word);
        } else if let Some(word) = word {
            *stats.entry("reject:stamped_catalog".into()).or_default() += 1;
            if let Some(w) = rejects.as_mut() {
                writeln!(w, "{ct_id}\t{set}\t{number}\t{name}\tstamp:{word}\t")?;
            }
            continue;
        }
        if ct_id.parse::<u64>().is_ok_and(|id| stamped.contains(&id)) {
            *stats.entry("reject:stamped_list".into()).or_default() += 1;
            continue;
        }
        let Some(collector) = collector(number) else {
            *stats.entry("reject:no_collector".into()).or_default() += 1;
            continue;
        };
        let Some((set_key, slot)) = set_candidates(set, &collector)
            .into_iter()
            .find_map(|k| english.get(&k).map(|slot| (k, slot)))
        else {
            *stats.entry("reject:no_tcgdex_slot".into()).or_default() += 1;
            *missing_sets.entry(set.to_owned()).or_default() += 1;
            continue;
        };
        if !same_name(name, &slot.name) {
            *stats.entry("reject:name_mismatch".into()).or_default() += 1;
            if let Some(w) = rejects.as_mut() {
                writeln!(w, "{ct_id}\t{set}\t{number}\t{name}\t{}\t{}", slot.name, slot.key)?;
            }
            continue;
        }
        *stats.entry("matched_en".into()).or_default() += 1;
        let mut langs_here = Vec::new();
        for (lang, index) in &by_lang {
            let Some(found) = index.get(&set_key) else { continue };
            // The API sends one path for every language of a printing.
            if suffix(&found.key) != suffix(&slot.key) {
                *stats.entry(format!("reject:suffix_differs:{lang}")).or_default() += 1;
                continue;
            }
            langs_here.push((lang.clone(), found.key.clone()));
        }
        let promo = PROMO_FAMILIES.contains(&set.to_ascii_lowercase().as_str());
        let leftover = if promo { image_url.rsplit('/').next().unwrap_or("").to_owned() } else { String::new() };
        matched.push((ct_id.to_owned(), name.to_owned(), leftover, langs_here));
    }

    // A scan that is missing, tiny, or cut off (the opaque card ends early,
    // the rest transparent) never replaces a good leftover JPEG.
    let bad = match arg("--scan-root") {
        Some(root) => {
            let keys: Vec<&str> = matched.iter().flat_map(|m| m.3.iter().map(|(_, k)| k.as_str())).collect();
            check_scans(&root, &keys)
        }
        None => HashMap::new(),
    };
    // Promo families: the leftover's artwork window against each scan's.
    let promo_pairs: Vec<(String, String, String)> = matched
        .iter()
        .filter(|m| !m.2.is_empty())
        .flat_map(|m| m.3.iter().filter(|(_, k)| !bad.contains_key(k)).map(|(_, k)| (m.0.clone(), m.2.clone(), k.clone())))
        .collect();
    let differences = match (arg("--leftover-root"), arg("--scan-root")) {
        (Some(leftovers), Some(scans)) => promo_differences(&leftovers, &scans, &promo_pairs),
        _ => HashMap::new(),
    };
    let promo_max = arg("--promo-max").and_then(|v| v.parse::<f32>().ok()).unwrap_or(PROMO_MAX_DIFFERENCE);
    if let Some(path) = arg("--promo-report") {
        let mut w = BufWriter::new(File::create(path)?);
        for (ct_id, leftover, key) in &promo_pairs {
            let (max, median) = differences.get(&(ct_id.clone(), key.clone())).copied().unwrap_or((f32::NAN, f32::NAN));
            let stamp = stamp_of.get(ct_id).copied().unwrap_or("-");
            writeln!(w, "{ct_id}\t{leftover}\t{key}\t{max:.4}\t{median:.4}\t{stamp}")?;
        }
        w.flush()?;
    }
    for (ct_id, name, leftover, langs_here) in matched {
        let mut kept = Vec::new();
        for (lang, key) in langs_here {
            if let Some(reason) = bad.get(&key) {
                *stats.entry(format!("scan_rejected:{lang}:{reason}")).or_default() += 1;
                continue;
            }
            if !leftover.is_empty() {
                // No leftover to compare with is not proof of the same printing.
                match differences.get(&(ct_id.clone(), key.clone())).map(|(max, median)| stamp_contrast(*max, *median)) {
                    Some(d) if d <= promo_max => {}
                    Some(_) => {
                        *stats.entry(format!("promo_rejected:{lang}:art_differs")).or_default() += 1;
                        continue;
                    }
                    None => {
                        *stats.entry(format!("promo_rejected:{lang}:unchecked")).or_default() += 1;
                        continue;
                    }
                }
            }
            writeln!(writer, "{ct_id}\t{lang}\t{}", scan_path(&key))?;
            *stats.entry(format!("lang:{lang}")).or_default() += 1;
            kept.push((lang, key));
        }
        if kept.is_empty() {
            *stats.entry("matched_no_language".into()).or_default() += 1;
        } else {
            *stats.entry("printings_with_language".into()).or_default() += 1;
            samples.push((ct_id, name, kept));
        }
    }
    writer.flush()?;
    if let Some(mut w) = rejects {
        w.flush()?;
    }
    if let (Some(n), Some(path)) = (arg("--sample").and_then(|n| n.parse::<usize>().ok()), arg("--sample-out")) {
        write_sample(&samples, n, &path)?;
    }
    for (key, value) in &stats {
        println!("{key}\t{value}");
    }
    let mut missing: Vec<_> = missing_sets.into_iter().collect();
    missing.sort_by(|a, b| b.1.cmp(&a.1));
    for (set, count) in missing.iter().take(40) {
        println!("missing_set\t{set}\t{count}");
    }
    Ok(())
}

/// Scan key -> why it is unusable (`missing`, `small`, `cut`), checked on
/// every core. A good TCGdex scan is >= 400 px wide and opaque down its
/// middle; only the rounded corners are transparent.
fn check_scans(root: &str, keys: &[&str]) -> HashMap<String, &'static str> {
    let mut unique: Vec<&str> = keys.to_vec();
    unique.sort_unstable();
    unique.dedup();
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
    let chunk = unique.len().div_ceil(threads).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> = unique
            .chunks(chunk)
            .map(|part| {
                scope.spawn(move || {
                    part.iter()
                        .filter_map(|key| scan_problem(&format!("{root}/{key}")).map(|r| (key.to_string(), r)))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    })
}

fn scan_problem(path: &str) -> Option<&'static str> {
    let Ok(image) = image::open(path) else { return Some("missing") };
    let image = image.to_rgba8();
    let (w, h) = image.dimensions();
    if w < 400 || h < 550 {
        return Some("small");
    }
    if opaque_box_is_full(&image) {
        None
    } else {
        Some("cut")
    }
}

/// The opaque card spans the whole image: along three columns its first and
/// last opaque pixels sit within 3 % of the top and bottom edge, and along
/// three rows within 3 % of the left and right edge (only the rounded corners
/// are transparent). A truncated upload is opaque at the top and empty below.
fn opaque_box_is_full(image: &image::RgbaImage) -> bool {
    let (w, h) = image.dimensions();
    let opaque = |x: u32, y: u32| image.get_pixel(x, y)[3] > 200;
    let spans = |len: u32, at: &dyn Fn(u32) -> bool| -> bool {
        let first = (0..len).find(|i| at(*i));
        let last = (0..len).rev().find(|i| at(*i));
        matches!((first, last), (Some(a), Some(b)) if a * 100 <= len * 3 && b * 100 >= len * 97)
    };
    [0.25f32, 0.5, 0.75].iter().all(|f| {
        let x = (w as f32 * f) as u32;
        let y = (h as f32 * f) as u32;
        spans(h, &|row| opaque(x, row)) && spans(w, &|col| opaque(col, y))
    })
}

/// (ct_id, scan key) -> artwork-window difference for the promo pairs, on
/// every core. Pairs whose leftover or scan does not load are left out.
fn promo_differences(leftovers: &str, scans: &str, pairs: &[(String, String, String)]) -> HashMap<(String, String), (f32, f32)> {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
    let chunk = pairs.len().div_ceil(threads).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> = pairs
            .chunks(chunk)
            .map(|part| {
                scope.spawn(move || {
                    part.iter()
                        .filter_map(|(ct_id, leftover, key)| {
                            let a = image::open(format!("{leftovers}/{leftover}")).ok()?;
                            let b = image::open(format!("{scans}/{key}")).ok()?;
                            let blocks = art_blocks(&a, &b);
                            Some(((ct_id.clone(), key.clone()), (blocks[15], blocks[8])))
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    })
}

/// Artwork window of a portrait card (x 10-90 %, y 12-47 %) as a 32x24
/// grayscale grid, normalised to zero mean and unit spread so scan exposure
/// and JPEG/WebP colour differences cancel out.
fn art_window(image: &image::DynamicImage) -> Vec<f32> {
    let (w, h) = (image.width(), image.height());
    let crop = image.crop_imm(w / 10, h * 12 / 100, w * 8 / 10, h * 35 / 100);
    let small = crop.resize_exact(32, 24, image::imageops::FilterType::Triangle).to_luma8();
    let values: Vec<f32> = small.pixels().map(|p| p[0] as f32).collect();
    let mean = values.iter().sum::<f32>() / values.len() as f32;
    let spread = (values.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / values.len() as f32).sqrt().max(1.0);
    values.iter().map(|v| (v - mean) / spread).collect()
}

/// How much the worst artwork block stands out from the typical one. Holo
/// glare and scan exposure raise every block alike; a stamp printed on the
/// painting raises one or two.
fn stamp_contrast(max: f32, median: f32) -> f32 {
    max - median
}

/// Mean absolute difference of the two artwork windows per block of a 4x4
/// grid, ascending.
fn art_blocks(a: &image::DynamicImage, b: &image::DynamicImage) -> Vec<f32> {
    let (a, b) = (art_window(a), art_window(b));
    let mut blocks = Vec::with_capacity(16);
    for by in 0..4 {
        for bx in 0..4 {
            let mut sum = 0.0;
            for y in by * 6..by * 6 + 6 {
                for x in bx * 8..bx * 8 + 8 {
                    sum += (a[y * 32 + x] - b[y * 32 + x]).abs();
                }
            }
            blocks.push(sum / 48.0);
        }
    }
    blocks.sort_by(|x, y| x.total_cmp(y));
    blocks
}

/// Public card ids in market/src/data/card-stamps.js -> leftover ct_ids.
fn load_stamped(path: &str) -> Result<std::collections::HashSet<u64>> {
    let text = std::fs::read_to_string(path).with_context(|| format!("open {path}"))?;
    Ok(text
        .lines()
        .filter_map(|line| line.trim().split_once(':'))
        .filter_map(|(id, _)| id.trim().parse::<u64>().ok())
        .filter(|id| id % 2 == 0)
        .map(|id| id / 2)
        .collect())
}

/// The first stamp word in the catalog text, compared as folded words
/// (`Semi-Finalist` -> `semifinalist`, `Pokémon Day` -> `pokemonday` also
/// across two words).
fn stamp_word(fields: &[&str]) -> Option<&'static str> {
    let words: Vec<String> = fields
        .iter()
        .flat_map(|f| f.split(|c: char| c.is_whitespace() || c == '|' || c == '[' || c == ']' || c == '(' || c == ')' || c == ','))
        .map(|w| w.nfkd().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect::<String>())
        .filter(|w| !w.is_empty())
        .collect();
    let pairs = words.windows(2).map(|p| format!("{}{}", p[0], p[1]));
    let all: Vec<String> = words.iter().cloned().chain(pairs).collect();
    STAMP_WORDS.iter().copied().find(|stamp| all.iter().any(|w| w == stamp))
}

/// Every `stride`-th printing, cycling it -> fr -> de -> ... so each language
/// shows up in the contact sheet: ct_id, name, language, scan key.
fn write_sample(samples: &[(String, String, Vec<(String, String)>)], n: usize, path: &str) -> Result<()> {
    let mut w = BufWriter::new(File::create(path)?);
    let stride = (samples.len() / n.max(1)).max(1);
    for (i, (ct_id, name, langs)) in samples.iter().step_by(stride).take(n).enumerate() {
        let (lang, key) = &langs[i % langs.len()];
        writeln!(w, "{ct_id}\t{name}\t{lang}\t{key}")?;
    }
    w.flush()?;
    Ok(())
}

/// `(folded set, folded collector)` -> slot, from one language manifest.
/// The first slot wins when two localIds fold together.
fn load_manifest(path: &str) -> Result<HashMap<(String, String), Slot>> {
    let mut map = HashMap::new();
    for line in BufReader::new(File::open(path).with_context(|| format!("open {path}"))?).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let row: ManifestRow = serde_json::from_str(&line).with_context(|| format!("{path}: {line}"))?;
        // tcgdex/{lang}/{serie}/{set}/{localId}.webp
        let parts: Vec<&str> = row.key.split('/').collect();
        if parts.len() != 5 || parts[2] == "tcgp" {
            continue;
        }
        map.entry((fold_set(parts[3]), fold_number(&row.local_id)))
            .or_insert(Slot { name: row.name, key: row.key });
    }
    Ok(map)
}

/// `{serie}/{set}/{localId}.webp`: the part of a key every language shares.
fn suffix(key: &str) -> &str {
    key.splitn(3, '/').nth(2).unwrap_or(key)
}

/// `tcgdex/it/swsh/swsh3/136.webp` -> `swsh/swsh3/136`, the stored scan_path.
fn scan_path(key: &str) -> &str {
    suffix(key).strip_suffix(".webp").unwrap_or(suffix(key))
}

/// pokemontcg.io / TCGdex set ids to one form: `sv3pt5` and `sv03.5` -> `sv3.5`.
fn fold_set(set: &str) -> String {
    let lower = set.to_ascii_lowercase().replace("pt", ".");
    strip_zero_runs(&lower)
}

/// `TG05` -> `TG5`, `005` -> `5`; leading zeros of every digit run go.
fn fold_number(number: &str) -> String {
    strip_zero_runs(&number.trim().to_ascii_uppercase())
}

fn strip_zero_runs(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    for (i, &b) in bytes.iter().enumerate() {
        // A zero with no digit written before it and a digit after it leads its run.
        let leading = !out.ends_with(|c: char| c.is_ascii_digit());
        if b == b'0' && leading && bytes.get(i + 1).is_some_and(u8::is_ascii_digit) {
            continue;
        }
        out.push(b as char);
    }
    out
}

/// Printed collector number from `Rarity | 170/163`, `074/093 | Sample Print`,
/// `SWSH050`, `TG01/TG30`, `Prerelease 008`: the first segment whose last
/// word is a number, before `/`.
fn collector(card_number: &str) -> Option<String> {
    card_number.split('|').map(str::trim).find_map(|segment| {
        let head = segment.split('/').next()?.split_whitespace().last()?;
        let digits = head.bytes().filter(u8::is_ascii_digit).count();
        let plain = head.bytes().all(|b| b.is_ascii_alphanumeric());
        (digits > 0 && plain && head.len() <= 8 && head.as_bytes()[head.len() - 1].is_ascii_alphanumeric())
            .then(|| fold_number(head))
    })
}

/// Folded set ids to try, in order: the set itself, then its alias, then the
/// parent set for a gallery subset (`swsh9tg` TG05 lives in TCGdex `swsh9`).
fn set_candidates(set: &str, number: &str) -> Vec<(String, String)> {
    let lower = set.to_ascii_lowercase();
    let mut sets = vec![fold_set(&lower)];
    if let Some((_, to)) = SET_ALIASES.iter().find(|(from, _)| *from == lower) {
        sets.push(fold_set(to));
    }
    for gallery in ["tg", "gg", "sv"] {
        if let Some(parent) = lower.strip_suffix(gallery) {
            sets.push(fold_set(parent));
            if let Some((_, to)) = SET_ALIASES.iter().find(|(from, _)| *from == parent) {
                sets.push(fold_set(to));
            }
        }
    }
    let mut unique: Vec<String> = Vec::new();
    for set in sets {
        if !unique.contains(&set) {
            unique.push(set);
        }
    }
    let mut out: Vec<(String, String)> = unique.iter().map(|s| (s.clone(), number.to_owned())).collect();
    if number.bytes().all(|b| b.is_ascii_digit()) {
        if let Some((_, prefix)) = PROMO_PREFIXES.iter().find(|(from, _)| *from == lower) {
            out.extend(unique.into_iter().map(|s| (s, format!("{prefix}{number}"))));
        }
    }
    out
}

/// Names compare without accents, case, punctuation or spacing.
/// CardTrader's DP/Platinum `Lv.36` and EX `δ Delta Species` / `☆ Gold Star`
/// suffixes are not part of the TCGdex name (`LV.X` is, and stays).
fn fold_name(name: &str) -> String {
    // `Professor's Research - Professor Turo` and `Tropical Wind
    // [Quarter-Finalist]` name the slot's own printing by its subtitle/stamp.
    let base = name.split(" - ").next().unwrap_or(name).split(" [").next().unwrap_or(name);
    let mut text = base.to_lowercase().replace("delta species", "").replace("gold star", "").replace("prism star", "");
    while let Some(at) = text.find("lv.") {
        let gap = text[at + 3..].bytes().take_while(|b| *b == b' ').count();
        let digits = text[at + 3 + gap..].bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            break;
        }
        text.replace_range(at..at + 3 + gap + digits, "");
    }
    text.replace('♀', "f")
        .replace('♂', "m")
        .replace('δ', "delta")
        .replace(['☆', '★'], "star")
        .nfkd()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn same_name(leftover: &str, tcgdex: &str) -> bool {
    let (a, b) = (fold_name(leftover), fold_name(tcgdex));
    !a.is_empty() && a == b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_fold_across_sources() {
        assert_eq!(fold_set("sv3pt5"), "sv3.5");
        assert_eq!(fold_set("sv03.5"), "sv3.5");
        assert_eq!(fold_set("me03"), "me3");
        assert_eq!(fold_set("me3"), "me3");
        assert_eq!(fold_set("swsh10"), "swsh10");
        assert_eq!(fold_set("base1"), "base1");
    }

    #[test]
    fn numbers_fold_leading_zeros_only() {
        assert_eq!(fold_number("095"), "95");
        assert_eq!(fold_number("TG05"), "TG5");
        assert_eq!(fold_number("SWSH050"), "SWSH50");
        assert_eq!(fold_number("100"), "100");
        assert_eq!(fold_number("0"), "0");
        assert_eq!(fold_number("SV001"), "SV1");
    }

    #[test]
    fn collector_is_the_printed_number() {
        assert_eq!(collector("Rainbow Secret Rare | 170/163").as_deref(), Some("170"));
        assert_eq!(collector("074/093 | Sample Print").as_deref(), Some("74"));
        assert_eq!(collector("Illustration Rare | 095/088").as_deref(), Some("95"));
        assert_eq!(collector("SWSH050").as_deref(), Some("SWSH50"));
        assert_eq!(collector("TG01/TG30").as_deref(), Some("TG1"));
        assert_eq!(collector("Prerelease 008").as_deref(), Some("8"));
        assert_eq!(collector("Rare Holo"), None);
    }

    #[test]
    fn promo_numbers_gain_their_prefix() {
        assert!(set_candidates("swshp", "45").contains(&("swshp".into(), "SWSH45".into())));
        assert_eq!(set_candidates("swsh5", "45").len(), 1);
    }

    #[test]
    fn level_and_era_suffixes_are_not_names() {
        assert!(same_name("Skuntank Lv.36", "Skuntank"));
        assert!(same_name("Dragonair δ Delta Species", "Dragonair δ"));
        assert!(same_name("Umbreon ☆ Gold Star", "Umbreon ★"));
        assert!(same_name("Happiny Lv. 5", "Happiny"));
        assert!(same_name("Diancie ◇ Prism Star", "Diancie ◇"));
        assert!(same_name("Professor's Research - Professor Turo", "Professor's Research"));
        assert!(same_name("Tropical Wind [Quarter-Finalist]", "Tropical Wind"));
        assert!(!same_name("Alakazam LV.X", "Alakazam"));
    }

    #[test]
    fn galleries_try_their_parent_set() {
        let sets: Vec<String> = set_candidates("swsh12pt5gg", "GG1").into_iter().map(|s| s.0).collect();
        assert_eq!(sets, ["swsh12.5gg", "swsh12.5"]);
        let sets: Vec<String> = set_candidates("swsh45sv", "SV1").into_iter().map(|s| s.0).collect();
        assert_eq!(sets, ["swsh45sv", "swsh4.5", "swsh45"]);
    }

    #[test]
    fn names_fold_accents_and_symbols() {
        assert!(same_name("Flabébé", "Flabebe"));
        assert!(same_name("Nidoran ♀", "Nidoran♀"));
        assert!(same_name("Professor's Research", "Professor’s Research"));
        assert!(!same_name("Pikachu", "Raichu"));
        assert!(!same_name("", ""));
    }

    #[test]
    fn catalog_stamps_are_found() {
        assert_eq!(stamp_word(&["Non-Holo Promo | XY176 | Top Thirty-Two", "Champions Festival", "XY Black Star Promos"]), Some("top"));
        assert_eq!(stamp_word(&["Promo BW30 | 2nd Place Autumn 2012", "Victory Cup", ""]), Some("place"));
        assert_eq!(stamp_word(&["Holo Promo | SM78 | Semi-Finalist", "x", ""]), Some("semifinalist"));
        assert_eq!(stamp_word(&["Italian Pokémon Day", "x", ""]), Some("pokemonday"));
        assert_eq!(stamp_word(&["STAFF Prerelease SM12", "x", ""]), Some("prerelease"));
        assert_eq!(stamp_word(&["WORLD 12 Promo BW50", "x", ""]), Some("world"));
        assert_eq!(stamp_word(&["Holo Promo | BW54", "Pikachu", "BW Black Star Promos"]), None);
        assert_eq!(stamp_word(&["Holo Rare | 132/172", "Boss's Orders - Cyrus", "Brilliant Stars"]), None);
        assert_eq!(stamp_word(&["074/073", "Champion's Path", "Champion's Path"]), None);
        assert_eq!(stamp_word(&["SV001", "Topaz", "Stopwatch"]), None);
        assert_eq!(stamp_word(&["1/98", "Oddish", "Ancient Origins"]), None);
        assert_eq!(stamp_word(&["Origins Game Fair 2008", "x", ""]), Some("originsgame"));
    }

    #[test]
    fn a_truncated_scan_is_not_full() {
        let full = image::RgbaImage::from_pixel(600, 825, image::Rgba([10, 20, 30, 255]));
        assert!(opaque_box_is_full(&full));
        let mut cut = full.clone();
        for y in 363..825 {
            for x in 0..600 {
                cut.put_pixel(x, y, image::Rgba([0, 0, 0, 0]));
            }
        }
        assert!(!opaque_box_is_full(&cut));
    }

    #[test]
    fn a_stamp_on_the_artwork_lights_up_one_block() {
        let paint = image::RgbImage::from_fn(600, 825, |x, y| image::Rgb([(x / 3) as u8, (y / 4) as u8, 90]));
        let plain = image::DynamicImage::ImageRgb8(paint.clone());
        let mut stamped = paint;
        for y in 300..380 {
            for x in 420..520 {
                stamped.put_pixel(x, y, image::Rgb([255, 255, 255]));
            }
        }
        let stamped = image::DynamicImage::ImageRgb8(stamped);
        let same = art_blocks(&plain, &plain);
        let diff = art_blocks(&plain, &stamped);
        assert!(stamp_contrast(same[15], same[8]) < 0.01);
        assert!(stamp_contrast(diff[15], diff[8]) > PROMO_MAX_DIFFERENCE);
    }

    #[test]
    fn suffix_is_language_free() {
        assert_eq!(suffix("tcgdex/it/swsh/swsh3/136.webp"), "swsh/swsh3/136.webp");
        assert_eq!(scan_path("tcgdex/it/swsh/swsh3/136.webp"), "swsh/swsh3/136");
    }
}
