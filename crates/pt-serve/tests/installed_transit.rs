//! Signed installer selections are consumed offline without producer pointers.
#[path = "common/mod.rs"]
mod common;
use common::publisher;
use ed25519_dalek::SigningKey;
use pt_artifacts::{
    transit_catalog::Checkpoint,
    transit_export,
    transit_install::{activation_path, Activation, Release, TransitStore},
};
use pt_serve::{bundle::installed, reload::poll::poll_tick, Metrics, ReloadRunner};
use pt_shared::{clock::MockClock, manifest::GenerationManifest, pack_manifest::PackManifest};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{atomic::AtomicU64, Arc},
    time::{Duration, SystemTime},
};

struct Fixture {
    _root: tempfile::TempDir,
    config: pt_serve::ops::ServerConfig,
    clock: Arc<MockClock>,
    full: Release,
    minimal: Release,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let producer = root.path().join("producer");
        fs::create_dir(&producer).unwrap();
        let shapes = publisher::encode_test_shapes_bin(&common::tiny_ptb_path());
        let id = publisher::publish_generation_with_artifacts(
            &producer,
            "vilnius",
            &common::tiny_ptb_path(),
            &publisher::rfc3339_format(common::RELOAD_HARNESS_ANCHOR),
            &publisher::SidecarArtifacts {
                shapes_bin: Some(shapes),
                ..Default::default()
            },
        );
        let source = publisher::bundle_path_for(&producer, &id)
            .parent()
            .unwrap()
            .to_path_buf();
        let mut manifest: GenerationManifest =
            serde_json::from_slice(&fs::read(source.join("generation.json")).unwrap()).unwrap();
        manifest.city_tz_iana = Some("Europe/Vilnius".into());
        fs::write(
            source.join("generation.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let mut pack: PackManifest = serde_json::from_value(json!({
            "schemaVersion":2,"packId":"","bundleId":manifest.bundle_sha256,
            "generationId":id,"publicationInputsSha256":manifest.publication_inputs_sha256,
            "citySlug":"vilnius","cityTzIana":"Europe/Vilnius","createdAt":manifest.created_at,
            "feedStartDate":manifest.feed_start_date,"windowDays":90,"serviceEndDate":20270203,
            "staleAfter":"2027-01-20","hardExpireAfter":"2027-02-03",
            "stopBBox":[0,0,1,1],"coverageBBox":[0,0,1,1],
            "rights":{"redistributable":false,"status":"fixture","note":"synthetic"},
            "artifacts":[
                {"kind":"ptb","path":"bundle.ptb","sha256":manifest.bundle_sha256,
                 "sizeBytes":manifest.bundle_size_bytes,"required":true,"mediaType":"application/octet-stream","cache":"immutable"},
                {"kind":"shapes-bin","path":"shapes.bin","sha256":manifest.shapes_bin_sha256,
                 "sizeBytes":fs::metadata(source.join("shapes.bin")).unwrap().len(),"required":false,"mediaType":"application/octet-stream","cache":"immutable"}
            ]
        })).unwrap();
        pack.pack_id = pack.compute_pack_id().unwrap();
        fs::write(source.join("pack.json"), serde_json::to_vec(&pack).unwrap()).unwrap();
        let key = SigningKey::from_bytes(&[17; 32]);
        let store_root = root.path().join("installed");
        let releases = store_root.join("transit/cities/vilnius/releases");
        fs::create_dir_all(&releases).unwrap();
        let export = |geometry, name| {
            let output = root.path().join(name);
            let selection = transit_export::export(&source, &output, geometry, &key).unwrap();
            fs::rename(output, releases.join(&selection)).unwrap();
            Release {
                selection,
                pack_id: pack.pack_id.clone(),
                generation_id: id.clone(),
                geometry_selected: geometry,
            }
        };
        let full = export(true, "full");
        let minimal = export(false, "minimal");
        let runtime = root.path().join("runtime");
        fs::create_dir(&runtime).unwrap();
        let mut config = common::default_test_config(runtime);
        config.city_slug = "vilnius".into();
        config.transit_store_root = Some(store_root);
        config.transit_trusted_key = vec![key
            .verifying_key()
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()];
        let clock = Arc::new(MockClock::new(
            SystemTime::UNIX_EPOCH + Duration::from_secs(common::RELOAD_HARNESS_ANCHOR),
        ));
        let fixture = Self {
            _root: root,
            config,
            clock,
            full,
            minimal,
        };
        fixture.activate(&fixture.full, None, 1);
        fixture
    }
    fn store(&self) -> &Path {
        self.config.transit_store_root.as_deref().unwrap()
    }
    fn activate(&self, current: &Release, previous: Option<Release>, revision: u64) {
        let state = Activation {
            schema_version: 1,
            revision,
            current: current.clone(),
            previous,
            checkpoint: Checkpoint {
                sequence: 9,
                sha256: "a".repeat(64),
            },
            pinned: false,
        };
        let path = activation_path(self.store(), "vilnius").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let staging = path.with_extension("tmp");
        fs::write(&staging, serde_json::to_vec(&state).unwrap()).unwrap();
        fs::rename(staging, path).unwrap();
    }
    fn release(&self, release: &Release) -> PathBuf {
        self.store()
            .join("transit/cities/vilnius/releases")
            .join(&release.selection)
    }
}

#[test]
fn offline_startup_poll_geometry_switch_rollback_and_failed_reload() {
    let f = Fixture::new();
    // Hold the installer lock throughout: serving must neither take it nor clean staging.
    let store = TransitStore::open(f.store()).unwrap();
    let staging = f
        .store()
        .join("transit/cities/vilnius")
        .join(format!(".staging-{}", "b".repeat(64)));
    fs::create_dir(&staging).unwrap();
    let metrics = Metrics::new();
    let initial = installed::load(&f.config, f.clock.as_ref(), &metrics).unwrap();
    assert_eq!(
        initial.transit_selection.as_deref(),
        Some(f.full.selection.as_str())
    );
    assert!(initial.shapes_json_bytes().is_some());
    let handle = Arc::new(arc_swap::ArcSwap::new(Arc::new(initial)));
    let runner = ReloadRunner::new(
        handle.clone(),
        Arc::new(f.config.clone()),
        metrics.clone(),
        f.clock.clone(),
    );
    assert!(runner.trigger_reload().is_noop());
    f.activate(&f.minimal, Some(f.full.clone()), 2);
    let observed = AtomicU64::new(0);
    poll_tick(&runner, &f.config.data_root, &observed);
    assert_eq!(handle.load().generation_id, f.full.generation_id);
    assert_eq!(
        handle.load().transit_selection.as_deref(),
        Some(f.minimal.selection.as_str())
    );
    assert!(handle.load().shapes_json_bytes().is_none());
    assert!(handle.load().address_search.is_none());
    assert_eq!(handle.load().epoch, 1);
    store.set_pinned("vilnius", true).unwrap();
    assert!(runner.trigger_reload().is_noop());
    // Corruption in the current installed selection fails even on the no-op path.
    let sig = f.release(&f.minimal).join("selection.json.sig");
    let before = fs::read(&sig).unwrap();
    fs::write(&sig, [0; 64]).unwrap();
    assert!(!runner.trigger_reload().is_adopted());
    assert_eq!(metrics.reload_consecutive_failures(), 1);
    assert_eq!(handle.load().epoch, 1);
    fs::write(sig, before).unwrap();
    store
        .rollback(
            "vilnius",
            &installed::trusted_keys(&f.config).unwrap(),
            common::RELOAD_HARNESS_ANCHOR as i64,
        )
        .unwrap();
    poll_tick(&runner, &f.config.data_root, &observed);
    assert_eq!(
        handle.load().transit_selection.as_deref(),
        Some(f.full.selection.as_str())
    );
    assert!(handle.load().shapes_json_bytes().is_some());
    assert_eq!(handle.load().epoch, 2);
    assert_eq!(
        store
            .status("vilnius")
            .unwrap()
            .unwrap()
            .checkpoint
            .sequence,
        9
    );
    assert!(staging.exists());
    assert_eq!(
        fs::read_dir(&f.config.data_root).unwrap().count(),
        0,
        "no producer pointers or cleanup writes"
    );
}

#[test]
fn startup_requires_trusted_current_selection_and_binds_geometry() {
    let mut f = Fixture::new();
    let metrics = Metrics::new();
    f.config.transit_trusted_key.clear();
    assert!(installed::load(&f.config, f.clock.as_ref(), &metrics).is_err());
    f.config.transit_trusted_key = vec!["00".repeat(32)];
    assert!(installed::load(&f.config, f.clock.as_ref(), &metrics).is_err());
    let key = SigningKey::from_bytes(&[17; 32]);
    f.config.transit_trusted_key = vec![key
        .verifying_key()
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()];
    f.activate(&f.minimal, Some(f.full.clone()), 2);
    // A bogus unselected geometry file is ignored; runtime policy comes from the signed selection.
    fs::write(f.release(&f.minimal).join("files/shapes.bin"), b"garbage").unwrap();
    fs::write(
        f.release(&f.minimal).join("files/address-search.fst"),
        b"unselected extra",
    )
    .unwrap();
    let generation = installed::load(&f.config, f.clock.as_ref(), &metrics).unwrap();
    assert!(generation.shapes_json_bytes().is_none());
    assert!(generation.address_search.is_none());
    fs::write(f.release(&f.minimal).join("files/bundle.ptb"), b"corrupt").unwrap();
    assert!(
        installed::load(&f.config, f.clock.as_ref(), &metrics).is_err(),
        "no implicit previous-selection fallback"
    );
    f.activate(&f.full, None, 3);
    f.config.without_geometry = true;
    assert!(installed::load(&f.config, f.clock.as_ref(), &metrics)
        .unwrap()
        .shapes_json_bytes()
        .is_none());
    f.config.force_current = Some(f.full.generation_id.clone());
    assert!(installed::validate_config(&f.config).is_err());
    f.config.force_current = None;
    f.config.city_slug = "../vilnius".into();
    assert!(installed::load(&f.config, f.clock.as_ref(), &metrics).is_err());
}
