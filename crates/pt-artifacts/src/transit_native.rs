//! Builder-free native validation of a selected immutable transit generation.
//! Hash/closure checks run first; native parsers do not authenticate the source.
use crate::transit::{self, TransitInventory};
use pt_core::{Reader, Transfers};
use pt_shared::{
    manifest::GenerationManifest, sidecar, validate::namespace::bundle_namespace_shas,
};
use std::{fs::File, io, path::Path, sync::Arc, time::SystemTime};

#[derive(Clone)]
struct Mapping(Arc<memmap2::Mmap>);
impl AsRef<[u8]> for Mapping {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}
fn invalid(message: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}
fn map(root: &Path, relative: &str) -> io::Result<Mapping> {
    let file = File::open(transit::file_path(root, relative)?)?;
    // Caller owns an immutable generation throughout validation. Read-only
    // mmap avoids allocating a second full PTB on constrained hosts.
    Ok(Mapping(Arc::new(unsafe { memmap2::Mmap::map(&file)? })))
}

/// Validate selected binaries using the same structural/metadata/sidecar readers
/// as pt-serve. This does not build a routing index, start a server, or establish
/// completeness of the frontend JSON schema. Optional geometry is never opened
/// when omitted. `now` is explicit for reproducible offline validation.
pub fn validate(root: &Path, geometry: bool, now: SystemTime) -> io::Result<TransitInventory> {
    let inventory = transit::inspect(root, geometry)?;
    let manifest: GenerationManifest =
        serde_json::from_slice(&transit::metadata(root, "generation.json")?).map_err(invalid)?;
    let bundle = map(root, "bundle.ptb")?;
    pt_core::validate::structural::validate_structural(bundle.as_ref())
        .map_err(|e| invalid(format!("PTB structure: {e:?}")))?;
    let reader =
        Reader::from_bytes(bundle.clone()).map_err(|e| invalid(format!("PTB reader: {e:?}")))?;
    let transfers = if manifest.has_transfers {
        Some(map(root, "transfers.bin")?)
    } else {
        None
    };
    pt_shared::validate::metadata::validate_metadata(
        &manifest,
        bundle.as_ref(),
        transfers.as_ref().map(AsRef::as_ref),
        &inventory.city,
        reader.feed_start_date(),
        now,
        true,
    )
    .map_err(invalid)?;
    if let Some(transfers) = &transfers {
        Transfers::from_bytes(transfers.as_ref())
            .map_err(|e| invalid(format!("PTFT structure: {e:?}")))?;
    }
    let iana = manifest
        .city_tz_iana
        .as_deref()
        .ok_or_else(|| invalid("generation lacks city timezone"))?;
    let offset = pt_shared::tz::offset_at_anchor(iana, reader.feed_start_date())
        .map_err(|e| invalid(format!("PTB timezone: {e:?}")))?;
    if offset != reader.header().city_tz_offset_seconds {
        return Err(invalid("PTB timezone offset mismatch"));
    }
    let (trips_sha, stops_sha) = bundle_namespace_shas(&reader).map_err(invalid)?;
    for file in &inventory.files {
        match file.kind.as_str() {
            "departures-idx" => {
                let bytes = map(root, &file.path)?;
                let index = sidecar::DeparturesIdx::parse(bytes.as_ref(), &trips_sha, &stops_sha)
                    .map_err(invalid)?;
                if index.num_stops() != reader.num_stops() {
                    return Err(invalid("DPIX stop count mismatch"));
                }
                for stop in 0..index.num_stops() {
                    if index.entries_iter(stop).any(|(trip, row)| {
                        trip as usize >= reader.num_trips()
                            || row as usize >= reader.num_stop_times()
                    }) {
                        return Err(invalid("DPIX trip reference out of range"));
                    }
                }
            }
            "shapes-bin" => {
                let bytes = map(root, &file.path)?;
                let shapes = sidecar::ShapesBin::parse(bytes.as_ref(), &trips_sha, &stops_sha)
                    .map_err(invalid)?;
                let (hash, size) = sidecar::shapes_json_sha256(&shapes);
                let hash: String = hash.iter().map(|b| format!("{b:02x}")).collect();
                if manifest
                    .shapes_json_sha256
                    .as_ref()
                    .is_some_and(|expected| expected != &hash)
                    || manifest
                        .shapes_json_size_bytes
                        .is_some_and(|expected| expected != size)
                {
                    return Err(invalid("generated shapes JSON hash/size mismatch"));
                }
            }
            "metadata" | "ptb" | "pedestrian-transfers-ptft" => {}
            "schedule-tile" => {
                // Compressed tile hashes were verified by inventory. Bound the
                // decoder's output independently of its compressed size.
                validate_tile(root, &file.path, &inventory.city, &inventory.generation_id)?;
            }
            _ => {
                // All remaining supported selected sidecars are JSON. This is
                // syntax validation; semantic loaders retain their own checks.
                serde_json::from_slice::<serde_json::Value>(&transit::metadata(root, &file.path)?)
                    .map_err(invalid)?;
            }
        }
    }
    Ok(inventory)
}

const MAX_TILE_JSON_BYTES: u64 = 64 * 1024 * 1024;
fn validate_tile(root: &Path, path: &str, city: &str, generation: &str) -> io::Result<()> {
    use std::io::Read;
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Identity {
        v: u32,
        bundle_hash: String,
        city_id: String,
        tile_size: u32,
    }
    let input = File::open(transit::file_path(root, path)?)?;
    let mut json = Vec::new();
    brotli::Decompressor::new(input, 64 * 1024)
        .take(MAX_TILE_JSON_BYTES + 1)
        .read_to_end(&mut json)?;
    if json.len() as u64 > MAX_TILE_JSON_BYTES {
        return Err(invalid("decoded schedule tile exceeds limit"));
    }
    let identity: Identity = serde_json::from_slice(&json).map_err(invalid)?;
    if identity.v != 1
        || identity.bundle_hash != generation
        || identity.city_id != city
        || identity.tile_size != 6000
    {
        return Err(invalid("schedule tile identity mismatch"));
    }
    serde_json::from_slice::<pt_shared::schedule_tile_wire::ScheduleTileTripMembership>(&json)
        .map_err(invalid)?;
    Ok(())
}
