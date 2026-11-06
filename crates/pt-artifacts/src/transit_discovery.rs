//! Signed served-city snapshots bind discovery to immutable city heads.
use crate::{
    transit_catalog::{self, Catalog, Checkpoint},
    transit_export,
};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use pt_shared::osm_manifest::{digest, timestamp_seconds, valid_digest};
use serde::{Deserialize, Serialize};

pub const MAX_BYTES: usize = 1024 * 1024;
pub const MAX_CITIES: usize = 4096;
const DOMAIN: &[u8] = b"PTN-TRANSIT-DISCOVERY-v1\0";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Choice {
    pub geometry_selected: bool,
    pub selection_sha256: String,
    pub selection_bytes: u64,
    /// Sum of signed selected file bytes, not peak disk space or runtime RAM.
    pub selected_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct City {
    pub city: String,
    pub head_sha256: String,
    pub head_bytes: u64,
    pub sequence: u64,
    pub pack_id: String,
    pub generation_id: String,
    pub expires_at: String,
    pub choices: Vec<Choice>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Discovery {
    pub schema_version: u32,
    pub sequence: u64,
    pub published_at: String,
    pub expires_at: String,
    /// Strictly sorted unique city slugs. Each points at a retained immutable head.
    pub cities: Vec<City>,
}
fn message(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_BYTES {
        return Err("transit discovery exceeds metadata limit".into());
    }
    Ok([DOMAIN, bytes].concat())
}
impl Discovery {
    fn validate(&self, now: i64) -> Result<(), String> {
        let published = timestamp_seconds(&self.published_at)?;
        let expires = timestamp_seconds(&self.expires_at)?;
        if self.schema_version != 1
            || self.sequence == 0
            || self.cities.len() > MAX_CITIES
            || published > now.saturating_add(300)
            || expires <= now
            || expires <= published
        {
            return Err("invalid or expired transit discovery".into());
        }
        let mut previous = None;
        for city in &self.cities {
            if city.city.is_empty()
                || city.city.len() > 64
                || !city
                    .city
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                || previous.is_some_and(|p: &str| p >= city.city.as_str())
                || !valid_digest(&city.head_sha256)
                || !valid_digest(&city.pack_id)
                || !valid_digest(&city.generation_id)
                || city.head_bytes == 0
                || city.head_bytes > transit_catalog::MAX_CATALOG_BYTES as u64
                || city.sequence == 0
                || expires > timestamp_seconds(&city.expires_at)?
                || city.choices.is_empty()
                || city.choices.len() > 2
            {
                return Err("invalid transit discovery city".into());
            }
            previous = Some(city.city.as_str());
            let mut variants = std::collections::BTreeSet::new();
            let mut hashes = std::collections::BTreeSet::new();
            for choice in &city.choices {
                if !valid_digest(&choice.selection_sha256)
                    || choice.selection_bytes == 0
                    || choice.selection_bytes > transit_export::MAX_DESCRIPTOR_BYTES as u64
                    || choice.selected_bytes == 0
                    || !variants.insert(choice.geometry_selected)
                    || !hashes.insert(&choice.selection_sha256)
                {
                    return Err("invalid transit discovery choice".into());
                }
            }
        }
        Ok(())
    }
}
pub fn prepare(
    discovery: &Discovery,
    key: &SigningKey,
    now: i64,
) -> Result<(Vec<u8>, [u8; 64]), String> {
    discovery.validate(now)?;
    let bytes = serde_json::to_vec_pretty(discovery).map_err(|e| e.to_string())?;
    let signature = key.sign(&message(&bytes)?).to_bytes();
    Ok((bytes, signature))
}
pub fn verify(
    bytes: &[u8],
    sig: &[u8],
    keys: &[[u8; 32]],
    checkpoint: Option<&Checkpoint>,
    now: i64,
) -> Result<Discovery, String> {
    let signature = Signature::from_slice(sig).map_err(|e| e.to_string())?;
    let message = message(bytes)?;
    if !keys.iter().any(|key| {
        VerifyingKey::from_bytes(key)
            .is_ok_and(|key| key.verify_strict(&message, &signature).is_ok())
    }) {
        return Err("transit discovery signature does not match a trusted key".into());
    }
    let discovery: Discovery = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    discovery.validate(now)?;
    if checkpoint.is_some_and(|prior| {
        prior.sequence == 0
            || !valid_digest(&prior.sha256)
            || discovery.sequence < prior.sequence
            || (discovery.sequence == prior.sequence && digest(bytes) != prior.sha256)
    }) {
        return Err("transit discovery rollback or sequence equivocation".into());
    }
    Ok(discovery)
}
/// Verify a city's exact head against discovery and its own signing domain.
pub fn verify_city(
    city: &City,
    bytes: &[u8],
    sig: &[u8],
    keys: &[[u8; 32]],
    checkpoint: Option<&Checkpoint>,
    now: i64,
) -> Result<Catalog, String> {
    if bytes.len() as u64 != city.head_bytes || digest(bytes) != city.head_sha256 {
        return Err("transit head does not match discovery".into());
    }
    let catalog = transit_catalog::verify(bytes, sig, keys, &city.city, checkpoint, now)?;
    if catalog.sequence != city.sequence
        || catalog.pack_id != city.pack_id
        || catalog.generation_id != city.generation_id
        || catalog.expires_at != city.expires_at
        || catalog.selections.len() != city.choices.len()
        || catalog.selections.iter().any(|selection| {
            !city.choices.iter().any(|choice| {
                choice.geometry_selected == selection.geometry_selected
                    && choice.selection_sha256 == selection.sha256
                    && choice.selection_bytes == selection.bytes
            })
        })
    {
        return Err("transit catalog identity does not match discovery".into());
    }
    Ok(catalog)
}
