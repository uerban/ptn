//! Signed transit download -> native validation -> atomic local activation.
//! Transit has its own locked subtree; OSM extras remain independently managed.
use crate::{
    install::Repository,
    store::{atomic_json, durable_mkdir, Store},
    transit_catalog::{self, Checkpoint},
    transit_export, transit_native,
};
use pt_shared::{
    fsync,
    osm_manifest::{digest, valid_digest},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    os::fd::AsFd,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub selection: String,
    pub pack_id: String,
    pub generation_id: String,
    pub geometry_selected: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Activation {
    pub schema_version: u32,
    pub revision: u64,
    pub current: Release,
    pub previous: Option<Release>,
    pub checkpoint: Checkpoint,
    pub pinned: bool,
}
pub struct Policy {
    pub geometry: bool,
    pub max_file_bytes: u64,
    pub max_selected_bytes: u64,
    pub max_files: usize,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            geometry: true,
            max_file_bytes: 4 * 1024 * 1024 * 1024,
            max_selected_bytes: 8 * 1024 * 1024 * 1024,
            max_files: 100_000,
        }
    }
}
pub struct TransitStore {
    store: Store,
}
fn invalid(message: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}
fn city_slug(city: &str) -> io::Result<&str> {
    if city.is_empty()
        || city.len() > 64
        || !city
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(invalid("invalid transit city"));
    }
    Ok(city)
}
fn metadata(
    repository: &(impl Repository + ?Sized),
    path: &str,
    limit: u64,
) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    repository
        .open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid("transit metadata exceeds limit"));
    }
    Ok(bytes)
}
fn write_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = File::create(path)?;
    file.write_all(bytes)?;
    fsync::durable(file.as_fd())
}
fn wall_time(now: i64) -> io::Result<SystemTime> {
    UNIX_EPOCH
        .checked_add(Duration::from_secs(
            now.try_into().map_err(|_| invalid("invalid clock"))?,
        ))
        .ok_or_else(|| invalid("invalid clock"))
}
fn valid_release(release: &Release) -> bool {
    valid_digest(&release.selection)
        && valid_digest(&release.pack_id)
        && valid_digest(&release.generation_id)
}
impl TransitStore {
    /// `root/transit` is exclusively managed by this installer. Never point it
    /// at a producer's mutable tree. Opening acquires the writer lock and
    /// cleans only owned interrupted staging names.
    pub fn open(root: &Path) -> io::Result<Self> {
        Ok(Self {
            store: Store::open(&root.join("transit"))?,
        })
    }
    fn state_path(&self, city: &str) -> io::Result<PathBuf> {
        Ok(self
            .store
            .root
            .join("state")
            .join(format!("transit-{}.json", city_slug(city)?)))
    }
    fn city_root(&self, city: &str) -> io::Result<PathBuf> {
        Ok(self.store.root.join("cities").join(city_slug(city)?))
    }
    pub fn release_path(&self, city: &str, release: &Release) -> io::Result<PathBuf> {
        if !valid_release(release) {
            return Err(invalid("invalid transit release"));
        }
        Ok(self
            .city_root(city)?
            .join("releases")
            .join(&release.selection)
            .join("files"))
    }
    pub fn status(&self, city: &str) -> io::Result<Option<Activation>> {
        let path = self.state_path(city)?;
        let file = match File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let mut bytes = Vec::new();
        file.take(64 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 64 * 1024 {
            return Err(invalid("transit activation exceeds limit"));
        }
        let state: Activation = serde_json::from_slice(&bytes).map_err(invalid)?;
        if state.schema_version != 1
            || state.revision == 0
            || !valid_release(&state.current)
            || state
                .previous
                .as_ref()
                .is_some_and(|p| !valid_release(p) || p == &state.current)
            || state.checkpoint.sequence == 0
            || !valid_digest(&state.checkpoint.sha256)
        {
            return Err(invalid("invalid transit activation"));
        }
        Ok(Some(state))
    }
    pub fn set_pinned(&self, city: &str, pinned: bool) -> io::Result<()> {
        let mut state = self
            .status(city)?
            .ok_or_else(|| invalid("transit city is not installed"))?;
        if state.pinned != pinned {
            state.revision = state
                .revision
                .checked_add(1)
                .ok_or_else(|| invalid("revision overflow"))?;
            state.pinned = pinned;
            atomic_json(&self.state_path(city)?, &state)?;
        }
        Ok(())
    }
    fn validate_installed(
        &self,
        city: &str,
        release: &Release,
        keys: &[[u8; 32]],
        now: SystemTime,
    ) -> io::Result<()> {
        let files = self.release_path(city, release)?;
        let root = files.parent().expect("release root");
        let repository = crate::install::LocalRepository(root.into());
        let bytes = metadata(
            &repository,
            "selection.json",
            transit_export::MAX_DESCRIPTOR_BYTES as u64,
        )?;
        let sig = metadata(&repository, "selection.json.sig", 64)?;
        if digest(&bytes) != release.selection {
            return Err(invalid("installed selection hash mismatch"));
        }
        let inventory = transit_export::verify(&bytes, &sig, keys, city)?;
        if inventory.pack_id != release.pack_id
            || inventory.generation_id != release.generation_id
            || inventory.geometry_selected != release.geometry_selected
        {
            return Err(invalid("installed selection identity mismatch"));
        }
        let actual = transit_native::validate(&files, release.geometry_selected, now)?;
        if serde_json::to_value(&actual).map_err(invalid)?
            != serde_json::to_value(&inventory).map_err(invalid)?
        {
            return Err(invalid("installed files do not match selection"));
        }
        Ok(())
    }
    /// Validate the local current selection without contacting a source. Head
    /// expiry never prevents offline use or a deliberate local rollback.
    pub fn validate_current(&self, city: &str, keys: &[[u8; 32]], now: i64) -> io::Result<PathBuf> {
        let state = self
            .status(city)?
            .ok_or_else(|| invalid("transit city is not installed"))?;
        self.validate_installed(city, &state.current, keys, wall_time(now)?)?;
        self.release_path(city, &state.current)
    }
    pub fn rollback(&self, city: &str, keys: &[[u8; 32]], now: i64) -> io::Result<()> {
        let mut state = self
            .status(city)?
            .ok_or_else(|| invalid("transit city is not installed"))?;
        let target = state
            .previous
            .take()
            .ok_or_else(|| invalid("no previous transit release"))?;
        self.validate_installed(city, &target, keys, wall_time(now)?)?;
        state.previous = Some(std::mem::replace(&mut state.current, target));
        state.revision = state
            .revision
            .checked_add(1)
            .ok_or_else(|| invalid("revision overflow"))?;
        state.pinned = true; // Explicit unpin before a later upstream update.
        atomic_json(&self.state_path(city)?, &state)
    }
    pub fn sync(
        &self,
        repository: &(impl Repository + ?Sized),
        city: &str,
        keys: &[[u8; 32]],
        now: i64,
        policy: &Policy,
    ) -> io::Result<bool> {
        let previous = self.status(city)?; // Validates city before any URL is built.
        if previous.as_ref().is_some_and(|p| p.pinned) {
            return Ok(false);
        }
        let time = wall_time(now)?;
        let head = format!("transit/catalog/v1/{city}/latest.json");
        let bytes = metadata(repository, &head, transit_catalog::MAX_CATALOG_BYTES as u64)?;
        let sig = metadata(repository, &format!("{head}.sig"), 64)?;
        let catalog = transit_catalog::verify(
            &bytes,
            &sig,
            keys,
            city,
            previous.as_ref().map(|p| &p.checkpoint),
            now,
        )
        .map_err(invalid)?;
        let selected = catalog
            .selections
            .iter()
            .find(|s| s.geometry_selected == policy.geometry)
            .ok_or_else(|| invalid("requested transit geometry selection unavailable"))?;
        let prefix = format!("transit/selections/{}", selected.sha256);
        let selection = metadata(
            repository,
            &format!("{prefix}/selection.json"),
            selected.bytes,
        )?;
        let selection_sig = metadata(repository, &format!("{prefix}/selection.json.sig"), 64)?;
        let inventory = transit_catalog::verify_selection(
            &catalog,
            &selection,
            &selection_sig,
            keys,
            policy.geometry,
        )
        .map_err(invalid)?;
        if inventory.files.len() > policy.max_files
            || inventory.selected_bytes > policy.max_selected_bytes
            || inventory.files.iter().any(|f| {
                f.size_bytes == 0
                    || f.size_bytes > policy.max_file_bytes
                    || f.size_bytes > pt_shared::osm_manifest::MAX_OBJECT_BYTES
            })
        {
            return Err(invalid("transit selection exceeds local resource policy"));
        }
        let release = Release {
            selection: selected.sha256.clone(),
            pack_id: inventory.pack_id.clone(),
            generation_id: inventory.generation_id.clone(),
            geometry_selected: policy.geometry,
        };
        let city_root = self.city_root(city)?;
        let final_root = city_root.join("releases").join(&release.selection);
        if !final_root.exists() {
            let staging = city_root.join(format!(".staging-{}", release.selection));
            durable_mkdir(&staging.join("files"))?;
            let result = (|| {
                for artifact in &inventory.files {
                    let object = match self
                        .store
                        .cached_object(&artifact.sha256, artifact.size_bytes)?
                    {
                        Some(path) => path,
                        None => self.store.install_object(
                            &artifact.sha256,
                            artifact.size_bytes,
                            &mut repository
                                .open(&format!("transit/objects/sha256/{}", artifact.sha256))?,
                        )?,
                    };
                    let destination = staging.join("files").join(&artifact.path);
                    durable_mkdir(destination.parent().expect("artifact parent"))?;
                    // Copy rather than hard-link: cache repair or later local
                    // release corruption must not mutate another generation.
                    fs::copy(object, &destination)?;
                    fsync::durable(File::open(&destination)?.as_fd())?;
                    fsync::durable_dir(File::open(destination.parent().unwrap())?.as_fd())?;
                }
                write_file(&staging.join("selection.json"), &selection)?;
                write_file(&staging.join("selection.json.sig"), &selection_sig)?;
                let actual =
                    transit_native::validate(&staging.join("files"), policy.geometry, time)?;
                if serde_json::to_value(&actual).map_err(invalid)?
                    != serde_json::to_value(&inventory).map_err(invalid)?
                {
                    return Err(invalid("downloaded files do not match signed selection"));
                }
                fsync::durable_dir(File::open(&staging)?.as_fd())?;
                durable_mkdir(final_root.parent().unwrap())?;
                fs::rename(&staging, &final_root)?;
                fsync::durable_dir(File::open(final_root.parent().unwrap())?.as_fd())?;
                Ok(())
            })();
            if result.is_err() {
                let _ = fs::remove_dir_all(&staging);
            }
            result?;
        }
        // Includes the retry-after-crash case: a complete immutable tree may
        // exist even though the atomic activation never happened.
        self.validate_installed(city, &release, keys, time)?;
        let checkpoint = Checkpoint {
            sequence: catalog.sequence,
            sha256: digest(&bytes),
        };
        if previous.as_ref().is_some_and(|p| {
            p.current == release
                && p.checkpoint.sequence == checkpoint.sequence
                && p.checkpoint.sha256 == checkpoint.sha256
        }) {
            return Ok(false);
        }
        let prior = previous.as_ref().and_then(|p| {
            if p.current == release {
                p.previous.clone()
            } else {
                Some(p.current.clone())
            }
        });
        let state = Activation {
            schema_version: 1,
            revision: previous
                .as_ref()
                .map_or(Some(1), |p| p.revision.checked_add(1))
                .ok_or_else(|| invalid("revision overflow"))?,
            current: release,
            previous: prior,
            checkpoint,
            pinned: false,
        };
        atomic_json(&self.state_path(city)?, &state)?;
        Ok(true)
    }
}
