//! pokoin-ops: failure mail, dead-man pings, the cross-host sentinel, and Postgres
//! backups / restore tests. See docs/BACKUPS_AND_ALERTS.md.

mod backup;
mod env;
mod hc;
mod health;
mod mail;
mod nezopt;
mod notify;
mod secretary;
mod sentinel;
mod sys;
mod wal;

use anyhow::{anyhow, Result};
use clap::{Parser, Subcommand};
use std::io::Write;
use std::path::PathBuf;

#[derive(Parser)]
#[command(version, about = "Pokoin host operations")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Mail a failed unit's status and journal, and ping its dead-man check /fail.
    NotifyUnit {
        unit: String,
        /// The unit is a systemd --user unit.
        #[arg(long)]
        user: bool,
    },
    /// Ping a dead-man check: ok (default), start or fail.
    HcPing {
        #[arg(long, conflicts_with = "unit")]
        slug: Option<String>,
        /// Derive the slug from a unit name and POKOIN_HC_SLUG_PREFIX.
        #[arg(long)]
        unit: Option<String>,
        kind: Option<String>,
    },
    /// Create or update every dead-man check (needs POKOIN_HC_API_KEY).
    HcProvision,
    /// Run the checks for this host and mail what changed.
    Sentinel {
        #[arg(long, value_enum)]
        role: sentinel::Role,
        /// Print findings and would-be events; no mail, no state change.
        #[arg(long)]
        dry_run: bool,
    },
    #[command(subcommand)]
    Backup(BackupCmd),
    #[command(subcommand)]
    Wal(WalCmd),
}

#[derive(Subcommand)]
enum BackupCmd {
    /// Dump every database of the Pi standby to POKOIN_BACKUP_DIR, then upload.
    Dump,
    /// Copy finished local dump sets off-site with rclone.
    Upload,
    /// Keep the newest 14 sets and the newest 8 weekly sets.
    Prune {
        #[arg(long)]
        dry_run: bool,
    },
    /// Logical restore test of the newest (or the given) dump set.
    Verify {
        #[arg(long)]
        stamp: Option<String>,
    },
    /// Physical restore test from the wal-g mirror on mybook.
    PitrTest,
    /// Create the age key pair for dumps (identity 0600 + public recipient file).
    Keygen,
    /// Decrypt an .age file to stdout (still zstd-compressed) for a manual restore.
    Decrypt {
        file: PathBuf,
    },
}

#[derive(Subcommand)]
enum WalCmd {
    /// Upload and delete the standby's spooled WAL files.
    PushSpool {
        #[arg(long, default_value = "/srv/pokoin/postgres/wal-spool")]
        spool: PathBuf,
        #[arg(long, default_value = "/usr/local/bin/wal-g")]
        walg: String,
        /// wal-g env file of one store; repeat for several stores.
        #[arg(long = "env-file", required = true)]
        env_files: Vec<PathBuf>,
    },
}

fn main() {
    env::load(&env::default_files());
    if let Err(err) = run(Cli::parse()) {
        eprintln!("pokoin-ops: {err:#}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<()> {
    match cli.cmd {
        Cmd::NotifyUnit { unit, user } => notify::run(&unit, user),
        Cmd::HcPing { slug, unit, kind } => {
            let slug = match (slug, unit) {
                (Some(s), _) => s,
                (None, Some(u)) => hc::slug_for_unit(&hc::host_prefix(), &u),
                (None, None) => return Err(anyhow!("--slug or --unit is required")),
            };
            let kind = hc::Kind::parse(kind.as_deref().unwrap_or(""))?;
            if !hc::ping(&slug, kind, "")? {
                eprintln!("POKOIN_HC_PING_KEY not set; {slug} not pinged");
            }
            Ok(())
        }
        Cmd::HcProvision => hc::provision(),
        Cmd::Sentinel { role, dry_run } => sentinel::run(role, dry_run),
        Cmd::Backup(cmd) => {
            let cfg = backup::Cfg::from_env;
            match cmd {
                BackupCmd::Dump => {
                    let cfg = cfg()?;
                    backup::dump(&cfg)?;
                    backup::upload(&cfg)
                }
                BackupCmd::Upload => backup::upload(&cfg()?),
                BackupCmd::Prune { dry_run } => backup::prune(&cfg()?, dry_run),
                BackupCmd::Verify { stamp } => backup::verify::run(&cfg()?, stamp),
                BackupCmd::PitrTest => backup::pitr::run(&cfg()?),
                BackupCmd::Keygen => {
                    let dir = env::home().join(".config/pokoin");
                    let id = env::get("POKOIN_BACKUP_AGE_IDENTITY").map(PathBuf::from).unwrap_or_else(|| dir.join("backup-age.key"));
                    let pubf = env::get("POKOIN_BACKUP_AGE_RECIPIENTS_FILE").map(PathBuf::from).unwrap_or_else(|| dir.join("backup-age.pub"));
                    backup::keygen(&id, &pubf)
                }
                BackupCmd::Decrypt { file } => {
                    let id = env::get("POKOIN_BACKUP_AGE_IDENTITY")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| env::home().join(".config/pokoin/backup-age.key"));
                    let identity = backup::read_identity(&id)?;
                    let mut r = backup::decrypt_reader(&file, &identity)?;
                    let stdout = std::io::stdout();
                    let mut lock = stdout.lock();
                    std::io::copy(&mut r, &mut lock)?;
                    lock.flush()?;
                    Ok(())
                }
            }
        }
        Cmd::Wal(WalCmd::PushSpool { spool, walg, env_files }) => wal::push_spool(&spool, &walg, &env_files).map(|_| ()),
    }
}
