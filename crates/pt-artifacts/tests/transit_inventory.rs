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

    fn native() -> Self {
        let mut fixture = Self::new();
        let bytes = include_bytes!("../../../packages/shared/src/ptb/__fixtures__/tiny.ptb");
        fixture.replace_bundle(bytes);
        fixture.pack.city_tz_iana = Some("Europe/Vilnius".into());
        fixture.generation.city_tz_iana = Some("Europe/Vilnius".into());
        let reader = pt_core::Reader::from_bytes(bytes.to_vec()).unwrap();
        fixture.pack.feed_start_date = reader.feed_start_date();
        fixture.generation.feed_start_date = reader.feed_start_date();
        fixture.save();
        fixture
    }

    fn replace_bundle(&mut self, bytes: &[u8]) {
        fs::write(self.path().join("bundle.ptb"), bytes).unwrap();
        self.pack.bundle_id = digest(bytes);
        self.pack.generation_id =
            publication_id(&self.pack.bundle_id, &self.pack.publication_inputs_sha256);
        self.generation.bundle_sha256 = self.pack.bundle_id.clone();
        self.generation.generation_id = self.pack.generation_id.clone();
        self.generation.bundle_size_bytes = bytes.len() as u64;
        self.pack.artifacts[0].sha256 = digest(bytes);
        self.pack.artifacts[0].size_bytes = bytes.len() as u64;
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

#[test]
fn signed_export_preserves_identity_and_excludes_unselected_data() {
    use ed25519_dalek::{Signer, SigningKey};
    use pt_artifacts::transit_export::{export, verify};
    let mut fixture = Fixture::new();
    fixture.artifact("shapes-bin", "shapes.bin", b"optional geometry");
    fixture.artifact("address-search", "address.bin", b"independent extra");
    fixture.tiles(true);
    fixture.save();
    fs::write(fixture.path().join("private-source.txt"), b"never export").unwrap();
    let parent = tempfile::tempdir().unwrap();
    let output = parent.path().join("export");
    let key = SigningKey::from_bytes(&[17; 32]);
    let id = export(fixture.path(), &output, false, &key).unwrap();
    let bytes = fs::read(output.join("selection.json")).unwrap();
    let sig = fs::read(output.join("selection.json.sig")).unwrap();
    assert_eq!(id, digest(&bytes));
    let keys = [key.verifying_key().to_bytes()];
    let selection = verify(&bytes, &sig, &keys, "fixture").unwrap();
    assert_eq!(selection.pack_id, fixture.pack.pack_id);
    assert!(!selection.geometry_selected);
    assert!(!output.join("files/shapes.bin").exists());
    assert!(!output.join("files/address.bin").exists());
    assert!(!output.join("files/private-source.txt").exists());
    for file in selection.files {
        let body = fs::read(output.join("files").join(file.path)).unwrap();
        assert_eq!(digest(&body), file.sha256);
        assert_eq!(body.len() as u64, file.size_bytes);
    }
    assert!(verify(&bytes, &sig, &[], "fixture").is_err());
    assert!(verify(&bytes, &sig, &keys, "another-city").is_err());
    for case in 0..3 {
        let mut descriptor: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        match case {
            0 => descriptor["files"][0]["path"] = json!("../outside"),
            1 => descriptor["selectedBytes"] = json!(0),
            _ => {
                let duplicate = descriptor["files"][0].clone();
                descriptor["files"].as_array_mut().unwrap().push(duplicate);
            }
        }
        let body = serde_json::to_vec(&descriptor).unwrap();
        let message = [b"PTN-TRANSIT-SELECTION-v1\0".as_slice(), &body].concat();
        assert!(verify(&body, &key.sign(&message).to_bytes(), &keys, "fixture").is_err());
    }

    let mut tampered = bytes.clone();
    tampered.push(b' ');
    assert!(verify(&tampered, &sig, &keys, "fixture").is_err());
    // Neither a raw Ed25519 signature nor the OSM catalog signing domain works.
    for message in [
        bytes.clone(),
        pt_artifacts::catalog::signing_message(&bytes).unwrap(),
    ] {
        assert!(verify(&bytes, &key.sign(&message).to_bytes(), &keys, "fixture").is_err());
    }
    assert!(export(fixture.path(), &output, false, &key).is_err());
    assert_eq!(fs::read(output.join("selection.json")).unwrap(), bytes);
    let full = parent.path().join("full");
    assert_ne!(export(fixture.path(), &full, true, &key).unwrap(), id);
    let full_selection = verify(
        &fs::read(full.join("selection.json")).unwrap(),
        &fs::read(full.join("selection.json.sig")).unwrap(),
        &keys,
        "fixture",
    )
    .unwrap();
    assert_eq!(full_selection.pack_id, fixture.pack.pack_id);
    assert!(full.join("files/shapes.bin").exists());
}

#[test]
fn corrupt_source_does_not_create_export_directory() {
    use ed25519_dalek::SigningKey;
    let fixture = Fixture::new();
    let parent = tempfile::tempdir().unwrap();
    let output = parent.path().join("export");
    fs::write(fixture.path().join("bundle.ptb"), b"corrupt").unwrap();
    assert!(pt_artifacts::transit_export::export(
        fixture.path(),
        &output,
        true,
        &SigningKey::from_bytes(&[17; 32])
    )
    .is_err());
    assert!(!output.exists());
}

#[test]
fn catalog_cli_checks_both_exports_before_preparing_a_head() {
    use ed25519_dalek::SigningKey;
    use pt_artifacts::{transit_catalog, transit_export};
    use std::process::Command;
    let mut fixture = Fixture::native();
    let reader =
        pt_core::Reader::from_bytes(fs::read(fixture.path().join("bundle.ptb")).unwrap()).unwrap();
    let (trips, stops) = pt_shared::validate::namespace::bundle_namespace_shas(&reader).unwrap();
    let shapes = pt_shared::sidecar::encode_shapes_bin(&[], &trips, &stops).unwrap();
    fixture.artifact("shapes-bin", "shapes.bin", &shapes);
    fixture.save();
    let parent = tempfile::tempdir().unwrap();
    let key = SigningKey::from_bytes(&[17; 32]);
    let public: String = key
        .verifying_key()
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let seed = parent.path().join("seed");
    fs::write(&seed, "11".repeat(32)).unwrap();
    let minimal = parent.path().join("minimal");
    let full = parent.path().join("full");
    transit_export::export(fixture.path(), &minimal, false, &key).unwrap();
    transit_export::export(fixture.path(), &full, true, &key).unwrap();
    let output = parent.path().join("head");
    let run = |output: &Path| {
        Command::new(env!("CARGO_BIN_EXE_pt-pack-catalog"))
            .arg("--selection")
            .arg(&minimal)
            .arg("--selection")
            .arg(&full)
            .args([
                "--city",
                "fixture",
                "--sequence",
                "1",
                "--expires-at",
                "2099-01-01T00:00:00Z",
            ])
            .arg("--signing-key")
            .arg(&seed)
            .arg("--trusted-key")
            .arg(&public)
            .arg("--output")
            .arg(output)
            .output()
            .unwrap()
    };
    let result = run(&output);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let bytes = fs::read(output.join("latest.json")).unwrap();
    let signature = fs::read(output.join("latest.json.sig")).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let keys = [key.verifying_key().to_bytes()];
    let head = transit_catalog::verify(&bytes, &signature, &keys, "fixture", None, now).unwrap();
    assert_eq!(head.selections.len(), 2);
    for (root, geometry) in [(&minimal, false), (&full, true)] {
        transit_catalog::verify_selection(
            &head,
            &fs::read(root.join("selection.json")).unwrap(),
            &fs::read(root.join("selection.json.sig")).unwrap(),
            &keys,
            geometry,
        )
        .unwrap();
    }
    assert!(!run(&output).status.success());
    assert_eq!(fs::read(output.join("latest.json")).unwrap(), bytes);
    fs::write(full.join("files/shapes.bin"), b"corrupt").unwrap();
    let failed = parent.path().join("failed-head");
    assert!(!run(&failed).status.success());
    assert!(!failed.exists());
}

fn validate_native(
    fixture: &Fixture,
    geometry: bool,
) -> std::io::Result<pt_artifacts::transit::TransitInventory> {
    pt_artifacts::transit_native::validate(fixture.path(), geometry, std::time::SystemTime::now())
}

#[test]
fn native_validation_rejects_hash_correct_invalid_ptb_metadata_and_timezone() {
    let mut fixture = Fixture::native();
    validate_native(&fixture, false).unwrap();
    fixture.pack.city_tz_iana = Some("Etc/UTC".into());
    fixture.generation.city_tz_iana = Some("Etc/UTC".into());
    fixture.save();
    assert!(validate_native(&fixture, false)
        .unwrap_err()
        .to_string()
        .contains("timezone"));
    fixture.pack.city_tz_iana = Some("Europe/Vilnius".into());
    fixture.generation.city_tz_iana = Some("Europe/Vilnius".into());
    fixture.pack.feed_start_date = 20261106;
    fixture.generation.feed_start_date = 20261106;
    fixture.save();
    assert!(validate_native(&fixture, false).is_err());
    fixture.replace_bundle(b"hash-correct but not PTB");
    fixture.save();
    inspect(fixture.path(), false).unwrap();
    assert!(validate_native(&fixture, false)
        .unwrap_err()
        .to_string()
        .contains("PTB structure"));
}

#[test]
fn native_validation_checks_transfers_departures_and_sidecar_namespace() {
    use pt_shared::{sidecar, validate::namespace::bundle_namespace_shas};
    let mut fixture = Fixture::native();
    let reader =
        pt_core::Reader::from_bytes(fs::read(fixture.path().join("bundle.ptb")).unwrap()).unwrap();
    let (trips, stops) = bundle_namespace_shas(&reader).unwrap();
    let valid =
        sidecar::encode_departures_idx(&vec![0; reader.num_stops() + 1], &[], &trips, &stops)
            .unwrap();
    fixture.artifact("departures-idx", "departures-idx.bin", &valid);
    fixture.generation.departures_idx_sha256 = Some(digest(&valid));
    fixture.artifact(
        "pedestrian-transfers-ptft",
        "transfers.bin",
        b"PTFT\x01\x00",
    );
    fixture.generation.has_transfers = true;
    fixture.generation.transfers_sha256 = Some(digest(b"PTFT\x01\x00"));
    fixture.generation.transfers_size_bytes = Some(6);
    fixture.save();
    validate_native(&fixture, false).unwrap();
    let foreign =
        sidecar::encode_departures_idx(&vec![0; reader.num_stops() + 1], &[], &[99; 32], &stops)
            .unwrap();
    fs::write(fixture.path().join("departures-idx.bin"), &foreign).unwrap();
    fixture.pack.artifacts[1].sha256 = digest(&foreign);
    fixture.generation.departures_idx_sha256 = Some(digest(&foreign));
    fixture.save();
    inspect(fixture.path(), false).unwrap();
    assert!(validate_native(&fixture, false).is_err());
    fs::write(fixture.path().join("departures-idx.bin"), &valid).unwrap();
    fixture.pack.artifacts[1].sha256 = digest(&valid);
    fixture.generation.departures_idx_sha256 = Some(digest(&valid));
    fs::write(fixture.path().join("transfers.bin"), b"broken").unwrap();
    fixture.pack.artifacts[2].sha256 = digest(b"broken");
    fixture.generation.transfers_sha256 = Some(digest(b"broken"));
    fixture.save();
    inspect(fixture.path(), false).unwrap();
    assert!(validate_native(&fixture, false)
        .unwrap_err()
        .to_string()
        .contains("PTFT structure"));
}

#[test]
fn native_geometry_validation_checks_generated_body_without_reading_omitted_shapes() {
    use pt_shared::{sidecar, validate::namespace::bundle_namespace_shas};
    let mut fixture = Fixture::native();
    let reader =
        pt_core::Reader::from_bytes(fs::read(fixture.path().join("bundle.ptb")).unwrap()).unwrap();
    let (trips, stops) = bundle_namespace_shas(&reader).unwrap();
    let shapes = sidecar::encode_shapes_bin(&[], &trips, &stops).unwrap();
    fixture.artifact("shapes-bin", "shapes.bin", &shapes);
    fixture.generation.shapes_bin_sha256 = Some(digest(&shapes));
    fixture.save();
    let full = validate_native(&fixture, true).unwrap();
    fixture.generation.shapes_json_sha256 = Some(digest(b"wrong generated JSON"));
    fixture.save();
    assert!(validate_native(&fixture, true)
        .unwrap_err()
        .to_string()
        .contains("shapes JSON"));
    fs::remove_file(fixture.path().join("shapes.bin")).unwrap();
    assert_eq!(
        validate_native(&fixture, false).unwrap().pack_id,
        full.pack_id
    );
}

#[test]
fn native_tile_validation_decodes_identity_and_parallel_arrays() {
    use std::io::Write;
    let mut fixture = Fixture::native();
    let tile = fixture.tiles(false);
    let json = json!({"v":1,"bundleHash":fixture.pack.generation_id,"cityId":"fixture","tileSize":6000,
        "stringTable":["trip"],"trips":[{"tripIdIx":0}],"stops":{"stop":{"tripIxs":[0],"departureSecs":[1]}}});
    let write_tile = |json: &serde_json::Value| {
        let mut compressed = Vec::new();
        {
            let mut writer = brotli::CompressorWriter::new(&mut compressed, 4096, 3, 22);
            writer
                .write_all(&serde_json::to_vec(json).unwrap())
                .unwrap();
        }
        fs::write(fixture.path().join(&tile), compressed).unwrap();
    };
    write_tile(&json);
    validate_native(&fixture, false).unwrap();
    let mut invalid = json.clone();
    invalid["bundleHash"] = json!(digest(b"other generation"));
    write_tile(&invalid);
    assert!(validate_native(&fixture, false)
        .unwrap_err()
        .to_string()
        .contains("tile identity"));
    let mut invalid = json;
    invalid["stops"]["stop"]["departureSecs"] = json!([]);
    write_tile(&invalid);
    assert!(validate_native(&fixture, false).is_err());
}

#[test]
fn native_departures_validation_rejects_counts_and_out_of_range_references() {
    use pt_shared::{sidecar, validate::namespace::bundle_namespace_shas};
    for case in 0..3 {
        let mut fixture = Fixture::native();
        let reader =
            pt_core::Reader::from_bytes(fs::read(fixture.path().join("bundle.ptb")).unwrap())
                .unwrap();
        let (trips, stops) = bundle_namespace_shas(&reader).unwrap();
        let mut offsets = vec![0; reader.num_stops() + 1];
        let entries = match case {
            0 => {
                offsets.push(0);
                vec![]
            }
            1 => {
                offsets[reader.num_stops()] = 1;
                vec![reader.num_trips() as u32, 0]
            }
            _ => {
                offsets[reader.num_stops()] = 1;
                vec![0, reader.num_stop_times() as u32]
            }
        };
        let bytes = sidecar::encode_departures_idx(&offsets, &entries, &trips, &stops).unwrap();
        fixture.artifact("departures-idx", "departures-idx.bin", &bytes);
        fixture.generation.departures_idx_sha256 = Some(digest(&bytes));
        fixture.save();
        inspect(fixture.path(), false).unwrap();
        assert!(validate_native(&fixture, false).is_err());
    }
}

#[test]
fn export_cli_rejects_hash_correct_non_native_bundle_before_signing() {
    let fixture = Fixture::new();
    let parent = tempfile::tempdir().unwrap();
    let seed = parent.path().join("seed");
    fs::write(&seed, "11".repeat(32)).unwrap();
    let output = parent.path().join("export");
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_pt-pack-export"))
        .arg("--generation")
        .arg(fixture.path())
        .arg("--output")
        .arg(&output)
        .arg("--signing-key")
        .arg(&seed)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("PTB structure"));
    assert!(!output.exists());
}

struct TransitRepository {
    root: tempfile::TempDir,
    key: ed25519_dalek::SigningKey,
}
impl TransitRepository {
    fn new() -> Self {
        Self {
            root: tempfile::tempdir().unwrap(),
            key: ed25519_dalek::SigningKey::from_bytes(&[17; 32]),
        }
    }
    fn source(&self) -> pt_artifacts::install::LocalRepository {
        pt_artifacts::install::LocalRepository(self.root.path().into())
    }
    fn keys(&self) -> [[u8; 32]; 1] {
        [self.key.verifying_key().to_bytes()]
    }
    fn head_path(&self) -> std::path::PathBuf {
        self.root
            .path()
            .join("transit/catalog/v1/fixture/latest.json")
    }
    fn publish(&self, fixture: &Fixture, sequence: u64, variants: &[bool]) -> Vec<String> {
        use pt_artifacts::{
            transit_catalog::{self, Catalog, Selection},
            transit_export,
        };
        let now = transit_now();
        let mut selections = Vec::new();
        for geometry in variants {
            let staging = tempfile::tempdir().unwrap();
            let export = staging.path().join("export");
            let id = transit_export::export(fixture.path(), &export, *geometry, &self.key).unwrap();
            let bytes = fs::read(export.join("selection.json")).unwrap();
            let inventory = transit_export::verify(
                &bytes,
                &fs::read(export.join("selection.json.sig")).unwrap(),
                &self.keys(),
                "fixture",
            )
            .unwrap();
            let release = self.root.path().join("transit/selections").join(&id);
            fs::create_dir_all(&release).unwrap();
            for name in ["selection.json", "selection.json.sig"] {
                fs::copy(export.join(name), release.join(name)).unwrap();
            }
            let objects = self.root.path().join("transit/objects/sha256");
            fs::create_dir_all(&objects).unwrap();
            for file in inventory.files {
                fs::copy(
                    export.join("files").join(file.path),
                    objects.join(file.sha256),
                )
                .unwrap();
            }
            selections.push(Selection {
                sha256: id,
                bytes: bytes.len() as u64,
                geometry_selected: *geometry,
            });
        }
        let catalog = Catalog {
            schema_version: 1,
            city: "fixture".into(),
            sequence,
            pack_id: fixture.pack.pack_id.clone(),
            generation_id: fixture.pack.generation_id.clone(),
            published_at: jiff::Timestamp::from_second(now).unwrap().to_string(),
            expires_at: jiff::Timestamp::from_second(now + 86400)
                .unwrap()
                .to_string(),
            selections,
        };
        let (bytes, sig) = transit_catalog::prepare(&catalog, &self.key, now).unwrap();
        fs::create_dir_all(self.head_path().parent().unwrap()).unwrap();
        fs::write(self.head_path(), bytes).unwrap();
        fs::write(self.head_path().with_extension("json.sig"), sig).unwrap();
        catalog.selections.into_iter().map(|s| s.sha256).collect()
    }
}
fn transit_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
fn minimal_policy() -> pt_artifacts::transit_install::Policy {
    pt_artifacts::transit_install::Policy {
        geometry: false,
        ..Default::default()
    }
}

#[test]
fn transit_install_switches_geometry_and_rolls_back_without_rewinding_checkpoint() {
    use pt_artifacts::transit_install::{Policy, TransitStore};
    let fixture = Fixture::native();
    let repo = TransitRepository::new();
    let ids = repo.publish(&fixture, 1, &[false, true]);
    let root = tempfile::tempdir().unwrap();
    let store = TransitStore::open(root.path()).unwrap();
    assert!(TransitStore::open(root.path()).is_err());
    assert!(store
        .sync(
            &repo.source(),
            "fixture",
            &repo.keys(),
            transit_now(),
            &minimal_policy()
        )
        .unwrap());
    let first = store.status("fixture").unwrap().unwrap();
    assert_eq!(first.current.selection, ids[0]);
    assert_eq!(first.revision, 1);
    assert!(!store
        .sync(
            &repo.source(),
            "fixture",
            &repo.keys(),
            transit_now(),
            &minimal_policy()
        )
        .unwrap());
    assert_eq!(store.status("fixture").unwrap().unwrap().revision, 1);
    assert!(store
        .sync(
            &repo.source(),
            "fixture",
            &repo.keys(),
            transit_now(),
            &Policy::default()
        )
        .unwrap());
    assert_eq!(
        store.status("fixture").unwrap().unwrap().current.pack_id,
        first.current.pack_id
    );
    repo.publish(&fixture, 2, &[false, true]);
    assert!(store
        .sync(
            &repo.source(),
            "fixture",
            &repo.keys(),
            transit_now(),
            &Policy::default()
        )
        .unwrap());
    store
        .rollback("fixture", &repo.keys(), transit_now())
        .unwrap();
    let rollback = store.status("fixture").unwrap().unwrap();
    assert_eq!(rollback.current.selection, ids[0]);
    assert_eq!(rollback.checkpoint.sequence, 2);
    assert!(rollback.pinned);
    fs::remove_file(repo.head_path()).unwrap();
    assert!(!store
        .sync(
            &repo.source(),
            "fixture",
            &repo.keys(),
            transit_now(),
            &Policy::default()
        )
        .unwrap());
    store
        .validate_current("fixture", &repo.keys(), transit_now() + 40 * 86400)
        .unwrap();
    drop(store);
    let store = TransitStore::open(root.path()).unwrap();
    store
        .validate_current("fixture", &repo.keys(), transit_now() + 40 * 86400)
        .unwrap();
    store.set_pinned("fixture", false).unwrap();
    repo.publish(&fixture, 1, &[false, true]);
    assert!(store
        .sync(
            &repo.source(),
            "fixture",
            &repo.keys(),
            transit_now(),
            &Policy::default()
        )
        .is_err());
    assert_eq!(
        store.status("fixture").unwrap().unwrap().current.selection,
        ids[0]
    );
    assert_eq!(
        store
            .status("fixture")
            .unwrap()
            .unwrap()
            .checkpoint
            .sequence,
        2
    );
    repo.publish(&fixture, 3, &[false, true]);
    assert!(store
        .sync(
            &repo.source(),
            "fixture",
            &repo.keys(),
            transit_now(),
            &Policy::default()
        )
        .unwrap());
    assert_eq!(
        store.status("fixture").unwrap().unwrap().current.selection,
        ids[1]
    );
}

#[test]
fn transit_install_failures_preserve_the_current_selection_and_checkpoint() {
    use pt_artifacts::transit_install::TransitStore;
    let fixture = Fixture::native();
    let repo = TransitRepository::new();
    repo.publish(&fixture, 1, &[false]);
    let root = tempfile::tempdir().unwrap();
    let store = TransitStore::open(root.path()).unwrap();
    store
        .sync(
            &repo.source(),
            "fixture",
            &repo.keys(),
            transit_now(),
            &minimal_policy(),
        )
        .unwrap();
    let baseline = serde_json::to_value(store.status("fixture").unwrap()).unwrap();
    for case in 0..7 {
        let mut next = Fixture::native();
        next.pack.publication_inputs_sha256 = digest(format!("update-{case}").as_bytes());
        next.generation.publication_inputs_sha256 = next.pack.publication_inputs_sha256.clone();
        let bundle = fs::read(next.path().join("bundle.ptb")).unwrap();
        next.replace_bundle(if case == 3 {
            b"hash-correct but invalid PTB"
        } else {
            &bundle
        });
        next.save();
        let ids = repo.publish(&next, 2, &[false]);
        match case {
            0 => fs::write(repo.head_path().with_extension("json.sig"), [0; 64]).unwrap(),
            1 => fs::write(
                repo.root
                    .path()
                    .join("transit/selections")
                    .join(&ids[0])
                    .join("selection.json"),
                b"truncated",
            )
            .unwrap(),
            2 => {
                fs::remove_file(
                    repo.root
                        .path()
                        .join("transit/objects/sha256")
                        .join(digest(&fs::read(next.path().join("pack.json")).unwrap())),
                )
                .unwrap();
            }
            4 => {
                let path = repo
                    .root
                    .path()
                    .join("transit/objects/sha256")
                    .join(digest(&fs::read(next.path().join("pack.json")).unwrap()));
                fs::write(path, b"truncated object").unwrap();
            }
            5 => {
                let path = repo
                    .root
                    .path()
                    .join("transit/objects/sha256")
                    .join(digest(&fs::read(next.path().join("pack.json")).unwrap()));
                let mut bytes = fs::read(&path).unwrap();
                bytes[0] ^= 1;
                fs::write(path, bytes).unwrap();
            }
            6 => fs::write(
                repo.root
                    .path()
                    .join("transit/selections")
                    .join(&ids[0])
                    .join("selection.json.sig"),
                [0; 64],
            )
            .unwrap(),
            _ => {}
        }
        assert!(store
            .sync(
                &repo.source(),
                "fixture",
                &repo.keys(),
                transit_now(),
                &minimal_policy()
            )
            .is_err());
        assert_eq!(
            serde_json::to_value(store.status("fixture").unwrap()).unwrap(),
            baseline
        );
        store
            .validate_current("fixture", &repo.keys(), transit_now())
            .unwrap();
    }
}

#[test]
fn transit_install_enforces_limits_and_reuses_verified_objects_after_restart() {
    use pt_artifacts::{install::Repository, transit_install::TransitStore};
    struct MetadataOnly(pt_artifacts::install::LocalRepository);
    impl Repository for MetadataOnly {
        fn open(&self, path: &str) -> std::io::Result<Box<dyn std::io::Read>> {
            assert!(
                !path.contains("/objects/"),
                "unchanged objects must come from verified cache"
            );
            self.0.open(path)
        }
    }
    let fixture = Fixture::native();
    let repo = TransitRepository::new();
    repo.publish(&fixture, 1, &[false, true]);
    let root = tempfile::tempdir().unwrap();
    let store = TransitStore::open(root.path()).unwrap();
    let limited = pt_artifacts::transit_install::Policy {
        max_selected_bytes: 1,
        ..minimal_policy()
    };
    assert!(store
        .sync(
            &repo.source(),
            "fixture",
            &repo.keys(),
            transit_now(),
            &limited
        )
        .is_err());
    assert!(store.status("fixture").unwrap().is_none());
    store
        .sync(
            &repo.source(),
            "fixture",
            &repo.keys(),
            transit_now(),
            &minimal_policy(),
        )
        .unwrap();
    drop(store);
    let store = TransitStore::open(root.path()).unwrap();
    assert!(store
        .sync(
            &MetadataOnly(repo.source()),
            "fixture",
            &repo.keys(),
            transit_now(),
            &Default::default()
        )
        .unwrap());
    assert_eq!(
        fs::read_dir(root.path().join("transit/cities/fixture/releases"))
            .unwrap()
            .count(),
        2
    );
}

#[test]
fn transit_cli_installs_verifies_and_pins_without_builders() {
    let fixture = Fixture::native();
    let repo = TransitRepository::new();
    repo.publish(&fixture, 1, &[false]);
    let root = tempfile::tempdir().unwrap();
    let public: String = repo
        .key
        .verifying_key()
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let run = |command: &[&str]| {
        let result = std::process::Command::new(env!("CARGO_BIN_EXE_pt-transit"))
            .arg("--root")
            .arg(root.path())
            .args(["--city", "fixture", "--trusted-key", &public])
            .args(command)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        result.stdout
    };
    run(&[
        "sync",
        "--source-directory",
        repo.root.path().to_str().unwrap(),
        "--without-geometry",
    ]);
    let status: serde_json::Value = serde_json::from_slice(&run(&["status"])).unwrap();
    assert_eq!(status["checkpoint"]["sequence"], 1);
    let verified = String::from_utf8(run(&["verify"])).unwrap();
    assert!(Path::new(verified.trim()).join("bundle.ptb").exists());
    run(&["pin"]);
    fs::remove_file(repo.head_path()).unwrap();
    run(&[
        "sync",
        "--source-directory",
        repo.root.path().to_str().unwrap(),
        "--without-geometry",
    ]);
    run(&["verify"]);
    run(&["unpin"]);
}

#[test]
fn transit_install_rejects_expired_equivocating_heads_and_unsafe_city() {
    use pt_artifacts::transit_install::TransitStore;
    let fixture = Fixture::native();
    let repo = TransitRepository::new();
    repo.publish(&fixture, 1, &[false, true]);
    let root = tempfile::tempdir().unwrap();
    let store = TransitStore::open(root.path()).unwrap();
    let now = transit_now();
    store
        .sync(
            &repo.source(),
            "fixture",
            &repo.keys(),
            now,
            &minimal_policy(),
        )
        .unwrap();
    let baseline = serde_json::to_value(store.status("fixture").unwrap()).unwrap();
    assert!(store
        .sync(
            &repo.source(),
            "fixture",
            &repo.keys(),
            now + 86401,
            &minimal_policy()
        )
        .is_err());
    // Same sequence, different set of choices: a signed head still cannot
    // replace the exact head already accepted at that sequence.
    repo.publish(&fixture, 1, &[false]);
    assert!(store
        .sync(
            &repo.source(),
            "fixture",
            &repo.keys(),
            now,
            &minimal_policy()
        )
        .is_err());
    assert!(store
        .sync(
            &repo.source(),
            "../fixture",
            &repo.keys(),
            now,
            &minimal_policy()
        )
        .is_err());
    assert_eq!(
        serde_json::to_value(store.status("fixture").unwrap()).unwrap(),
        baseline
    );
}

#[test]
fn transit_restart_reuses_complete_unactivated_release_and_cleans_partial_staging() {
    use pt_artifacts::{install::Repository, transit_install::TransitStore};
    struct NoObjects(pt_artifacts::install::LocalRepository);
    impl Repository for NoObjects {
        fn open(&self, path: &str) -> std::io::Result<Box<dyn std::io::Read>> {
            assert!(!path.contains("/objects/"));
            self.0.open(path)
        }
    }
    let fixture = Fixture::native();
    let repo = TransitRepository::new();
    repo.publish(&fixture, 1, &[false, true]);
    let root = tempfile::tempdir().unwrap();
    let store = TransitStore::open(root.path()).unwrap();
    store
        .sync(
            &repo.source(),
            "fixture",
            &repo.keys(),
            transit_now(),
            &minimal_policy(),
        )
        .unwrap();
    let state_path = root.path().join("transit/state/transit-fixture.json");
    let old_state = fs::read(&state_path).unwrap();
    store
        .sync(
            &repo.source(),
            "fixture",
            &repo.keys(),
            transit_now(),
            &Default::default(),
        )
        .unwrap();
    drop(store);
    // Reproduce the durable filesystem state immediately before the activation
    // rename: both release trees exist, but the old state remains authoritative.
    fs::write(state_path, old_state).unwrap();
    let incomplete = root
        .path()
        .join("transit/cities/fixture")
        .join(format!(".staging-{}", digest(b"interrupted")));
    fs::create_dir_all(&incomplete).unwrap();
    fs::write(incomplete.join("partial"), b"unfinished").unwrap();
    let store = TransitStore::open(root.path()).unwrap();
    assert!(!incomplete.exists());
    assert!(
        !store
            .status("fixture")
            .unwrap()
            .unwrap()
            .current
            .geometry_selected
    );
    assert!(store
        .sync(
            &NoObjects(repo.source()),
            "fixture",
            &repo.keys(),
            transit_now(),
            &Default::default()
        )
        .unwrap());
    assert!(
        store
            .status("fixture")
            .unwrap()
            .unwrap()
            .current
            .geometry_selected
    );
}

#[test]
fn read_only_transit_discovery_never_creates_or_cleans_a_store() {
    let root = tempfile::tempdir().unwrap();
    let now = std::time::SystemTime::now();
    assert!(pt_artifacts::transit_install::read_current(root.path(), "fixture", &[], now).is_err());
    assert!(
        pt_artifacts::transit_install::read_current(root.path(), "../fixture", &[], now).is_err()
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}

#[path = "support/transit_publication.rs"]
mod publication;
