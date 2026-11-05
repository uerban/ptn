//! `pt-producer pack-address-search` — extractor JSON intermediate to packed
//! `PTAS` artifact.
//!
//! Two distinct contracts meet in this file, and they are versioned
//! independently:
//!
//! - the INPUT is the extractor's JSON intermediate
//!   (`packages/backend/scripts/extract-addr-fixture.ts`), whose
//!   `schemaVersion` must be `EXTRACT_SCHEMA_VERSION`. It is never served and
//!   never committed;
//! - the OUTPUT is the packed artifact that ships, stamped with
//!   `pt_geocode::SCHEMA_VERSION`.
//!
//! The intermediate is JSON because the extractor runs osmium from Node. It
//! repeats every lookup key as `{"key":"...","rowId":N}` and so runs ~4x the
//! size of the index it describes (21.4 MB against 5.2 MB on vilnius). This
//! step builds the FST once, up front, so what gets committed, served and
//! downloaded is the index itself.
//!
//! Packing goes through `pt_geocode::AddrIndex::pack` — the same crate pt-serve
//! and pt-wasm read the result back with — so the writer and the readers cannot
//! drift apart.

use crate::error::{Error, Result};
use pt_geocode::{AddrKey, AddrRow, ArtifactMeta};
use serde::Deserialize;
use std::path::Path;

/// `schemaVersion` this step accepts on the extractor's JSON intermediate.
///
/// Unrelated to `pt_geocode::SCHEMA_VERSION`, which versions the packed
/// artifact this step writes. The two happen to share a number and must be
/// bumped independently.
const EXTRACT_SCHEMA_VERSION: u32 = 1;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractArtifact {
    schema_version: u32,
    city_id: Option<String>,
    source: Option<String>,
    generated_at: String,
    rows: Vec<ExtractRow>,
    keys: Vec<ExtractKey>,
    stats: ExtractStats,
}

#[derive(Deserialize)]
struct ExtractRow {
    label: String,
    lat: f64,
    lon: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractKey {
    key: String,
    row_id: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractStats {
    row_count: usize,
    key_count: usize,
}

/// Read `input` (the extractor's JSON intermediate), write the packed `PTAS`
/// artifact to `out`.
///
/// Returns `(input_bytes, output_bytes)` so the caller can log the ratio.
pub fn pack_address_search(input: &Path, out: &Path, city: Option<&str>) -> Result<(usize, usize)> {
    let raw = std::fs::read(input).map_err(|e| {
        Error::Config(format!(
            "failed to read address corpus {}: {e}",
            input.display()
        ))
    })?;
    let extract: ExtractArtifact = serde_json::from_slice(&raw).map_err(|e| {
        Error::Config(format!(
            "{} is not an address-search JSON intermediate: {e}",
            input.display()
        ))
    })?;

    if extract.schema_version != EXTRACT_SCHEMA_VERSION {
        return Err(Error::Config(format!(
            "{} has schemaVersion {}, expected {EXTRACT_SCHEMA_VERSION} (the extractor's \
             JSON intermediate, not the packed artifact)",
            input.display(),
            extract.schema_version
        )));
    }
    // Cross-check the intermediate against its own stats here, at pack time,
    // where the operator is standing next to it, rather than letting a corpus
    // that disagrees with itself reach a generation load.
    if extract.stats.row_count != extract.rows.len() {
        return Err(Error::Config(format!(
            "{}: stats.rowCount {} does not match rows length {}",
            input.display(),
            extract.stats.row_count,
            extract.rows.len()
        )));
    }
    if extract.stats.key_count != extract.keys.len() {
        return Err(Error::Config(format!(
            "{}: stats.keyCount {} does not match keys length {}",
            input.display(),
            extract.stats.key_count,
            extract.keys.len()
        )));
    }
    if let (Some(want), Some(found)) = (city, extract.city_id.as_deref()) {
        if want != found {
            return Err(Error::Config(format!(
                "{}: cityId {found:?} does not match --city {want:?}",
                input.display()
            )));
        }
    }

    let rows: Vec<AddrRow> = extract
        .rows
        .into_iter()
        .map(|r| AddrRow {
            label: r.label,
            lat: r.lat,
            lon: r.lon,
        })
        .collect();
    let keys: Vec<AddrKey> = extract
        .keys
        .into_iter()
        .map(|k| AddrKey {
            key: k.key,
            row_id: k.row_id,
        })
        .collect();

    let meta = ArtifactMeta {
        city_id: city.map(str::to_string).or(extract.city_id),
        source: extract.source,
        generated_at: extract.generated_at,
    };

    let packed = pt_geocode::AddrIndex::pack(&rows, &keys, &meta)
        .map_err(|e| Error::Config(format!("packing {} failed: {e}", input.display())))?;

    // Load the bytes back before writing them. Packing and reading live in the
    // same crate, so this cannot catch a format disagreement — what it does
    // catch is a corpus that encodes but does not load (a row no key points at,
    // a label that escapes its section), which would otherwise fail at a
    // generation load in production instead of here.
    let index = pt_geocode::AddrIndex::from_bytes(std::sync::Arc::from(packed.clone()))
        .map_err(|e| Error::Config(format!("packed artifact failed to load back: {e}")))?;
    if index.row_count() != rows.len() {
        return Err(Error::Config(format!(
            "packed artifact holds {} rows, expected {}",
            index.row_count(),
            rows.len()
        )));
    }

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| Error::Config(format!("failed to create {}: {e}", parent.display())))?;
    }
    std::fs::write(out, &packed)
        .map_err(|e| Error::Config(format!("failed to write {}: {e}", out.display())))?;

    Ok((raw.len(), packed.len()))
}
