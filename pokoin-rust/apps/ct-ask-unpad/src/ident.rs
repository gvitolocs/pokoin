//! The one identifier this tool interpolates into SQL: the backup table.

/// A Postgres identifier this tool will quote into a statement. Lower-case only,
/// so the quoted form is the same relation the writer created.
pub fn validate(name: &str, flag: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let allowed = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_';
    let shape = match chars.next() {
        Some(first) if (first.is_ascii_lowercase() || first == '_') && chars.all(allowed) => {
            !name.is_empty() && name.len() <= 51
        }
        _ => false,
    };
    if shape {
        return Ok(());
    }
    Err(format!(
        "{flag} must be 1 to 51 characters of [a-z_][a-z0-9_], got {name:?}"
    ))
}

/// The backup table, always in `public` and always double-quoted.
pub fn qualified(name: &str) -> String {
    format!("public.\"{name}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_names() {
        for name in ["b", "_b", "ct_ask_unpad_backup", "fix_pad", "a1"] {
            assert!(validate(name, "--backup-table").is_ok(), "{name}");
        }
        assert!(validate(&"a".repeat(51), "--backup-table").is_ok());
        assert_eq!(qualified("fix_pad"), "public.\"fix_pad\"");
    }

    #[test]
    fn refused_names() {
        for name in [
            "",
            "1b",
            "Fix",
            "fix pad",
            "fix; drop table x",
            "fix\"pad",
            "fix.pad",
            "public.fix",
            &"a".repeat(52),
            "fix\npad",
        ] {
            assert!(validate(name, "--backup-table").is_err(), "{name:?}");
        }
    }
}
