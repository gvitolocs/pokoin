//! The connection URL must never reach a terminal, a log or an error message.

/// Replace every form the URL can appear in with a marker: the whole string, and
/// the user and password of its credentials, raw and percent-decoded. sqlx quotes
/// the string it was handed in some connect errors, so a message is only safe
/// after this pass.
pub fn redact(url: &str, message: &str) -> String {
    let mut out = message.to_string();
    for secret in forms(url) {
        out = out.replace(secret.as_str(), REDACTION);
    }
    out
}

const REDACTION: &str = "<redacted>";

/// Below this a fragment is ordinary text — the `u` of `lock_timeout` — and
/// replacing it would mangle the error while hiding nothing.
const MIN_SECRET: usize = 3;

/// The strings to replace, longest first so the whole URL goes before its parts
/// and no half-redacted host survives.
fn forms(url: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |value: String| {
        if value.len() >= MIN_SECRET && !out.contains(&value) {
            out.push(value);
        }
    };
    push(url.to_string());
    for value in credentials_of(url) {
        push(value.clone());
        push(percent_decode(&value));
    }
    out.sort_by_key(|value| std::cmp::Reverse(value.len()));
    out
}

/// The user and password a connection string carries: the authority of
/// `scheme://user:password@host/…`, or the `user=` and `password=` pairs of a
/// keyword/value DSN.
fn credentials_of(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let authority = text
        .find("://")
        .and_then(|scheme| text.get(scheme + 3..))
        .and_then(|rest| rest.split('/').next());
    if let Some(credentials) = authority
        .and_then(|value| value.rsplit_once('@'))
        .map(|pair| pair.0)
    {
        match credentials.split_once(':') {
            Some((user, password)) => out.extend([user.to_string(), password.to_string()]),
            None => out.push(credentials.to_string()),
        }
    }
    for word in text.split([' ', ';']) {
        let Some((key, value)) = word.split_once('=') else {
            continue;
        };
        let secret = value.trim_matches('\'');
        if matches!(
            key.trim().to_ascii_lowercase().as_str(),
            "password" | "user"
        ) && !secret.is_empty()
        {
            out.push(secret.to_string());
        }
    }
    out
}

/// A URL can percent-encode the password; both spellings are redacted.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(byte) = hex.and_then(|pair| u8::from_str_radix(pair, 16).ok()) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connect_error_never_repeats_the_url() {
        let url = "postgres://pokoin_writer:s3cr3t%40t@127.0.0.1:55432/pokoin_marketplace";
        for message in [
            format!("cannot connect: {url}"),
            "password authentication failed for user \"pokoin_writer\"".to_string(),
            "pool timed out while waiting for an available connection: s3cr3t@t".to_string(),
            "invalid connection string (s3cr3t%40t)".to_string(),
        ] {
            let safe = redact(url, &message);
            assert!(!safe.contains("s3cr3t"), "{safe}");
            assert!(!safe.contains("pokoin_writer"), "{safe}");
            assert!(!safe.contains(url), "{safe}");
            assert!(safe.contains(REDACTION), "{safe}");
        }
    }

    #[test]
    fn a_message_without_the_url_is_untouched() {
        let message = "lock_timeout exceeded on 2026-09-01";
        assert_eq!(redact("postgres://u:p@h/db", message), message);
        assert_eq!(redact("", message), message);
    }

    #[test]
    fn a_url_without_a_password_redacts_only_the_whole_string() {
        let url = "postgres://postgres@127.0.0.1/db";
        assert_eq!(
            redact(url, "connect postgres://postgres@127.0.0.1/db"),
            "connect <redacted>"
        );
    }

    #[test]
    fn the_whole_url_goes_before_its_parts() {
        let url = "postgres://pokoin_writer:s3cr3t@127.0.0.1:55432/pokoin_marketplace";
        assert_eq!(
            redact(url, &format!("cannot connect to {url}")),
            "cannot connect to <redacted>"
        );
    }

    #[test]
    fn a_keyword_dsn_hides_its_credential_values() {
        let dsn = "user=pokoin_writer password=s3cr3t dbname=pokoin_marketplace";
        let safe = redact(
            dsn,
            "authentication failed for user=pokoin_writer password=s3cr3t",
        );
        assert_eq!(
            safe,
            "authentication failed for user=<redacted> password=<redacted>"
        );
    }
}
