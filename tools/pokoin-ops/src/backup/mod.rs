//! Logical backups of every database on the Pi hot standby, taken from nezopt.
//!
//! pg_dump runs inside the replica container over SSH (`-Fc -Z0`, so the Pi spends no
//! CPU on compression); nezopt compresses with zstd, encrypts with age to the public
//! key in ~/.config/pokoin/backup-age.pub and writes to mybook. The dump refuses to
//! run against a server that is not in recovery: backups never touch the writer.
//! rclone then copies each finished set off-site, under daily/ or weekly/.

pub mod copycount;
pub mod pitr;
pub mod verify;

use crate::{env, sys};
use anyhow::{anyhow, bail, Context, Result};
use chrono::{Datelike, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::File;
use std::io::{self, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::str::FromStr;
use std::time::{Duration, SystemTime};

pub struct Cfg {
    pub dir: PathBuf,
    pub require_mount: Option<PathBuf>,
    pub exec: Vec<String>,
    pub pg_user: String,
    pub allow_primary: bool,
    pub recipients_file: PathBuf,
    pub identity_file: PathBuf,
    pub zstd: String,
    pub zstd_level: u32,
    pub zstd_threads: u32,
    pub retries: u32,
    pub retry_wait_s: u64,
    pub min_free_gb: u64,
    pub rclone: String,
    pub rclone_remote: Option<String>,
    pub keep_daily: usize,
    pub keep_weekly: usize,
    pub pg_image: String,
}

impl Cfg {
    pub fn from_env() -> Result<Cfg> {
        let cfg_dir = env::home().join(".config/pokoin");
        Ok(Cfg {
            dir: env::get("POKOIN_BACKUP_DIR").map(PathBuf::from).ok_or_else(|| anyhow!("POKOIN_BACKUP_DIR is not set"))?,
            require_mount: env::get("POKOIN_BACKUP_REQUIRE_MOUNT").map(PathBuf::from),
            exec: env::get_or(
                "POKOIN_BACKUP_EXEC",
                "ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 pi-home docker exec -i pokoin-marketplace-postgres-replica",
            )
            .split_whitespace()
            .map(str::to_string)
            .collect(),
            pg_user: env::get_or("POKOIN_PG_USER", "pokoin_marketplace"),
            allow_primary: env::get("POKOIN_BACKUP_ALLOW_PRIMARY").as_deref() == Some("1"),
            recipients_file: env::get("POKOIN_BACKUP_AGE_RECIPIENTS_FILE").map(PathBuf::from).unwrap_or_else(|| cfg_dir.join("backup-age.pub")),
            identity_file: env::get("POKOIN_BACKUP_AGE_IDENTITY").map(PathBuf::from).unwrap_or_else(|| cfg_dir.join("backup-age.key")),
            zstd: env::get_or("POKOIN_ZSTD", "zstd"),
            zstd_level: env::get_num("POKOIN_BACKUP_ZSTD_LEVEL", 6),
            zstd_threads: env::get_num("POKOIN_BACKUP_ZSTD_THREADS", 4),
            retries: env::get_num("POKOIN_BACKUP_RETRIES", 3),
            retry_wait_s: env::get_num("POKOIN_BACKUP_RETRY_WAIT_S", 120),
            min_free_gb: env::get_num("POKOIN_BACKUP_MIN_FREE_GB", 100),
            rclone: env::get_or("POKOIN_RCLONE", "rclone"),
            rclone_remote: env::get("POKOIN_BACKUP_RCLONE_REMOTE"),
            keep_daily: env::get_num("POKOIN_BACKUP_KEEP_DAILY", 14),
            keep_weekly: env::get_num("POKOIN_BACKUP_KEEP_WEEKLY", 8),
            pg_image: env::get_or("POKOIN_RESTORE_IMAGE", "postgres:17.11-alpine"),
        })
    }

    pub fn dumps(&self) -> PathBuf {
        self.dir.join("dumps")
    }

    fn check_mount(&self) -> Result<()> {
        if let Some(m) = &self.require_mount {
            if !sys::is_mountpoint(m) {
                bail!("{} is not mounted; refusing to write backups to the root disk", m.display());
            }
        }
        Ok(())
    }

    /// The replica command with `args` appended. Over ssh every argument is quoted for the
    /// remote shell, so SQL with spaces and parentheses arrives as one argument.
    pub fn remote(&self, args: &[&str]) -> Vec<String> {
        let over_ssh = self.exec.first().is_some_and(|p| p == "ssh" || p.ends_with("/ssh"));
        let mut cmd = self.exec.clone();
        cmd.extend(args.iter().map(|a| if over_ssh { shell_quote(a) } else { a.to_string() }));
        cmd
    }

    pub fn query(&self, db: &str, sql: &str) -> Result<String> {
        let cmd = self.remote(&["psql", "-X", "-q", "-A", "-t", "-U", &self.pg_user, "-d", db, "-c", sql]);
        let args: Vec<&str> = cmd[1..].iter().map(String::as_str).collect();
        Ok(sys::output(&cmd[0], &args)?.trim().to_string())
    }
}

pub fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

// ---------------------------------------------------------------- manifest

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FileEntry {
    pub name: String,
    pub database: Option<String>,
    pub bytes: u64,
    pub sha256: String,
    pub db_size_bytes: Option<u64>,
    pub attempts: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Manifest {
    pub format: u32,
    pub stamp: String,
    pub kind: String,
    pub started_at: String,
    pub finished_at: String,
    pub source: String,
    pub server_version: String,
    pub replay_lsn_start: String,
    pub replay_lsn_end: String,
    pub age_recipients: Vec<String>,
    pub files: Vec<FileEntry>,
}

pub fn is_stamp(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() == 14
        && b[..8].iter().all(u8::is_ascii_digit)
        && b[8] == b'T'
        && b[9..13].iter().all(u8::is_ascii_digit)
        && b[13] == b'Z'
}

pub fn read_manifest(dir: &Path) -> Result<Manifest> {
    let bytes = std::fs::read(dir.join("MANIFEST.json")).with_context(|| format!("{}/MANIFEST.json", dir.display()))?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Complete dump sets, newest first.
pub fn list_sets(dumps: &Path) -> Result<Vec<Manifest>> {
    let mut out = Vec::new();
    if !dumps.is_dir() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dumps)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_stamp(&name) {
            if let Ok(m) = read_manifest(&entry.path()) {
                out.push(m);
            }
        }
    }
    out.sort_by(|a, b| b.stamp.cmp(&a.stamp));
    Ok(out)
}

// ---------------------------------------------------------------- age

pub fn read_recipients(path: &Path) -> Result<Vec<age::x25519::Recipient>> {
    let text = std::fs::read_to_string(path).with_context(|| format!("read age recipients {}", path.display()))?;
    let out: Vec<_> = text
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("age1"))
        .map(|l| age::x25519::Recipient::from_str(l).map_err(|e| anyhow!("bad recipient {l}: {e}")))
        .collect::<Result<_>>()?;
    if out.is_empty() {
        bail!("no age1… recipient in {}", path.display());
    }
    Ok(out)
}

pub fn read_identity(path: &Path) -> Result<age::x25519::Identity> {
    let text = std::fs::read_to_string(path).with_context(|| format!("read age identity {}", path.display()))?;
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("AGE-SECRET-KEY-"))
        .ok_or_else(|| anyhow!("no AGE-SECRET-KEY in {}", path.display()))?;
    age::x25519::Identity::from_str(line).map_err(|e| anyhow!("bad identity: {e}"))
}

pub fn keygen(identity: &Path, public: &Path) -> Result<()> {
    if identity.exists() {
        bail!("{} exists; not overwriting a backup key", identity.display());
    }
    if let Some(d) = identity.parent() {
        std::fs::create_dir_all(d)?;
    }
    let id = age::x25519::Identity::generate();
    let pk = id.to_public().to_string();
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(identity)?;
        use age::secrecy::ExposeSecret;
        writeln!(f, "# created {} by pokoin-ops backup keygen\n# public key: {pk}\n{}", Utc::now().to_rfc3339(), id.to_string().expose_secret())?;
        f.sync_all()?;
    }
    std::fs::write(public, format!("{pk}\n"))?;
    println!("identity {} (0600) — keep an offline copy; without it no backup can be read", identity.display());
    println!("recipient {pk} → {}", public.display());
    Ok(())
}

/// Plaintext reader for an age file (the zstd stream inside it).
pub fn decrypt_reader(path: &Path, identity: &age::x25519::Identity) -> Result<impl Read> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let dec = age::Decryptor::new(io::BufReader::new(file)).map_err(|e| anyhow!("{}: {e}", path.display()))?;
    dec.decrypt(std::iter::once(identity as &dyn age::Identity)).map_err(|e| anyhow!("decrypt {}: {e}", path.display()))
}

struct HashWriter<W: Write> {
    inner: W,
    hasher: Sha256,
    bytes: u64,
}

impl<W: Write> Write for HashWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        self.bytes += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

pub fn sha256_file(path: &Path) -> Result<(u64, String)> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut n = 0u64;
    loop {
        let k = f.read(&mut buf)?;
        if k == 0 {
            break;
        }
        h.update(&buf[..k]);
        n += k as u64;
    }
    Ok((n, hex::encode(h.finalize())))
}

fn fsync_dir(dir: &Path) {
    if let Ok(f) = File::open(dir) {
        let _ = f.sync_all();
    }
}

/// `cmd` stdout → zstd → age → `out`. Fails if either process fails, so a pg_dump that
/// was cancelled half-way never leaves a file behind.
pub fn stream_encrypted(cmd: &[String], out: &Path, recipients: &[age::x25519::Recipient], cfg: &Cfg) -> Result<(u64, String)> {
    let tmp = out.with_extension("part");
    let mut src = Command::new(&cmd[0])
        .args(&cmd[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawn {}", cmd[0]))?;
    let src_out = src.stdout.take().expect("piped");
    let mut src_err = src.stderr.take().expect("piped");
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = src_err.read_to_string(&mut s);
        s
    });
    let mut z = Command::new(&cfg.zstd)
        .args(["-q", "-c", &format!("-{}", cfg.zstd_level), &format!("-T{}", cfg.zstd_threads)])
        .stdin(Stdio::from(src_out))
        .stdout(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawn {}", cfg.zstd))?;
    let mut z_out = z.stdout.take().expect("piped");

    let result = (|| -> Result<(u64, String)> {
        let file = File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        let hw = HashWriter { inner: BufWriter::with_capacity(1 << 20, file), hasher: Sha256::new(), bytes: 0 };
        let enc = age::Encryptor::with_recipients(recipients.iter().map(|r| r as &dyn age::Recipient))
            .map_err(|e| anyhow!("age: {e}"))?;
        let mut w = enc.wrap_output(hw)?;
        io::copy(&mut z_out, &mut w)?;
        let mut hw = w.finish()?;
        hw.flush()?;
        let file = hw.inner.into_inner().map_err(|e| anyhow!("flush: {e}"))?;
        file.sync_all()?;
        Ok((hw.bytes, hex::encode(hw.hasher.finalize())))
    })();
    let z_status = z.wait()?;
    let src_status = src.wait()?;
    let stderr = err_thread.join().unwrap_or_default();
    let fail = |msg: String| {
        let _ = std::fs::remove_file(&tmp);
        Err(anyhow!(msg))
    };
    let (bytes, sha) = match result {
        Ok(v) => v,
        Err(e) => return fail(format!("{e:#}; source stderr: {}", stderr.trim())),
    };
    if !src_status.success() {
        return fail(format!("{} exited {src_status}: {}", cmd.join(" "), stderr.trim()));
    }
    if !z_status.success() {
        return fail(format!("zstd exited {z_status}"));
    }
    std::fs::rename(&tmp, out)?;
    Ok((bytes, sha))
}

// ---------------------------------------------------------------- dump

fn valid_db_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub fn dump(cfg: &Cfg) -> Result<PathBuf> {
    cfg.check_mount()?;
    std::fs::create_dir_all(cfg.dumps())?;
    let free = sys::free_bytes(&cfg.dir)?;
    if free < cfg.min_free_gb * sys::GB {
        bail!("{} has {} GB free, below POKOIN_BACKUP_MIN_FREE_GB={}", cfg.dir.display(), free / sys::GB, cfg.min_free_gb);
    }
    let recipients = read_recipients(&cfg.recipients_file)?;

    let in_recovery = cfg.query("postgres", "select pg_is_in_recovery()")?;
    if in_recovery != "t" && !cfg.allow_primary {
        bail!("refusing to dump: {} is not a standby (pg_is_in_recovery = {in_recovery:?}); backups never touch the writer", cfg.exec.join(" "));
    }
    let server_version = cfg.query("postgres", "show server_version")?;
    let lsn_sql = "select coalesce(pg_last_wal_replay_lsn()::text, '')";
    let replay_lsn_start = cfg.query("postgres", lsn_sql)?;
    let dbs: Vec<String> = cfg
        .query("postgres", "select datname from pg_database where datallowconn and not datistemplate order by pg_database_size(datname)")?
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if dbs.is_empty() {
        bail!("no databases listed");
    }
    if let Some(bad) = dbs.iter().find(|d| !valid_db_name(d)) {
        bail!("unexpected database name {bad:?}");
    }

    let now = Utc::now();
    let stamp = now.format("%Y%m%dT%H%MZ").to_string();
    let kind = env::get("POKOIN_BACKUP_KIND").unwrap_or_else(|| {
        if now.weekday() == chrono::Weekday::Sun { "weekly".into() } else { "daily".into() }
    });
    let final_dir = cfg.dumps().join(&stamp);
    if final_dir.exists() {
        bail!("{} already exists", final_dir.display());
    }
    let part = cfg.dumps().join(format!(".{stamp}.part"));
    std::fs::create_dir_all(&part)?;

    let mut jobs: Vec<(String, Option<String>, Vec<String>)> =
        vec![("globals.sql.zst.age".into(), None, cfg.remote(&["pg_dumpall", "-U", &cfg.pg_user, "--globals-only"]))];
    for db in &dbs {
        jobs.push((
            format!("{db}.dump.zst.age"),
            Some(db.clone()),
            cfg.remote(&["pg_dump", "-U", &cfg.pg_user, "-Fc", "-Z0", "--lock-wait-timeout=120000", db]),
        ));
    }

    let mut files = Vec::new();
    for (name, db, cmd) in jobs {
        let db_size = match &db {
            Some(d) => cfg.query("postgres", &format!("select pg_database_size('{d}')"))?.parse().ok(),
            None => None,
        };
        let mut attempt = 0;
        let (bytes, sha) = loop {
            attempt += 1;
            let started = std::time::Instant::now();
            match stream_encrypted(&cmd, &part.join(&name), &recipients, cfg) {
                Ok(v) => {
                    println!("{name}: {} MB in {}s (attempt {attempt})", v.0 / 1_000_000, started.elapsed().as_secs());
                    break v;
                }
                // Replay on a hot standby cancels long queries that conflict with it; retry.
                Err(e) if attempt < cfg.retries => {
                    eprintln!("{name}: attempt {attempt} failed, retrying in {}s: {e:#}", cfg.retry_wait_s);
                    std::thread::sleep(Duration::from_secs(cfg.retry_wait_s));
                }
                Err(e) => {
                    let _ = std::fs::remove_dir_all(&part);
                    return Err(e.context(format!("{name} failed after {attempt} attempts")));
                }
            }
        };
        files.push(FileEntry { name, database: db, bytes, sha256: sha, db_size_bytes: db_size, attempts: attempt });
    }

    let manifest = Manifest {
        format: 1,
        stamp: stamp.clone(),
        kind,
        started_at: now.to_rfc3339(),
        finished_at: Utc::now().to_rfc3339(),
        source: cfg.exec.join(" "),
        server_version,
        replay_lsn_start,
        replay_lsn_end: cfg.query("postgres", lsn_sql)?,
        age_recipients: recipients.iter().map(|r| r.to_string()).collect(),
        files,
    };
    let mpath = part.join("MANIFEST.json");
    {
        let mut f = File::create(&mpath)?;
        f.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
        f.sync_all()?;
    }
    fsync_dir(&part);
    std::fs::rename(&part, &final_dir)?;
    fsync_dir(&cfg.dumps());
    let total: u64 = manifest.files.iter().map(|f| f.bytes).sum();
    println!("dump {stamp} ({}) complete: {} files, {} MB", manifest.kind, manifest.files.len(), total / 1_000_000);
    Ok(final_dir)
}

// ---------------------------------------------------------------- upload

const UPLOADED: &str = ".uploaded";

/// Copies complete local sets that are not off-site yet, newest first (at most 3 per run).
pub fn upload(cfg: &Cfg) -> Result<()> {
    let Some(remote) = &cfg.rclone_remote else {
        println!("POKOIN_BACKUP_RCLONE_REMOTE not set; nothing uploaded");
        return Ok(());
    };
    let mut done = 0;
    for m in list_sets(&cfg.dumps())? {
        let dir = cfg.dumps().join(&m.stamp);
        if dir.join(UPLOADED).exists() {
            continue;
        }
        if done == 3 {
            break;
        }
        let dest = format!("{}/{}/{}", remote.trim_end_matches('/'), m.kind, m.stamp);
        let status = Command::new(&cfg.rclone)
            .args(["copy", "--immutable", "--exclude", UPLOADED, "--transfers", "2", "--retries", "5"])
            .arg(&dir)
            .arg(&dest)
            .status()
            .with_context(|| format!("spawn {}", cfg.rclone))?;
        if !status.success() {
            bail!("rclone copy {} → {dest} exited {status}", dir.display());
        }
        std::fs::write(dir.join(UPLOADED), format!("{dest}\n{}\n", Utc::now().to_rfc3339()))?;
        println!("uploaded {} → {dest}", m.stamp);
        done += 1;
    }
    Ok(())
}

// ---------------------------------------------------------------- prune

/// Newest `keep_daily` sets of any kind plus the newest `keep_weekly` weekly sets.
pub fn select_keep(sets: &[(String, String)], keep_daily: usize, keep_weekly: usize) -> BTreeSet<String> {
    let mut sorted: Vec<_> = sets.to_vec();
    sorted.sort_by(|a, b| b.0.cmp(&a.0));
    let mut keep: BTreeSet<String> = sorted.iter().take(keep_daily).map(|s| s.0.clone()).collect();
    keep.extend(sorted.iter().filter(|s| s.1 == "weekly").take(keep_weekly).map(|s| s.0.clone()));
    keep
}

pub fn prune(cfg: &Cfg, dry_run: bool) -> Result<()> {
    cfg.check_mount()?;
    let sets = list_sets(&cfg.dumps())?;
    let keep = select_keep(&sets.iter().map(|m| (m.stamp.clone(), m.kind.clone())).collect::<Vec<_>>(), cfg.keep_daily, cfg.keep_weekly);
    for m in &sets {
        if !keep.contains(&m.stamp) {
            let dir = cfg.dumps().join(&m.stamp);
            println!("{} {} ({})", if dry_run { "would delete" } else { "delete" }, dir.display(), m.kind);
            if !dry_run {
                std::fs::remove_dir_all(&dir)?;
            }
        }
    }
    // Leftovers of interrupted runs.
    let cutoff = SystemTime::now() - Duration::from_secs(2 * 86_400);
    if let Ok(rd) = std::fs::read_dir(cfg.dumps()) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stale = name.starts_with('.') && name.ends_with(".part") && entry.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < cutoff);
            if stale {
                println!("{} {}", if dry_run { "would delete" } else { "delete" }, entry.path().display());
                if !dry_run {
                    std::fs::remove_dir_all(entry.path())?;
                }
            }
        }
    }
    println!("{} sets kept", keep.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_keeps_14_newest_and_8_weeklies() {
        // 70 days of nightly sets; every 7th is weekly.
        let sets: Vec<(String, String)> = (0..70)
            .map(|d| (format!("2026{:04}T0230Z", 1000 + d), if d % 7 == 6 { "weekly".to_string() } else { "daily".to_string() }))
            .collect();
        let keep = select_keep(&sets, 14, 8);
        let newest: Vec<_> = (56..70).map(|d| format!("2026{:04}T0230Z", 1000 + d)).collect();
        for s in &newest {
            assert!(keep.contains(s));
        }
        let weeklies: Vec<_> = sets.iter().filter(|s| s.1 == "weekly").map(|s| s.0.clone()).collect();
        assert_eq!(weeklies.len(), 10);
        for w in &weeklies[2..] {
            assert!(keep.contains(w), "{w}");
        }
        assert!(!keep.contains(&weeklies[0]) && !keep.contains(&weeklies[1]));
        // 14 newest include 2 weeklies, so 14 + 6 older weeklies.
        assert_eq!(keep.len(), 20);
    }

    #[test]
    fn stamps() {
        assert!(is_stamp("20261015T1130Z"));
        assert!(!is_stamp(".20261015T1130Z.part"));
        assert!(!is_stamp("2026-10-15"));
    }

    #[test]
    fn quoting_for_ssh() {
        assert_eq!(shell_quote("pg_dump"), "pg_dump");
        assert_eq!(shell_quote("--lock-wait-timeout=120000"), "--lock-wait-timeout=120000");
        assert_eq!(shell_quote("select pg_is_in_recovery()"), "'select pg_is_in_recovery()'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        let mut cfg = test_cfg();
        cfg.exec = vec!["ssh".into(), "pi-home".into(), "docker".into(), "exec".into(), "-i".into(), "c".into()];
        assert_eq!(cfg.remote(&["psql", "-c", "select 1"]).last().unwrap(), "'select 1'");
        cfg.exec = vec!["docker".into(), "exec".into(), "-i".into(), "c".into()];
        assert_eq!(cfg.remote(&["psql", "-c", "select 1"]).last().unwrap(), "select 1");
    }

    #[test]
    fn age_roundtrip_through_zstd() {
        let tmp = tempfile::tempdir().unwrap();
        let idp = tmp.path().join("k");
        let pubp = tmp.path().join("k.pub");
        keygen(&idp, &pubp).unwrap();
        assert!(keygen(&idp, &pubp).is_err(), "never overwrites a key");
        let rcpt = read_recipients(&pubp).unwrap();
        let id = read_identity(&idp).unwrap();
        let mut cfg = test_cfg();
        cfg.zstd_threads = 1;
        let out = tmp.path().join("x.zst.age");
        let cmd: Vec<String> = ["sh", "-c", "seq 1 20000"].iter().map(|s| s.to_string()).collect();
        let (bytes, sha) = stream_encrypted(&cmd, &out, &rcpt, &cfg).unwrap();
        assert_eq!(sha256_file(&out).unwrap(), (bytes, sha));
        let mut zstd = Command::new("zstd").args(["-d", "-c", "-q"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut zin = zstd.stdin.take().unwrap();
        let mut reader = decrypt_reader(&out, &id).unwrap();
        let writer = std::thread::spawn(move || io::copy(&mut reader, &mut zin).map(|_| ()));
        let plain = zstd.wait_with_output().unwrap();
        writer.join().unwrap().unwrap();
        let text = String::from_utf8(plain.stdout).unwrap();
        assert_eq!(text.lines().count(), 20000);
        assert!(text.ends_with("20000\n"));

        let failing: Vec<String> = ["sh", "-c", "echo partial; echo boom >&2; exit 3"].iter().map(|s| s.to_string()).collect();
        let err = stream_encrypted(&failing, &tmp.path().join("bad.age"), &rcpt, &cfg).unwrap_err();
        assert!(format!("{err:#}").contains("boom"));
        assert!(!tmp.path().join("bad.age").exists() && !tmp.path().join("bad.part").exists());
    }

    pub fn test_cfg() -> Cfg {
        Cfg {
            dir: PathBuf::from("/nonexistent"),
            require_mount: None,
            exec: vec![],
            pg_user: "u".into(),
            allow_primary: false,
            recipients_file: PathBuf::new(),
            identity_file: PathBuf::new(),
            zstd: "zstd".into(),
            zstd_level: 3,
            zstd_threads: 1,
            retries: 1,
            retry_wait_s: 0,
            min_free_gb: 0,
            rclone: "rclone".into(),
            rclone_remote: None,
            keep_daily: 14,
            keep_weekly: 8,
            pg_image: "postgres:17.11-alpine".into(),
        }
    }
}
