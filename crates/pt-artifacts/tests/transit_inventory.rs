use pt_artifacts::transit::inspect;
use pt_shared::{
    manifest::{publication_id, GenerationManifest},
    pack_manifest::{PackArtifact, PackManifest},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct Fixture {
    root: tempfile::TempDir,
    pack: PackManifest,
    generation: GenerationManifest,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let bundle = b"fixture timetable: inventory hashes, not native PTB validation";
        let bundle_id = digest(bundle);
        let inputs = digest(b"fixture input identity");
        let generation_id = publication_id(&bundle_id, &inputs);
        let pack = serde_json::from_value(json!({
            "schemaVersion": 2, "packId": "", "bundleId": bundle_id,
            "generationId": generation_id, "publicationInputsSha256": inputs,
            "citySlug": "fixture", "cityTzIana": "Europe/Vilnius",
            "createdAt": "2026-11-06T00:00:00Z", "feedStartDate": 20261106,
            "windowDays": 90, "serviceEndDate": 20270203,
            "staleAfter": "2027-01-20", "hardExpireAfter": "2027-02-03",
            "stopBBox": [0,0,1,1], "coverageBBox": [0,0,1,1],
            "rights": {"redistributable":false,"status":"fixture","note":"synthetic"},
            "artifacts": []
        }))
        .unwrap();
        let generation = serde_json::from_value(json!({
            "manifestSchemaVersion": 2, "generationId": generation_id,
            "citySlug": "fixture", "bundleSha256": bundle_id,
            "publicationInputsSha256": inputs, "bundleSizeBytes": bundle.len(),
            "feedStartDate": 20261106, "hasTransfers": false,
            "createdAt": "2026-11-06T00:00:00Z", "cityTzIana":"Europe/Vilnius",
            "windowDays":90
        }))
        .unwrap();
        let mut fixture = Self {
            root,
            pack,
            generation,
        };
        fixture.artifact("ptb", "bundle.ptb", bundle);
        fixture.pack.artifacts[0].required = true;
        fixture.save();
        fixture
    }

    fn path(&self) -> &Path {
        self.root.path()
    }

    fn artifact(&mut self, kind: &str, path: &str, bytes: &[u8]) {
        let destination = self.path().join(path);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(destination, bytes).unwrap();
        self.pack.artifacts.push(PackArtifact {
            kind: kind.into(),
            path: path.into(),
            sha256: digest(bytes),
            size_bytes: bytes.len() as u64,
            required: false,
            media_type: "application/octet-stream".into(),
            cache: "immutable".into(),
            bbox: None,
            namespaces: Default::default(),
            encoding: None,
            derived_from: vec![],
            format_version: None,
        });
    }

    fn save(&mut self) {
        self.pack.pack_id = self.pack.compute_pack_id().unwrap();
        fs::write(
            self.path().join("pack.json"),
            serde_json::to_vec(&self.pack).unwrap(),
        )
        .unwrap();
        fs::write(
            self.path().join("generation.json"),
            serde_json::to_vec(&self.generation).unwrap(),
        )
        .unwrap();
    }

    fn tiles(&mut self, subdivisions: bool) -> String {
        let id = self.pack.generation_id.clone();
        let mut manifest =
            json!({"schemaVersion":1,"bundleHash":id,"generatedAt":0,"tileSize":6000});
        if subdivisions {
            manifest["subdivisions"] = json!({"1_2":{"leaves":[
                {"suffix":"0","bbox":{"minLat":0,"maxLat":1,"minLon":0,"maxLon":1},"compressedBytes":4,"oversized":false},
                {"suffix":"1","bbox":{"minLat":0,"maxLat":1,"minLon":1,"maxLon":2},"compressedBytes":4,"oversized":false}
            ]}});
        }
        let manifest = serde_json::to_vec(&manifest).unwrap();
        self.artifact(
            "schedule-tiles-manifest",
            "schedule-tiles/manifest.json",
            &manifest,
        );
        self.generation.schedule_tile_bundle_sha256 = Some(digest(&manifest));
        self.generation.schedule_tile_bundle_hash = Some(id.clone());
        let cells =
            serde_json::to_vec(&json!({"stop":if subdivisions {"1_2-0"} else {"1_2"}})).unwrap();
        self.artifact("stop-cell", "stop-cell.json", &cells);
        self.generation.stop_cell_sha256 = Some(digest(&cells));
        let directory = self.path().join(format!("schedule-tiles/{id}/6km"));
        fs::create_dir_all(&directory).unwrap();
        let coords = if subdivisions { "1_2-0" } else { "1_2" };
        fs::write(directory.join(format!("{coords}.br")), b"tile").unwrap();
        if subdivisions {
            fs::write(directory.join("1_2-1.br"), b"leaf").unwrap();
        }
        self.save();
        format!("schedule-tiles/{id}/6km/{coords}.br")
    }
}

#[test]
fn geometry_selection_keeps_pack_identity_and_needs_no_extras() {
    let mut fixture = Fixture::new();
    fixture.artifact("shapes-bin", "shapes.bin", b"shapes");
    fixture.artifact("legacy-shapes-json", "bundle.ptb.shapes.json", b"{}");
    fixture.generation.shapes_bin_sha256 = Some(digest(b"shapes"));
    fixture.artifact("address-search", "address-search.fst", b"independent extra");
    fixture.save();
    let with_geometry = inspect(fixture.path(), true).unwrap();
    fs::remove_file(fixture.path().join("address-search.fst")).unwrap();
    fs::remove_file(fixture.path().join("shapes.bin")).unwrap();
    fs::remove_file(fixture.path().join("bundle.ptb.shapes.json")).unwrap();
    let without = inspect(fixture.path(), false).unwrap();
    assert_eq!(with_geometry.pack_id, without.pack_id);
    assert_eq!(without.pack_id, fixture.pack.pack_id);
    assert_eq!(
        without.omitted_geometry,
        ["bundle.ptb.shapes.json", "shapes.bin"]
    );
    assert_eq!(without.excluded_extras, ["address-search.fst"]);
    assert!(without.selected_bytes < with_geometry.selected_bytes);
    assert!(inspect(fixture.path(), true).is_err());
    assert!(without
        .files
        .iter()
        .all(|file| !file.path.contains("shapes") && !file.path.contains("address")));
}

#[test]
fn selected_geometry_corruption_fails_without_affecting_geometry_free_selection() {
    let mut fixture = Fixture::new();
    fixture.artifact("shapes-bin", "shapes.bin", b"shapes");
    fixture.save();
    fs::write(fixture.path().join("shapes.bin"), b"broken").unwrap();
    assert!(inspect(fixture.path(), true)
        .unwrap_err()
        .to_string()
        .contains("size/hash"));
    assert!(inspect(fixture.path(), false).is_ok());
}

#[test]
fn advertised_transfers_are_needed_even_when_generic_required_flag_is_false() {
    let mut fixture = Fixture::new();
    fixture.artifact("pedestrian-transfers-ptft", "transfers.bin", b"transfer");
    fixture.generation.has_transfers = true;
    fixture.generation.transfers_sha256 = Some(digest(b"transfer"));
    fixture.generation.transfers_size_bytes = Some(8);
    fixture.save();
    assert!(inspect(fixture.path(), false).is_ok());
    fs::remove_file(fixture.path().join("transfers.bin")).unwrap();
    assert!(inspect(fixture.path(), false).is_err());
    fixture
        .pack
        .artifacts
        .retain(|artifact| artifact.kind != "pedestrian-transfers-ptft");
    fixture.save();
    assert!(inspect(fixture.path(), false)
        .unwrap_err()
        .to_string()
        .contains("dependency missing"));
}

#[test]
fn inventories_unlisted_tile_bodies_and_rejects_missing_body() {
    let mut fixture = Fixture::new();
    let tile = fixture.tiles(false);
    let first = inspect(fixture.path(), false).unwrap();
    assert!(first
        .files
        .iter()
        .any(|file| file.path == tile && file.sha256 == digest(b"tile")));
    let second = inspect(fixture.path(), false).unwrap();
    assert_eq!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&second).unwrap()
    );
    fs::remove_file(fixture.path().join(tile)).unwrap();
    assert!(inspect(fixture.path(), false).is_err());
}

#[test]
fn includes_every_subdivision_leaf_not_only_stop_cell_references() {
    let mut fixture = Fixture::new();
    fixture.tiles(true);
    let report = inspect(fixture.path(), false).unwrap();
    assert_eq!(
        report
            .files
            .iter()
            .filter(|file| file.kind == "schedule-tile")
            .count(),
        2
    );
    let other = format!("schedule-tiles/{}/6km/1_2-1.br", fixture.pack.generation_id);
    fs::remove_file(fixture.path().join(other)).unwrap();
    assert!(inspect(fixture.path(), false).is_err());
}

#[test]
fn rejects_stop_cell_references_to_an_undeclared_leaf() {
    let mut fixture = Fixture::new();
    fixture.tiles(true);
    fixture.pack.artifacts.retain(|a| a.kind != "stop-cell");
    let cells = br#"{"stop":"1_2-3"}"#;
    fixture.artifact("stop-cell", "stop-cell.json", cells);
    fixture.generation.stop_cell_sha256 = Some(digest(cells));
    fixture.save();
    assert!(inspect(fixture.path(), false)
        .unwrap_err()
        .to_string()
        .contains("undeclared subdivision leaf"));
}

#[test]
fn rejects_mixed_generation_and_wrong_pack_id() {
    let mut fixture = Fixture::new();
    fixture.generation.city_slug = "other-city".into();
    fixture.save();
    assert!(inspect(fixture.path(), false)
        .unwrap_err()
        .to_string()
        .contains("identity mismatch"));
    fixture.generation.city_slug = fixture.pack.city_slug.clone();
    fixture.save();
    let path = fixture.path().join("pack.json");
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    value["packId"] = json!("0".repeat(64));
    fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(inspect(fixture.path(), false)
        .unwrap_err()
        .to_string()
        .contains("packId"));
}

#[test]
fn refuses_unknown_extra_kinds_instead_of_silently_treating_them_as_transit() {
    let mut fixture = Fixture::new();
    fixture.artifact("poi", "poi.bin", b"not transit");
    fixture.save();
    assert!(inspect(fixture.path(), false)
        .unwrap_err()
        .to_string()
        .contains("unsupported transit artifact"));
}

#[cfg(unix)]
#[test]
fn rejects_nested_symlink_for_a_tile() {
    let mut fixture = Fixture::new();
    fixture.tiles(false);
    let directory = fixture
        .path()
        .join(format!("schedule-tiles/{}/6km", fixture.pack.generation_id));
    let outside = tempfile::tempdir().unwrap();
    fs::rename(&directory, outside.path().join("tiles")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("tiles"), &directory).unwrap();
    assert!(inspect(fixture.path(), false)
        .unwrap_err()
        .to_string()
        .contains("regular artifact path"));
}
