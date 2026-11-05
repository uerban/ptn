//! Compose installed per-city POI corpora into an immutable deployment release.
//! The mutable discovery pointer advances independently of source build dates,
//! including when rolling back to older source data. No corpus requires Vilnius.
use crate::{
    native::corpus_ids,
    store::{durable_mkdir, Store},
};
use pt_shared::{
    fsync,
    osm_manifest::{digest, valid_digest, Component, OsmManifest},
    poi_manifest_wire::MAX_POI_CITY_SLOTS,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{self, Read, Write},
    os::{fd::AsFd, unix::fs::symlink},
    path::Path,
};

const COMPOSITION_VERSION: u32 = 1;
fn invalid(message: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Deployment {
    composition_version: u32,
    activation_revision: u64,
    sources: BTreeMap<String, String>,
}

fn read_json(path: &Path) -> io::Result<Value> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err(invalid("POI metadata exceeds size limit"));
    }
    serde_json::from_slice(&bytes).map_err(invalid)
}

impl Store {
    /// Reconcile only enabled deployment cities. A failed/unavailable optional
    /// update retains that city's previous working POI release. Removing a city
    /// from this selection removes it from discovery without deleting its data.
    pub fn compose_poi(&self, cities: &[&str]) -> io::Result<bool> {
        let root = self.root.join("public/poi");
        let current_path = root.join("current/manifest.json");
        let previous = match read_json(&current_path) {
            Ok(value) => Some(
                serde_json::from_value::<Deployment>(value["deployment"].clone())
                    .map_err(invalid)?,
            ),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        let mut sources = BTreeMap::new();
        for city in cities {
            let state = self.status(city)?; // also validates city path grammar
            let selected = match state {
                Some(state) if self.has_poi(city, &state.release)? => Some(state.release),
                _ => previous
                    .as_ref()
                    .and_then(|p| p.sources.get(*city))
                    .cloned(),
            };
            if let Some(release) = selected {
                if !valid_digest(&release) || !self.has_poi(city, &release)? {
                    return Err(invalid("previous POI source is no longer valid"));
                }
                sources.insert((*city).to_owned(), release);
            }
        }
        if previous
            .as_ref()
            .is_some_and(|p| p.composition_version == COMPOSITION_VERSION && p.sources == sources)
        {
            return Ok(false);
        }
        let revision = previous
            .as_ref()
            .map_or(Some(1), |p| p.activation_revision.checked_add(1))
            .ok_or_else(|| invalid("POI activation overflow"))?;
        let deployment = Deployment {
            composition_version: COMPOSITION_VERSION,
            activation_revision: revision,
            sources,
        };
        let identity = digest(&serde_json::to_vec(&deployment).map_err(invalid)?);
        let staged = root.join(format!(".staging-{identity}"));
        let releases = root.join("releases");
        durable_mkdir(&releases)?;
        if staged.exists() {
            fs::remove_dir_all(&staged)?;
        }
        durable_mkdir(&staged)?;
        let result = (|| {
            let mut bundles: Vec<Value> = Vec::new();
            let mut filenames = BTreeSet::new();
            let mut strict = BTreeSet::new();
            let mut generated_at = 0u64;
            for (city, release) in &deployment.sources {
                let corpus = self.root.join("public/releases").join(release).join("poi");
                let manifest = read_json(&corpus.join("manifest.json"))?;
                if manifest["schemaVersion"] != 1 {
                    return Err(invalid("unsupported native POI manifest"));
                }
                generated_at = generated_at.max(
                    manifest["generatedAt"]
                        .as_u64()
                        .ok_or_else(|| invalid("missing source POI build time"))?,
                );
                for bundle in manifest["bundles"]
                    .as_array()
                    .ok_or_else(|| invalid("missing POI bundles"))?
                {
                    let corpus_id = bundle["cityId"]
                        .as_str()
                        .ok_or_else(|| invalid("missing POI city"))?;
                    let filename = bundle["filename"]
                        .as_str()
                        .ok_or_else(|| invalid("missing POI filename"))?;
                    if !corpus_ids(city).contains(&corpus_id)
                        || ![format!("{corpus_id}.br"), format!("{corpus_id}.loose.br")]
                            .contains(&filename.to_owned())
                        || !filenames.insert(filename.to_owned())
                    {
                        return Err(invalid("ambiguous or invalid POI corpus mapping"));
                    }
                    if filename == format!("{corpus_id}.br") {
                        strict.insert(corpus_id.to_owned());
                    }
                    let path = corpus.join(filename);
                    let expected = bundle["sha256"]
                        .as_str()
                        .ok_or_else(|| invalid("missing POI checksum"))?;
                    let size = bundle["sizeBytes"]
                        .as_u64()
                        .ok_or_else(|| invalid("missing POI size"))?;
                    verify_bundle(&path, expected, size)?;
                    fs::hard_link(&path, staged.join(filename))?;
                    bundles.push(bundle.clone());
                }
            }
            if strict.len() as u64 > MAX_POI_CITY_SLOTS {
                return Err(invalid("deployment exceeds POI strict corpus slot limit"));
            }
            bundles.sort_by(|a, b| a["filename"].as_str().cmp(&b["filename"].as_str()));
            let manifest = serde_json::json!({"schemaVersion":1,"generatedAt":generated_at,
                "activationRevision":revision,"baseUrl":format!("/poi/releases/{identity}/"),
                "deployment":deployment,"bundles":bundles});
            let bytes = serde_json::to_vec(&manifest).map_err(invalid)?;
            if bytes.len() > 1024 * 1024 {
                return Err(invalid("aggregate POI manifest exceeds size limit"));
            }
            let mut file = File::create(staged.join("manifest.json"))?;
            file.write_all(&bytes)?;
            fsync::durable(file.as_fd())?;
            fsync::durable_dir(File::open(&staged)?.as_fd())?;
            let target = releases.join(&identity);
            if target.exists() {
                if fs::read(target.join("manifest.json"))? != bytes {
                    return Err(invalid("immutable POI activation collision"));
                }
                let names = |path: &Path| -> io::Result<BTreeSet<std::ffi::OsString>> {
                    fs::read_dir(path)?
                        .map(|e| e.map(|e| e.file_name()))
                        .collect()
                };
                if names(&target)? != names(&staged)? {
                    return Err(invalid("immutable POI inventory mismatch"));
                }
                for bundle in manifest["bundles"].as_array().unwrap() {
                    let path = target.join(bundle["filename"].as_str().unwrap());
                    if !fs::symlink_metadata(&path)?.file_type().is_file() {
                        return Err(invalid("unsafe immutable POI member"));
                    }
                    verify_bundle(
                        &path,
                        bundle["sha256"].as_str().unwrap(),
                        bundle["sizeBytes"].as_u64().unwrap(),
                    )?;
                }
                fs::remove_dir_all(&staged)?;
            } else {
                fs::rename(&staged, &target)?;
            }
            fsync::durable_dir(File::open(&releases)?.as_fd())?;
            // Static discovery has one authority: current/manifest.json. The
            // convenience manifest symlink is fixed and never points privately.
            let discovery = root.join("manifest.json");
            if discovery.symlink_metadata().is_err() {
                symlink("current/manifest.json", &discovery)?;
            }
            let next = root.join(".current-next");
            if next.symlink_metadata().is_ok() {
                fs::remove_file(&next)?;
            }
            symlink(format!("releases/{identity}"), &next)?;
            fs::rename(next, root.join("current"))?;
            fsync::durable_dir(File::open(&root)?.as_fd())?;
            Ok(true)
        })();
        if staged.exists() {
            let _ = fs::remove_dir_all(staged);
        }
        result
    }

    fn has_poi(&self, city: &str, release: &str) -> io::Result<bool> {
        let path = self
            .root
            .join("cities")
            .join(city)
            .join("releases")
            .join(release)
            .join("manifest.json");
        let value = read_json(&path)?;
        let bytes = fs::read(&path)?;
        if digest(&bytes) != release {
            return Err(invalid("installed OSM manifest mismatch"));
        }
        let manifest: OsmManifest = serde_json::from_value(value).map_err(invalid)?;
        manifest.validate(city).map_err(invalid)?;
        Ok(matches!(
            manifest.components.get("poi"),
            Some(Component::Present { .. })
        ))
    }
}

fn verify_bundle(path: &Path, expected: &str, size: u64) -> io::Result<()> {
    if !valid_digest(expected) || size == 0 || size > crate::native::MAX_NATIVE_BYTES {
        return Err(invalid("invalid POI bundle bounds"));
    }
    let mut file = File::open(path)?;
    if file.metadata()?.len() != size {
        return Err(invalid("POI bundle size mismatch"));
    }
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != expected {
        return Err(invalid("POI bundle checksum mismatch"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn install(store: &Store, city: &str, sequence: u64, date: u64, present: bool) -> String {
        let missing = serde_json::json!({"status":"unsupported","reason":"fixture"});
        let poi = if present {
            serde_json::json!({"status":"present","format":"poi-corpus","formatVersion":1,"compression":"gzip","sha256":digest(b"archive"),"bytes":1,"decodedBytes":1})
        } else {
            missing.clone()
        };
        let manifest = serde_json::json!({"schemaVersion":1,"city":city,"coverageE5":[1,1,2,2],"createdAt":"2026-10-29T00:00:00Z",
            "source":{"url":"https://example.org/source","snapshotAt":"2026-10-28T00:00:00Z","sha256":digest(format!("{sequence}").as_bytes())},
            "builderRevision":"fixture","configurationSha256":digest(b"config"),"tools":{},"attribution":"OSM contributors","licenseUrl":"https://www.openstreetmap.org/copyright",
            "components":{"walking":missing,"addresses":missing,"walkGraph":missing,"poi":poi}});
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let release = digest(&bytes);
        let directory = store
            .root
            .join("cities")
            .join(city)
            .join("releases")
            .join(&release);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("manifest.json"), bytes).unwrap();
        if present {
            let corpus = store
                .root
                .join("public/releases")
                .join(&release)
                .join("poi");
            fs::create_dir_all(&corpus).unwrap();
            let mut bundles = Vec::new();
            for id in corpus_ids(city) {
                let native = serde_json::json!({"meta":{"cityId":id,"tier":"strict","entryCount":0},"entries":[]});
                let mut compressed = Vec::new();
                {
                    let mut writer = brotli::CompressorWriter::new(&mut compressed, 4096, 4, 22);
                    writer
                        .write_all(&serde_json::to_vec(&native).unwrap())
                        .unwrap();
                }
                let filename = format!("{id}.br");
                fs::write(corpus.join(&filename), &compressed).unwrap();
                bundles.push(serde_json::json!({"cityId":id,"filename":filename,"sizeBytes":compressed.len(),"sha256":digest(&compressed)}));
            }
            fs::write(
                corpus.join("manifest.json"),
                serde_json::to_vec(
                    &serde_json::json!({"schemaVersion":1,"generatedAt":date,"bundles":bundles}),
                )
                .unwrap(),
            )
            .unwrap();
        }
        store.activate_validated(city, &release, sequence).unwrap();
        release
    }
    fn active(store: &Store) -> Value {
        read_json(&store.root.join("public/poi/manifest.json")).unwrap()
    }

    #[test]
    fn composes_tricity_and_tbilisi_without_vilnius_and_preserves_optional_failures() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let tricity = install(&store, "tricity", 1, 100, true);
        install(&store, "tbilisi", 1, 200, true);
        assert!(store.compose_poi(&["tricity", "tbilisi"]).unwrap());
        let first = active(&store);
        assert_eq!(first["bundles"].as_array().unwrap().len(), 4);
        assert_eq!(first["activationRevision"], 1);
        assert_eq!(first["generatedAt"], 200);
        assert!(!store.compose_poi(&["tbilisi", "tricity"]).unwrap());
        install(&store, "tricity", 2, 300, false);
        assert!(!store.compose_poi(&["tricity", "tbilisi"]).unwrap());
        assert_eq!(active(&store)["deployment"]["sources"]["tricity"], tricity);
        assert!(store.compose_poi(&["tbilisi"]).unwrap());
        assert_eq!(active(&store)["bundles"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn rollback_advances_activation_and_retains_immutable_urls() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        install(&store, "tbilisi", 1, 100, true);
        store.compose_poi(&["tbilisi"]).unwrap();
        let first = active(&store);
        let first_path = store
            .root
            .join("public")
            .join(first["baseUrl"].as_str().unwrap().trim_start_matches('/'));
        install(&store, "tbilisi", 2, 200, true);
        store.compose_poi(&["tbilisi"]).unwrap();
        assert_eq!(active(&store)["activationRevision"], 2);
        store.rollback("tbilisi").unwrap();
        store.compose_poi(&["tbilisi"]).unwrap();
        let rolled = active(&store);
        assert_eq!(rolled["activationRevision"], 3);
        assert_eq!(rolled["generatedAt"], 100);
        assert_ne!(rolled["baseUrl"], first["baseUrl"]);
        assert!(first_path.join("tbilisi.br").is_file());
        assert_eq!(read_json(&first_path.join("manifest.json")).unwrap(), first);
    }

    #[test]
    fn corrupt_candidate_keeps_current_and_crash_before_pointer_is_retryable() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        install(&store, "tbilisi", 1, 100, true);
        store.compose_poi(&["tbilisi"]).unwrap();
        let original_link = fs::read_link(store.root.join("public/poi/current")).unwrap();
        let release = install(&store, "tbilisi", 2, 200, true);
        let file = store
            .root
            .join("public/releases")
            .join(&release)
            .join("poi/tbilisi.br");
        let good = fs::read(&file).unwrap();
        fs::write(&file, b"corrupt").unwrap();
        assert!(store.compose_poi(&["tbilisi"]).is_err());
        assert_eq!(
            fs::read_link(store.root.join("public/poi/current")).unwrap(),
            original_link
        );
        fs::write(&file, good).unwrap();
        store.compose_poi(&["tbilisi"]).unwrap();
        // Simulate interruption after immutable directory rename but before
        // current promotion: restore the old pointer, leave the new tree.
        let current = store.root.join("public/poi/current");
        fs::remove_file(&current).unwrap();
        symlink(&original_link, &current).unwrap();
        assert!(store.compose_poi(&["tbilisi"]).unwrap());
        assert_eq!(active(&store)["activationRevision"], 2);
    }
}
