//! Read-only installed-release discovery shared by producers and serving tools.
//! Resolve the activation once and keep the resulting immutable paths for a whole
//! operation. When the manager prunes, pair resolution with a consumer lease via
//! `producer_inputs_leased` and hold the lease for the whole operation.
use crate::osm_manifest::{digest, valid_digest, Component, OsmManifest};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Activation {
    pub schema_version: u32,
    pub revision: u64,
    pub release: String,
    pub previous_release: Option<String>,
    pub catalog_sequence: u64,
    pub catalog_manifest: String,
    pub pinned: bool,
}

pub struct ProducerInputs {
    pub release: String,
    pub walking: PathBuf,
    pub addresses: PathBuf,
}
fn invalid(message: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}
fn bounded_json(path: &Path) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err(invalid("installed metadata exceeds limit"));
    }
    Ok(bytes)
}

pub fn producer_inputs(root: &Path, city: &str) -> io::Result<ProducerInputs> {
    if city.is_empty()
        || city.len() > 64
        || !city
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(invalid("invalid city"));
    }
    let activation: Activation = serde_json::from_slice(&bounded_json(
        &root.join("public/current").join(format!("{city}.json")),
    )?)
    .map_err(invalid)?;
    if activation.schema_version != 1
        || activation.revision == 0
        || !valid_digest(&activation.release)
    {
        return Err(invalid("invalid installed activation"));
    }
    let directory = root
        .join("cities")
        .join(city)
        .join("releases")
        .join(&activation.release);
    let bytes = bounded_json(&directory.join("manifest.json"))?;
    if digest(&bytes) != activation.release {
        return Err(invalid("installed manifest hash mismatch"));
    }
    let manifest: OsmManifest = serde_json::from_slice(&bytes).map_err(invalid)?;
    manifest.validate(city).map_err(invalid)?;
    let resolve = |component: &str, name: &str| -> io::Result<PathBuf> {
        let Some(Component::Present { sha256, bytes, .. }) = manifest.components.get(component)
        else {
            return Err(invalid(format!(
                "required OSM component unavailable: {component}"
            )));
        };
        let path = directory.join("private").join(name);
        let mut file = File::open(&path)?;
        if file.metadata()?.len() != *bytes {
            return Err(invalid("installed input size mismatch"));
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
        if format!("{:x}", hash.finalize()) != *sha256 {
            return Err(invalid("installed input hash mismatch"));
        }
        Ok(path)
    };
    Ok(ProducerInputs {
        release: activation.release,
        walking: resolve("walking", "walking.geojsonseq.gz")?,
        addresses: resolve("addresses", "address-search.fst")?,
    })
}

/// Resolve under the shared resolution gate and pin the resolved release, so a
/// concurrent collector can neither delete it between resolution and pinning
/// nor while the returned lease is alive.
#[cfg(feature = "durable-fsync")]
pub fn producer_inputs_leased(
    root: &Path,
    lease_root: &Path,
    city: &str,
) -> io::Result<(ProducerInputs, crate::artifact_lease::ConsumerLease)> {
    let resolving = crate::artifact_lease::ResolutionGuard::acquire(lease_root)?;
    let inputs = producer_inputs(root, city)?;
    let lease = resolving.pin(&inputs.release)?;
    Ok((inputs, lease))
}
