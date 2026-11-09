use super::{digest, transit_now, Fixture};
use ed25519_dalek::SigningKey;
use pt_artifacts::{
    install::{LocalRepository, Repository},
    store::Store,
    transit_catalog::{self, Catalog},
    transit_export,
    transit_install::{Policy, TransitStore},
    transit_publish::{self, Publication, Receipt},
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, Read},
    os::unix::fs::symlink,
    path::{Path, PathBuf},
};

fn key() -> SigningKey {
    SigningKey::from_bytes(&[17; 32])
}
fn keys() -> [[u8; 32]; 1] {
    [key().verifying_key().to_bytes()]
}
fn native_with_shapes() -> Fixture {
    let mut fixture = Fixture::native();
    let reader =
        pt_core::Reader::from_bytes(fs::read(fixture.path().join("bundle.ptb")).unwrap()).unwrap();
    let (trips, stops) = pt_shared::validate::namespace::bundle_namespace_shas(&reader).unwrap();
    let shapes = pt_shared::sidecar::encode_shapes_bin(&[], &trips, &stops).unwrap();
    fixture.artifact("shapes-bin", "shapes.bin", &shapes);
    fixture.generation.shapes_bin_sha256 = Some(digest(&shapes));
    fixture.save();
    fixture
}
fn exports(fixture: &Fixture, variants: &[bool]) -> (tempfile::TempDir, Vec<PathBuf>) {
    let root = tempfile::tempdir().unwrap();
    let paths = variants
        .iter()
        .enumerate()
        .map(|(i, geometry)| {
            let path = root.path().join(i.to_string());
            transit_export::export(fixture.path(), &path, *geometry, &key()).unwrap();
            path
        })
        .collect();
    (root, paths)
}
fn publish(root: &Path, paths: &[PathBuf], now: i64) -> io::Result<Receipt> {
    transit_publish::publish(
        root,
        &Publication {
            city: "fixture",
            exports: paths,
            expires_at: &jiff::Timestamp::from_second(now + 86400)
                .unwrap()
                .to_string(),
            signing_key: &key(),
            trusted_keys: &keys(),
            now,
        },
    )
}
fn channel(root: &Path) -> PathBuf {
    root.join("public/transit/catalog/v1/fixture")
}
fn ledger(root: &Path) -> PathBuf {
    root.join("private/state/transit-publish-fixture.json")
}
fn head(root: &Path) -> Vec<u8> {
    fs::read(channel(root).join("latest.json")).unwrap()
}

#[test]
fn assembles_a_complete_installable_repository_and_renews_expired_heads() {
    let fixture = native_with_shapes();
    let (_exports, paths) = exports(&fixture, &[false, true]);
    let repo = tempfile::tempdir().unwrap();
    let first = publish(repo.path(), &paths, transit_now()).unwrap();
    assert_eq!(first.sequence, 1);
    assert_eq!(first.pack_id, fixture.pack.pack_id);
    let first_bytes = head(repo.path());
    assert_eq!(first.head_sha256, digest(&first_bytes));
    assert!(fs::symlink_metadata(channel(repo.path()))
        .unwrap()
        .file_type()
        .is_symlink());
    let public = repo.path().join("public");
    assert_eq!(
        fs::read_dir(&public).unwrap().count(),
        1,
        "only transit is public"
    );
    let objects = public.join("transit/objects/sha256");
    let count = fs::read_dir(&objects).unwrap().count();
    let installed = tempfile::tempdir().unwrap();
    let store = TransitStore::open(installed.path()).unwrap();
    let source = LocalRepository(public);
    assert!(store
        .sync(
            &source,
            "fixture",
            &keys(),
            transit_now(),
            &Policy {
                geometry: false,
                ..Default::default()
            }
        )
        .unwrap());
    let minimal = store.status("fixture").unwrap().unwrap().current;
    assert!(!store
        .release_path("fixture", &minimal)
        .unwrap()
        .join("shapes.bin")
        .exists());
    assert!(store
        .sync(
            &source,
            "fixture",
            &keys(),
            transit_now(),
            &Policy::default()
        )
        .unwrap());
    let full = store.status("fixture").unwrap().unwrap().current;
    assert!(store
        .release_path("fixture", &full)
        .unwrap()
        .join("shapes.bin")
        .exists());
    assert_eq!(minimal.pack_id, full.pack_id);
    let second = publish(repo.path(), &paths, transit_now() + 86401).unwrap();
    assert_eq!(second.sequence, 2);
    assert_eq!(fs::read_dir(objects).unwrap().count(), count);
    assert_eq!(
        fs::read(
            repo.path()
                .join("public/transit/catalog/heads")
                .join(&first.head_sha256)
                .join("latest.json")
        )
        .unwrap(),
        first_bytes
    );
    let state: Value = serde_json::from_slice(&fs::read(ledger(repo.path())).unwrap()).unwrap();
    assert_eq!(state["highestSequence"], 2);
    assert!(state["pending"].is_null());
    assert_eq!(state["published"]["sha256"], second.head_sha256);
    // Renewal can use a new head key while preserving existing trusted descriptor signatures.
    let new_key = SigningKey::from_bytes(&[29; 32]);
    let rotated = [keys()[0], new_key.verifying_key().to_bytes()];
    let receipt = transit_publish::publish(
        repo.path(),
        &Publication {
            city: "fixture",
            exports: &paths,
            expires_at: &jiff::Timestamp::from_second(transit_now() + 200000)
                .unwrap()
                .to_string(),
            signing_key: &new_key,
            trusted_keys: &rotated,
            now: transit_now() + 86402,
        },
    )
    .unwrap();
    assert_eq!(receipt.sequence, 3);
}

#[test]
fn invalid_exports_leave_head_and_sequence_unchanged() {
    let fixture = Fixture::native();
    let (_good, good) = exports(&fixture, &[false]);
    let repo = tempfile::tempdir().unwrap();
    publish(repo.path(), &good, transit_now()).unwrap();
    let before = head(repo.path());
    let checkpoint = fs::read(ledger(repo.path())).unwrap();
    for case in 0..5 {
        let bad = if case == 3 {
            Fixture::new()
        } else {
            Fixture::native()
        };
        let (_inputs, mut paths) = exports(&bad, &[false]);
        match case {
            0 => fs::write(paths[0].join("selection.json.sig"), [0; 64]).unwrap(),
            1 => fs::remove_file(paths[0].join("files/bundle.ptb")).unwrap(),
            2 => fs::write(paths[0].join("files/bundle.ptb"), b"corruption").unwrap(),
            3 => {} // Correct hashes/signature over invalid native data.
            4 => paths.push(paths[0].clone()), // Ambiguous geometry choice.
            _ => unreachable!(),
        }
        assert!(
            publish(repo.path(), &paths, transit_now() + 1).is_err(),
            "case {case}"
        );
        assert_eq!(head(repo.path()), before);
        assert_eq!(fs::read(ledger(repo.path())).unwrap(), checkpoint);
    }
    let writer = Store::open(&repo.path().join("private")).unwrap();
    assert!(publish(repo.path(), &good, transit_now() + 1).is_err());
    drop(writer);
    assert_eq!(head(repo.path()), before);
}

#[test]
fn reservation_survives_failure_and_pending_completion_recovers() {
    let fixture = Fixture::native();
    let (_exports, paths) = exports(&fixture, &[false]);
    let repo = tempfile::tempdir().unwrap();
    publish(repo.path(), &paths, transit_now()).unwrap();
    let before = head(repo.path());
    let mut next: Catalog = serde_json::from_slice(&before).unwrap();
    next.sequence = 2;
    next.published_at = jiff::Timestamp::from_second(transit_now() + 1)
        .unwrap()
        .to_string();
    next.expires_at = jiff::Timestamp::from_second(transit_now() + 86401)
        .unwrap()
        .to_string();
    let (bytes, _) = transit_catalog::prepare(&next, &key(), transit_now() + 1).unwrap();
    // Collision discovered after durable reservation but before the public switch.
    let blocked = repo
        .path()
        .join("public/transit/catalog/heads")
        .join(digest(&bytes));
    fs::create_dir(&blocked).unwrap();
    fs::write(blocked.join("latest.json"), b"corrupt").unwrap();
    assert!(publish(repo.path(), &paths, transit_now() + 1).is_err());
    assert_eq!(head(repo.path()), before);
    let mut state: Value = serde_json::from_slice(&fs::read(ledger(repo.path())).unwrap()).unwrap();
    assert_eq!(state["highestSequence"], 2);
    assert_eq!(state["pending"]["sequence"], 2);
    let prior = state["published"].clone();
    assert_eq!(
        publish(repo.path(), &paths, transit_now() + 2)
            .unwrap()
            .sequence,
        3
    );
    // Simulate crash just after head switch: ledger still has its write-ahead entry.
    state = serde_json::from_slice(&fs::read(ledger(repo.path())).unwrap()).unwrap();
    state["pending"] = state["published"].clone();
    state["published"] = prior;
    fs::write(ledger(repo.path()), serde_json::to_vec(&state).unwrap()).unwrap();
    assert_eq!(
        publish(repo.path(), &paths, transit_now() + 3)
            .unwrap()
            .sequence,
        4
    );
    assert!(!repo
        .path()
        .join("private/state/transit-publish-staging")
        .exists());
}

#[test]
fn corruption_and_missing_or_rewound_state_never_reset_sequence() {
    let fixture = Fixture::native();
    let (_exports, paths) = exports(&fixture, &[false]);
    let repo = tempfile::tempdir().unwrap();
    let first = publish(repo.path(), &paths, transit_now()).unwrap();
    publish(repo.path(), &paths, transit_now() + 1).unwrap();
    let before = head(repo.path());
    let state = fs::read(ledger(repo.path())).unwrap();
    fs::remove_file(ledger(repo.path())).unwrap();
    assert!(publish(repo.path(), &paths, transit_now() + 2).is_err());
    let current = fs::read_link(channel(repo.path())).unwrap();
    fs::remove_file(channel(repo.path())).unwrap();
    assert!(
        publish(repo.path(), &paths, transit_now() + 2).is_err(),
        "retained immutable heads forbid resetting a lost ledger and alias"
    );
    symlink(&current, channel(repo.path())).unwrap();
    fs::write(ledger(repo.path()), &state).unwrap();
    fs::remove_file(channel(repo.path())).unwrap();
    symlink(
        format!("../heads/{}", first.head_sha256),
        channel(repo.path()),
    )
    .unwrap();
    assert!(publish(repo.path(), &paths, transit_now() + 2).is_err());
    fs::remove_file(channel(repo.path())).unwrap();
    symlink(current, channel(repo.path())).unwrap();
    let object = fs::read_dir(repo.path().join("public/transit/objects/sha256"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::write(object, b"corrupt immutable object").unwrap();
    assert!(publish(repo.path(), &paths, transit_now() + 2).is_err());
    assert_eq!(head(repo.path()), before);
    assert_eq!(fs::read(ledger(repo.path())).unwrap(), state);
}

#[test]
fn installer_uses_signature_of_exact_cached_head_during_publication_race() {
    let fixture = Fixture::native();
    let (_exports, paths) = exports(&fixture, &[false]);
    let repo = tempfile::tempdir().unwrap();
    publish(repo.path(), &paths, transit_now()).unwrap();
    let stale = head(repo.path());
    publish(repo.path(), &paths, transit_now() + 1).unwrap();
    struct CachedHead {
        source: LocalRepository,
        stale: Vec<u8>,
    }
    impl Repository for CachedHead {
        fn open(&self, path: &str) -> io::Result<Box<dyn Read>> {
            if path == "transit/catalog/v1/fixture/latest.json" {
                return Ok(Box::new(io::Cursor::new(self.stale.clone())));
            }
            if path == "transit/catalog/v1/fixture/latest.json.sig" {
                return Err(io::Error::other("mutable signature unavailable"));
            }
            self.source.open(path)
        }
    }
    let source = LocalRepository(repo.path().join("public"));
    let cached = CachedHead {
        source: LocalRepository(source.0.clone()),
        stale,
    };
    let local = tempfile::tempdir().unwrap();
    let store = TransitStore::open(local.path()).unwrap();
    let policy = Policy {
        geometry: false,
        ..Default::default()
    };
    assert!(store
        .sync(&cached, "fixture", &keys(), transit_now() + 2, &policy)
        .unwrap());
    assert_eq!(
        store
            .status("fixture")
            .unwrap()
            .unwrap()
            .checkpoint
            .sequence,
        1
    );
    assert!(store
        .sync(&source, "fixture", &keys(), transit_now() + 2, &policy)
        .unwrap());
    assert!(store
        .sync(&cached, "fixture", &keys(), transit_now() + 2, &policy)
        .is_err());
}

#[test]
fn publication_cli_builds_a_consumable_public_tree() {
    let fixture = Fixture::native();
    let (_exports, paths) = exports(&fixture, &[false, true]);
    let root = tempfile::tempdir().unwrap();
    let keyfile = root.path().join("signing-key");
    fs::write(&keyfile, "11".repeat(32)).unwrap();
    let public_key: String = keys()[0].iter().map(|b| format!("{b:02x}")).collect();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let repo = root.path().join("repository");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_pt-pack-publish"))
        .arg("--repository")
        .arg(&repo)
        .arg("--city")
        .arg("fixture")
        .arg("--selection")
        .arg(&paths[0])
        .arg("--selection")
        .arg(&paths[1])
        .arg("--signing-key")
        .arg(keyfile)
        .arg("--trusted-key")
        .arg(public_key)
        .arg("--expires-at")
        .arg(
            jiff::Timestamp::from_second(now + 86400)
                .unwrap()
                .to_string(),
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["sequence"], 1);
    let local = tempfile::tempdir().unwrap();
    TransitStore::open(local.path())
        .unwrap()
        .sync(
            &LocalRepository(repo.join("public")),
            "fixture",
            &keys(),
            now,
            &Policy::default(),
        )
        .unwrap();
    assert!(!repo.join("public/signing-key").exists());
    assert_eq!(receipt["packId"], json!(fixture.pack.pack_id));
}

#[test]
fn rejects_invalid_policy_mixed_packs_and_missing_published_head() {
    let fixture = Fixture::native();
    let (_exports, paths) = exports(&fixture, &[false]);
    let repo = tempfile::tempdir().unwrap();
    publish(repo.path(), &paths, transit_now()).unwrap();
    let before = head(repo.path());
    let before_ledger = fs::read(ledger(repo.path())).unwrap();
    let mut other = Fixture::native();
    other.artifact("color-config", "color-config.json", b"{}");
    other.save();
    let (_other, other_paths) = exports(&other, &[true]);
    let mixed = vec![paths[0].clone(), other_paths[0].clone()];
    let expiry = jiff::Timestamp::from_second(transit_now() + 86400)
        .unwrap()
        .to_string();
    for (city, selected, expires, trusted) in [
        (
            "../fixture",
            paths.as_slice(),
            expiry.as_str(),
            keys().to_vec(),
        ),
        ("fixture", &[][..], expiry.as_str(), keys().to_vec()),
        (
            "fixture",
            paths.as_slice(),
            "2000-01-01T00:00:00Z",
            keys().to_vec(),
        ),
        ("fixture", paths.as_slice(), expiry.as_str(), vec![[0; 32]]),
        (
            "fixture",
            mixed.as_slice(),
            expiry.as_str(),
            keys().to_vec(),
        ),
    ] {
        assert!(transit_publish::publish(
            repo.path(),
            &Publication {
                city,
                exports: selected,
                expires_at: expires,
                signing_key: &key(),
                trusted_keys: &trusted,
                now: transit_now() + 1,
            }
        )
        .is_err());
        assert_eq!(head(repo.path()), before);
        assert_eq!(fs::read(ledger(repo.path())).unwrap(), before_ledger);
    }
    let target = fs::read_link(channel(repo.path())).unwrap();
    fs::remove_file(channel(repo.path())).unwrap();
    assert!(publish(repo.path(), &paths, transit_now() + 1).is_err());
    symlink(target, channel(repo.path())).unwrap();
    assert_eq!(head(repo.path()), before);
}

#[test]
fn interrupted_first_publication_does_not_reuse_its_reserved_sequence() {
    let fixture = Fixture::native();
    let (_exports, paths) = exports(&fixture, &[false]);
    let repo = tempfile::tempdir().unwrap();
    fs::create_dir_all(ledger(repo.path()).parent().unwrap()).unwrap();
    fs::write(
        ledger(repo.path()),
        serde_json::to_vec(&json!({
            "schemaVersion":1,"city":"fixture","highestSequence":7,"published":null,
            "pending":{"sequence":7,"sha256":"a".repeat(64)}
        }))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        publish(repo.path(), &paths, transit_now())
            .unwrap()
            .sequence,
        8
    );
}

#[test]
fn cities_share_objects_but_keep_independent_sequences() {
    let fixture = Fixture::native();
    let (_exports, paths) = exports(&fixture, &[false]);
    let repo = tempfile::tempdir().unwrap();
    publish(repo.path(), &paths, transit_now()).unwrap();
    let mut second = Fixture::native();
    second.pack.city_slug = "second".into();
    second.generation.city_slug = "second".into();
    second.save();
    let (_second, inputs) = exports(&second, &[false]);
    let receipt = transit_publish::publish(
        repo.path(),
        &Publication {
            city: "second",
            exports: &inputs,
            expires_at: &jiff::Timestamp::from_second(transit_now() + 86400)
                .unwrap()
                .to_string(),
            signing_key: &key(),
            trusted_keys: &keys(),
            now: transit_now(),
        },
    )
    .unwrap();
    assert_eq!(receipt.sequence, 1);
    assert_eq!(
        publish(repo.path(), &paths, transit_now() + 1)
            .unwrap()
            .sequence,
        2
    );
    let local = tempfile::tempdir().unwrap();
    let store = TransitStore::open(local.path()).unwrap();
    let source = LocalRepository(repo.path().join("public"));
    let policy = Policy {
        geometry: false,
        ..Default::default()
    };
    for city in ["fixture", "second"] {
        assert!(store
            .sync(&source, city, &keys(), transit_now() + 2, &policy)
            .unwrap());
    }
}

#[path = "transit_discovery.rs"]
mod discovery;
