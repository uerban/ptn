//! `ServerConfig::validate()` integration tests.
//!
//! clap's parse layer is exercised by clap's own test suite — we don't
//! reproduce it here. These tests cover the post-parse runtime checks
//! (`validate()`) that clap can't express: integer bounds + filesystem
//! existence/writability.
//!
//! Each test constructs a [`ServerConfig`] via [`common::default_test_config`]
//! (which produces a passing baseline) and then mutates ONE field to provoke
//! the targeted [`ConfigError`] variant. The pattern keeps each test focused
//! on a single failure mode and makes adding a new field straightforward —
//! add a new mutation here.

#[path = "common/mod.rs"]
mod common;

use pt_serve::{ConfigError, Generation, Metrics, ServerConfig, ServerCtx};
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;

/// Sanity check: the `default_test_config` baseline must itself validate
/// cleanly. If this fails, every other test in this file fails too — and
/// the failure mode is "the harness is broken", not "the validator is
/// broken". Keep it as the first test.
#[test]
fn default_test_config_validates_cleanly() {
    let dir = TempDir::new().expect("tempdir");
    let mut cfg = common::default_test_config(dir.path().to_path_buf());
    cfg.validate()
        .expect("baseline default_test_config must validate");
}

#[test]
fn worker_pool_size_zero_rejected() {
    let dir = TempDir::new().expect("tempdir");
    let mut cfg = common::default_test_config(dir.path().to_path_buf());
    cfg.worker_pool_size = 0;
    match cfg.validate() {
        Err(ConfigError::WorkerPoolSizeZero) => {}
        other => panic!("expected WorkerPoolSizeZero, got {other:?}"),
    }
}

#[test]
fn loopback_worker_count_zero_rejected() {
    let dir = TempDir::new().expect("tempdir");
    let mut cfg = common::default_test_config(dir.path().to_path_buf());
    cfg.loopback_worker_count = 0;
    match cfg.validate() {
        Err(ConfigError::LoopbackWorkerCountZero) => {}
        other => panic!("expected LoopbackWorkerCountZero, got {other:?}"),
    }
}

#[test]
fn request_timeout_ms_zero_rejected() {
    let dir = TempDir::new().expect("tempdir");
    let mut cfg = common::default_test_config(dir.path().to_path_buf());
    cfg.request_timeout_ms = 0;
    match cfg.validate() {
        Err(ConfigError::RequestTimeoutMsZero) => {}
        other => panic!("expected RequestTimeoutMsZero, got {other:?}"),
    }
}

#[test]
fn max_rss_bytes_zero_rejected() {
    let dir = TempDir::new().expect("tempdir");
    let mut cfg = common::default_test_config(dir.path().to_path_buf());
    cfg.max_rss_bytes = 0;
    match cfg.validate() {
        Err(ConfigError::MaxRssBytesZero) => {}
        other => panic!("expected MaxRssBytesZero, got {other:?}"),
    }
}

#[test]
fn city_slug_empty_rejected() {
    let dir = TempDir::new().expect("tempdir");
    let mut cfg = common::default_test_config(dir.path().to_path_buf());
    cfg.city_slug = String::new();
    match cfg.validate() {
        Err(ConfigError::CitySlugEmpty) => {}
        other => panic!("expected CitySlugEmpty, got {other:?}"),
    }
}

#[test]
fn data_root_missing_rejected() {
    // Point data_root at a path that definitely doesn't exist. Use the
    // TempDir's path + a non-existent subdir to keep the test hermetic
    // (no race against the global /nonexistent path being created by
    // another test).
    let dir = TempDir::new().expect("tempdir");
    let missing = dir.path().join("does-not-exist");
    let mut cfg = ServerConfig {
        data_root: missing.clone(),
        pidfile_path: dir.path().join("pt-serve.pid"),
        ..common::default_test_config(dir.path().to_path_buf())
    };
    match cfg.validate() {
        Err(ConfigError::DataRootMissing(p)) => assert_eq!(p, missing),
        other => panic!("expected DataRootMissing, got {other:?}"),
    }
}

#[test]
fn data_root_is_file_not_dir_rejected() {
    // A regular file at data_root path → metadata.is_dir() false → same
    // class as missing. We want to confirm that path too.
    let dir = TempDir::new().expect("tempdir");
    let file_at_dir = dir.path().join("not-a-dir");
    std::fs::write(&file_at_dir, b"x").expect("write file");
    let mut cfg = ServerConfig {
        data_root: file_at_dir.clone(),
        pidfile_path: dir.path().join("pt-serve.pid"),
        ..common::default_test_config(dir.path().to_path_buf())
    };
    match cfg.validate() {
        Err(ConfigError::DataRootMissing(p)) => assert_eq!(p, file_at_dir),
        other => panic!("expected DataRootMissing for non-dir, got {other:?}"),
    }
}

#[test]
fn pidfile_parent_missing_rejected() {
    let dir = TempDir::new().expect("tempdir");
    let bad_pid = dir.path().join("no-such-subdir").join("pt-serve.pid");
    let mut cfg = ServerConfig {
        pidfile_path: bad_pid.clone(),
        ..common::default_test_config(dir.path().to_path_buf())
    };
    match cfg.validate() {
        Err(ConfigError::PidfileParentMissing(p)) => assert_eq!(p, bad_pid),
        other => panic!("expected PidfileParentMissing, got {other:?}"),
    }
}

#[test]
fn pidfile_parent_empty_path_rejected() {
    // `PathBuf::from("foo.pid")` has `parent() == Some("")`. We treat
    // that as "no parent" because writing to cwd is operator-ambiguous
    // (cwd is whatever systemd/container set, not what `--pidfile-path`
    // implied).
    let dir = TempDir::new().expect("tempdir");
    let mut cfg = ServerConfig {
        pidfile_path: PathBuf::from("just-a-name.pid"),
        ..common::default_test_config(dir.path().to_path_buf())
    };
    match cfg.validate() {
        Err(ConfigError::PidfileParentMissing(_)) => {}
        other => panic!("expected PidfileParentMissing for bare filename, got {other:?}"),
    }
}

#[cfg(unix)]
#[test]
fn poi_preflight_pins_snapshot_but_keeps_configured_discovery_pointer() {
    use std::os::unix::fs::symlink;

    let root = TempDir::new().expect("tempdir");
    let release_a = root.path().join("release-a");
    let release_b = root.path().join("release-b");
    std::fs::create_dir_all(&release_a).expect("create release-a");
    std::fs::create_dir_all(&release_b).expect("create release-b");
    for release in [&release_a, &release_b] {
        std::fs::write(
            release.join("manifest.json"),
            br#"{"schemaVersion":1,"bundles":[]}"#,
        )
        .expect("write manifest");
    }
    let current = root.path().join("current");
    symlink(&release_a, &current).expect("link current to release-a");

    let mut cfg = common::default_test_config(root.path().to_path_buf());
    cfg.poi_bundle_dir = Some(current.clone());
    cfg.validate().expect("config validates");
    let pinned_release_a = std::fs::canonicalize(&release_a).expect("canonical release-a");
    assert_eq!(
        cfg.poi_bundle_dir.as_deref(),
        Some(current.as_path()),
        "discovery must retain the configured pointer"
    );

    std::fs::remove_file(&current).expect("remove current link");
    symlink(&release_b, &current).expect("link current to release-b");
    assert_eq!(cfg.poi_bundle_dir.as_deref(), Some(current.as_path()));
    let Some(pt_serve::poi::catalog::PoiPreflightState::Ready(ready)) =
        cfg.validated_poi_manifest.as_ref()
    else {
        panic!("startup snapshot must be ready");
    };
    assert_eq!(ready.pinned_dir, pinned_release_a);
}

#[test]
fn missing_poi_manifest_is_a_nonfatal_cold_state() {
    let root = TempDir::new().expect("tempdir");
    let poi_dir = root.path().join("poi");
    std::fs::create_dir(&poi_dir).expect("create POI dir");
    let mut cfg = common::default_test_config(root.path().to_path_buf());
    cfg.poi_bundle_dir = Some(poi_dir);

    cfg.validate()
        .expect("missing POI manifest must not reject transit config");

    assert!(matches!(
        cfg.validated_poi_manifest,
        Some(pt_serve::poi::catalog::PoiPreflightState::Cold)
    ));
}

#[test]
fn malformed_poi_manifest_is_a_nonfatal_failed_state() {
    let root = TempDir::new().expect("tempdir");
    let poi_dir = root.path().join("poi");
    std::fs::create_dir(&poi_dir).expect("create POI dir");
    std::fs::write(poi_dir.join("manifest.json"), b"not-json").expect("write malformed manifest");
    let mut cfg = common::default_test_config(root.path().to_path_buf());
    cfg.poi_bundle_dir = Some(poi_dir);

    cfg.validate()
        .expect("malformed POI manifest must not reject transit config");

    match cfg.validated_poi_manifest {
        Some(pt_serve::poi::catalog::PoiPreflightState::Failed(error)) => {
            assert!(
                error.contains("JSON decode failed"),
                "unexpected error: {error}"
            );
        }
        other => panic!("expected failed POI preflight state, got {other:?}"),
    }
}

#[test]
fn failed_poi_preflight_is_visible_without_lowering_transit_readiness() {
    let root = TempDir::new().expect("tempdir");
    let generation = Generation::from_paths(
        &common::tiny_ptb_path(),
        None,
        "vilnius".to_string(),
        pt_core::PatternMode::Off,
    )
    .expect("load test generation");
    let mut cfg = common::default_test_config(root.path().to_path_buf());
    cfg.poi_bundle_dir = Some(root.path().join("poi"));
    cfg.validated_poi_manifest = Some(pt_serve::poi::catalog::PoiPreflightState::Failed(
        Arc::from("invalid POI manifest"),
    ));
    let ctx = ServerCtx::new(generation, cfg, Metrics::new());
    let current = ctx.current_generation();

    let pt_serve::app::response::Resp::Json { status, body } =
        pt_serve::app::version::ready(&current, &ctx)
    else {
        panic!("expected JSON readiness response");
    };
    assert_eq!(status, 200);
    let body: serde_json::Value = serde_json::from_str(&body).expect("valid readiness JSON");
    assert_eq!(body["status"], "ready");
    assert_eq!(
        body["poiTile"],
        serde_json::json!({
            "configured": true,
            "ready": false,
            "error": "invalid POI manifest"
        })
    );
}

#[test]
fn ready_poi_preflight_retains_metadata_without_decoded_cache_seeding() {
    let root = TempDir::new().expect("tempdir");
    let generation = Generation::from_paths(
        &common::tiny_ptb_path(),
        None,
        "vilnius".to_string(),
        pt_core::PatternMode::Off,
    )
    .expect("load test generation");
    let manifest: Arc<pt_shared::poi_manifest_wire::PoiManifest> = Arc::new(
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "bundles": [{
                "cityId": "vilnius",
                "filename": "vilnius.br",
                "sizeBytes": 1,
                "sha256": "a".repeat(64),
                "poiTile": {
                    "edgeKm": 12,
                    "anchor": {"minLat": 54.58, "minLon": 25.08, "refLat": 54.68},
                    "tilingPolicy": "fixed-edge",
                    "kAnonWaived": true,
                    "tileBounds": {"minX": 0, "maxX": 0, "minY": 0, "maxY": 0},
                    "deliveryActive": true
                }
            }]
        }))
        .expect("manifest decodes"),
    );
    let contract = pt_serve::poi::catalog::active_tiling_contract(
        1,
        "vilnius",
        manifest.bundles[0].poi_tile.as_ref(),
    )
    .expect("contract validates")
    .expect("active contract");
    std::fs::create_dir(root.path().join("poi")).expect("create pinned POI dir");
    let pinned_dir = std::fs::canonicalize(root.path().join("poi")).expect("canonical POI dir");
    let mut cfg = common::default_test_config(root.path().to_path_buf());
    cfg.poi_bundle_dir = Some(pinned_dir.clone());
    cfg.validated_poi_manifest = Some(pt_serve::poi::catalog::PoiPreflightState::Ready(
        pt_serve::poi::catalog::PoiPreflightReady {
            pinned_dir,
            lease: None,
            manifest: Arc::clone(&manifest),
            cities: vec![
                pt_serve::poi::catalog::PoiPreflightCity::Inactive {
                    city_id: "gdansk".to_string(),
                },
                pt_serve::poi::catalog::PoiPreflightCity::Active {
                    city_id: "vilnius".to_string(),
                    contract,
                    bundle_sha256: Arc::from("a".repeat(64)),
                },
            ],
            envelope_exceeds_cache_budget: None,
        },
    ));
    let ctx = ServerCtx::new(generation, cfg, Metrics::new());

    let cached_preflight = ctx
        .poi_manifest_cache
        .get_or_load(&ctx.config)
        .expect("manifest cache is ready")
        .expect("manifest is present");
    assert!(Arc::ptr_eq(&cached_preflight.manifest, &manifest));
    let pinned_dir = &cached_preflight.pinned_dir;
    assert!(ctx
        .poi_city_tiling_cache
        .get("gdansk", pinned_dir)
        .is_none());
    assert!(ctx
        .poi_city_tiling_cache
        .get("vilnius", pinned_dir)
        .is_none());
}

#[test]
fn poi_k_anon_floor_rejects_49_and_accepts_50() {
    let tiling: pt_shared::poi_manifest_wire::PoiTileManifest =
        serde_json::from_value(serde_json::json!({
            "edgeKm": 12,
            "anchor": {"minLat": 54.58, "minLon": 25.08, "refLat": 54.68},
            "tilingPolicy": "k-anon-floor",
            "kAnonWaived": false,
            "tileBounds": {"minX": 0, "maxX": 0, "minY": 0, "maxY": 0},
            "deliveryActive": true
        }))
        .expect("tiling decodes");
    let contract = pt_serve::poi::catalog::active_tiling_contract(1, "vilnius", Some(&tiling))
        .expect("contract validates")
        .expect("delivery is active");

    for (count, should_pass) in [(49usize, false), (50usize, true)] {
        let entries: Vec<pt_shared::poi_bundle_wire::PoiEntry> = (0..count)
            .map(|index| {
                serde_json::from_value(serde_json::json!({
                    "id": format!("poi-{index}"),
                    "lat": 54.6,
                    "lon": 25.2,
                    "tier": "strict"
                }))
                .expect("entry decodes")
            })
            .collect();
        let result = pt_serve::poi::catalog::validate_tiling("vilnius", &contract, &entries);
        if should_pass {
            result.expect("50 entries meet the privacy floor");
        } else {
            let error = result.expect_err("49 entries violate the privacy floor");
            assert!(
                error
                    .to_string()
                    .contains("contains 49 entries; minimum is 50"),
                "unexpected error: {error}"
            );
        }
    }
}

#[test]
fn poi_activation_contract_covers_inactive_and_active_tiling() {
    let inactive: pt_shared::poi_manifest_wire::PoiTileManifest =
        serde_json::from_value(serde_json::json!({"deliveryActive": false}))
            .expect("inactive tiling decodes");
    let active: pt_shared::poi_manifest_wire::PoiTileManifest =
        serde_json::from_value(serde_json::json!({
            "edgeKm": 12,
            "anchor": {"minLat": 54.58, "minLon": 25.08, "refLat": 54.68},
            "tilingPolicy": "fixed-edge",
            "kAnonWaived": true,
            "tileBounds": {"minX": 0, "maxX": 0, "minY": 0, "maxY": 0},
            "deliveryActive": true
        }))
        .expect("active tiling decodes");

    for version in [0, 2, 3] {
        for tiling in [&inactive, &active] {
            let error =
                pt_serve::poi::catalog::active_tiling_contract(version, "vilnius", Some(tiling))
                    .expect_err("only schemaVersion 1 is served");
            assert!(error
                .to_string()
                .contains(&format!("schemaVersion {version}")));
        }
    }
    assert!(
        pt_serve::poi::catalog::active_tiling_contract(1, "vilnius", Some(&inactive))
            .expect("inactive tiling short-circuits")
            .is_none()
    );
    assert!(
        pt_serve::poi::catalog::active_tiling_contract(1, "vilnius", Some(&active))
            .expect("active tiling validates")
            .is_some()
    );

    let incomplete_active: pt_shared::poi_manifest_wire::PoiTileManifest =
        serde_json::from_value(serde_json::json!({"deliveryActive": true}))
            .expect("wire decode permits active-only fields to be absent");
    let error =
        pt_serve::poi::catalog::active_tiling_contract(1, "vilnius", Some(&incomplete_active))
            .expect_err("active tiling must require edgeKm");
    assert!(error.to_string().contains("edgeKm"));
}

#[cfg(unix)]
#[test]
fn data_root_not_writable_rejected() {
    use std::os::unix::fs::PermissionsExt;

    let dir = TempDir::new().expect("tempdir");
    // Drop write bits from the temp dir. POSIX `0o555` = r-xr-xr-x;
    // root can still write through, so we skip the assert under euid 0
    // (CI runners are usually non-root, so this normally runs).
    let ro_perms = std::fs::Permissions::from_mode(0o555);
    std::fs::set_permissions(dir.path(), ro_perms.clone()).expect("chmod ro");

    let mut cfg = ServerConfig {
        // Use a pidfile in a writable parent so the failure is unambiguously
        // the data_root probe, not the pidfile probe.
        pidfile_path: std::env::temp_dir().join("pt-serve-task4a-test.pid"),
        ..common::default_test_config(dir.path().to_path_buf())
    };

    let result = cfg.validate();
    // Restore perms before any assert path so the TempDir's Drop can
    // actually clean up (a r-x dir blocks `unlink`).
    let rw_perms = std::fs::Permissions::from_mode(0o755);
    let _ = std::fs::set_permissions(dir.path(), rw_perms);

    if is_root() {
        // Root bypasses POSIX perms — skip the assert, the probe will
        // succeed. We don't want a false-negative on a root CI.
        return;
    }
    match result {
        Err(ConfigError::DataRootNotWritable(p, _)) => assert_eq!(p, dir.path()),
        other => panic!("expected DataRootNotWritable, got {other:?}"),
    }
}

#[cfg(unix)]
#[test]
fn pidfile_parent_not_writable_rejected() {
    use std::os::unix::fs::PermissionsExt;

    // We need TWO dirs: one writable (data_root) and one read-only (pidfile
    // parent). Otherwise `validate()` short-circuits on the data_root check
    // before reaching the pidfile probe.
    let data_dir = TempDir::new().expect("data tempdir");
    let pid_dir = TempDir::new().expect("pid tempdir");

    let ro_perms = std::fs::Permissions::from_mode(0o555);
    std::fs::set_permissions(pid_dir.path(), ro_perms).expect("chmod ro");

    let pidfile_path = pid_dir.path().join("pt-serve.pid");
    let mut cfg = ServerConfig {
        pidfile_path: pidfile_path.clone(),
        ..common::default_test_config(data_dir.path().to_path_buf())
    };

    let result = cfg.validate();
    // Restore perms before any assert / Drop so TempDir cleanup succeeds.
    let rw_perms = std::fs::Permissions::from_mode(0o755);
    let _ = std::fs::set_permissions(pid_dir.path(), rw_perms);

    if is_root() {
        return;
    }
    match result {
        Err(ConfigError::PidfileParentNotWritable(p, _)) => assert_eq!(p, pid_dir.path()),
        other => panic!("expected PidfileParentNotWritable, got {other:?}"),
    }
}

/// Detect whether the test process is running as root. Linux/macOS expose
/// this via `geteuid`. On root, POSIX permission checks are bypassed by the
/// kernel, so `0o555`-style writability probes succeed even where we'd
/// expect them to fail. We use this to skip the "not writable" arms of the
/// tests above (rather than fail them and pretend the validator is broken).
#[cfg(unix)]
fn is_root() -> bool {
    // SAFETY: `geteuid` is a process-global syscall with no inputs and a
    // single integer return. Calling it from a test thread is safe.
    unsafe { libc_geteuid() == 0 }
}

#[cfg(unix)]
extern "C" {
    #[link_name = "geteuid"]
    fn libc_geteuid() -> u32;
}
