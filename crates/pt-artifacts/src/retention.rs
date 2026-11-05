//! Consumer-aware pruning of immutable releases.
//!
//! A city release is retained while it is current, previous, a source of the
//! active POI composition, held by a consumer lease, or unreferenced for less
//! than the configured grace period. The grace period bounds how long a browser
//! that discovered an immutable URL may keep fetching it after activation moved
//! on. Composite POI releases follow the same lease and grace rules. Pruning runs inside
//! the single writer lock, defers when any consumer is resolving, and moves a
//! release to a `.staging-*` name before deleting it so a crash leaves only
//! leftovers that restart cleanup already reclaims.
use crate::store::{durable_mkdir, Store};
use pt_shared::{artifact_lease::CollectionGuard, fsync, osm_manifest::valid_digest};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct Policy {
    pub grace_seconds: u64,
    pub lease_root: PathBuf,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub deferred: bool,
    pub releases_removed: Vec<String>,
    pub compositions_removed: Vec<String>,
    pub objects_removed: usize,
}

/// first-unreferenced-at per identity, persisted so grace survives restarts.
type Ledger = BTreeMap<String, i64>;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn read_ledger(path: &Path) -> io::Result<Ledger> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| invalid(&e.to_string())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Ledger::new()),
        Err(e) => Err(e),
    }
}

fn write_ledger(path: &Path, ledger: &Ledger) -> io::Result<()> {
    durable_mkdir(path.parent().unwrap())?;
    crate::store::atomic_json(path, ledger)
}

fn child_digests(path: &Path) -> io::Result<Vec<String>> {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str().filter(|n| valid_digest(n)) {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}

/// Rename into the restart-reclaimed staging namespace, then delete.
/// `staging_parent` must be a directory restart cleanup scans for `.staging-*`.
fn retire_directory(parent: &Path, name: &str, staging_parent: &Path) -> io::Result<()> {
    let target = parent.join(name);
    if !target.exists() {
        return Ok(());
    }
    let staged = staging_parent.join(format!(".staging-{name}"));
    if staged.exists() {
        fs::remove_dir_all(&staged)?;
    }
    fs::rename(&target, &staged)?;
    fsync::durable_dir(File::open(parent)?.as_fd())?;
    if staging_parent != parent {
        fsync::durable_dir(File::open(staging_parent)?.as_fd())?;
    }
    fs::remove_dir_all(&staged)
}

/// Decide which unreferenced identities are past grace, updating the ledger.
/// A clock that moved backwards never makes anything eligible.
fn expired(
    ledger: &mut Ledger,
    unreferenced: &BTreeSet<String>,
    held: &BTreeSet<String>,
    now: i64,
    grace: u64,
) -> Vec<String> {
    ledger.retain(|id, _| unreferenced.contains(id));
    let mut eligible = Vec::new();
    for id in unreferenced {
        let since = *ledger.entry(id.clone()).or_insert(now);
        let age = now.saturating_sub(since);
        if age >= 0 && age as u64 >= grace && !held.contains(id) {
            eligible.push(id.clone());
        }
    }
    eligible
}

fn active_composition(root: &Path) -> io::Result<(Option<String>, BTreeMap<String, String>)> {
    let current = root.join("public/poi/current");
    let identity = match fs::read_link(&current) {
        Ok(target) => target
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| valid_digest(n))
            .map(str::to_owned)
            .ok_or_else(|| invalid("unexpected POI current target"))?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((None, BTreeMap::new())),
        Err(e) => return Err(e),
    };
    let bytes = fs::read(current.join("manifest.json"))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| invalid(&e.to_string()))?;
    let sources = serde_json::from_value(value["deployment"]["sources"].clone())
        .map_err(|e| invalid(&e.to_string()))?;
    Ok((Some(identity), sources))
}

fn installed_object_references(root: &Path) -> io::Result<BTreeSet<String>> {
    let mut referenced = BTreeSet::new();
    let cities = match fs::read_dir(root.join("cities")) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(referenced),
        Err(e) => return Err(e),
    };
    for city in cities {
        let releases = city?.path().join("releases");
        for release in child_digests(&releases)? {
            let bytes = fs::read(releases.join(release).join("manifest.json"))?;
            // Unreadable metadata aborts pruning rather than risking deletion.
            let manifest: Value =
                serde_json::from_slice(&bytes).map_err(|e| invalid(&e.to_string()))?;
            if let Some(components) = manifest["components"].as_object() {
                referenced.extend(
                    components
                        .values()
                        .filter_map(|c| c["sha256"].as_str())
                        .filter(|h| valid_digest(h))
                        .map(str::to_owned),
                );
            }
        }
    }
    Ok(referenced)
}

impl Store {
    /// Prune releases of the enabled `cities`. Disabled cities keep their data
    /// so re-enabling them needs no download and an operator can inspect them.
    pub fn prune(&self, cities: &[&str], policy: &Policy, now: i64) -> io::Result<Report> {
        let guard = match CollectionGuard::try_acquire(&policy.lease_root) {
            Ok(guard) => guard,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                return Ok(Report {
                    deferred: true,
                    ..Report::default()
                })
            }
            Err(e) => return Err(e),
        };
        let mut report = Report::default();
        let (composition, poi_sources) = active_composition(&self.root)?;
        let ledgers = self.root.join("state/retention");

        for city in cities {
            let mut keep = BTreeSet::new();
            if let Some(state) = self.status(city)? {
                keep.insert(state.release);
                keep.extend(state.previous_release);
            }
            keep.extend(poi_sources.get(*city).cloned());
            let releases = self.root.join("cities").join(city).join("releases");
            let mut unreferenced = BTreeSet::new();
            let mut held = BTreeSet::new();
            for release in child_digests(&releases)? {
                if keep.contains(&release) {
                    continue;
                }
                if guard.is_live(&release)? {
                    held.insert(release.clone());
                }
                unreferenced.insert(release);
            }
            let ledger_path = ledgers.join(format!("{city}.json"));
            let mut ledger = read_ledger(&ledger_path)?;
            let eligible = expired(&mut ledger, &unreferenced, &held, now, policy.grace_seconds);
            write_ledger(&ledger_path, &ledger)?;
            for release in eligible {
                let public = self.root.join("public/releases");
                retire_directory(&public, &release, &public)?;
                retire_directory(&releases, &release, releases.parent().unwrap())?;
                ledger.remove(&release);
                report.releases_removed.push(release);
            }
            write_ledger(&ledger_path, &ledger)?;
        }

        let compositions = self.root.join("public/poi/releases");
        let unreferenced: BTreeSet<_> = child_digests(&compositions)?
            .into_iter()
            .filter(|id| Some(id) != composition.as_ref())
            .collect();
        // pt-serve leases the composition it serves, including a snapshot it
        // retains after rejecting a newer one.
        let mut held = BTreeSet::new();
        for identity in &unreferenced {
            if guard.is_live(identity)? {
                held.insert(identity.clone());
            }
        }
        let ledger_path = ledgers.join("poi.json");
        let mut ledger = read_ledger(&ledger_path)?;
        let eligible = expired(&mut ledger, &unreferenced, &held, now, policy.grace_seconds);
        write_ledger(&ledger_path, &ledger)?;
        for identity in eligible {
            retire_directory(&compositions, &identity, compositions.parent().unwrap())?;
            ledger.remove(&identity);
            report.compositions_removed.push(identity);
        }
        write_ledger(&ledger_path, &ledger)?;

        // Some components (POI) are unpacked rather than hard-linked, so the
        // link count alone cannot prove an object unused: keep anything an
        // installed manifest (any city, enabled or not) still names.
        let referenced = installed_object_references(&self.root)?;
        let objects = self.root.join("objects/sha256");
        if let Ok(entries) = fs::read_dir(&objects) {
            for entry in entries {
                let entry = entry?;
                let name = entry.file_name();
                let Some(name) = name.to_str().filter(|n| valid_digest(n)) else {
                    continue;
                };
                let metadata = entry.metadata()?;
                if metadata.is_file() && metadata.nlink() == 1 && !referenced.contains(name) {
                    fs::remove_file(objects.join(name))?;
                    report.objects_removed += 1;
                }
            }
            if report.objects_removed > 0 {
                fsync::durable_dir(File::open(&objects)?.as_fd())?;
            }
        }
        drop(guard);
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pt_shared::{artifact_lease::ResolutionGuard, osm_manifest::digest};

    struct Fixture {
        dir: tempfile::TempDir,
        store: Store,
        policy: Policy,
    }

    fn fixture(grace: u64) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("root")).unwrap();
        let policy = Policy {
            grace_seconds: grace,
            lease_root: dir.path().join("leases"),
        };
        Fixture { dir, store, policy }
    }

    /// Installs a release whose private and public files hard-link one object.
    fn install(store: &Store, city: &str, name: &str) -> String {
        let id = digest(name.as_bytes());
        let object = store
            .root
            .join("objects/sha256")
            .join(digest(id.as_bytes()));
        fs::create_dir_all(object.parent().unwrap()).unwrap();
        fs::write(&object, name).unwrap();
        for dir in [
            store
                .root
                .join("cities")
                .join(city)
                .join("releases")
                .join(&id),
            store.root.join("public/releases").join(&id),
        ] {
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("manifest.json"), b"{}").unwrap();
            fs::hard_link(&object, dir.join("payload")).unwrap();
        }
        id
    }

    fn activate(store: &Store, city: &str, release: &str, previous: Option<&str>, revision: u64) {
        let state = serde_json::json!({
            "schemaVersion":1,"revision":revision,"release":release,
            "previousRelease":previous,"catalogSequence":revision,
            "catalogManifest":release,"pinned":false
        });
        let path = store
            .root
            .join("public/current")
            .join(format!("{city}.json"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec(&state).unwrap()).unwrap();
    }

    fn exists(store: &Store, city: &str, id: &str) -> bool {
        let private = store
            .root
            .join("cities")
            .join(city)
            .join("releases")
            .join(id);
        let public = store.root.join("public/releases").join(id);
        assert_eq!(private.exists(), public.exists());
        private.exists()
    }

    #[test]
    fn keeps_current_previous_and_grace_then_prunes_with_objects() {
        let f = fixture(100);
        let [a, b, c] = ["a", "b", "c"].map(|n| install(&f.store, "vilnius", n));
        activate(&f.store, "vilnius", &c, Some(&b), 3);

        let first = f.store.prune(&["vilnius"], &f.policy, 1_000).unwrap();
        assert!(first.releases_removed.is_empty());
        assert!(exists(&f.store, "vilnius", &a));

        let early = f.store.prune(&["vilnius"], &f.policy, 1_099).unwrap();
        assert!(early.releases_removed.is_empty());

        let late = f.store.prune(&["vilnius"], &f.policy, 1_100).unwrap();
        assert_eq!(late.releases_removed, vec![a.clone()]);
        assert_eq!(late.objects_removed, 1);
        assert!(!exists(&f.store, "vilnius", &a));
        assert!(exists(&f.store, "vilnius", &b) && exists(&f.store, "vilnius", &c));
        let objects = fs::read_dir(f.store.root.join("objects/sha256"))
            .unwrap()
            .count();
        assert_eq!(objects, 2);
        drop(f.dir);
    }

    #[test]
    fn live_lease_and_busy_resolution_protect_consumers() {
        let f = fixture(0);
        let [a, b, c] = ["a", "b", "c"].map(|n| install(&f.store, "vilnius", n));
        activate(&f.store, "vilnius", &c, Some(&b), 3);

        let resolving = ResolutionGuard::acquire(&f.policy.lease_root).unwrap();
        let deferred = f.store.prune(&["vilnius"], &f.policy, 10).unwrap();
        assert!(deferred.deferred);
        let lease = resolving.pin(&a).unwrap();
        drop(resolving);

        let held = f.store.prune(&["vilnius"], &f.policy, 10).unwrap();
        assert!(held.releases_removed.is_empty());
        assert!(exists(&f.store, "vilnius", &a));

        drop(lease);
        let freed = f.store.prune(&["vilnius"], &f.policy, 10).unwrap();
        assert_eq!(freed.releases_removed, vec![a]);
    }

    #[test]
    fn rereferenced_release_restarts_grace_and_backward_clock_never_prunes() {
        let f = fixture(100);
        let [a, b, c] = ["a", "b", "c"].map(|n| install(&f.store, "vilnius", n));
        activate(&f.store, "vilnius", &c, Some(&b), 3);
        f.store.prune(&["vilnius"], &f.policy, 1_000).unwrap();
        // Rollback-like move re-references `a`, then it becomes unreferenced again.
        activate(&f.store, "vilnius", &a, Some(&c), 4);
        f.store.prune(&["vilnius"], &f.policy, 1_050).unwrap();
        activate(&f.store, "vilnius", &c, Some(&b), 5);
        let r = f.store.prune(&["vilnius"], &f.policy, 1_120).unwrap();
        assert!(r.releases_removed.is_empty(), "grace restarted at 1_120");
        let back = f.store.prune(&["vilnius"], &f.policy, 0).unwrap();
        assert!(back.releases_removed.is_empty());
        assert!(exists(&f.store, "vilnius", &a));
    }

    #[test]
    fn poi_sources_and_disabled_cities_are_retained() {
        let f = fixture(0);
        let [a, b, c] = ["a", "b", "c"].map(|n| install(&f.store, "vilnius", n));
        activate(&f.store, "vilnius", &c, Some(&b), 3);
        let other = install(&f.store, "krakow", "k");

        let poi = f.store.root.join("public/poi");
        let [old, cur] = [digest(b"old"), digest(b"cur")];
        for id in [&old, &cur] {
            let dir = poi.join("releases").join(id);
            fs::create_dir_all(&dir).unwrap();
            let body = serde_json::json!({"deployment":{"sources":{"vilnius":a}}});
            fs::write(dir.join("manifest.json"), body.to_string()).unwrap();
        }
        std::os::unix::fs::symlink(format!("releases/{cur}"), poi.join("current")).unwrap();

        let r = f.store.prune(&["vilnius"], &f.policy, 10).unwrap();
        assert!(
            r.releases_removed.is_empty(),
            "a feeds the active POI composition"
        );
        assert_eq!(r.compositions_removed, vec![old]);
        assert!(poi.join("releases").join(&cur).exists());
        assert!(exists(&f.store, "krakow", &other));
    }

    #[test]
    fn leased_poi_composition_outlives_its_grace() {
        let f = fixture(0);
        let a = install(&f.store, "vilnius", "a");
        activate(&f.store, "vilnius", &a, None, 1);
        let poi = f.store.root.join("public/poi");
        let [old, cur] = [digest(b"old"), digest(b"cur")];
        for id in [&old, &cur] {
            let dir = poi.join("releases").join(id);
            fs::create_dir_all(&dir).unwrap();
            let body = serde_json::json!({"deployment":{"sources":{"vilnius":a}}});
            fs::write(dir.join("manifest.json"), body.to_string()).unwrap();
        }
        std::os::unix::fs::symlink(format!("releases/{cur}"), poi.join("current")).unwrap();

        // pt-serve still serves `old` (for example a retained snapshot).
        let resolving = ResolutionGuard::acquire(&f.policy.lease_root).unwrap();
        let lease = resolving.pin(&old).unwrap();
        drop(resolving);
        let held = f.store.prune(&["vilnius"], &f.policy, 10).unwrap();
        assert!(held.compositions_removed.is_empty());
        assert!(poi.join("releases").join(&old).exists());

        drop(lease);
        let freed = f.store.prune(&["vilnius"], &f.policy, 10).unwrap();
        assert_eq!(freed.compositions_removed, vec![old]);
    }

    #[test]
    fn unpacked_component_objects_named_by_a_release_are_kept() {
        let f = fixture(0);
        let a = install(&f.store, "vilnius", "a");
        activate(&f.store, "vilnius", &a, None, 1);
        let poi = digest(b"poi object");
        let objects = f.store.root.join("objects/sha256");
        fs::write(objects.join(&poi), b"poi").unwrap();
        let orphan = digest(b"orphan");
        fs::write(objects.join(&orphan), b"orphan").unwrap();
        let manifest = serde_json::json!({"components":{"poi":{"status":"present","sha256":poi}}});
        let path = f
            .store
            .root
            .join("cities/vilnius/releases")
            .join(&a)
            .join("manifest.json");
        fs::write(path, manifest.to_string()).unwrap();
        let r = f.store.prune(&["vilnius"], &f.policy, 10).unwrap();
        assert_eq!(r.objects_removed, 1);
        assert!(objects.join(&poi).exists() && !objects.join(&orphan).exists());
    }

    #[test]
    fn interrupted_retirement_is_reclaimed_on_restart() {
        let f = fixture(0);
        let a = install(&f.store, "vilnius", "a");
        let city = f.store.root.join("cities/vilnius");
        let staged = city.join(format!(".staging-{a}"));
        fs::rename(city.join("releases").join(&a), &staged).unwrap();
        let root = f.store.root.clone();
        drop(f.store);
        let _reopened = Store::open(&root).unwrap();
        assert!(!staged.exists());
    }
}
