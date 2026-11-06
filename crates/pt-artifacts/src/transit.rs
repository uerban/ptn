//! Local transit-pack inventory, with independently optional geometry.
//!
//! This is an audit, not a signed publication or a native runtime validator.
//! It verifies advertised file hashes and records the tile bodies that current
//! pack manifests omit. Those new hashes need authenticated publication before
//! an installer can trust them. Neither OSM data nor builders are needed.
use pt_shared::{
    manifest::GenerationManifest,
    pack_manifest::{validate_artifact_path, PackManifest},
    schedule_tile_manifest::ScheduleTileManifest,
    tile_coord::{parse_tile_coords, SCHEDULE_TILE_SIZE_LABEL},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
};

const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransitInventory {
    pub schema_version: u32,
    pub city: String,
    pub pack_id: String,
    pub generation_id: String,
    pub geometry_selected: bool,
    pub files: Vec<InventoryFile>,
    pub omitted_geometry: Vec<String>,
    /// Historical packs listed address data; it is never a transit dependency.
    pub excluded_extras: Vec<String>,
    pub selected_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InventoryFile {
    pub path: String,
    pub kind: String,
    pub sha256: String,
    pub size_bytes: u64,
}

fn invalid(message: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

/// Inspect an immutable local generation. Optional shapes are not opened when
/// omitted, even if their publisher-advertised files are absent locally.
pub fn inspect(root: &Path, geometry: bool) -> io::Result<TransitInventory> {
    let pack_bytes = metadata(root, "pack.json")?;
    let pack: PackManifest = serde_json::from_slice(&pack_bytes).map_err(invalid)?;
    pack.validate_pack_id().map_err(invalid)?;
    let generation_bytes = metadata(root, "generation.json")?;
    let generation: GenerationManifest =
        serde_json::from_slice(&generation_bytes).map_err(invalid)?;
    if generation.manifest_schema_version != 2
        || generation.generation_id != pack.generation_id
        || generation.city_slug != pack.city_slug
        || generation.bundle_sha256 != pack.bundle_id
        || generation.publication_inputs_sha256 != pack.publication_inputs_sha256
        || generation.feed_start_date != pack.feed_start_date
        || generation.created_at != pack.created_at
        || generation.city_tz_iana != pack.city_tz_iana
        || generation
            .window_days
            .is_some_and(|days| days != pack.window_days)
    {
        return Err(invalid("pack/generation identity mismatch"));
    }
    let mut files = BTreeMap::new();
    for (path, bytes) in [
        ("pack.json", &pack_bytes),
        ("generation.json", &generation_bytes),
    ] {
        files.insert(path.to_string(), inventory_bytes(path, "metadata", bytes));
    }
    let mut omitted_geometry = Vec::new();
    let mut excluded_extras = Vec::new();
    for artifact in &pack.artifacts {
        match artifact.kind.as_str() {
            "address-search" => {
                if artifact.required {
                    return Err(invalid(
                        "transit pack requires an independent address extra",
                    ));
                }
                excluded_extras.push(artifact.path.clone());
                continue;
            }
            "shapes-bin" | "legacy-shapes-json" if !geometry => {
                omitted_geometry.push(artifact.path.clone());
                continue;
            }
            "ptb"
            | "pedestrian-transfers-ptft"
            | "departures-idx"
            | "shapes-bin"
            | "color-config"
            | "route-styles"
            | "label-anchors"
            | "schedule-tiles-manifest"
            | "trip-route"
            | "stop-cell"
            | "legacy-meta-json"
            | "legacy-shapes-json" => {}
            other => {
                return Err(invalid(format!(
                    "unsupported transit artifact kind: {other}"
                )))
            }
        }
        let file = inventory_file(root, &artifact.path, &artifact.kind)?;
        if file.size_bytes != artifact.size_bytes || file.sha256 != artifact.sha256 {
            return Err(invalid(format!(
                "artifact size/hash mismatch: {}",
                artifact.path
            )));
        }
        if artifact.kind == "ptb"
            && (artifact.path != "bundle.ptb"
                || artifact.sha256 != pack.bundle_id
                || artifact.size_bytes != generation.bundle_size_bytes)
        {
            return Err(invalid("PTB identity mismatch"));
        }
        if files.insert(file.path.clone(), file).is_some() {
            return Err(invalid("artifact collides with generation metadata"));
        }
    }
    // Generation-advertised sidecars must also be in the pack selection. Shapes
    // can be deliberately omitted; required transit data cannot disappear merely
    // because a manifest's generic `required` flag is false.
    for (path, expected, selected) in [
        ("transfers.bin", generation.transfers_sha256.as_ref(), true),
        (
            "departures-idx.bin",
            generation.departures_idx_sha256.as_ref(),
            true,
        ),
        (
            "shapes.bin",
            generation.shapes_bin_sha256.as_ref(),
            geometry,
        ),
        (
            "color-config.json",
            generation.color_config_sha256.as_ref(),
            true,
        ),
        (
            "route-styles.json",
            generation.route_styles_sha256.as_ref(),
            true,
        ),
        (
            "label-anchors.json",
            generation.label_anchors_sha256.as_ref(),
            true,
        ),
        (
            "trip-route.json",
            generation.trip_route_sha256.as_ref(),
            true,
        ),
        ("stop-cell.json", generation.stop_cell_sha256.as_ref(), true),
        (
            "schedule-tiles/manifest.json",
            generation.schedule_tile_bundle_sha256.as_ref(),
            true,
        ),
    ] {
        if let Some(sha) = expected.filter(|_| selected) {
            if files.get(path).is_none_or(|file| &file.sha256 != sha) {
                return Err(invalid(format!(
                    "generation dependency missing or mismatched: {path}"
                )));
            }
        }
    }
    if generation.has_transfers != generation.transfers_sha256.is_some()
        || generation.has_transfers != generation.transfers_size_bytes.is_some()
    {
        return Err(invalid("inconsistent generation transfers metadata"));
    }
    if let Some(size) = generation.transfers_size_bytes {
        if files
            .get("transfers.bin")
            .is_none_or(|file| file.size_bytes != size)
        {
            return Err(invalid("transfers size mismatch"));
        }
    }
    if generation.schedule_tile_bundle_sha256.is_some()
        != generation.schedule_tile_bundle_hash.is_some()
    {
        return Err(invalid("incomplete schedule-tile identity"));
    }
    if let Some(tile_generation) = &generation.schedule_tile_bundle_hash {
        if tile_generation != &pack.generation_id {
            return Err(invalid("schedule-tile generation mismatch"));
        }
        add_tiles(root, &pack.generation_id, &mut files)?;
    }
    omitted_geometry.sort();
    excluded_extras.sort();
    let files: Vec<_> = files.into_values().collect();
    let selected_bytes = files.iter().try_fold(0u64, |total, file| {
        total
            .checked_add(file.size_bytes)
            .ok_or_else(|| invalid("inventory size overflow"))
    })?;
    Ok(TransitInventory {
        schema_version: 1,
        city: pack.city_slug,
        pack_id: pack.pack_id,
        generation_id: pack.generation_id,
        geometry_selected: geometry,
        files,
        omitted_geometry,
        excluded_extras,
        selected_bytes,
    })
}

fn add_tiles(
    root: &Path,
    generation: &str,
    files: &mut BTreeMap<String, InventoryFile>,
) -> io::Result<()> {
    if !files.contains_key("stop-cell.json") {
        return Err(invalid(
            "schedule tiles require an inventoried stop-cell map",
        ));
    }
    let manifest: ScheduleTileManifest =
        serde_json::from_slice(&metadata(root, "schedule-tiles/manifest.json")?)
            .map_err(invalid)?;
    if manifest.schema_version != 1
        || manifest.bundle_hash != generation
        || manifest.tile_size != 6000
    {
        return Err(invalid("unsupported or mismatched schedule-tile manifest"));
    }
    let stop_cells: BTreeMap<String, String> =
        serde_json::from_slice(&metadata(root, "stop-cell.json")?).map_err(invalid)?;
    let referenced_tiles: BTreeSet<String> = stop_cells.into_values().collect();
    let mut tiles = referenced_tiles.clone();
    let mut sizes = BTreeMap::new();
    if let Some(subdivisions) = manifest.subdivisions {
        for (cell, plan) in subdivisions {
            if parse_tile_coords(&cell).is_none_or(|p| !p.suffix.is_empty())
                || plan.leaves.is_empty()
            {
                return Err(invalid("invalid schedule subdivision"));
            }
            // A subdivided base cell has no tile body; the stop-cell map must
            // name leaf bodies. Include every leaf, even an unreferenced one.
            if referenced_tiles.contains(&cell) {
                return Err(invalid("stop-cell map references a subdivided base tile"));
            }
            for leaf in plan.leaves {
                let coords = format!("{cell}-{}", leaf.suffix);
                if parse_tile_coords(&coords).is_none()
                    || sizes
                        .insert(coords.clone(), leaf.compressed_bytes)
                        .is_some()
                {
                    return Err(invalid("invalid or duplicate subdivision leaf"));
                }
                tiles.insert(coords);
            }
        }
    }
    for coords in &referenced_tiles {
        let parsed = parse_tile_coords(coords)
            .ok_or_else(|| invalid("invalid schedule-tile coordinates"))?;
        if !parsed.suffix.is_empty() && !sizes.contains_key(coords) {
            return Err(invalid(
                "stop-cell map references an undeclared subdivision leaf",
            ));
        }
    }
    for coords in tiles {
        if parse_tile_coords(&coords).is_none() {
            return Err(invalid("invalid schedule-tile coordinates"));
        }
        let path = format!("schedule-tiles/{generation}/{SCHEDULE_TILE_SIZE_LABEL}/{coords}.br");
        let file = inventory_file(root, &path, "schedule-tile")?;
        if sizes
            .get(&coords)
            .is_some_and(|size| *size != file.size_bytes)
        {
            return Err(invalid(format!("schedule-tile size mismatch: {path}")));
        }
        if files.insert(path, file).is_some() {
            return Err(invalid("duplicate schedule-tile artifact"));
        }
    }
    Ok(())
}

/// Reject links at every component; never inventory private data through a
/// generated symlink. The caller owns an immutable root during inspection.
pub(crate) fn file_path(root: &Path, relative: &str) -> io::Result<PathBuf> {
    validate_artifact_path(relative).map_err(invalid)?;
    let mut path = root.to_path_buf();
    let mut parts = relative.split('/').peekable();
    while let Some(part) = parts.next() {
        path.push(part);
        let kind = fs::symlink_metadata(&path)?.file_type();
        if kind.is_symlink()
            || (parts.peek().is_some() && !kind.is_dir())
            || (parts.peek().is_none() && !kind.is_file())
        {
            return Err(invalid(format!("not a regular artifact path: {relative}")));
        }
    }
    Ok(path)
}

pub(crate) fn metadata(root: &Path, relative: &str) -> io::Result<Vec<u8>> {
    let file = File::open(file_path(root, relative)?)?;
    let mut bytes = Vec::new();
    file.take(MAX_METADATA_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err(invalid(format!("metadata exceeds limit: {relative}")));
    }
    Ok(bytes)
}

fn inventory_file(root: &Path, relative: &str, kind: &str) -> io::Result<InventoryFile> {
    let mut file = File::open(file_path(root, relative)?)?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        size += count as u64;
    }
    Ok(InventoryFile {
        path: relative.to_string(),
        kind: kind.to_string(),
        sha256: format!("{:x}", hasher.finalize()),
        size_bytes: size,
    })
}

fn inventory_bytes(path: &str, kind: &str, bytes: &[u8]) -> InventoryFile {
    InventoryFile {
        path: path.to_string(),
        kind: kind.to_string(),
        sha256: format!("{:x}", Sha256::digest(bytes)),
        size_bytes: bytes.len() as u64,
    }
}
