use anyhow::{bail, Context, Result};
use fs2::FileExt;
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

pub const RECORDS: &str = "newsroom-articles-v1.json";
pub const STORIES: &str = "newsroom-site-stories.json";
pub const STATE: &str = "newsroom-publisher-state.json";
// Read-only readers retain Node's missing/corrupt -> empty contract. The handover
// preflight uses strict_read instead: corrupt cadence must never reset the cap.
pub fn load_array(path: &Path) -> Vec<Value> {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}
pub fn strict_read(path: &Path) -> Result<Value> {
    serde_json::from_slice(&fs::read(path).with_context(|| format!("read {}", path.display()))?)
        .with_context(|| format!("invalid JSON {}", path.display()))
}
pub fn atomic_json(path: &Path, value: &Value) -> Result<()> {
    let parent = path.parent().context("file needs parent")?;
    fs::create_dir_all(parent)?;
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    let result = (|| {
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}
pub fn save_record(dir: &Path, record: &Value) -> Result<()> {
    let id = crate::text(record, "id");
    if id.is_empty() || id.contains(['/', '\\']) || id == "." || id == ".." {
        bail!("invalid record id");
    }
    let mut records = load_array(&dir.join(RECORDS));
    if let Some(existing) = records.iter_mut().find(|r| r["id"] == record["id"]) {
        if existing["slug"] != record["slug"] {
            bail!(
                "slug of {id} is permanent ({} → {} refused)",
                crate::text(existing, "slug"),
                crate::text(record, "slug")
            );
        }
        *existing = record.clone();
    } else {
        records.push(record.clone());
    }
    atomic_json(&dir.join(RECORDS), &Value::Array(records))?;
    if let Some(rev) = crate::array(&record["revisions"]).last() {
        let number = rev["rev"]
            .as_u64()
            .context("revision requires numeric rev")?;
        atomic_json(
            &dir.join("newsroom-revisions")
                .join(id)
                .join(format!("rev-{number:04}.json")),
            record,
        )?;
    }
    Ok(())
}
pub fn export_records(records: &[Value], scope: &str, strip: bool) -> Vec<Value> {
    records
        .iter()
        .filter(|r| {
            if scope == "all" {
                crate::text(r, "status") != "withdrawn"
            } else {
                crate::text(r, "status") == "published"
            }
        })
        .map(|r| {
            let mut r = r.clone();
            if strip {
                if let Some(obj) = r.as_object_mut() {
                    obj.remove("pendingRevision");
                    obj.remove("channels");
                }
            }
            r
        })
        .collect()
}
pub struct DataLock {
    _file: File,
}
impl DataLock {
    pub fn acquire(dir: &Path) -> Result<Self> {
        fs::create_dir_all(dir)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(dir.join("newsroom-rust.lock"))?;
        file.try_lock_exclusive()
            .context("another Rust newsroom owns the data lock")?;
        Ok(Self { _file: file })
    }
}
// Never use dotenv parsing that expands shell commands; never invoke a shell.
// Validate the opened descriptor (including owner), reject symlinks and 0644.
pub fn load_env_file(path: &Path) -> Result<()> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        bail!("env file must not be a symlink");
    }
    let file = File::open(path)?;
    let m = file.metadata()?;
    // Linux procfs reports the actual process owner; HOME is not trusted for uid checks.
    let uid = fs::metadata("/proc/self")?.uid();
    if !m.is_file() || m.permissions().mode() & 0o777 != 0o600 || m.uid() != uid {
        bail!("env file must be owned by runtime user with mode 0600");
    }
    use std::io::Read;
    let mut raw = String::new();
    (&file).read_to_string(&mut raw)?;
    let mut entries = Vec::new();
    for (index, line) in raw.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let (key, value) = line
            .split_once('=')
            .with_context(|| format!("invalid env syntax at line {}", index + 1))?;
        if key.is_empty()
            || !key
                .bytes()
                .enumerate()
                .all(|(i, b)| b.is_ascii_alphabetic() || b == b'_' || (i > 0 && b.is_ascii_digit()))
        {
            bail!("invalid env key at line {}", index + 1);
        }
        let value = value.trim();
        let value = if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            &value[1..value.len() - 1]
        } else {
            value
        };
        entries.push((key.to_owned(), value.to_owned()));
    }
    for (key, value) in entries {
        std::env::set_var(key, value);
    }
    Ok(())
}
pub fn data_dir() -> PathBuf {
    std::env::var_os("NEWSROOM_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data"))
}
