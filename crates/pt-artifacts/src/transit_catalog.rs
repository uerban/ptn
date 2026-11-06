//! Authenticated transit refresh heads, separate from independent OSM channels.
use crate::{transit::TransitInventory, transit_export};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use pt_shared::osm_manifest::{digest, timestamp_seconds, valid_digest};
use serde::{Deserialize, Serialize};

const DOMAIN: &[u8] = b"PTN-TRANSIT-CATALOG-v1\0";
pub const MAX_CATALOG_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub sha256: String,
    pub bytes: u64,
    pub geometry_selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalog {
    pub schema_version: u32,
    pub city: String,
    pub sequence: u64,
    pub pack_id: String,
    pub generation_id: String,
    pub published_at: String,
    pub expires_at: String,
    /// At most one full and one geometry-free selection of the same pack.
    pub selections: Vec<Selection>,
}

/// Persist only after coherent installation succeeds. Local rollback must not
/// rewind this checkpoint. Equal sequences must retain the exact catalog hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkpoint {
    pub sequence: u64,
    pub sha256: String,
}

pub fn signing_message(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_CATALOG_BYTES {
        return Err("transit catalog exceeds metadata limit".into());
    }
    Ok([DOMAIN, bytes].concat())
}

impl Catalog {
    fn validate(&self, city: &str, now: i64) -> Result<(), String> {
        if self.schema_version != 1
            || self.city != city
            || self.sequence == 0
            || (city.is_empty()
                || !city
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
            || !valid_digest(&self.pack_id)
            || !valid_digest(&self.generation_id)
            || self.selections.is_empty()
            || self.selections.len() > 2
        {
            return Err("invalid transit catalog identity or selections".into());
        }
        let mut variants = std::collections::BTreeSet::new();
        let mut hashes = std::collections::BTreeSet::new();
        for selection in &self.selections {
            if !valid_digest(&selection.sha256)
                || selection.bytes == 0
                || selection.bytes > transit_export::MAX_DESCRIPTOR_BYTES as u64
                || !variants.insert(selection.geometry_selected)
                || !hashes.insert(&selection.sha256)
            {
                return Err("invalid or duplicate transit selection".into());
            }
        }
        let published = timestamp_seconds(&self.published_at)?;
        let expires = timestamp_seconds(&self.expires_at)?;
        if published > now.saturating_add(300) || expires <= now || expires <= published {
            return Err("expired or future-dated transit catalog".into());
        }
        Ok(())
    }
}

pub fn verify(
    bytes: &[u8],
    signature: &[u8],
    keys: &[[u8; 32]],
    city: &str,
    checkpoint: Option<&Checkpoint>,
    now: i64,
) -> Result<Catalog, String> {
    let signature = Signature::from_slice(signature).map_err(|e| e.to_string())?;
    let message = signing_message(bytes)?;
    if !keys.iter().any(|bytes| {
        VerifyingKey::from_bytes(bytes)
            .is_ok_and(|key| key.verify_strict(&message, &signature).is_ok())
    }) {
        return Err("transit catalog signature does not match a trusted key".into());
    }
    let catalog: Catalog = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    catalog.validate(city, now)?;
    if let Some(prior) = checkpoint {
        if !valid_digest(&prior.sha256)
            || prior.sequence == 0
            || catalog.sequence < prior.sequence
            || (catalog.sequence == prior.sequence && digest(bytes) != prior.sha256)
        {
            return Err("transit catalog rollback or sequence equivocation".into());
        }
    }
    Ok(catalog)
}

/// Authenticate a selection AND bind its identity and exact bytes to the head.
/// Native artifact validation and activation remain the installer's job.
pub fn verify_selection(
    catalog: &Catalog,
    bytes: &[u8],
    signature: &[u8],
    keys: &[[u8; 32]],
    geometry: bool,
) -> Result<TransitInventory, String> {
    let selected = catalog
        .selections
        .iter()
        .find(|s| s.geometry_selected == geometry)
        .ok_or("requested transit selection is unavailable")?;
    if selected.bytes != bytes.len() as u64 || selected.sha256 != digest(bytes) {
        return Err("transit selection does not match catalog".into());
    }
    let inventory =
        transit_export::verify(bytes, signature, keys, &catalog.city).map_err(|e| e.to_string())?;
    if inventory.pack_id != catalog.pack_id
        || inventory.generation_id != catalog.generation_id
        || inventory.geometry_selected != geometry
    {
        return Err("transit selection identity does not match catalog".into());
    }
    Ok(inventory)
}

/// Prepare a signed offline head. This does not expose or promote any files.
/// Input descriptors must already be authenticated with the configured keys.
pub fn prepare(
    catalog: &Catalog,
    key: &SigningKey,
    now: i64,
) -> Result<(Vec<u8>, [u8; 64]), String> {
    catalog.validate(&catalog.city, now)?;
    let bytes = serde_json::to_vec_pretty(catalog).map_err(|e| e.to_string())?;
    let signature = key.sign(&signing_message(&bytes)?).to_bytes();
    Ok((bytes, signature))
}
