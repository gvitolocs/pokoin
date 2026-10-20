//! `card.reverseScan` on the card page: a verified reverse-holo / mirror scan of
//! the same printing, hosted at `cdn.pokoin.com/reverse/`. The desk shows the
//! gold sparkles button only when this is set (`market/src/reverse-scans.js`).
//!
//! CardTrader sells reverse as a listing option (`pokemon_reverse`) of the one
//! blueprint, so the scan is keyed by the CardTrader id. The table is
//! `market/src/data/reverse-scans.json`, built by `tools/reverse-scan-audit`
//! (docs/REVERSE_SCANS.md); its `token` busts the CDN cache for every file.
use serde_json::Value;
use std::{collections::HashMap, sync::LazyLock};

const CDN_ORIGIN: &str = "https://cdn.pokoin.com";

static TABLE: LazyLock<(String, HashMap<String, String>)> = LazyLock::new(|| {
    let v: Value = serde_json::from_str(include_str!("../../../../market/src/data/reverse-scans.json")).expect("reverse-scans.json");
    let token = v["token"].as_str().unwrap_or("").to_owned();
    let scans = v["scans"]
        .as_object()
        .expect("reverse-scans.json scans")
        .iter()
        .filter_map(|(id, file)| Some((id.clone(), file.as_str()?.to_owned())))
        .collect();
    (token, scans)
});

/// The reverse scan URL for a CardTrader id, when there is a verified one.
/// Only the Pokémon catalog has them.
pub fn reverse_scan_url(ct_id: &str, game: &str) -> Option<String> {
    if game != "pokemon" {
        return None;
    }
    let (token, scans) = &*TABLE;
    let file = scans.get(ct_id.trim())?;
    Some(if token.is_empty() {
        format!("{CDN_ORIGIN}/reverse/{file}")
    } else {
        format!("{CDN_ORIGIN}/reverse/{file}?v={token}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wigglytuff_has_its_stamped_reverse() {
        assert_eq!(
            reverse_scan_url("114719", "pokemon").as_deref(),
            Some("https://cdn.pokoin.com/reverse/114719_wigglytuff-rare-holo-13-100-ex-crystal-guardians.jpg?v=rv1")
        );
    }

    #[test]
    fn unknown_ids_and_other_games_have_none() {
        assert_eq!(reverse_scan_url("1", "pokemon"), None);
        assert_eq!(reverse_scan_url("", "pokemon"), None);
        assert_eq!(reverse_scan_url("114719", "magic"), None);
    }

    #[test]
    fn every_file_is_a_flat_jpeg_named_by_its_id() {
        let (token, scans) = &*TABLE;
        assert!(!token.is_empty());
        for (id, file) in scans {
            assert!(id.parse::<u64>().is_ok(), "{id}");
            assert!(file.starts_with(&format!("{id}_")) && file.ends_with(".jpg") && !file.contains('/'), "{file}");
        }
    }
}
