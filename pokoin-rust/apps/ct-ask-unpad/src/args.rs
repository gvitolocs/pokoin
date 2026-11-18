//! Command line: verb + flags. Hand-rolled like the other one-shot apps here.

use crate::ident;

pub const NAME: &str = "ct-ask-unpad";

pub const USAGE: &str = concat!(
    "usage: ct-ask-unpad [plan] [--backup-table NAME] [--database-url-env VAR]\n",
    "       ct-ask-unpad apply   --backup-table NAME [--database-url-env VAR]\n",
    "       ct-ask-unpad verify  --backup-table NAME [--database-url-env VAR]\n",
    "       ct-ask-unpad revert  --backup-table NAME [--database-url-env VAR]\n",
    "\n",
    "plan is the default and reads only. apply, verify and revert name the table\n",
    "that records what was changed; see README.md. The database URL comes from the\n",
    "environment variable named by --database-url-env (default MARKETPLACE_DATABASE_URL),\n",
    "never from the command line.",
);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Plan,
    Apply,
    Verify,
    Revert,
}

impl Command {
    pub fn name(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Apply => "apply",
            Self::Verify => "verify",
            Self::Revert => "revert",
        }
    }

    fn parse(word: &str) -> Option<Self> {
        match word {
            "plan" => Some(Self::Plan),
            "apply" => Some(Self::Apply),
            "verify" => Some(Self::Verify),
            "revert" => Some(Self::Revert),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Args {
    pub command: Command,
    pub backup_table: Option<String>,
    /// Name of the environment variable that holds the connection URL.
    pub database_url_env: Option<String>,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            command: Command::Plan,
            backup_table: None,
            database_url_env: None,
        }
    }
}

/// True for anything that is a connection string or a DSN, not a flag value we
/// accept. The URL must come from the environment, so a token that looks like
/// one is refused rather than ignored.
fn looks_like_url(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    lower.contains("://")
        || lower.starts_with("postgres:")
        || lower.starts_with("postgresql:")
        || lower.contains("user=")
        || lower.contains("password=")
        || lower.contains("dbname=")
        || lower.contains("host=")
        || lower.contains("sslmode=")
        || (lower.contains('@') && lower.contains(':'))
}

/// A value that is meant to be the name of an environment variable.
fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

pub fn parse(argv: Vec<String>) -> Result<Args, String> {
    for token in &argv {
        if looks_like_url(token) {
            return Err(
                "a database URL does not belong on the command line: name it with \
                 --database-url-env (default MARKETPLACE_DATABASE_URL)"
                    .to_string(),
            );
        }
    }
    let mut args = Args::default();
    let mut verb_seen = false;
    let mut words = argv.iter();
    while let Some(word) = words.next() {
        match word.as_str() {
            "--backup-table" => {
                let name = needed(word, words.next())?;
                ident::validate(name, word)?;
                args.backup_table = Some(name.to_string());
            }
            "--database-url-env" => {
                let name = needed(word, words.next())?;
                if !valid_env_name(name) {
                    return Err(format!(
                        "{word} needs an environment variable name, got {name}"
                    ));
                }
                args.database_url_env = Some(name.to_string());
            }
            "-h" | "--help" => return Err(USAGE.to_string()),
            flag if flag.starts_with('-') => {
                return Err(format!("unknown flag {flag}\n{USAGE}"));
            }
            verb => {
                if verb_seen {
                    return Err(format!("unexpected argument {verb}\n{USAGE}"));
                }
                args.command = Command::parse(verb)
                    .ok_or_else(|| format!("unknown command {verb}\n{USAGE}"))?;
                verb_seen = true;
            }
        }
    }
    if args.command != Command::Plan && args.backup_table.is_none() {
        return Err(format!("{} needs --backup-table", args.command.name()));
    }
    Ok(args)
}

fn needed<'a>(flag: &str, value: Option<&'a String>) -> Result<&'a str, String> {
    let value = value.ok_or_else(|| format!("{flag} needs a value"))?;
    if value.is_empty() {
        return Err(format!("{flag} needs a value"));
    }
    Ok(value.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(argv: &[&str]) -> Vec<String> {
        argv.iter().map(|word| (*word).to_string()).collect()
    }

    #[test]
    fn no_arguments_is_plan() {
        let parsed = parse(words(&[]));
        assert_eq!(
            parsed,
            Ok(Args {
                command: Command::Plan,
                backup_table: None,
                database_url_env: None,
            })
        );
    }

    #[test]
    fn each_verb_parses() {
        for (word, command) in [
            ("plan", Command::Plan),
            ("apply", Command::Apply),
            ("verify", Command::Verify),
            ("revert", Command::Revert),
        ] {
            let argv = words(&[word, "--backup-table", "ct_ask_unpad_backup"]);
            assert_eq!(parse(argv).map(|args| args.command), Ok(command), "{word}");
        }
    }

    #[test]
    fn flags_take_their_values() {
        let argv = words(&[
            "apply",
            "--backup-table",
            "fix_pad",
            "--database-url-env",
            "MARKETPLACE_WRITER_DATABASE_URL",
        ]);
        assert_eq!(
            parse(argv),
            Ok(Args {
                command: Command::Apply,
                backup_table: Some("fix_pad".to_string()),
                database_url_env: Some("MARKETPLACE_WRITER_DATABASE_URL".to_string()),
            })
        );
    }

    #[test]
    fn writing_commands_demand_a_backup_table() {
        for word in ["apply", "verify", "revert"] {
            let error = parse(words(&[word])).unwrap_err();
            assert!(
                error.contains(&format!("{word} needs --backup-table")),
                "{error}"
            );
        }
    }

    #[test]
    fn a_url_on_the_command_line_is_refused() {
        for argv in [
            words(&[
                "apply",
                "--backup-table",
                "b",
                "postgres://u:secret@127.0.0.1/db",
            ]),
            words(&["postgres://u:secret@127.0.0.1/db", "--backup-table", "b"]),
            words(&[
                "verify",
                "--backup-table",
                "postgres://u:secret@127.0.0.1/db",
            ]),
            words(&["plan", "--database-url-env", "postgresql://u@h/db"]),
            words(&["plan", "user=postgres password=secret dbname=pokoin"]),
        ] {
            let error = parse(argv).unwrap_err();
            assert!(
                error.contains("does not belong on the command line"),
                "{error}"
            );
        }
    }

    #[test]
    fn a_plain_backup_table_name_is_not_a_url() {
        let argv = words(&["apply", "--backup-table", "ct_ask_unpad_backup"]);
        assert!(parse(argv).is_ok_and(|args| args.backup_table.is_some()));
    }

    #[test]
    fn an_url_looking_env_name_is_refused() {
        let error = parse(words(&[
            "plan",
            "--database-url-env",
            "MARKETPLACE=DATABASE",
        ]))
        .unwrap_err();
        assert!(error.contains("environment variable name"), "{error}");
    }

    #[test]
    fn a_backup_table_name_is_validated_at_the_gate() {
        for bad in [
            "Main",
            "1fix",
            "fix pad",
            "fix;drop",
            "\"fix\"",
            "",
            &"a".repeat(52),
        ] {
            let error = parse(words(&["apply", "--backup-table", bad])).unwrap_err();
            assert!(error.contains("--backup-table"), "{error}");
            assert!(
                ident::validate(bad, "--backup-table").is_err(),
                "{bad} must be refused"
            );
        }
        assert!(parse(words(&["apply", "--backup-table", "_fix1"]))
            .is_ok_and(|args| args.backup_table.as_deref() == Some("_fix1")));
    }

    #[test]
    fn unknown_input_is_reported_with_the_usage() {
        for argv in [
            words(&["recalculate"]),
            words(&["plan", "--force"]),
            words(&["plan", "extra"]),
            words(&["plan", "--help"]),
        ] {
            let error = parse(argv).unwrap_err();
            assert!(error.contains("usage:"), "{error}");
        }
        for argv in [
            words(&["--backup-table"]),
            words(&["plan", "--database-url-env"]),
        ] {
            let error = parse(argv).unwrap_err();
            assert!(error.contains("needs a value"), "{error}");
        }
    }
}
