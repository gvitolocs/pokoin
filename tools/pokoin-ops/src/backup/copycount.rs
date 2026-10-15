//! Counts the rows of every table in a plain-SQL restore stream (`pg_restore -a -f -`).
//! In COPY text format a row is exactly one line (newlines inside values are escaped),
//! so the count is exact.

use anyhow::{bail, Result};
use std::collections::BTreeMap;
use std::io::BufRead;

/// `COPY public.cards (id, name) FROM stdin;` → `public.cards`; quoted identifiers kept as written.
pub fn copy_target(line: &str) -> Option<String> {
    let rest = line.strip_prefix("COPY ")?;
    if !line.ends_with(" FROM stdin;") {
        return None;
    }
    let mut out = String::new();
    let mut in_quotes = false;
    let mut chars = rest.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if in_quotes && chars.peek() == Some(&'"') => {
                out.push_str("\"\"");
                chars.next();
            }
            '"' => {
                in_quotes = !in_quotes;
                out.push('"');
            }
            ' ' if !in_quotes => break,
            _ => out.push(c),
        }
    }
    (!out.is_empty() && !in_quotes).then_some(out)
}

pub fn count_rows(reader: impl BufRead) -> Result<BTreeMap<String, u64>> {
    let mut counts = BTreeMap::new();
    let mut current: Option<String> = None;
    let mut line = Vec::new();
    let mut reader = reader;
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end_matches(['\n', '\r']);
        match &current {
            Some(table) => {
                if text == "\\." {
                    current = None;
                } else {
                    *counts.get_mut(table).expect("inserted at COPY") += 1;
                }
            }
            None => {
                if let Some(table) = copy_target(text) {
                    counts.entry(table.clone()).or_insert(0);
                    current = Some(table);
                }
            }
        }
    }
    if let Some(table) = current {
        bail!("restore stream ended inside the COPY block of {table}");
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets() {
        assert_eq!(copy_target("COPY public.cards (id, name) FROM stdin;").as_deref(), Some("public.cards"));
        assert_eq!(copy_target("COPY public.empty  FROM stdin;").as_deref(), Some("public.empty"));
        assert_eq!(copy_target(r#"COPY "My Schema"."Odd ""T"" x" (a) FROM stdin;"#).as_deref(), Some(r#""My Schema"."Odd ""T"" x""#));
        assert_eq!(copy_target("-- COPY x FROM stdin;"), None);
        assert_eq!(copy_target("COPY public.t (a) TO stdout;"), None);
    }

    #[test]
    fn counts_rows_and_ignores_sql_around_them() {
        let dump = "SET x = 1;\nCOPY public.a (id, note) FROM stdin;\n1\tline\\nwith escaped newline\n2\t\\N\n\\.\n\n\
                    COPY public.b (id) FROM stdin;\n\\.\nSELECT 1;\nCOPY public.a (id, note) FROM stdin;\n3\tx\n\\.\n";
        let got = count_rows(dump.as_bytes()).unwrap();
        assert_eq!(got.get("public.a"), Some(&3));
        assert_eq!(got.get("public.b"), Some(&0));
    }

    #[test]
    fn truncated_stream_is_an_error() {
        assert!(count_rows("COPY public.a (id) FROM stdin;\n1\n".as_bytes()).is_err());
    }
}
