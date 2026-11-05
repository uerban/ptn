//! Signed repository -> validated immutable release -> one atomic activation.
use crate::{
    catalog, native,
    store::{durable_mkdir, Store},
};
use pt_shared::{
    fsync,
    osm_manifest::{digest, object_path, Component, OsmManifest},
};
use std::{
    fs::{self, File},
    io::{self, Read},
    os::fd::AsFd,
    path::{Path, PathBuf},
};

fn invalid(message: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

pub trait Repository {
    fn open(&self, relative: &str) -> io::Result<Box<dyn Read>>;
}

pub struct LocalRepository(pub PathBuf);
impl Repository for LocalRepository {
    fn open(&self, relative: &str) -> io::Result<Box<dyn Read>> {
        if Path::new(relative)
            .components()
            .any(|p| !matches!(p, std::path::Component::Normal(_)))
        {
            return Err(invalid("unsafe repository path"));
        }
        Ok(Box::new(File::open(self.0.join(relative))?))
    }
}

fn metadata(repository: &impl Repository, path: &str, limit: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    repository
        .open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid("metadata size limit"));
    }
    Ok(bytes)
}

pub fn sync(
    store: &Store,
    repository: &impl Repository,
    city: &str,
    keys: &[[u8; 32]],
    now: i64,
    required: &[&str],
) -> io::Result<bool> {
    // Validate the city before interpolating it into any remote path.
    let previous = store.status(city)?;
    if previous.as_ref().is_some_and(|p| p.pinned) {
        return Ok(false);
    }
    let head = format!("catalog/v1/{city}/latest.json");
    let bytes = metadata(repository, &head, catalog::MAX_METADATA_BYTES as u64)?;
    let signature = metadata(repository, &format!("{head}.sig"), 64)?;
    let catalog = catalog::verify(
        &bytes,
        &signature,
        keys,
        city,
        previous.as_ref().map_or(0, |p| p.catalog_sequence),
        now,
    )
    .map_err(invalid)?;
    if let Some(previous) = &previous {
        if catalog.sequence == previous.catalog_sequence
            && catalog.manifest_sha256 != previous.catalog_manifest
        {
            return Err(invalid("catalog equivocation"));
        }
    }
    let manifest_bytes = metadata(
        repository,
        &format!("releases/{}/manifest.json", catalog.manifest_sha256),
        catalog.manifest_bytes,
    )?;
    if manifest_bytes.len() as u64 != catalog.manifest_bytes
        || digest(&manifest_bytes) != catalog.manifest_sha256
    {
        return Err(invalid("manifest checksum mismatch"));
    }
    let manifest: OsmManifest = serde_json::from_slice(&manifest_bytes).map_err(invalid)?;
    manifest.validate(city).map_err(invalid)?;
    for name in required {
        if !matches!(
            manifest.components.get(*name),
            Some(Component::Present { .. })
        ) {
            return Err(invalid(format!("required component unavailable: {name}")));
        }
    }

    let city_root = store.root.join("cities").join(city);
    let staging = city_root.join(format!(".staging-{}", catalog.manifest_sha256));
    let public_root = store.root.join("public/releases");
    let public_staging = public_root.join(format!(".staging-{}", catalog.manifest_sha256));
    let final_private = city_root.join("releases").join(&catalog.manifest_sha256);
    let final_public = public_root.join(&catalog.manifest_sha256);
    // Locked Store owns these paths. Crash leftovers are never considered releases.
    for path in [&staging, &public_staging] {
        if path.exists() {
            fs::remove_dir_all(path)?;
        }
        durable_mkdir(path)?;
    }
    let result = (|| {
        durable_mkdir(&staging.join("private"))?;
        for (name, component) in &manifest.components {
            let Component::Present {
                sha256,
                bytes,
                decoded_bytes,
                compression,
                ..
            } = component
            else {
                continue;
            };
            let object = if let Some(path) = store.cached_object(sha256, *bytes)? {
                path
            } else {
                let mut source = repository.open(&object_path(sha256).map_err(invalid)?)?;
                store.install_object(sha256, *bytes, &mut source)?
            };
            let decoded = staging.join(format!("{name}.decoded"));
            native::decode_to(&object, &decoded, *compression, *decoded_bytes)?;
            native::validate(name, city, &decoded, &public_staging.join("poi"))?;
            match name.as_str() {
                "walking" => {
                    fs::hard_link(&object, staging.join("private/walking.geojsonseq.gz"))?;
                }
                "addresses" => {
                    fs::hard_link(&object, staging.join("private/address-search.fst"))?;
                }
                "walkGraph" => {
                    fs::hard_link(&object, public_staging.join("walk-graph.ptwg.br"))?;
                }
                "poi" => {}
                _ => unreachable!(),
            }
            fs::remove_file(decoded)?;
        }
        fs::write(staging.join("manifest.json"), &manifest_bytes)?;
        fs::write(public_staging.join("manifest.json"), &manifest_bytes)?;
        durable_tree(&staging)?;
        durable_tree(&public_staging)?;
        durable_mkdir(final_private.parent().unwrap())?;
        install_directory(&staging, &final_private, &city_root)?;
        install_directory(&public_staging, &final_public, &public_root)?;
        store.activate_validated(city, &catalog.manifest_sha256, catalog.sequence)
    })();
    for path in [&staging, &public_staging] {
        if path.exists() {
            let _ = fs::remove_dir_all(path);
        }
    }
    result
}

/// `aside_parent` must be a directory restart cleanup scans for `.staging-*`.
fn install_directory(staged: &Path, target: &Path, aside_parent: &Path) -> io::Result<()> {
    if target.exists() {
        // Reuse only a byte-identical immutable release.
        if same_tree(staged, target).is_err() {
            // The staged copy just passed checksum and native validation, so a
            // mismatch means the installed copy rotted (objects are hard-linked,
            // so cache corruption reaches it). Swap it out; readers holding open
            // files keep their inodes. Never leaves corrupt bytes being served.
            let name = target
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            let aside = aside_parent.join(format!(
                ".staging-{}",
                pt_shared::osm_manifest::digest(format!("repair:{name}").as_bytes())
            ));
            if aside.exists() {
                fs::remove_dir_all(&aside)?;
            }
            fs::rename(target, &aside)?;
            fs::rename(staged, target)?;
            fsync::durable_dir(File::open(target.parent().unwrap())?.as_fd())?;
            fsync::durable_dir(File::open(aside_parent)?.as_fd())?;
            eprintln!("repaired corrupt installed release {name}");
            return fs::remove_dir_all(aside);
        }
        fs::remove_dir_all(staged)?;
    } else {
        fs::rename(staged, target)?;
    }
    fsync::durable_dir(File::open(target.parent().unwrap())?.as_fd())
}

fn same_tree(left: &Path, right: &Path) -> io::Result<()> {
    let names = |path: &Path| -> io::Result<std::collections::BTreeSet<std::ffi::OsString>> {
        fs::read_dir(path)?
            .map(|entry| entry.map(|e| e.file_name()))
            .collect()
    };
    let inventory = names(left)?;
    if inventory != names(right)? {
        return Err(invalid("immutable release inventory mismatch"));
    }
    for name in inventory {
        let a = left.join(&name);
        let b = right.join(&name);
        let kind = fs::symlink_metadata(&b)?.file_type();
        if kind.is_symlink() {
            return Err(invalid("immutable release contains symlink"));
        }
        if a.is_dir() && kind.is_dir() {
            same_tree(&a, &b)?;
        } else if a.is_file() && kind.is_file() {
            // Bounded streaming comparison avoids allocating a walking input.
            let mut a = File::open(a)?;
            let mut b = File::open(b)?;
            loop {
                let mut left = [0; 65536];
                let mut right = [0; 65536];
                let count = a.read(&mut left)?;
                b.read_exact(&mut right[..count])?;
                if left[..count] != right[..count] {
                    return Err(invalid("immutable release bytes mismatch"));
                }
                if count == 0 {
                    if b.read(&mut right[..1])? != 0 {
                        return Err(invalid("immutable release size mismatch"));
                    }
                    break;
                }
            }
        } else {
            return Err(invalid("immutable release file type mismatch"));
        }
    }
    Ok(())
}

fn durable_tree(path: &Path) -> io::Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            durable_tree(&entry.path())?;
        } else {
            fsync::durable(File::open(entry.path())?.as_fd())?;
        }
    }
    fsync::durable_dir(File::open(path)?.as_fd())
}
