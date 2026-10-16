//! `backup pitr-test`: the monthly physical restore test. Fetches the newest wal-g base
//! backup from the mybook mirror of the off-site store, fetches every WAL segment after
//! it, replays them in a throwaway container and checks that recovery reached a recent
//! transaction and that every table can be read.
//!
//! wal-g runs on nezopt (glibc); the container is the same Alpine image as the replica, so
//! collations match, and it restores with a plain `cp` from the pre-fetched WAL.

use super::verify::{remove_work, Container};
use super::Cfg;
use crate::{env, mail, sys};
use anyhow::{anyhow, bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// 16 MB segments: `TTTTTTTTXXXXXXXXYYYYYYYY` where YY runs 00..FF before XX increments.
pub fn next_segment(name: &str) -> Result<String> {
    if name.len() != 24 || !name.chars().all(|c| c.is_ascii_hexdigit()) {
        bail!("not a WAL segment name: {name:?}");
    }
    let tli = &name[..8];
    let log = u32::from_str_radix(&name[8..16], 16)?;
    let seg = u32::from_str_radix(&name[16..], 16)?;
    let (log, seg) = if seg >= 0xFF { (log + 1, 0) } else { (log, seg + 1) };
    Ok(format!("{tli}{log:08X}{seg:08X}"))
}

/// `START WAL LOCATION: 95/AC000028 (file 0000000100000095000000AC)` → the file name.
pub fn start_segment(backup_label: &str) -> Result<String> {
    for line in backup_label.lines() {
        if let Some(rest) = line.strip_prefix("START WAL LOCATION:") {
            if let Some(i) = rest.find("(file ") {
                let name = rest[i + 6..].trim_end_matches(')').trim();
                return Ok(name.to_string());
            }
        }
    }
    bail!("no START WAL LOCATION in backup_label")
}

fn walg_env(path: &Path) -> Result<Vec<(String, String)>> {
    let text = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    Ok(env::parse(&text))
}

fn walg(bin: &str, envs: &[(String, String)], args: &[&str]) -> Result<std::process::Output> {
    Command::new(bin).args(args).envs(envs.iter().map(|(k, v)| (k, v))).output().with_context(|| format!("spawn {bin}"))
}

pub fn run(cfg: &Cfg) -> Result<()> {
    cfg.check_mount()?;
    let started = Instant::now();
    let bin = env::get("POKOIN_WALG").unwrap_or_else(|| env::home().join(".local/bin/wal-g").display().to_string());
    let env_file = env::get("POKOIN_WALG_MIRROR_ENV").map(PathBuf::from).unwrap_or_else(|| env::home().join(".config/pokoin/walg-mirror.env"));
    let envs = walg_env(&env_file)?;
    let max_age_h: i64 = env::get_num("POKOIN_PITR_MAX_AGE_H", 30);
    let work = cfg.dir.join("restore-test").join("pitr");
    let container = Container { name: "pokoin-pitr-test".into() };
    container.remove();
    remove_work(&work, &cfg.pg_image);
    std::fs::create_dir_all(work.join("wal"))?;

    let result = fetch_and_replay(cfg, &bin, &envs, &work, &container, max_age_h);
    if env::get("POKOIN_RESTORE_KEEP").as_deref() != Some("1") {
        container.remove();
        remove_work(&work, &cfg.pg_image);
    }
    let (ok, body) = match result {
        Ok(summary) => (true, summary),
        Err(e) => (false, format!("{e:#}")),
    };
    let body = format!("PITR restore test {} in {} min.\n\n{body}\n", if ok { "PASSED" } else { "FAILED" }, started.elapsed().as_secs() / 60);
    println!("{body}");
    if let Err(e) = mail::send(&mail::subject(&format!("PITR restore test {}", if ok { "passed" } else { "FAILED" })), &body) {
        eprintln!("{e:#}");
    }
    if ok { Ok(()) } else { Err(anyhow!("PITR restore test failed")) }
}

fn fetch_and_replay(cfg: &Cfg, bin: &str, envs: &[(String, String)], work: &Path, c: &Container, max_age_h: i64) -> Result<String> {
    let pgdata = work.join("pgdata");
    let out = walg(bin, envs, &["backup-fetch", &pgdata.display().to_string(), "LATEST"])?;
    if !out.status.success() {
        bail!("wal-g backup-fetch: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    let label = std::fs::read_to_string(pgdata.join("backup_label")).context("backup_label")?;
    let first = start_segment(&label)?;

    // Every segment from the backup start until the store has no more.
    let wal = work.join("wal");
    let mut seg = first.clone();
    let mut fetched = 0u32;
    loop {
        let dst = wal.join(&seg);
        let out = walg(bin, envs, &["wal-fetch", &seg, &dst.display().to_string()])?;
        if !out.status.success() {
            break;
        }
        fetched += 1;
        seg = next_segment(&seg)?;
    }
    if fetched == 0 {
        bail!("no WAL found from {first}: the backup cannot be made consistent");
    }
    sys::output("chmod", &["-R", "a+rX", &wal.display().to_string()])?;

    // A copy of the standby: drop its replication settings and archiving, recover from /wal.
    for f in ["standby.signal", "postmaster.pid", "postmaster.opts"] {
        let _ = std::fs::remove_file(pgdata.join(f));
    }
    let mut auto = std::fs::read_to_string(pgdata.join("postgresql.auto.conf")).unwrap_or_default();
    auto.push_str("\n# pokoin-ops pitr-test\nprimary_conninfo = ''\nprimary_slot_name = ''\narchive_mode = 'off'\n\
                   restore_command = 'cp /wal/%f %p'\nrecovery_target_timeline = 'current'\n");
    std::fs::write(pgdata.join("postgresql.auto.conf"), auto)?;
    std::fs::write(pgdata.join("recovery.signal"), "")?;

    let data = format!("{}:/var/lib/postgresql/data/pgdata", pgdata.display());
    let walm = format!("{}:/wal:ro", wal.display());
    sys::output("docker", &[
        "run", "-d", "--name", &c.name, "--label", "pokoin-restore-test=1", "--network", "none",
        "--shm-size", "1g", "--memory", &env::get_or("POKOIN_RESTORE_MEMORY", "6g"),
        "-e", "PGDATA=/var/lib/postgresql/data/pgdata", "-v", &data, "-v", &walm, &cfg.pg_image,
        "-c", "max_connections=200", "-c", "fsync=off", "-c", "ssl=off",
    ])?;

    let timeout = Duration::from_secs(env::get_num("POKOIN_PITR_TIMEOUT_S", 4 * 3600));
    let t0 = Instant::now();
    loop {
        // The bootstrap superuser of the replica cluster is the pg user, not postgres.
        let r = c.exec(&["psql", "-X", "-At", "-U", &cfg.pg_user, "-d", "postgres", "-c", "select pg_is_in_recovery()"]);
        if matches!(r.as_deref().map(str::trim), Ok("f")) {
            break;
        }
        if t0.elapsed() > timeout {
            let logs = Command::new("docker").args(["logs", "--tail", "40", &c.name]).output()?;
            bail!("recovery did not finish in {}s:\n{}", timeout.as_secs(), String::from_utf8_lossy(&logs.stderr));
        }
        std::thread::sleep(Duration::from_secs(10));
    }
    let q = |db: &str, sql: &str| -> Result<String> {
        Ok(c.exec(&["psql", "-X", "-q", "-At", "-F", "\t", "-U", &cfg.pg_user, "-d", db, "-c", sql])?.trim().to_string())
    };
    let age_s: i64 = q("postgres", "select coalesce(extract(epoch from now() - pg_last_xact_replay_timestamp())::bigint, -1)")?
        .parse()
        .map_err(|_| anyhow!("no replay timestamp"))?;
    if age_s < 0 || age_s > max_age_h * 3600 {
        bail!("recovered only to a transaction {} h old (max {max_age_h} h): the WAL chain or the mirror is stale", age_s / 3600);
    }
    let mut summary = format!(
        "base backup start segment {first}, {fetched} WAL segments replayed, last replayed transaction {} h {} min before now.\n\n",
        age_s / 3600,
        (age_s % 3600) / 60
    );
    let dbs = q("postgres", "select datname from pg_database where datallowconn and not datistemplate order by 1")?;
    for db in dbs.lines().filter(|l| !l.is_empty()) {
        let tables = q(db, "select format('%I.%I', schemaname, tablename) from pg_tables \
            where schemaname not in ('pg_catalog', 'information_schema') order by 1")?;
        let mut rows = 0u64;
        let mut n = 0;
        for t in tables.lines().filter(|l| !l.is_empty()) {
            rows += q(db, &format!("select count(*) from {t}"))?.parse::<u64>().unwrap_or(0);
            n += 1;
        }
        summary.push_str(&format!("{db:32} {n:6} tables {rows:12} rows readable\n"));
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_roll_over() {
        assert_eq!(next_segment("0000000100000095000000AC").unwrap(), "0000000100000095000000AD");
        assert_eq!(next_segment("0000000100000095000000FF").unwrap(), "000000010000009600000000");
        assert!(next_segment("00000001.history").is_err());
    }

    #[test]
    fn label() {
        let label = "START WAL LOCATION: 95/AC000028 (file 0000000100000095000000AC)\nCHECKPOINT LOCATION: 95/AC000060\n";
        assert_eq!(start_segment(label).unwrap(), "0000000100000095000000AC");
        assert!(start_segment("nothing").is_err());
    }
}
