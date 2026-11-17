use anyhow::{anyhow, bail, Context, Result};
use std::ffi::CString;
use std::path::Path;
use std::process::{Command, Stdio};

/// Runs a command to completion; stdout on success, stderr in the error otherwise.
pub fn output(program: &str, args: &[&str]) -> Result<String> {
    let out = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("spawn {program}"))?;
    if !out.status.success() {
        bail!(
            "{program} {} exited {}: {}",
            args.join(" "),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `docker exec <container> psql` over the container's local socket (trust auth).
pub fn psql(container: &str, user: &str, db: &str, sql: &str) -> Result<String> {
    output("docker", &["exec", container, "psql", "-X", "-q", "-A", "-t", "-F", "\t", "-U", user, "-d", db, "-c", sql])
}

pub fn rows(text: &str) -> Vec<Vec<String>> {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.split('\t').map(|c| c.trim().to_string()).collect())
        .collect()
}

pub fn free_bytes(path: &Path) -> Result<u64> {
    Ok(fs_stats(path)?.2)
}

/// (total, free incl. root-reserved, available to users) in bytes, as df computes them.
pub fn fs_stats(path: &Path) -> Result<(u64, u64, u64)> {
    let c = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| anyhow!("bad path"))?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        bail!("statvfs {}: {}", path.display(), std::io::Error::last_os_error());
    }
    let f = st.f_frsize as u64;
    Ok((st.f_blocks as u64 * f, st.f_bfree as u64 * f, st.f_bavail as u64 * f))
}

/// True when `path` is the root of a mounted filesystem (its device differs from its parent's).
pub fn is_mountpoint(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let (Ok(me), Some(parent)) = (std::fs::metadata(path), path.parent()) else { return false };
    std::fs::metadata(parent).map(|p| p.dev() != me.dev()).unwrap_or(false)
}

/// First column of `systemctl --failed --plain --no-legend`.
pub fn parse_failed_units(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| l.trim_start().trim_start_matches('●').split_whitespace().next())
        .filter(|u| u.contains('.'))
        .map(str::to_string)
        .collect()
}

pub fn failed_units(user: bool) -> Result<Vec<String>> {
    let mut args = vec!["--failed", "--plain", "--no-legend", "--no-pager"];
    if user {
        args.insert(0, "--user");
    }
    Ok(parse_failed_units(&output("systemctl", &args)?))
}

/// Units made by `systemd-run` (Transient=yes), from `systemctl show -p Id -p Transient`.
pub fn parse_transient(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for block in text.split("\n\n") {
        let id = block.lines().find_map(|l| l.strip_prefix("Id="));
        let transient = block.lines().any(|l| l == "Transient=yes");
        if let (Some(id), true) = (id, transient) {
            out.push(id.to_string());
        }
    }
    out
}

pub fn transient_units(user: bool, units: &[String]) -> Result<Vec<String>> {
    if units.is_empty() {
        return Ok(vec![]);
    }
    let mut args: Vec<&str> = if user { vec!["--user"] } else { vec![] };
    args.extend(["show", "-p", "Id", "-p", "Transient"]);
    args.extend(units.iter().map(String::as_str));
    Ok(parse_transient(&output("systemctl", &args)?))
}

pub fn is_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

pub const GB: u64 = 1_000_000_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_units_plain_and_bulleted() {
        let text = "pokoin-all-cardtrader-daily.service loaded failed failed Pokoin all-game\n\
                    ● run-p1160974-i1160975.service loaded failed failed [systemd-run] x\n\n";
        assert_eq!(
            parse_failed_units(text),
            vec!["pokoin-all-cardtrader-daily.service", "run-p1160974-i1160975.service"]
        );
    }

    #[test]
    fn transient_blocks() {
        let text = "Id=a.service\nTransient=yes\n\nId=b.service\nTransient=no\n\nTransient=yes\nId=c.service\n";
        assert_eq!(parse_transient(text), vec!["a.service", "c.service"]);
    }

    #[test]
    fn rows_split_tabs() {
        assert_eq!(rows("a\t1\n\nb\t2\n"), vec![vec!["a", "1"], vec!["b", "2"]]);
    }

    #[test]
    fn root_is_not_a_child_mount_but_has_free_space() {
        assert!(free_bytes(Path::new("/")).unwrap() > 0);
        assert!(!is_mountpoint(Path::new("/definitely/missing")));
    }
}
