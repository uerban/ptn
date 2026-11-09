//! Durable single-writer release activation. Data rollback advances activation
//! revision while preserving the catalog high-water mark. Pruning lives in
//! `retention` and only runs when a deployment configures a lease root.
use pt_shared::{fsync, osm_manifest::valid_digest};
use rustix::fs::{flock, FlockOperation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::os::fd::AsFd;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

pub use pt_shared::osm_install::Activation;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefreshStatus {
    pub checked_at: i64,
    pub last_success_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationalStatus {
    pub activation: Option<Activation>,
    pub refresh: Option<RefreshStatus>,
    pub source_snapshot_at: Option<String>,
    pub source_age_seconds: Option<u64>,
}

pub struct Store {
    pub(crate) root: PathBuf,
    // OS lock is released automatically on exit/crash. Never unlink the inode.
    _lock: File,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn city_path(city: &str) -> io::Result<&str> {
    if city.is_empty()
        || city.len() > 64
        || !city
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(invalid("invalid city"));
    }
    Ok(city)
}

impl Drop for Store {
    fn drop(&mut self) {
        // Concurrent subprocess creation can briefly inherit this open file
        // description before exec closes CLOEXEC descriptors. Explicit unlock
        // ends our critical section even while such a duplicate still exists.
        let _ = flock(&self._lock, FlockOperation::Unlock);
    }
}

impl Store {
    fn refresh_status(&self, city: &str) -> io::Result<Option<RefreshStatus>> {
        match fs::read(
            self.root
                .join("state")
                .join(format!("{}.refresh.json", city_path(city)?)),
        ) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(io::Error::other),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn record_refresh(&self, city: &str, now: i64, error: Option<&str>) -> io::Result<()> {
        let previous = self.refresh_status(city)?;
        let status = RefreshStatus {
            checked_at: now,
            last_success_at: if error.is_none() {
                Some(now)
            } else {
                previous.and_then(|v| v.last_success_at)
            },
            error: error.map(|message| message.chars().take(2048).collect()),
        };
        atomic_json(
            &self
                .root
                .join("state")
                .join(format!("{}.refresh.json", city_path(city)?)),
            &status,
        )
    }

    pub fn operational_status(&self, city: &str, now: i64) -> io::Result<OperationalStatus> {
        let activation = self.status(city)?;
        let snapshot = if let Some(active) = &activation {
            let path = self
                .city_root(city)?
                .join("releases")
                .join(&active.release)
                .join("manifest.json");
            let mut bytes = Vec::new();
            File::open(path)?
                .take(1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 1024 * 1024
                || pt_shared::osm_manifest::digest(&bytes) != active.release
            {
                return Err(invalid("installed manifest hash or size mismatch"));
            }
            let manifest: pt_shared::osm_manifest::OsmManifest =
                serde_json::from_slice(&bytes).map_err(io::Error::other)?;
            manifest
                .validate(city)
                .map_err(|message| invalid(&message))?;
            Some(manifest.source.snapshot_at)
        } else {
            None
        };
        let age = snapshot
            .as_deref()
            .map(|value| {
                let timestamp: jiff::Timestamp = value.parse().map_err(io::Error::other)?;
                Ok::<_, io::Error>(now.saturating_sub(timestamp.as_second()).max(0) as u64)
            })
            .transpose()?;
        Ok(OperationalStatus {
            activation,
            refresh: self.refresh_status(city)?,
            source_snapshot_at: snapshot,
            source_age_seconds: age,
        })
    }

    pub fn open(root: &Path) -> io::Result<Self> {
        durable_mkdir(&root.join("state"))?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("state/writer.lock"))?;
        flock(&lock, FlockOperation::NonBlockingLockExclusive)?;
        let store = Self {
            root: root.into(),
            _lock: lock,
        };
        store.clean_interrupted_staging()?;
        Ok(store)
    }

    /// Only incomplete writer-owned names are eligible, including releases a
    /// crashed `prune` had already moved aside.
    fn clean_interrupted_staging(&self) -> io::Result<()> {
        clean_children(&self.root.join("objects/sha256"), |name| {
            name.strip_suffix(".part").is_some_and(valid_digest)
        })?;
        for directory in ["public/releases", "public/poi"] {
            clean_children(&self.root.join(directory), staging_name)?;
        }
        for directory in ["state", "public/current"] {
            clean_children(&self.root.join(directory), |name| {
                name.ends_with(".json.part")
            })?;
        }
        let cities = self.root.join("cities");
        if let Some(entries) = read_owned_directory(&cities)? {
            for entry in entries {
                let entry = entry?;
                if entry.file_type()?.is_dir() {
                    clean_children(&entry.path(), staging_name)?;
                }
            }
        }
        Ok(())
    }

    fn city_root(&self, city: &str) -> io::Result<PathBuf> {
        Ok(self.root.join("cities").join(city_path(city)?))
    }

    fn activation_path(&self, city: &str) -> io::Result<PathBuf> {
        Ok(self
            .root
            .join("public/current")
            .join(format!("{}.json", city_path(city)?)))
    }

    pub(crate) fn cached_object(&self, hash: &str, bytes: u64) -> io::Result<Option<PathBuf>> {
        if !valid_digest(hash) {
            return Err(invalid("invalid object digest"));
        }
        let path = self.root.join("objects/sha256").join(hash);
        Ok(verify_object(&path, hash, bytes).is_ok().then_some(path))
    }

    /// Stream bounded object bytes into staging and verify before exposure.
    /// Existing cache entries are rehashed, so disk corruption is never a hit.
    pub fn install_object(
        &self,
        hash: &str,
        bytes: u64,
        source: &mut impl Read,
    ) -> io::Result<PathBuf> {
        if !valid_digest(hash) || bytes == 0 || bytes > pt_shared::osm_manifest::MAX_OBJECT_BYTES {
            return Err(invalid("invalid object bounds"));
        }
        let root = self.root.join("objects/sha256");
        durable_mkdir(&root)?;
        let target = root.join(hash);
        if target.exists() && verify_object(&target, hash, bytes).is_ok() {
            return Ok(target);
        }
        let staging = root.join(format!("{hash}.part"));
        let result = (|| {
            let mut file = File::create(&staging)?;
            let mut hasher = Sha256::new();
            let mut copied = 0u64;
            let mut buffer = [0; 64 * 1024];
            loop {
                let count = source.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                copied = copied
                    .checked_add(count as u64)
                    .ok_or_else(|| invalid("object size overflow"))?;
                if copied > bytes {
                    return Err(invalid("object exceeds advertised size"));
                }
                hasher.update(&buffer[..count]);
                file.write_all(&buffer[..count])?;
            }
            if copied != bytes || format!("{:x}", hasher.finalize()) != hash {
                return Err(invalid("object checksum or size mismatch"));
            }
            fsync::durable(file.as_fd())?;
            fs::rename(&staging, &target)?;
            fsync::durable_dir(File::open(&root)?.as_fd())?;
            Ok(target)
        })();
        if result.is_err() {
            let _ = fs::remove_file(staging);
        }
        result
    }

    pub fn status(&self, city: &str) -> io::Result<Option<Activation>> {
        let bytes = match fs::read(self.activation_path(city)?) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let state: Activation =
            serde_json::from_slice(&bytes).map_err(|e| invalid(&e.to_string()))?;
        if state.schema_version != 1
            || state.revision == 0
            || !valid_digest(&state.release)
            || !valid_digest(&state.catalog_manifest)
            || state
                .previous_release
                .as_ref()
                .is_some_and(|v| !valid_digest(v))
        {
            return Err(invalid("invalid activation state"));
        }
        Ok(Some(state))
    }

    /// Only call after every object and native format has passed validation and
    /// the complete immutable release directory has been durably installed.
    pub(crate) fn activate_validated(
        &self,
        city: &str,
        release: &str,
        sequence: u64,
    ) -> io::Result<bool> {
        if !valid_digest(release) || sequence == 0 {
            return Err(invalid("invalid release identity"));
        }
        let root = self.city_root(city)?;
        if !root
            .join("releases")
            .join(release)
            .join("manifest.json")
            .is_file()
        {
            return Err(invalid("release is not installed"));
        }
        let previous = self.status(city)?;
        if let Some(state) = &previous {
            if sequence < state.catalog_sequence
                || (sequence == state.catalog_sequence && release != state.catalog_manifest)
            {
                return Err(invalid("catalog replay or equivocation"));
            }
            if state.pinned {
                return Ok(false);
            }
            if state.release == release && sequence == state.catalog_sequence {
                return Ok(false);
            }
        }
        let state = Activation {
            schema_version: 1,
            revision: next_revision(previous.as_ref())?,
            release: release.into(),
            previous_release: previous.as_ref().and_then(|p| {
                if p.release == release {
                    p.previous_release.clone()
                } else {
                    Some(p.release.clone())
                }
            }),
            catalog_sequence: sequence,
            catalog_manifest: release.into(),
            pinned: false,
        };
        atomic_json(&self.activation_path(city)?, &state)?;
        Ok(true)
    }

    /// Rollback pins the selected installed release so the next scheduled sync
    /// cannot immediately undo the operator's decision.
    pub fn rollback(&self, city: &str) -> io::Result<Activation> {
        let mut state = self
            .status(city)?
            .ok_or_else(|| invalid("no active release"))?;
        let target = state
            .previous_release
            .clone()
            .ok_or_else(|| invalid("no previous release"))?;
        let root = self.city_root(city)?;
        if !root
            .join("releases")
            .join(&target)
            .join("manifest.json")
            .is_file()
        {
            return Err(invalid("previous release missing"));
        }
        state.revision = state
            .revision
            .checked_add(1)
            .ok_or_else(|| invalid("activation overflow"))?;
        state.previous_release = Some(std::mem::replace(&mut state.release, target));
        state.pinned = true;
        atomic_json(&self.activation_path(city)?, &state)?;
        Ok(state)
    }

    pub fn set_pinned(&self, city: &str, pinned: bool) -> io::Result<()> {
        let mut state = self
            .status(city)?
            .ok_or_else(|| invalid("no active release"))?;
        state.pinned = pinned;
        atomic_json(&self.activation_path(city)?, &state)
    }
}

fn staging_name(name: &str) -> bool {
    name.strip_prefix(".staging-").is_some_and(valid_digest)
}
fn read_owned_directory(path: &Path) -> io::Result<Option<fs::ReadDir>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::read_dir(path).map(Some),
        Ok(_) => Err(invalid("artifact storage directory is not a directory")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
fn clean_children(path: &Path, eligible: impl Fn(&str) -> bool) -> io::Result<()> {
    let Some(entries) = read_owned_directory(path)? else {
        return Ok(());
    };
    let mut changed = false;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        if !name.to_str().is_some_and(&eligible) {
            continue;
        }
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path())?;
        } else {
            fs::remove_file(entry.path())?;
        }
        changed = true;
    }
    if changed {
        fsync::durable_dir(File::open(path)?.as_fd())?;
    }
    Ok(())
}

fn verify_object(path: &Path, hash: &str, bytes: u64) -> io::Result<()> {
    let file = File::open(path)?;
    if file.metadata()?.len() != bytes {
        return Err(invalid("cached object size mismatch"));
    }
    let mut hasher = Sha256::new();
    let mut reader = file.take(bytes + 1);
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    if format!("{:x}", hasher.finalize()) != hash {
        return Err(invalid("cached object checksum mismatch"));
    }
    Ok(())
}

fn next_revision(previous: Option<&Activation>) -> io::Result<u64> {
    previous
        .map_or(Some(1), |p| p.revision.checked_add(1))
        .ok_or_else(|| invalid("activation overflow"))
}

/// Persist newly created directory entries as well as the eventual files. A
/// fsync of only the deepest directory does not make first-deploy ancestors durable.
pub(crate) fn durable_mkdir(path: &Path) -> io::Result<()> {
    if path.is_dir() {
        return Ok(());
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    durable_mkdir(parent)?;
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => {}
        Err(error) => return Err(error),
    }
    fsync::durable_dir(File::open(path)?.as_fd())?;
    fsync::durable_dir(File::open(parent)?.as_fd())
}

pub(crate) fn atomic_json(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| invalid("missing parent"))?;
    durable_mkdir(parent)?;
    let staged = path.with_extension("json.part");
    // The exclusive Store lock permits deterministic restart cleanup.
    let result = (|| {
        let mut file = File::create(&staged)?;
        file.write_all(&serde_json::to_vec(value).map_err(|e| invalid(&e.to_string()))?)?;
        fsync::durable(file.as_fd())?;
        fs::rename(&staged, path)?;
        fsync::durable_dir(File::open(parent)?.as_fd())
    })();
    if result.is_err() {
        let _ = fs::remove_file(staged);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use pt_shared::osm_manifest::digest;
    fn install(root: &Path, city: &str, id: &str) {
        let dir = root.join("cities").join(city).join("releases").join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), b"{}").unwrap();
    }
    #[test]
    fn dropping_writer_unlocks_inherited_file_description() {
        let root = tempfile::tempdir().unwrap();
        let writer = Store::open(root.path()).unwrap();
        // dup and fork share the same lock-bearing open file description.
        let inherited = writer._lock.try_clone().unwrap();
        assert!(Store::open(root.path()).is_err());
        drop(writer);
        let next = Store::open(root.path()).unwrap();
        drop(inherited);
        // Closing the old duplicate must not release the new writer's lock.
        assert!(Store::open(root.path()).is_err());
        drop(next);
        assert!(Store::open(root.path()).is_ok());
    }

    #[test]
    fn objects_are_bounded_verified_and_repaired() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let hash = digest(b"correct");
        assert!(store
            .install_object(&hash, 7, &mut &b"wrong!!"[..])
            .is_err());
        assert!(store
            .install_object(&hash, 7, &mut &b"correct extra"[..])
            .is_err());
        assert!(store.install_object(&hash, 7, &mut &b"short"[..]).is_err());
        assert!(!dir
            .path()
            .join("objects/sha256")
            .join(format!("{hash}.part"))
            .exists());
        let path = store
            .install_object(&hash, 7, &mut &b"correct"[..])
            .unwrap();
        // A valid warm cache requires no source reads.
        store.install_object(&hash, 7, &mut &b""[..]).unwrap();
        fs::write(&path, b"corrupt").unwrap();
        store
            .install_object(&hash, 7, &mut &b"correct"[..])
            .unwrap();
        assert_eq!(fs::read(path).unwrap(), b"correct");
    }

    #[test]
    fn rollback_advances_activation_without_rewinding_upstream() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let first = digest(b"first");
        let second = digest(b"second");
        install(dir.path(), "oslo", &first);
        install(dir.path(), "oslo", &second);
        assert!(store.activate_validated("oslo", &first, 1).unwrap());
        assert!(!store.activate_validated("oslo", &first, 1).unwrap());
        assert!(store.activate_validated("oslo", &second, 2).unwrap());
        let rollback = store.rollback("oslo").unwrap();
        assert_eq!(rollback.release, first);
        assert_eq!(rollback.revision, 3);
        assert_eq!(rollback.catalog_sequence, 2);
        assert!(rollback.pinned);
        assert!(!store.activate_validated("oslo", &second, 2).unwrap());
        assert!(store.activate_validated("oslo", &first, 1).is_err());
        store.set_pinned("oslo", false).unwrap();
        assert!(store.activate_validated("oslo", &second, 2).unwrap());
        assert_eq!(store.status("oslo").unwrap().unwrap().revision, 4);
    }
    #[test]
    fn restart_cleans_only_interrupted_staging_after_acquiring_writer_lock() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let hash = digest(b"interrupted");
        let mut stale = Vec::new();
        for parent in ["cities/oslo", "public/releases", "public/poi"] {
            let path = dir.path().join(parent).join(format!(".staging-{hash}"));
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("partial"), b"partial").unwrap();
            stale.push(path);
        }
        for parent in ["state", "public/current", "objects/sha256"] {
            let parent = dir.path().join(parent);
            fs::create_dir_all(&parent).unwrap();
            let filename = if parent.ends_with("sha256") {
                format!("{hash}.part")
            } else {
                "oslo.json.part".into()
            };
            let path = parent.join(filename);
            fs::write(&path, b"partial").unwrap();
            stale.push(path);
        }
        let retained = dir.path().join("public/releases").join(&hash);
        fs::create_dir_all(&retained).unwrap();
        fs::write(retained.join("manifest.json"), b"retained").unwrap();
        let unrelated = dir.path().join("public/releases/.staging-operator-note");
        fs::write(&unrelated, b"keep").unwrap();
        assert!(Store::open(dir.path()).is_err());
        assert!(stale.iter().all(|path| path.exists()));
        drop(store);
        let _store = Store::open(dir.path()).unwrap();
        assert!(stale.iter().all(|path| !path.exists()));
        assert_eq!(
            fs::read(retained.join("manifest.json")).unwrap(),
            b"retained"
        );
        assert!(unrelated.exists());
    }

    #[test]
    fn refresh_health_survives_restart_and_preserves_last_success_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        assert!(store
            .operational_status("oslo", 100)
            .unwrap()
            .activation
            .is_none());
        store.record_refresh("oslo", 100, None).unwrap();
        store.record_refresh("oslo", 200, Some("offline")).unwrap();
        drop(store);
        let store = Store::open(dir.path()).unwrap();
        let status = store.operational_status("oslo", 300).unwrap();
        assert!(status.source_snapshot_at.is_none());
        let refresh = status.refresh.unwrap();
        assert_eq!(refresh.checked_at, 200);
        assert_eq!(refresh.last_success_at, Some(100));
        assert_eq!(refresh.error.as_deref(), Some("offline"));
        store.record_refresh("oslo", 400, None).unwrap();
        assert!(store
            .refresh_status("oslo")
            .unwrap()
            .unwrap()
            .error
            .is_none());
        assert!(store.record_refresh("../escape", 400, None).is_err());
    }

    #[test]
    fn lock_excludes_another_writer_and_is_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let first = Store::open(dir.path()).unwrap();
        assert!(Store::open(dir.path()).is_err());
        drop(first);
        assert!(Store::open(dir.path()).is_ok());
    }
    #[test]
    fn failed_activation_keeps_current_and_cities_are_independent() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let id = digest(b"installed");
        install(dir.path(), "oslo", &id);
        store.activate_validated("oslo", &id, 1).unwrap();
        let before = store.status("oslo").unwrap();
        assert!(store
            .activate_validated("oslo", &digest(b"absent"), 2)
            .is_err());
        assert_eq!(store.status("oslo").unwrap(), before);
        assert!(store.status("tbilisi").unwrap().is_none());
        assert!(store.status("../oslo").is_err());
    }
}
