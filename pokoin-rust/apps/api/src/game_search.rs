//! Satellite (non-Pokémon) marketplace text matching.
//!
//! One Piece, Magic, Lorcana … have no Meili index and no local catalog, so their
//! typeahead and results page are one SQL statement over
//! `marketplace_search_candidates`. That statement used to compare the *whole*
//! typed phrase against `search_text`, so `luffy op01` — a character plus the
//! expansion the owner means — matched almost nothing, and an expansion code lost
//! its hyphen (`op01` for `OP-01`) only matched through the collector number,
//! which sorted last. Here the query becomes a set of tokens that must each appear
//! in the row's own name, expansion or search text, hyphen-insensitively, so
//! `op01`, `OP-01` and `romance dawn` all find `OP-01: Romance Dawn`.

/// Tokens bound as `LIKE` patterns. One search page is 100 rows of a phrase the
/// owner typed by hand; anything longer is a paste, and its tail would only add
/// parameters and exclude rows.
pub const MAX_TOKENS: usize = 8;

/// Whitespace-separated words with their punctuation dropped (`OP-01` → `op01`).
pub fn query_tokens(query: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for word in query.split_whitespace() {
        let token = word
            .chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>();
        if !token.is_empty() && !out.contains(&token) {
            out.push(token);
        }
        if out.len() == MAX_TOKENS {
            break;
        }
    }
    out
}

/// The satellite candidate columns, flattened once per row by the wrapping
/// subquery: `nflat` name, `sflat` expansion, `tflat` whole search text.
pub struct Coverage {
    /// Placeholder number of the first token parameter.
    first: usize,
    count: usize,
}

impl Coverage {
    /// `first` is the `$n` number of the first token, bound in `query_tokens` order.
    pub fn new(tokens: usize, first: usize) -> Self {
        Self {
            first,
            count: tokens,
        }
    }

    fn like(&self, index: usize) -> String {
        format!("${}", self.first + index)
    }

    /// `column` contains every token.
    fn all(&self, column: &str) -> String {
        (0..self.count)
            .map(|index| format!("{column} like {}", self.like(index)))
            .collect::<Vec<_>>()
            .join(" and ")
    }

    /// How many of the tokens `column` contains.
    fn hits(&self, column: &str) -> String {
        (0..self.count)
            .map(|index| format!("(({column} like {})::int)", self.like(index)))
            .collect::<Vec<_>>()
            .join(" + ")
    }

    /// Every token appears in at least one of `columns`.
    fn any_of(&self, columns: &[&str]) -> String {
        (0..self.count)
            .map(|index| {
                let pattern = self.like(index);
                format!(
                    "({})",
                    columns
                        .iter()
                        .map(|column| format!("{column} like {pattern}"))
                        .collect::<Vec<_>>()
                        .join(" or ")
                )
            })
            .collect::<Vec<_>>()
            .join(" and ")
    }

    /// Row filter: the tokens must all be somewhere in the candidate's own text,
    /// with the trigram similarity fallback that keeps a misspelling working.
    /// The caller wraps it in its own "no query typed yet" arm.
    pub fn predicate(&self, phrase: &str, like: &str) -> String {
        let similarity = format!(
            "word_similarity({phrase}, m.sflat) > 0.4 or word_similarity({phrase}, m.nflat) > 0.4"
        );
        if self.count == 0 {
            return format!("{similarity} or m.tflat like {like}");
        }
        format!("({}) or {similarity}", self.all("m.tflat"))
    }

    /// Relevance: an exact card name first, then rows whose expansion *and* name
    /// the query covers, then a pure name or pure expansion reading, then a card
    /// name plus expansion code (`luffy op01`), then anything else that mentions
    /// the tokens. A name or expansion written without its hyphen is the same row.
    pub fn ranking(&self, phrase: &str) -> String {
        let flat = format!("replace({phrase}, '-', '')");
        let mut arms = vec![
            format!("when {phrase} <> '' and {flat} = m.nflat then 0"),
            format!("when {phrase} <> '' and {flat} = m.sflat then 1"),
        ];
        if self.count > 0 {
            let names = self.hits("m.nflat");
            let sets = self.hits("m.sflat");
            let total = self.count;
            arms.extend([
                format!("when {names} = {total} and {sets} = {total} then 2"),
                format!("when {names} = {total} then 3"),
                format!("when {sets} = {total} then 4"),
                format!(
                    "when {} and {sets} >= 1 then 5",
                    self.any_of(&["m.nflat", "m.sflat"])
                ),
                format!("when {} then 6", self.all("m.tflat")),
            ]);
        }
        format!("case {} else 7 end", arms.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_expansion_code_loses_its_hyphen_and_its_punctuation() {
        assert_eq!(query_tokens("luffy op-01"), vec!["luffy", "op01"]);
        assert_eq!(query_tokens("OP01:"), vec!["op01"]);
        assert_eq!(
            query_tokens("ST-31  starter deck"),
            vec!["st31", "starter", "deck"]
        );
    }

    #[test]
    fn nothing_is_bound_twice_and_a_paste_stops_at_the_cap() {
        let long = query_tokens(
            &(0..=MAX_TOKENS)
                .map(|n| format!("w{n}"))
                .collect::<Vec<_>>()
                .join(" "),
        );
        assert_eq!(long.len(), MAX_TOKENS);
        assert_eq!(long.first(), Some(&"w0".to_string()));
        assert_eq!(query_tokens("faq faq faq"), vec!["faq"]);
        assert!(query_tokens("   ---   ").is_empty());
    }

    #[test]
    fn every_token_must_appear_in_the_row_itself() {
        let coverage = Coverage::new(2, 7);
        assert_eq!(
            coverage.predicate("$1", "$2"),
            "(m.tflat like $7 and m.tflat like $8) or word_similarity($1, m.sflat) > 0.4 or word_similarity($1, m.nflat) > 0.4"
        );
    }

    #[test]
    fn a_name_plus_an_expansion_code_outranks_a_coincidental_mention() {
        let ranking = Coverage::new(2, 3).ranking("$1");
        let at = |needle: &str| {
            ranking
                .find(needle)
                .unwrap_or_else(|| panic!("missing {needle} in {ranking}"))
        };
        // Exact card name, exact expansion, then name+expansion coverage, a pure
        // name reading, a pure expansion reading, the mixed query, a bare mention.
        for needle in [
            "= m.nflat then 0",
            "= m.sflat then 1",
            "= 2 then 2",
            "= 2 then 3",
            "= 2 then 4",
            ">= 1 then 5",
            "then 6",
        ] {
            assert!(ranking.contains(needle), "{needle} missing from {ranking}");
        }
        let order = [
            "then 1",
            "= 2 then 2",
            "= 2 then 3",
            "= 2 then 4",
            "then 5",
            "then 6",
        ];
        for pair in order.windows(2) {
            assert!(
                at(pair[0]) < at(pair[1]),
                "{pair:?} out of order in {ranking}"
            );
        }
    }

    #[test]
    fn a_hyphen_in_the_query_is_not_part_of_the_stored_name() {
        // `op-01` typed against the flattened `op01: romance dawn`.
        assert!(Coverage::new(1, 7)
            .ranking("$1")
            .contains("replace($1, '-', '') = m.sflat"));
        let statement = |query: &str| {
            let tokens = query_tokens(query);
            let coverage = Coverage::new(tokens.len(), 7);
            (
                tokens,
                coverage.predicate("$1", "$2"),
                coverage.ranking("$1"),
            )
        };
        // OP-01 and OP01 are the same search: same tokens, same SQL, same binds.
        assert_eq!(statement("luffy op-01"), statement("luffy op01"));
        // A two-word expansion title has to be covered word by word, so a card
        // that only mentions "romance" cannot ride in on the phrase.
        let romance = statement("romance dawn");
        assert_eq!(romance.0, vec!["romance", "dawn"]);
        assert!(romance
            .1
            .starts_with("(m.tflat like $7 and m.tflat like $8)"));
    }

    #[test]
    fn a_punctuation_only_query_falls_back_to_similarity() {
        let coverage = Coverage::new(0, 9);
        assert_eq!(
            coverage.predicate("$1", "$2"),
            "word_similarity($1, m.sflat) > 0.4 or word_similarity($1, m.nflat) > 0.4 or m.tflat like $2"
        );
        assert!(!coverage.ranking("$1").contains("then 2"));
    }
}
