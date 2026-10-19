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
//! tools/lang-scans/load.sql loads into the scripts/sql/127 table.
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
        *stats.entry("cards".into()).or_default() += 1;
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
        matched.push((ct_id.to_owned(), name.to_owned(), langs_here));
    }

    // A scan that is missing, tiny, or cut off (the opaque card ends early,
    // the rest transparent) never replaces a good leftover JPEG.
    let bad = match arg("--scan-root") {
        Some(root) => {
            let keys: Vec<&str> = matched.iter().flat_map(|m| m.2.iter().map(|(_, k)| k.as_str())).collect();
            check_scans(&root, &keys)
        }
        None => HashMap::new(),
    };
    for (ct_id, name, langs_here) in matched {
        let mut kept = Vec::new();
        for (lang, key) in langs_here {
            if let Some(reason) = bad.get(&key) {
                *stats.entry(format!("scan_rejected:{lang}:{reason}")).or_default() += 1;
                continue;
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
    let opaque = |fx: f32, fy: f32| image.get_pixel((w as f32 * fx) as u32, (h as f32 * fy) as u32)[3] > 200;
    let points = [(0.5, 0.03), (0.5, 0.5), (0.5, 0.97), (0.03, 0.5), (0.97, 0.5), (0.5, 0.8)];
    if points.iter().all(|(x, y)| opaque(*x, *y)) {
        None
    } else {
        Some("cut")
    }
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
    fn suffix_is_language_free() {
        assert_eq!(suffix("tcgdex/it/swsh/swsh3/136.webp"), "swsh/swsh3/136.webp");
        assert_eq!(scan_path("tcgdex/it/swsh/swsh3/136.webp"), "swsh/swsh3/136");
    }
}
