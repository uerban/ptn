//! Validate a prepared city release before atomically switching its signed head.
//! Publication and installation deliberately share the native validation path.
use crate::{
    catalog::{self, Catalog},
    install::{self, LocalRepository},
    store::{durable_mkdir, Store},
};
use ed25519_dalek::{Signer, SigningKey};
use pt_shared::{
    fsync,
    osm_manifest::{digest, Component, OsmManifest},
};
use std::{
    fs::{self, File},
    io,
    os::{fd::AsFd, unix::fs::symlink},
    path::Path,
};

fn invalid(message: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

pub fn publish(
    repository: &Path,
    manifest_file: &Path,
    objects: &Path,
    key: &SigningKey,
    trusted_keys: &[[u8; 32]],
    now: i64,
) -> io::Result<String> {
    let writer = Store::open(repository)?;
    let manifest_bytes = fs::read(manifest_file)?;
    if manifest_bytes.len() > catalog::MAX_METADATA_BYTES {
        return Err(invalid("manifest exceeds metadata limit"));
    }
    let manifest: OsmManifest = serde_json::from_slice(&manifest_bytes).map_err(invalid)?;
    manifest.validate(&manifest.city).map_err(invalid)?;
    let city = &manifest.city;
    let release = digest(&manifest_bytes);
    let public_key = key.verifying_key().to_bytes();
    if !trusted_keys.contains(&public_key) {
        return Err(invalid("publisher key is not trusted"));
    }
    let channel = repository.join("catalog/v1").join(city);
    let previous = match fs::read(channel.join("latest.json")) {
        Ok(bytes) => {
            let signature = fs::read(channel.join("latest.json.sig"))?;
            let prior: Catalog = serde_json::from_slice(&bytes).map_err(invalid)?;
            // A publisher may renew an expired channel, but its previous head
            // must still authenticate with a configured key.
            let at_publication =
                pt_shared::osm_manifest::timestamp_seconds(&prior.published_at).map_err(invalid)?;
            Some(
                catalog::verify(&bytes, &signature, trusted_keys, city, 0, at_publication)
                    .map_err(invalid)?,
            )
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let sequence = previous
        .map_or(Some(1), |p| p.sequence.checked_add(1))
        .ok_or_else(|| invalid("publication sequence overflow"))?;
    let catalog = Catalog {
        schema_version: 1,
        city: city.clone(),
        sequence,
        manifest_sha256: release.clone(),
        manifest_bytes: manifest_bytes.len() as u64,
        published_at: jiff::Timestamp::from_second(now)
            .map_err(invalid)?
            .to_string(),
        expires_at: jiff::Timestamp::from_second(
            now.checked_add(30 * 86400)
                .ok_or_else(|| invalid("expiry overflow"))?,
        )
        .map_err(invalid)?
        .to_string(),
    };
    let catalog_bytes = serde_json::to_vec(&catalog).map_err(invalid)?;
    let signature = key
        .sign(&catalog::signing_message(&catalog_bytes).map_err(invalid)?)
        .to_bytes();
    let staging = repository.join("state/publish-staging");
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    durable_mkdir(&staging)?;
    let result = (|| {
        let staged_repo = staging.join("repository");
        let staged_objects = staged_repo.join("objects/sha256");
        durable_mkdir(&staged_objects)?;
        for component in manifest.components.values() {
            if let Component::Present { sha256, bytes, .. } = component {
                let object = writer.install_object(
                    sha256,
                    *bytes,
                    &mut File::open(objects.join(sha256))?,
                )?;
                let target = staged_objects.join(sha256);
                if !target.exists() {
                    fs::hard_link(object, target)?;
                }
            }
        }
        let staged_release = staged_repo.join("releases").join(&release);
        durable_mkdir(&staged_release)?;
        durable_write(&staged_release.join("manifest.json"), &manifest_bytes)?;
        let staged_channel = staged_repo.join("catalog/v1").join(city);
        durable_mkdir(&staged_channel)?;
        durable_write(&staged_channel.join("latest.json"), &catalog_bytes)?;
        durable_write(&staged_channel.join("latest.json.sig"), &signature)?;
        let validation = Store::open(&staging.join("validation"))?;
        install::sync(
            &validation,
            &LocalRepository(staged_repo.clone()),
            city,
            trusted_keys,
            now,
            &["walking", "addresses"],
        )?;

        let release_dir = repository.join("releases").join(&release);
        durable_mkdir(&release_dir)?;
        let target_manifest = release_dir.join("manifest.json");
        if target_manifest.exists() {
            if fs::read(&target_manifest)? != manifest_bytes {
                return Err(invalid("immutable manifest collision"));
            }
        } else {
            durable_write(&target_manifest, &manifest_bytes)?;
        }

        // A head directory contains BOTH signed files. Prepare it completely,
        // then replace one symlink; disk failures cannot leave a half-written head.
        let head_id = digest(&catalog_bytes);
        let head = repository.join("catalog/heads").join(&head_id);
        durable_mkdir(&head)?;
        durable_write(&head.join("latest.json"), &catalog_bytes)?;
        durable_write(&head.join("latest.json.sig"), &signature)?;
        durable_mkdir(channel.parent().unwrap())?;
        if channel.exists() && !fs::symlink_metadata(&channel)?.file_type().is_symlink() {
            return Err(invalid("channel must be a publisher-owned symlink"));
        }
        let next = channel.with_extension("next");
        if next.symlink_metadata().is_ok() {
            fs::remove_file(&next)?;
        }
        symlink(format!("../heads/{head_id}"), &next)?;
        fs::rename(&next, &channel)?;
        fsync::durable_dir(File::open(channel.parent().unwrap())?.as_fd())?;
        Ok(release)
    })();
    let _ = fs::remove_dir_all(staging);
    result
}

fn durable_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut file = File::create(path)?;
    file.write_all(bytes)?;
    fsync::durable(file.as_fd())?;
    fsync::durable_dir(File::open(path.parent().unwrap())?.as_fd())
}
