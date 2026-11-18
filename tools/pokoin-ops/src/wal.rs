//! `wal push-spool` (Pi, every minute): uploads the WAL files the standby's archive_command
//! copied into the spool (scripts/backup/walspool-archive.sh) with `wal-g wal-push`, in
//! order, and deletes each one only after every configured store accepted it.
//!
//! The archive_command only copies, because wal-g (glibc) cannot run inside the Alpine
//! replica container. If uploads stall, the spool fills up to its cap, archive_command
//! starts failing, and Postgres keeps the WAL in pg_wal until uploads resume.

use crate::env;
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn is_wal_name(name: &str) -> bool {
    let hex = |s: &str, n: usize| s.len() == n && s.chars().all(|c| c.is_ascii_digit() || ('A'..='F').contains(&c));
    if let Some(tli) = name.strip_suffix(".history") {
        return hex(tli, 8);
    }
    if let Some(seg) = name.strip_suffix(".partial") {
        return hex(seg, 24);
    }
    if let Some(rest) = name.strip_suffix(".backup") {
        return rest.len() == 33 && hex(&rest[..24], 24) && &rest[24..25] == "." && hex(&rest[25..], 8);
    }
    hex(name, 24)
}

pub fn pending(spool: &Path) -> Result<Vec<String>> {
    let mut names: Vec<String> = std::fs::read_dir(spool)
        .with_context(|| format!("read {}", spool.display()))?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| is_wal_name(n))
        .collect();
    // Timeline history first, then segments in WAL order.
    names.sort_by_key(|n| (!n.ends_with(".history"), n.clone()));
    Ok(names)
}

pub fn push_spool(spool: &Path, walg: &str, env_files: &[PathBuf]) -> Result<usize> {
    if env_files.is_empty() {
        bail!("no --env-file: nowhere to push");
    }
    let mut stores = Vec::new();
    for f in env_files {
        let text = std::fs::read_to_string(f).with_context(|| format!("read {}", f.display()))?;
        let mut vars = env::parse(&text);
        for (k, v) in [("WALG_PREVENT_WAL_OVERWRITE", "true"), ("WALG_UPLOAD_CONCURRENCY", "1")] {
            if !vars.iter().any(|(key, _)| key == k) {
                vars.push((k.into(), v.into()));
            }
        }
        stores.push((f.clone(), vars));
    }
    // wal-g looks for archive_status next to the file it pushes.
    let _ = std::fs::create_dir_all(spool.join("archive_status"));
    let max: usize = env::get_num("POKOIN_WAL_PUSH_MAX", 2000);
    let mut pushed = 0;
    for name in pending(spool)?.into_iter().take(max) {
        let path = spool.join(&name);
        for (file, vars) in &stores {
            let out = Command::new(walg)
                .arg("wal-push")
                .arg(&path)
                .envs(vars.iter().map(|(k, v)| (k, v)))
                .output()
                .with_context(|| format!("spawn {walg}"))?;
            if !out.status.success() {
                bail!(
                    "wal-g wal-push {name} ({}) exited {} after {pushed} uploads: {}",
                    file.display(),
                    out.status,
                    String::from_utf8_lossy(&out.stderr).trim()
                );
            }
        }
        std::fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
        pushed += 1;
    }
    if pushed > 0 {
        println!("pushed {pushed} WAL files");
    }
    Ok(pushed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(is_wal_name("0000000100000095000000AC"));
        assert!(is_wal_name("00000002.history"));
        assert!(is_wal_name("0000000100000095000000AC.partial"));
        assert!(is_wal_name("0000000100000095000000AC.00000028.backup"));
        assert!(!is_wal_name(".0000000100000095000000AC.part"));
        assert!(!is_wal_name("0000000100000095000000ac"));
        assert!(!is_wal_name("archive_status"));
    }

    #[test]
    fn pushes_in_order_and_stops_at_first_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let spool = tmp.path().join("spool");
        std::fs::create_dir_all(&spool).unwrap();
        for n in ["0000000100000095000000AD", "0000000100000095000000AC", "00000001.history", ".0000000100000095000000AE.part"] {
            std::fs::write(spool.join(n), n).unwrap();
        }
        assert_eq!(pending(&spool).unwrap(), vec!["00000001.history", "0000000100000095000000AC", "0000000100000095000000AD"]);

        // A fake wal-g that logs its pushes and fails on AD.
        let log = tmp.path().join("log");
        let fake = tmp.path().join("wal-g");
        std::fs::write(&fake, format!(
            "#!/bin/sh\n[ \"$WALG_PREVENT_WAL_OVERWRITE\" = true ] || exit 9\necho \"$STORE $(basename \"$2\")\" >> {}\ncase \"$2\" in *AD) exit 1;; esac\n",
            log.display()
        )).unwrap();
        std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let a = tmp.path().join("a.env");
        let b = tmp.path().join("b.env");
        std::fs::write(&a, "STORE=a\n").unwrap();
        std::fs::write(&b, "STORE=b\n").unwrap();

        let err = push_spool(&spool, fake.to_str().unwrap(), &[a, b]).unwrap_err();
        assert!(format!("{err}").contains("after 2 uploads"));
        let logged = std::fs::read_to_string(&log).unwrap();
        assert_eq!(logged, "a 00000001.history\nb 00000001.history\na 0000000100000095000000AC\nb 0000000100000095000000AC\na 0000000100000095000000AD\n");
        let mut left: Vec<_> = std::fs::read_dir(&spool).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, vec![".0000000100000095000000AE.part", "0000000100000095000000AD", "archive_status"]);
    }
}
