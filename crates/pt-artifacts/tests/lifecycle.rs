use ed25519_dalek::{Signer, SigningKey};
use flate2::{write::GzEncoder, Compression};
use pt_artifacts::{
    catalog::{signing_message, Catalog},
    install::{sync, LocalRepository},
    store::Store,
};
use pt_shared::osm_manifest::digest;
use std::{fs, io::Write, path::Path};

const NOW: i64 = 1_793_318_400; // 2026-10-30T00:00:00Z
const WALKING: &[u8] = b"\x1e{\"type\":\"Feature\",\"geometry\":{\"type\":\"LineString\",\"coordinates\":[[1,2],[3,4]]}}\n";

fn publish(root: &Path, city: &str, sequence: u64, walking: &[u8], key: &SigningKey) -> String {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(walking).unwrap();
    let compressed = encoder.finish().unwrap();
    let object_hash = digest(&compressed);
    fs::create_dir_all(root.join("objects/sha256")).unwrap();
    fs::write(root.join("objects/sha256").join(&object_hash), &compressed).unwrap();
    let absent = serde_json::json!({"status":"unsupported","reason":"fixture policy"});
    let manifest = serde_json::json!({
        "schemaVersion":1,"city":city,"coverageE5":[1,1,2,2],
        "createdAt":"2026-10-29T00:00:00Z",
        "source":{"url":"https://example.org/source.pbf","snapshotAt":"2026-10-28T00:00:00Z","sha256":digest(format!("snapshot-{sequence}").as_bytes())},
        "builderRevision":"fixture", "configurationSha256":digest(b"config"),"tools":{},
        "attribution":"OpenStreetMap contributors","licenseUrl":"https://www.openstreetmap.org/copyright",
        "components":{
            "walking":{"status":"present","format":"geojsonseq","formatVersion":1,"compression":"gzip","sha256":object_hash,"bytes":compressed.len(),"decodedBytes":walking.len()},
            "addresses":absent,"walkGraph":absent,"poi":absent
        }
    });
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let id = digest(&bytes);
    fs::create_dir_all(root.join("releases").join(&id)).unwrap();
    fs::write(
        root.join("releases").join(&id).join("manifest.json"),
        &bytes,
    )
    .unwrap();
    let catalog = Catalog {
        schema_version: 1,
        city: city.into(),
        sequence,
        manifest_sha256: id.clone(),
        manifest_bytes: bytes.len() as u64,
        published_at: "2026-10-29T00:00:00Z".into(),
        expires_at: "2026-11-29T00:00:00Z".into(),
    };
    let bytes = serde_json::to_vec(&catalog).unwrap();
    let signature = key.sign(&signing_message(&bytes).unwrap()).to_bytes();
    let dir = root.join("catalog/v1").join(city);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("latest.json"), bytes).unwrap();
    fs::write(dir.join("latest.json.sig"), signature).unwrap();
    id
}

#[test]
fn signed_two_city_refresh_rollback_and_offline_restart() {
    let repo_dir = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let key = SigningKey::from_bytes(&[21; 32]);
    let keys = [key.verifying_key().to_bytes()];
    let first = publish(repo_dir.path(), "oslo", 1, WALKING, &key);
    let tbilisi = publish(repo_dir.path(), "tbilisi", 1, WALKING, &key);
    let repository = LocalRepository(repo_dir.path().into());
    let store = Store::open(data.path()).unwrap();
    assert!(sync(&store, &repository, "oslo", &keys, NOW, &["walking"]).unwrap());
    assert!(sync(&store, &repository, "tbilisi", &keys, NOW, &["walking"]).unwrap());
    assert!(!sync(&store, &repository, "oslo", &keys, NOW, &["walking"]).unwrap());
    let second = publish(repo_dir.path(), "oslo", 2, WALKING, &key);
    assert_ne!(first, second);
    assert!(sync(&store, &repository, "oslo", &keys, NOW, &["walking"]).unwrap());
    assert_eq!(store.status("tbilisi").unwrap().unwrap().release, tbilisi);
    assert_eq!(
        fs::read(
            data.path()
                .join("cities/oslo/releases")
                .join(&first)
                .join("manifest.json")
        )
        .unwrap(),
        fs::read(
            repo_dir
                .path()
                .join("releases")
                .join(&first)
                .join("manifest.json")
        )
        .unwrap()
    );
    let rolled = store.rollback("oslo").unwrap();
    assert_eq!(rolled.release, first);
    assert_eq!(rolled.revision, 3);
    assert!(!sync(&store, &repository, "oslo", &keys, NOW, &["walking"]).unwrap());
    drop(store);
    drop(repository);
    drop(repo_dir);
    let restarted = Store::open(data.path()).unwrap();
    assert_eq!(restarted.status("oslo").unwrap().unwrap(), rolled);
    let public = data.path().join("public");
    assert!(public.join("current/oslo.json").is_file());
    assert!(!public
        .join("releases")
        .join(&second)
        .join("private")
        .exists());
    assert!(!public
        .join("releases")
        .join(&second)
        .join("walking.geojsonseq.gz")
        .exists());
}

#[test]
fn bad_native_data_signatures_and_required_policy_preserve_last_good() {
    let repo_dir = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let key = SigningKey::from_bytes(&[21; 32]);
    let keys = [key.verifying_key().to_bytes()];
    publish(repo_dir.path(), "oslo", 1, WALKING, &key);
    let repository = LocalRepository(repo_dir.path().into());
    let store = Store::open(data.path()).unwrap();
    sync(&store, &repository, "oslo", &keys, NOW, &["walking"]).unwrap();
    let previous = store.status("oslo").unwrap();
    assert!(sync(&store, &repository, "oslo", &keys, NOW, &["addresses"]).is_err());
    publish(
        repo_dir.path(),
        "oslo",
        2,
        b"valid checksum, invalid walking geometry",
        &key,
    );
    assert!(sync(&store, &repository, "oslo", &keys, NOW, &["walking"]).is_err());
    assert_eq!(store.status("oslo").unwrap(), previous);
    assert!(!data
        .path()
        .join("cities/oslo")
        .read_dir()
        .unwrap()
        .any(|p| p
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".staging")));
    publish(
        repo_dir.path(),
        "oslo",
        2,
        WALKING,
        &SigningKey::from_bytes(&[22; 32]),
    );
    assert!(sync(&store, &repository, "oslo", &keys, NOW, &["walking"]).is_err());
    assert_eq!(store.status("oslo").unwrap(), previous);
    assert!(sync(&store, &repository, "../oslo", &keys, NOW, &[]).is_err());
}

#[test]
fn truncated_object_and_manifest_are_not_promoted() {
    let repo_dir = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let key = SigningKey::from_bytes(&[21; 32]);
    let keys = [key.verifying_key().to_bytes()];
    let id = publish(repo_dir.path(), "oslo", 1, WALKING, &key);
    let repository = LocalRepository(repo_dir.path().into());
    let store = Store::open(data.path()).unwrap();
    let object = fs::read_dir(repo_dir.path().join("objects/sha256"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::write(object, b"truncated").unwrap();
    assert!(sync(&store, &repository, "oslo", &keys, NOW, &["walking"]).is_err());
    assert!(store.status("oslo").unwrap().is_none());
    let manifest = repo_dir
        .path()
        .join("releases")
        .join(id)
        .join("manifest.json");
    fs::write(manifest, b"{}").unwrap();
    assert!(sync(&store, &repository, "oslo", &keys, NOW, &[]).is_err());
    assert!(store.status("oslo").unwrap().is_none());
}

#[test]
fn manager_cli_sync_status_and_pin_use_the_same_store() {
    let repo = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let key = SigningKey::from_bytes(&[21; 32]);
    publish(repo.path(), "oslo", 1, WALKING, &key);
    // CLI uses wall time: sign a fresh catalog rather than baking an expiry
    // into a test that would stop working a month after it was written.
    let head = repo.path().join("catalog/v1/oslo/latest.json");
    let mut catalog: Catalog = serde_json::from_slice(&fs::read(&head).unwrap()).unwrap();
    let now = jiff::Timestamp::now();
    catalog.published_at = now.to_string();
    catalog.expires_at = jiff::Timestamp::from_second(now.as_second() + 86400)
        .unwrap()
        .to_string();
    let bytes = serde_json::to_vec(&catalog).unwrap();
    fs::write(&head, &bytes).unwrap();
    fs::write(
        head.with_extension("json.sig"),
        key.sign(&signing_message(&bytes).unwrap()).to_bytes(),
    )
    .unwrap();
    let config = data.path().join("config.json");
    let hex: String = key
        .verifying_key()
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    fs::write(
        &config,
        serde_json::to_vec(&serde_json::json!({
            "root":data.path().join("installed"), "source":{"kind":"local","directory":repo.path()},
            "trustedKeys":[hex],"cities":{"oslo":{"required":["walking"]}}
        }))
        .unwrap(),
    )
    .unwrap();
    let invoke = |args: &[&str]| {
        std::process::Command::new(env!("CARGO_BIN_EXE_pt-artifacts"))
            .arg("--config")
            .arg(&config)
            .args(args)
            .output()
            .unwrap()
    };
    let result = invoke(&["sync"]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let result = invoke(&["status"]);
    assert!(result.status.success());
    let status: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(status["oslo"]["activation"]["revision"], 1);
    assert!(invoke(&["pin", "oslo"]).status.success());
    let result = invoke(&["status"]);
    let status: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(status["oslo"]["activation"]["pinned"], true);
    assert!(status["oslo"]["sourceSnapshotAt"].is_string());
    assert!(status["oslo"]["sourceAgeSeconds"].is_u64());
    assert!(status["oslo"]["refresh"]["lastSuccessAt"].is_i64());
    assert!(!invoke(&["pin", "disabled-city"]).status.success());
}

#[test]
fn publisher_validates_before_atomic_head_promotion() {
    let prepared = tempfile::tempdir().unwrap();
    let repository = tempfile::tempdir().unwrap();
    let key = SigningKey::from_bytes(&[21; 32]);
    let keys = [key.verifying_key().to_bytes()];
    let id = publish(prepared.path(), "oslo", 1, WALKING, &key);
    let source_manifest = prepared
        .path()
        .join("releases")
        .join(id)
        .join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(source_manifest).unwrap()).unwrap();
    let address = pt_geocode::AddrIndex::pack(
        &[pt_geocode::AddrRow {
            label: "Street 1".into(),
            lat: 59.0,
            lon: 10.0,
        }],
        &[pt_geocode::AddrKey {
            key: "street 1".into(),
            row_id: 0,
        }],
        &pt_geocode::ArtifactMeta {
            city_id: Some("oslo".into()),
            source: Some("fixture".into()),
            generated_at: "2026-10-29T00:00:00Z".into(),
        },
    )
    .unwrap();
    let hash = digest(&address);
    let objects = prepared.path().join("objects/sha256");
    fs::write(objects.join(&hash), &address).unwrap();
    manifest["components"]["addresses"] = serde_json::json!({"status":"present","format":"ptas","formatVersion":1,"compression":"none","sha256":hash,"bytes":address.len(),"decodedBytes":address.len()});
    let manifest_file = prepared.path().join("manifest.json");
    fs::write(&manifest_file, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let release = pt_artifacts::publish::publish(
        repository.path(),
        &manifest_file,
        &objects,
        &key,
        &keys,
        NOW,
    )
    .unwrap();
    let channel = repository.path().join("catalog/v1/oslo");
    let old_head = fs::read_link(&channel).unwrap();
    let catalog_bytes = fs::read(channel.join("latest.json")).unwrap();
    let signature = fs::read(channel.join("latest.json.sig")).unwrap();
    let head =
        pt_artifacts::catalog::verify(&catalog_bytes, &signature, &keys, "oslo", 0, NOW).unwrap();
    assert_eq!(head.sequence, 1);
    assert_eq!(head.manifest_sha256, release);
    let data = tempfile::tempdir().unwrap();
    let store = Store::open(data.path()).unwrap();
    assert!(
        pt_shared::osm_install::producer_inputs(data.path(), "oslo").is_err(),
        "required input discovery reports delayed initial installation"
    );
    sync(
        &store,
        &LocalRepository(repository.path().into()),
        "oslo",
        &keys,
        NOW,
        &["walking", "addresses"],
    )
    .unwrap();
    let pinned = pt_shared::osm_install::producer_inputs(data.path(), "oslo").unwrap();
    assert_eq!(pinned.release, release);
    assert!(pinned.walking.is_file() && pinned.addresses.is_file());
    assert!(pt_shared::osm_install::producer_inputs(data.path(), "../oslo").is_err());
    let activation = data.path().join("public/current/oslo.json");
    let original_activation = fs::read(&activation).unwrap();
    let mut changed: serde_json::Value = serde_json::from_slice(&original_activation).unwrap();
    changed["release"] = serde_json::Value::String(digest(b"not installed yet"));
    fs::write(&activation, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(pt_shared::osm_install::producer_inputs(data.path(), "oslo").is_err());
    assert!(
        pinned.walking.is_file() && pinned.addresses.is_file(),
        "in-flight pins keep immutable paths across activation changes"
    );
    fs::write(&activation, original_activation).unwrap();
    // Broken native bytes have a correct advertised checksum. Publication must
    // fail native validation and leave BOTH old catalog files intact.
    fs::write(objects.join(digest(b"bad")), b"bad").unwrap();
    manifest["components"]["walking"] = serde_json::json!({"status":"present","format":"geojsonseq","formatVersion":1,"compression":"gzip","sha256":digest(b"bad"),"bytes":3,"decodedBytes":3});
    fs::write(&manifest_file, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(pt_artifacts::publish::publish(
        repository.path(),
        &manifest_file,
        &objects,
        &key,
        &keys,
        NOW
    )
    .is_err());
    assert_eq!(fs::read_link(&channel).unwrap(), old_head);
    assert_eq!(
        fs::read(channel.join("latest.json")).unwrap(),
        catalog_bytes
    );
    assert_eq!(
        fs::read(channel.join("latest.json.sig")).unwrap(),
        signature
    );
}

#[test]
fn retention_prunes_only_idle_releases_beyond_current_previous_and_grace() {
    use pt_artifacts::retention::Policy;
    use pt_shared::artifact_lease::ResolutionGuard;
    let repo_dir = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let leases = tempfile::tempdir().unwrap();
    let key = SigningKey::from_bytes(&[23; 32]);
    let keys = [key.verifying_key().to_bytes()];
    let repository = LocalRepository(repo_dir.path().into());
    let store = Store::open(data.path()).unwrap();
    let policy = Policy {
        grace_seconds: 3600,
        lease_root: leases.path().into(),
    };
    let mut releases = Vec::new();
    let mut lease = None;
    for sequence in 1..=3u64 {
        let mut walking = WALKING.to_vec();
        walking.extend(std::iter::repeat_n(b'\n', sequence as usize));
        releases.push(publish(repo_dir.path(), "oslo", sequence, &walking, &key));
        assert!(sync(&store, &repository, "oslo", &keys, NOW, &["walking"]).unwrap());
        if sequence == 1 {
            // A consumer resolves release 1 and keeps building on it.
            let resolving = ResolutionGuard::acquire(leases.path()).unwrap();
            let active = store.status("oslo").unwrap().unwrap().release;
            lease = Some(resolving.pin(&active).unwrap());
        }
    }
    let path = |kind: &str, id: &String| data.path().join(kind).join(id);
    let first = path("cities/oslo/releases", &releases[0]);
    let r = store.prune(&["oslo"], &policy, NOW).unwrap();
    assert!(
        r.releases_removed.is_empty() && first.exists(),
        "within grace"
    );
    let r = store.prune(&["oslo"], &policy, NOW + 3600).unwrap();
    assert!(
        r.releases_removed.is_empty() && first.exists(),
        "live lease"
    );
    drop(lease);
    let r = store.prune(&["oslo"], &policy, NOW + 3600).unwrap();
    assert_eq!(r.releases_removed, vec![releases[0].clone()]);
    assert_eq!(r.objects_removed, 1);
    assert!(!first.exists() && !path("public/releases", &releases[0]).exists());
    for kept in &releases[1..] {
        assert!(path("cities/oslo/releases", kept).exists());
        assert!(path("public/releases", kept).exists());
    }
}

#[test]
fn resync_repairs_an_installed_release_corrupted_through_its_cached_object() {
    let repo_dir = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let key = SigningKey::from_bytes(&[24; 32]);
    let keys = [key.verifying_key().to_bytes()];
    let release = publish(repo_dir.path(), "oslo", 1, WALKING, &key);
    let repository = LocalRepository(repo_dir.path().into());
    let store = Store::open(data.path()).unwrap();
    assert!(sync(&store, &repository, "oslo", &keys, NOW, &["walking"]).unwrap());
    let installed = data
        .path()
        .join("cities/oslo/releases")
        .join(&release)
        .join("private/walking.geojsonseq.gz");
    let good = fs::read(&installed).unwrap();
    // Hard links share the inode: rot in the cache entry reaches the release.
    let object = fs::read_dir(data.path().join("objects/sha256"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut rotten = good.clone();
    rotten[0] ^= 0xff;
    fs::write(&object, &rotten).unwrap();
    assert_eq!(fs::read(&installed).unwrap(), rotten);
    assert!(!sync(&store, &repository, "oslo", &keys, NOW, &["walking"]).unwrap());
    assert_eq!(
        fs::read(&installed).unwrap(),
        good,
        "release repaired in place"
    );
    assert_eq!(store.status("oslo").unwrap().unwrap().release, release);
    let leftovers = fs::read_dir(data.path().join("cities/oslo"))
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".staging-")
        })
        .count();
    assert_eq!(leftovers, 0);
}

/// The shipped default configuration has no artifact source. A stack started
/// before one is configured must keep the manager running and report every
/// city as unavailable instead of crash-looping on its configuration.
#[test]
fn manager_without_a_source_stays_up_and_reports_cities_unavailable() {
    let data = tempfile::tempdir().unwrap();
    let config = data.path().join("config.json");
    fs::write(
        &config,
        serde_json::to_vec(&serde_json::json!({
            "root": data.path().join("installed"), "trustedKeys": [],
            "cities": {"oslo": {}, "vilnius": {}}
        }))
        .unwrap(),
    )
    .unwrap();
    let mut manager = std::process::Command::new(env!("CARGO_BIN_EXE_pt-artifacts"))
        .arg("--config")
        .arg(&config)
        .arg("run")
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let state = data.path().join("installed/state/vilnius.refresh.json");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !state.exists() && std::time::Instant::now() < deadline {
        assert!(
            manager.try_wait().unwrap().is_none(),
            "manager exited without a source"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let running = manager.try_wait().unwrap().is_none();
    manager.kill().ok();
    manager.wait().ok();
    assert!(running, "manager must stay up without a source");
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_pt-artifacts"))
        .arg("--config")
        .arg(&config)
        .arg("status")
        .output()
        .unwrap();
    assert!(status.status.success());
    let status: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    for city in ["oslo", "vilnius"] {
        assert!(status[city]["activation"].is_null());
        assert_eq!(
            status[city]["refresh"]["error"],
            "no artifact source configured"
        );
    }
}
