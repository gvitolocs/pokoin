//! Handover is a persisted CMS projection, not a replayable social outbox.
use crate::{array, store, text};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    env, fs,
    path::{Component, Path, PathBuf},
};

pub const PARITY_COMPLETE: bool = false;
pub const PARITY_GAPS: &[&str] = &[
    "J17 native RSS scout and canonical story placement",
    "J17 source fetching, primary discovery, claims/evidence ledger and Pokoin enrichment",
    "J17 article schema/publication gate, image composition, CMS revisions and living updates",
    "J17 publisher loop, Firestore moderation loop and static build/deploy adapter",
    "J17 real generated-draft parity and crash-injection integration acceptance",
    "H42 routing integration into the shared API/edge",
    "Mount F16 legacy newsroom-articles.json from the checkout data directory",
];
pub fn activation_preflight() -> Result<()> {
    if !PARITY_COMPLETE {
        bail!("production activation blocked: {}", PARITY_GAPS.join("; "));
    }
    Ok(())
}
pub fn validate_state(dir: &Path) -> Result<Value> {
    let records = store::strict_read(&dir.join(store::RECORDS))?;
    let stories = store::strict_read(&dir.join(store::STORIES))?;
    let state = store::strict_read(&dir.join(store::STATE))?;
    if !records.is_array()
        || !stories.is_array()
        || !state["attempts"].is_array()
        || !state["updates"].is_object()
    {
        bail!("invalid cadence/CMS state shape");
    }
    let mut ids = HashSet::new();
    let mut stories_seen = HashSet::new();
    let mut slugs = HashSet::new();
    for record in array(&records) {
        let id = text(record, "id");
        if id.is_empty() || !ids.insert(id) {
            bail!("missing/duplicate CMS record id");
        }
        let canonical = text(record, "canonicalStoryId");
        let language = text(record, "language");
        if canonical.is_empty() || !stories_seen.insert((canonical, language)) {
            bail!("missing/duplicate canonical story/language");
        }
        if !slugs.insert((crate::game(record), text(record, "slug"))) {
            bail!("duplicate game/slug");
        }
        if text(record, "status") == "published"
            && crate::timestamp(text(record, "datePublished")).is_none()
        {
            bail!("published record missing datePublished");
        }
    }
    let mut hashes = serde_json::Map::new();
    for file in [store::RECORDS, store::STORIES, store::STATE] {
        let bytes = fs::read(dir.join(file))?;
        hashes.insert(file.into(), json!(format!("{:x}", Sha256::digest(bytes))));
    }
    Ok(
        json!({"ok":true,"records":array(&records).len(),"stories":array(&stories).len(),"attempts":array(&state["attempts"]).len(),"sha256":hashes}),
    )
}
pub fn snapshot(source: &Path, destination: &Path) -> Result<Value> {
    if destination.exists() {
        bail!("snapshot destination must not exist");
    }
    let manifest = validate_state(source)?;
    // The copy lands inside the destination, so a destination at or inside the
    // source would have the snapshot overwrite what it is reading. The path does
    // not exist yet, so it is resolved away from the filesystem instead.
    let source = source.canonicalize()?;
    let resolved = match destination.canonicalize() {
        Ok(existing) => existing,
        Err(_) => resolve(destination, &env::current_dir()?),
    };
    if resolved == source || resolved.starts_with(&source) {
        bail!(
            "snapshot destination {} is inside the source directory {}",
            destination.display(),
            source.display()
        );
    }
    fs::create_dir_all(destination)?;
    copy_tree(&source, destination)?;
    store::atomic_json(&destination.join("handover-manifest.json"), &manifest)?;
    let verified = validate_state(destination)?;
    if verified != manifest {
        bail!("state changed during snapshot; retry after Node is stopped");
    }
    Ok(manifest)
}
/// `path` made absolute against `base` with `.` and `..` collapsed, for a
/// destination that does not exist yet and therefore cannot be canonicalized.
fn resolve(path: &Path, base: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let mut out = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}
fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name();
        if name == "newsroom-rust.lock" || name.to_string_lossy().ends_with(".tmp") {
            continue;
        }
        if kind.is_symlink() {
            bail!("state directory contains symlink");
        }
        if kind.is_dir() {
            fs::create_dir(to.join(&name))?;
            copy_tree(&entry.path(), &to.join(&name))?;
        } else if kind.is_file() {
            fs::copy(entry.path(), to.join(name)).context("copy handover state")?;
        }
    }
    Ok(())
}
