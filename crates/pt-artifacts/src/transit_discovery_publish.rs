//! Explicit served-city snapshot publication over complete per-city repositories.
use crate::{
    store::{atomic_json, durable_mkdir, Store},
    transit_catalog::{self, Checkpoint},
    transit_discovery::{self, Choice, City, Discovery},
    transit_publish::{bounded, check_hash, ledger, pair, read_ledger, regular, sync_dir},
};
use ed25519_dalek::SigningKey;
use pt_shared::osm_manifest::{digest, timestamp_seconds};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io,
    os::unix::fs::symlink,
    path::Path,
};

pub struct Publication<'a> {
    pub cities: &'a [String],
    pub expires_at: &'a str,
    pub signing_key: &'a SigningKey,
    pub trusted_keys: &'a [[u8; 32]],
    pub now: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub sequence: u64,
    pub sha256: String,
    pub cities: usize,
}
fn invalid(message: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

pub fn publish(root: &Path, request: &Publication<'_>) -> io::Result<Receipt> {
    if request.cities.is_empty()
        || request.cities.len() > transit_discovery::MAX_CITIES
        || !request
            .trusted_keys
            .contains(&request.signing_key.verifying_key().to_bytes())
    {
        return Err(invalid("invalid discovery publication inputs"));
    }
    let mut cities = request.cities.to_vec();
    cities.sort();
    if cities.windows(2).any(|pair| pair[0] == pair[1])
        || cities.iter().any(|city| {
            city.is_empty()
                || city.len() > 64
                || !city
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
    {
        return Err(invalid("invalid or duplicate discovery city"));
    }
    let _writer = Store::open(&root.join("private"))?;
    let public = root.join("public/transit");
    let channel = public.join("discovery/v1");
    let heads = public.join("discovery/heads");
    let state_path = root.join("private/state/transit-discovery-publish.json");
    let observed = match fs::symlink_metadata(&channel) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
        Ok(m) if !m.file_type().is_symlink() => {
            return Err(invalid("discovery alias must be publisher-owned symlink"))
        }
        Ok(_) => {
            let bytes = bounded(&channel.join("latest.json"), transit_discovery::MAX_BYTES)?;
            let sig = bounded(&channel.join("latest.json.sig"), 64)?;
            let old: Discovery = serde_json::from_slice(&bytes).map_err(invalid)?;
            let old = transit_discovery::verify(
                &bytes,
                &sig,
                request.trusted_keys,
                None,
                timestamp_seconds(&old.published_at).map_err(invalid)?,
            )
            .map_err(invalid)?;
            let sha256 = digest(&bytes);
            if fs::read_link(&channel)? != format!("heads/{sha256}") {
                return Err(invalid("discovery alias hash mismatch"));
            }
            Some(Checkpoint {
                sequence: old.sequence,
                sha256,
            })
        }
    };
    if !state_path.try_exists()?
        && observed.is_none()
        && heads.try_exists()?
        && fs::read_dir(&heads)?.next().is_some()
    {
        return Err(invalid(
            "discovery ledger missing while immutable snapshots remain",
        ));
    }
    let mut state = read_ledger(&state_path, "served-cities", observed)?;
    let mut entries = Vec::new();
    let mut objects = BTreeMap::new();
    for city in cities {
        let city_channel = public.join("catalog/v1").join(&city);
        let city_state = ledger(
            &root
                .join("private/state")
                .join(format!("transit-publish-{city}.json")),
            &city_channel,
            &city,
            request.trusted_keys,
        )?;
        let published = city_state
            .published
            .ok_or_else(|| invalid("city has no completed publication"))?;
        let head = public.join("catalog/heads").join(&published.sha256);
        let bytes = bounded(
            &head.join("latest.json"),
            transit_catalog::MAX_CATALOG_BYTES,
        )?;
        let sig = bounded(&head.join("latest.json.sig"), 64)?;
        let catalog = transit_catalog::verify(
            &bytes,
            &sig,
            request.trusted_keys,
            &city,
            Some(&published),
            request.now,
        )
        .map_err(invalid)?;
        let mut choices = Vec::new();
        for selection in &catalog.selections {
            let directory = public.join("selections").join(&selection.sha256);
            let bytes = bounded(&directory.join("selection.json"), selection.bytes as usize)?;
            let sig = bounded(&directory.join("selection.json.sig"), 64)?;
            let inventory = transit_catalog::verify_selection(
                &catalog,
                &bytes,
                &sig,
                request.trusted_keys,
                selection.geometry_selected,
            )
            .map_err(invalid)?;
            for file in inventory.files {
                if file.size_bytes == 0
                    || file.size_bytes > pt_shared::osm_manifest::MAX_OBJECT_BYTES
                {
                    return Err(invalid("discovery object exceeds installer limits"));
                }
                if let Some(previous) = objects.insert(file.sha256.clone(), file.size_bytes) {
                    if previous != file.size_bytes {
                        return Err(invalid("inconsistent discovery object sizes"));
                    }
                } else {
                    let path = public.join("objects/sha256").join(&file.sha256);
                    if !regular(&path)? {
                        return Err(invalid("discovery dependency missing"));
                    }
                    check_hash(&mut File::open(path)?, &file.sha256, file.size_bytes, None)?;
                }
            }
            choices.push(Choice {
                geometry_selected: selection.geometry_selected,
                selection_sha256: selection.sha256.clone(),
                selection_bytes: selection.bytes,
                selected_bytes: inventory.selected_bytes,
            });
        }
        choices.sort_by_key(|c| c.geometry_selected);
        entries.push(City {
            city,
            head_sha256: published.sha256,
            head_bytes: bytes.len() as u64,
            sequence: catalog.sequence,
            pack_id: catalog.pack_id,
            generation_id: catalog.generation_id,
            expires_at: catalog.expires_at,
            choices,
        });
    }
    let discovery = Discovery {
        schema_version: 1,
        sequence: state
            .highest_sequence
            .checked_add(1)
            .ok_or_else(|| invalid("discovery sequence overflow"))?,
        published_at: jiff::Timestamp::from_second(request.now)
            .map_err(invalid)?
            .to_string(),
        expires_at: request.expires_at.into(),
        cities: entries,
    };
    let (bytes, sig) = transit_discovery::prepare(&discovery, request.signing_key, request.now)
        .map_err(invalid)?;
    let sha256 = digest(&bytes);
    let stage = root.join("private/state/transit-discovery-staging");
    if stage.exists() {
        fs::remove_dir_all(&stage)?;
    }
    durable_mkdir(&stage)?;
    durable_mkdir(&heads)?;
    let result = (|| {
        state.highest_sequence = discovery.sequence;
        state.pending = Some(Checkpoint {
            sequence: discovery.sequence,
            sha256: sha256.clone(),
        });
        atomic_json(&state_path, &state)?;
        pair(&stage, &heads.join(&sha256), "latest.json", &bytes, &sig)?;
        let next = channel.with_extension("next");
        if fs::symlink_metadata(&next).is_ok() {
            fs::remove_file(&next)?;
        }
        symlink(format!("heads/{sha256}"), &next)?;
        fs::rename(next, &channel)?;
        sync_dir(channel.parent().unwrap())?;
        state.published = state.pending.take();
        atomic_json(&state_path, &state)?;
        Ok(Receipt {
            sequence: discovery.sequence,
            sha256,
            cities: discovery.cities.len(),
        })
    })();
    let _ = fs::remove_dir_all(stage);
    result
}
