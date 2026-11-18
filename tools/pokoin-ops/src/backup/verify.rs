//! `backup verify`: the monthly logical restore test. Restores the newest dump set into a
//! throwaway Postgres container (no network, data on mybook) and checks, per table, that
//! the restored row count equals the number of rows in the archive.

use super::{copycount, decrypt_reader, read_identity, read_manifest, sha256_file, list_sets, Cfg};
use crate::{env, mail, sys};
use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Serialize, Default)]
pub struct DbReport {
    pub database: String,
    pub tables: usize,
    pub rows: u64,
    pub mismatches: Vec<String>,
    pub restore_warnings: Vec<String>,
}

#[derive(Serialize)]
pub struct Report {
    pub stamp: String,
    pub started_at: String,
    pub seconds: u64,
    pub ok: bool,
    pub databases: Vec<DbReport>,
}

/// Decrypts and decompresses `src` into `dst`.
pub fn unpack(src: &Path, dst: &Path, identity: &age::x25519::Identity, zstd: &str) -> Result<()> {
    let out = File::create(dst).with_context(|| format!("create {}", dst.display()))?;
    let mut z = Command::new(zstd)
        .args(["-d", "-c", "-q"])
        .stdin(Stdio::piped())
        .stdout(Stdio::from(out))
        .spawn()
        .with_context(|| format!("spawn {zstd}"))?;
    let mut zin = z.stdin.take().expect("piped");
    let copied = decrypt_reader(src, identity).and_then(|mut r| io::copy(&mut r, &mut zin).map_err(Into::into));
    drop(zin);
    let status = z.wait()?;
    copied?;
    if !status.success() {
        bail!("zstd -d {} exited {status}", src.display());
    }
    Ok(())
}

pub struct Container {
    pub name: String,
}

impl Container {
    pub fn exec(&self, args: &[&str]) -> Result<String> {
        let mut all = vec!["exec", self.name.as_str()];
        all.extend(args);
        sys::output("docker", &all)
    }

    /// Feeds `sql` on stdin to psql in database `db`.
    pub fn psql_stdin(&self, db: &str, sql: &str) -> Result<String> {
        let mut child = Command::new("docker")
            .args(["exec", "-i", &self.name, "psql", "-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", db])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        child.stdin.take().expect("piped").write_all(sql.as_bytes())?;
        let out = child.wait_with_output()?;
        if !out.status.success() {
            bail!("psql {db}: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// The image's entrypoint runs a temporary server during initdb; wait for the real one.
    pub fn wait_ready(&self, timeout: Duration, fresh_init: bool) -> Result<()> {
        let start = Instant::now();
        loop {
            let logs = Command::new("docker").args(["logs", &self.name]).output()?;
            let text = format!("{}{}", String::from_utf8_lossy(&logs.stdout), String::from_utf8_lossy(&logs.stderr));
            let init_done = !fresh_init || text.contains("init process complete");
            if init_done && self.exec(&["pg_isready", "-U", "postgres", "-q"]).is_ok() {
                return Ok(());
            }
            if start.elapsed() > timeout {
                bail!("{} not ready after {}s; last log:\n{}", self.name, timeout.as_secs(), tail(&text, 3000));
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    }

    pub fn remove(&self) {
        let _ = Command::new("docker").args(["rm", "-f", &self.name]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
}

/// Deletes a work dir whose pgdata belongs to the container's postgres uid.
pub fn remove_work(work: &Path, image: &str) {
    if work.join("pgdata").exists() {
        let mount = format!("{}:/w", work.display());
        let _ = Command::new("docker").args(["run", "--rm", "--network", "none", "-v", &mount, image, "rm", "-rf", "/w/pgdata"]).status();
    }
    let _ = std::fs::remove_dir_all(work);
}

pub fn tail(text: &str, max: usize) -> &str {
    let mut start = text.len().saturating_sub(max);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

fn sql_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Exact row counts of `tables` (qualified, quoted as pg_dump wrote them).
pub fn count_tables(c: &Container, db: &str, tables: &[String]) -> Result<BTreeMap<String, u64>> {
    let mut out = BTreeMap::new();
    for chunk in tables.chunks(100) {
        let sql = chunk
            .iter()
            .map(|t| format!("select {}, count(*) from {t}", sql_literal(t)))
            .collect::<Vec<_>>()
            .join("\nunion all\n");
        for row in sys::rows(&c.psql_stdin(db, &format!("{sql};"))?) {
            if row.len() == 2 {
                out.insert(row[0].clone(), row[1].parse().map_err(|_| anyhow!("bad count {row:?}"))?);
            }
        }
    }
    Ok(out)
}

pub fn compare(archive: &BTreeMap<String, u64>, restored: &BTreeMap<String, u64>) -> Vec<String> {
    let mut bad = Vec::new();
    for (t, n) in archive {
        match restored.get(t) {
            Some(m) if m == n => {}
            Some(m) => bad.push(format!("{t}: archive {n} rows, restored {m}")),
            None => bad.push(format!("{t}: missing after restore")),
        }
    }
    bad
}

fn restore_errors(stderr: &str) -> Vec<String> {
    stderr
        .lines()
        .filter(|l| l.contains("ERROR") || l.contains("error:"))
        .map(str::to_string)
        .collect()
}

pub fn run(cfg: &Cfg, stamp: Option<String>) -> Result<()> {
    cfg.check_mount()?;
    let started = Instant::now();
    let started_at = chrono::Utc::now().to_rfc3339();
    let set_dir = match stamp {
        Some(s) => cfg.dumps().join(s),
        None => cfg.dumps().join(&list_sets(&cfg.dumps())?.first().ok_or_else(|| anyhow!("no complete dump set"))?.stamp),
    };
    let manifest = read_manifest(&set_dir)?;
    println!("restore test of {} ({})", manifest.stamp, manifest.kind);
    for f in &manifest.files {
        let got = sha256_file(&set_dir.join(&f.name))?;
        if got != (f.bytes, f.sha256.clone()) {
            bail!("{}: checksum mismatch (manifest {} bytes {}, file {} bytes {})", f.name, f.bytes, f.sha256, got.0, got.1);
        }
    }
    println!("checksums ok ({} files)", manifest.files.len());
    let identity = read_identity(&cfg.identity_file)?;
    let work = cfg.dir.join("restore-test").join(&manifest.stamp);
    let container = Container { name: format!("pokoin-restore-test-{}", manifest.stamp.to_lowercase()) };
    container.remove();
    remove_work(&work, &cfg.pg_image);
    std::fs::create_dir_all(work.join("files"))?;
    std::fs::create_dir_all(work.join("pgdata"))?;

    let result = restore_and_check(cfg, &manifest, &set_dir, &work, &container, &identity);
    let keep = env::get("POKOIN_RESTORE_KEEP").as_deref() == Some("1");
    if !keep {
        container.remove();
        remove_work(&work, &cfg.pg_image);
    }
    let databases = result?;
    let ok = databases.iter().all(|d| d.mismatches.is_empty());
    let report = Report { stamp: manifest.stamp.clone(), started_at, seconds: started.elapsed().as_secs(), ok, databases };
    let reports = cfg.dir.join("restore-reports");
    std::fs::create_dir_all(&reports)?;
    std::fs::write(reports.join(format!("{}-logical.json", manifest.stamp)), serde_json::to_vec_pretty(&report)?)?;

    let tables: usize = report.databases.iter().map(|d| d.tables).sum();
    let rows: u64 = report.databases.iter().map(|d| d.rows).sum();
    let mut body = format!(
        "Logical restore test of dump {} ({}): {}.\n{} databases, {} tables, {} rows, {} min.\n\n",
        report.stamp,
        manifest.kind,
        if ok { "PASSED" } else { "FAILED" },
        report.databases.len(),
        tables,
        rows,
        report.seconds / 60
    );
    for d in &report.databases {
        body.push_str(&format!("{:32} {:6} tables {:12} rows\n", d.database, d.tables, d.rows));
        for m in &d.mismatches {
            body.push_str(&format!("    MISMATCH {m}\n"));
        }
        for w in d.restore_warnings.iter().take(10) {
            body.push_str(&format!("    restore: {w}\n"));
        }
    }
    println!("{body}");
    let subject = mail::subject(&format!("restore test {} ({})", if ok { "passed" } else { "FAILED" }, report.stamp));
    if let Err(e) = mail::send(&subject, &body) {
        eprintln!("{e:#}");
    }
    if ok { Ok(()) } else { Err(anyhow!("restore test found row-count mismatches")) }
}

fn restore_and_check(
    cfg: &Cfg,
    manifest: &super::Manifest,
    set_dir: &Path,
    work: &Path,
    c: &Container,
    identity: &age::x25519::Identity,
) -> Result<Vec<DbReport>> {
    let files = work.join("files");
    let mut plain: Vec<(Option<String>, PathBuf)> = Vec::new();
    for f in &manifest.files {
        let out = files.join(f.name.trim_end_matches(".zst.age"));
        unpack(&set_dir.join(&f.name), &out, identity, &cfg.zstd)?;
        plain.push((f.database.clone(), out));
    }
    println!("unpacked into {}", files.display());

    let pgdata = format!("{}:/var/lib/postgresql/data", work.join("pgdata").display());
    let restore = format!("{}:/restore:ro", files.display());
    let mem = env::get_or("POKOIN_RESTORE_MEMORY", "6g");
    sys::output("docker", &[
        "run", "-d", "--name", &c.name, "--label", "pokoin-restore-test=1", "--network", "none",
        "--shm-size", "1g", "--memory", &mem, "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
        "-v", &pgdata, "-v", &restore, &cfg.pg_image,
        "-c", "fsync=off", "-c", "full_page_writes=off", "-c", "synchronous_commit=off",
        "-c", "autovacuum=off", "-c", "max_wal_size=16GB", "-c", "maintenance_work_mem=512MB",
    ])?;
    c.wait_ready(Duration::from_secs(300), true)?;

    if let Some((_, globals)) = plain.iter().find(|(db, _)| db.is_none()) {
        let name = globals.file_name().unwrap().to_string_lossy().into_owned();
        let out = Command::new("docker")
            .args(["exec", &c.name, "psql", "-X", "-q", "-U", "postgres", "-d", "postgres", "-f", &format!("/restore/{name}")])
            .output()?;
        for e in restore_errors(&String::from_utf8_lossy(&out.stderr)) {
            if !e.contains("already exists") {
                eprintln!("globals: {e}");
            }
        }
    }

    let jobs = env::get_or("POKOIN_RESTORE_JOBS", "4");
    let mut reports = Vec::new();
    for (db, path) in &plain {
        let Some(db) = db else { continue };
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let t0 = Instant::now();
        // `postgres` (and anything initdb made) already exists: restore into it, don't create it.
        let exists = c.psql_stdin("postgres", &format!("select 1 from pg_database where datname = {};", sql_literal(db)))?;
        let target: &[&str] = if exists.trim() == "1" { &["-d", db] } else { &["-d", "postgres", "-C"] };
        let file = format!("/restore/{name}");
        let mut args = vec!["exec", c.name.as_str(), "pg_restore", "-U", "postgres", "-j", &jobs];
        args.extend(target);
        args.push(&file);
        let out = Command::new("docker").args(&args).output()?;
        let warnings = restore_errors(&String::from_utf8_lossy(&out.stderr));
        if !out.status.success() {
            bail!("pg_restore {db} exited {}:\n{}", out.status, warnings.join("\n"));
        }

        let mut child = Command::new("docker")
            .args(["exec", &c.name, "pg_restore", "-a", "-f", "-", &format!("/restore/{name}")])
            .stdout(Stdio::piped())
            .spawn()?;
        let archive = copycount::count_rows(BufReader::with_capacity(1 << 20, child.stdout.take().expect("piped")))?;
        if !child.wait()?.success() {
            bail!("pg_restore -a {db} failed");
        }
        let tables: Vec<String> = archive.keys().cloned().collect();
        let restored = count_tables(c, db, &tables)?;
        let mismatches = compare(&archive, &restored);
        let rows = restored.values().sum();
        println!("{db}: {} tables, {rows} rows, {} mismatches, {}s", tables.len(), mismatches.len(), t0.elapsed().as_secs());
        reports.push(DbReport { database: db.clone(), tables: tables.len(), rows, mismatches, restore_warnings: warnings });
    }
    Ok(reports)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_reports_missing_and_different() {
        let a: BTreeMap<String, u64> = [("public.a".into(), 3), ("public.b".into(), 0), ("public.c".into(), 1)].into();
        let r: BTreeMap<String, u64> = [("public.a".into(), 3), ("public.b".into(), 1)].into();
        assert_eq!(compare(&a, &r), vec!["public.b: archive 0 rows, restored 1", "public.c: missing after restore"]);
    }

    #[test]
    fn literals_escape_quotes() {
        assert_eq!(sql_literal(r#""Odd's"."t""#), r#"'"Odd''s"."t"'"#);
    }
}
