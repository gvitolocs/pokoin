//! `pokoin-ops mail-config-check` against fixture env files holding marker values.
//! The process environment is cleared so only the fixture files are read.

use std::process::{Command, Output};

const FROM_MARK: &str = "marker-from-value-7731";
const TO_MARK: &str = "marker-to-value-5519";

fn check(files: &[&str]) -> (Output, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_pokoin-ops"));
    cmd.env_clear().env("HOME", dir.path()).arg("mail-config-check");
    for (i, body) in files.iter().enumerate() {
        let p = dir.path().join(format!("fixture{i}.env"));
        std::fs::write(&p, body).unwrap();
        cmd.arg("--env-file").arg(p);
    }
    (cmd.output().unwrap(), dir)
}

fn text(o: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))
}

fn no_markers(o: &Output) {
    let t = text(o);
    assert!(!t.contains(FROM_MARK) && !t.contains(TO_MARK), "a value leaked: {t}");
}

#[test]
fn both_keys_present_is_ok() {
    let (o, _d) = check(&[&format!("POKOIN_ALERT_MAIL_FROM={FROM_MARK}\nPOKOIN_ALERT_MAIL_TO={TO_MARK}\n")]);
    assert!(o.status.success(), "{}", text(&o));
    assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), "mail config ok");
    no_markers(&o);
}

#[test]
fn keys_may_come_from_separate_files() {
    let (o, _d) = check(&[&format!("POKOIN_ALERT_MAIL_FROM={FROM_MARK}\n"), &format!("POKOIN_ALERT_MAIL_TO={TO_MARK}\n")]);
    assert!(o.status.success(), "{}", text(&o));
    no_markers(&o);
}

#[test]
fn sender_missing_fails_and_names_the_key() {
    let (o, d) = check(&[&format!("POKOIN_ALERT_MAIL_TO={TO_MARK}\n")]);
    assert!(!o.status.success());
    let t = text(&o);
    assert!(t.contains("missing: POKOIN_ALERT_MAIL_FROM (looked in: "), "{t}");
    assert!(t.contains(&d.path().join("fixture0.env").display().to_string()), "{t}");
    assert!(!t.contains("POKOIN_ALERT_MAIL_TO"), "{t}");
    no_markers(&o);
}

#[test]
fn recipient_missing_fails_and_names_the_key() {
    let (o, _d) = check(&[&format!("POKOIN_ALERT_MAIL_FROM={FROM_MARK}\n")]);
    assert!(!o.status.success());
    let t = text(&o);
    assert!(t.contains("missing: POKOIN_ALERT_MAIL_TO (looked in: "), "{t}");
    assert!(!t.contains("POKOIN_ALERT_MAIL_FROM"), "{t}");
    no_markers(&o);
}

#[test]
fn both_missing_reports_both() {
    let (o, _d) = check(&["# nothing here\n"]);
    assert!(!o.status.success());
    let t = text(&o);
    assert!(t.contains("missing: POKOIN_ALERT_MAIL_FROM"), "{t}");
    assert!(t.contains("missing: POKOIN_ALERT_MAIL_TO"), "{t}");
}

#[test]
fn empty_values_are_reported_as_empty() {
    let (o, _d) = check(&["POKOIN_ALERT_MAIL_FROM=\nPOKOIN_ALERT_MAIL_TO=\"  \"\n"]);
    assert!(!o.status.success());
    let t = text(&o);
    assert!(t.contains("empty: POKOIN_ALERT_MAIL_FROM"), "{t}");
    assert!(t.contains("empty: POKOIN_ALERT_MAIL_TO"), "{t}");
}

#[test]
fn recipient_through_the_fallback_key_is_ok() {
    let (o, _d) = check(&[&format!("POKOIN_ALERT_MAIL_FROM={FROM_MARK}\nPOKOIN_UPTIME_MAIL_TO={TO_MARK}\n")]);
    assert!(o.status.success(), "{}", text(&o));
    assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), "mail config ok");
    no_markers(&o);
}

#[test]
fn help_shows_no_values() {
    let out = Command::new(env!("CARGO_BIN_EXE_pokoin-ops"))
        .env_clear()
        .args(["mail-config-check", "--help"])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(!String::from_utf8_lossy(&out.stdout).contains('@'));
}
