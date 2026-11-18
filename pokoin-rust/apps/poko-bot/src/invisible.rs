//! Invisible Unicode in incoming chat text (port of Hermes Agent's
//! invisible-Unicode check, Oct 2026; same ranges as Hermes
//! `src/invisible-unicode.js`).
//!
//! Poko is public, so instead of refusing we neutralise: bidi overrides/isolates
//! and Unicode tag characters can smuggle instructions to the model that a
//! human moderator never sees, and zero-width characters can split words to
//! dodge the reply gate. All of them are stripped before the turn runs.

const SMUGGLING: &[(u32, u32)] = &[
    (0x202a, 0x202e),   // bidi override
    (0x2066, 0x2069),   // bidi isolate
    (0xe0000, 0xe007f), // tag characters
];

const BENIGN: &[(u32, u32)] = &[
    (0x00ad, 0x00ad), // soft hyphen
    (0x061c, 0x061c), // arabic letter mark
    (0x180e, 0x180e), // mongolian vowel separator
    (0x200b, 0x200f), // zero-width / direction marks
    (0x2060, 0x2064), // word joiner / invisible operators
    (0xfeff, 0xfeff), // byte order mark
];

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Scan {
    pub smuggling: usize,
    pub benign: usize,
}

impl Scan {
    pub fn total(&self) -> usize {
        self.smuggling + self.benign
    }
}

fn in_ranges(ranges: &[(u32, u32)], c: char) -> bool {
    let code = c as u32;
    ranges
        .iter()
        .any(|(start, end)| code >= *start && code <= *end)
}

fn is_invisible(c: char) -> bool {
    in_ranges(SMUGGLING, c) || in_ranges(BENIGN, c)
}

pub fn scan(text: &str) -> Scan {
    text.chars().fold(Scan::default(), |mut acc, c| {
        if in_ranges(SMUGGLING, c) {
            acc.smuggling += 1;
        } else if in_ranges(BENIGN, c) {
            acc.benign += 1;
        }
        acc
    })
}

pub fn strip(text: &str) -> String {
    text.chars().filter(|c| !is_invisible(*c)).collect()
}

/// Strip invisible characters in place; returns what was found.
pub fn neutralize(text: &mut String) -> Scan {
    let found = scan(text);
    if found.total() > 0 {
        *text = strip(text);
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_smuggling_and_zero_width_but_keeps_emoji_and_accents() {
        let mut text = format!(
            "ciao\u{202E}abc\u{200B} {}👋 è",
            char::from_u32(0xe0041).unwrap()
        );
        let found = neutralize(&mut text);
        assert_eq!(
            found,
            Scan {
                smuggling: 2,
                benign: 1
            }
        );
        assert_eq!(text, "ciaoabc 👋 è");

        let mut clean = "Charizard ex 199/165".to_string();
        assert_eq!(neutralize(&mut clean).total(), 0);
        assert_eq!(clean, "Charizard ex 199/165");
    }
}
