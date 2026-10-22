use serde_json::Value;
use std::collections::HashSet;

const OUTLETS: &[(&str, &str)] = &[
    ("ign", "ign.com"),
    ("polygon", "polygon.com"),
    ("gamerant", "gamerant.com"),
    ("screenrant", "screenrant.com"),
    ("screen rant", "screenrant.com"),
    ("mashable", "mashable.com"),
    ("kotaku", "kotaku.com"),
    ("eurogamer", "eurogamer.net"),
    ("nintendolife", "nintendolife.com"),
    ("nintendo life", "nintendolife.com"),
    ("pokebeach", "pokebeach.com"),
    ("pokeguardian", "pokeguardian.com"),
    ("pokemon", "pokemon.com"),
    ("pokemon.com", "pokemon.com"),
    ("facebook", "facebook.com"),
    ("imdb", "imdb.com"),
    ("amazon", "amazon.com"),
    ("reddit", "reddit.com"),
];
pub fn domain_of(source: &str) -> String {
    let s = source.trim().to_lowercase();
    if s.is_empty() {
        return s;
    }
    let url = if s.contains("://") {
        s.clone()
    } else {
        format!("https://{s}")
    };
    url::Url::parse(&url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| {
            s.trim_start_matches("https://")
                .trim_start_matches("http://")
                .to_owned()
        })
        .trim_start_matches("www.")
        .to_owned()
}
pub fn resolve_source_host(source: &str) -> String {
    let raw = domain_of(source);
    if let Some((_, host)) = OUTLETS.iter().find(|(name, _)| *name == raw) {
        return (*host).into();
    }
    let key = [".co.uk", ".co.jp", ".com", ".net", ".org"]
        .iter()
        .find_map(|s| raw.strip_suffix(s))
        .unwrap_or(&raw);
    if let Some((_, host)) = OUTLETS.iter().find(|(name, _)| *name == key) {
        return (*host).into();
    }
    if regex::Regex::new(r"^[a-z0-9-]+(\.[a-z0-9-]+)+$").is_ok_and(|re| re.is_match(&raw)) {
        return raw;
    }
    for (name, host) in OUTLETS {
        let matches = if name.contains(' ') {
            raw == *name
                || raw.contains(&format!(" {name} "))
                || raw.ends_with(&format!(" {name}"))
                || raw.starts_with(&format!("{name} "))
        } else {
            !name.contains('.') && raw.contains(name)
        };
        if matches {
            return (*host).into();
        }
    }
    raw
}
pub fn source_tier(source: &str) -> char {
    let host = resolve_source_host(source);
    if host.is_empty() {
        return 'D';
    }
    let tiers: Value =
        serde_json::from_str(include_str!("../assets/source-tiers.json")).unwrap_or(Value::Null);
    for tier in ['A', 'B', 'C', 'D'] {
        if crate::array(&tiers[tier.to_string()]["domains"])
            .iter()
            .filter_map(Value::as_str)
            .any(|d| host == d || host.ends_with(&format!(".{d}")))
        {
            return tier;
        }
    }
    'C'
}
pub fn story_status(sources: &[String]) -> &'static str {
    let hosts: Vec<_> = sources.iter().map(|s| resolve_source_host(s)).collect();
    if hosts.iter().any(|h| source_tier(h) == 'A') {
        return "confirmed";
    }
    let distinct: HashSet<_> = hosts
        .iter()
        .filter(|h| !h.is_empty() && ['B', 'C'].contains(&source_tier(h)))
        .collect();
    match distinct.len() {
        0 => "rumor",
        1 => "single_source",
        _ => "multi_source",
    }
}
