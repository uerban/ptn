use super::*;
use ed25519_dalek::Signer;
use pt_artifacts::{
    transit_discovery::{self, Discovery},
    transit_discovery_publish::{self, Publication as Listing},
};

fn list(root: &Path, cities: &[&str], now: i64) -> io::Result<transit_discovery_publish::Receipt> {
    transit_discovery_publish::publish(
        root,
        &Listing {
            cities: &cities.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            expires_at: &jiff::Timestamp::from_second(now + 3600)
                .unwrap()
                .to_string(),
            signing_key: &key(),
            trusted_keys: &keys(),
            now,
        },
    )
}
fn alias(root: &Path) -> PathBuf {
    root.join("public/transit/discovery/v1")
}
fn state(root: &Path) -> PathBuf {
    root.join("private/state/transit-discovery-publish.json")
}
fn snapshot(root: &Path) -> (Vec<u8>, Vec<u8>) {
    (
        fs::read(alias(root).join("latest.json")).unwrap(),
        fs::read(alias(root).join("latest.json.sig")).unwrap(),
    )
}
fn signed(discovery: &Discovery) -> (Vec<u8>, [u8; 64]) {
    let bytes = serde_json::to_vec(discovery).unwrap();
    let sig = key()
        .sign(&[b"PTN-TRANSIT-DISCOVERY-v1\0".as_slice(), &bytes].concat())
        .to_bytes();
    (bytes, sig)
}

#[test]
fn discovery_installs_its_exact_snapshot_after_city_renewal_and_retains_removed_city() {
    let fixture = native_with_shapes();
    let (_exports, paths) = exports(&fixture, &[false, true]);
    let repo = tempfile::tempdir().unwrap();
    publish(repo.path(), &paths, transit_now()).unwrap();
    let mut second = Fixture::native();
    second.pack.city_slug = "second".into();
    second.generation.city_slug = "second".into();
    second.save();
    let (_second, second_paths) = exports(&second, &[false]);
    transit_publish::publish(
        repo.path(),
        &Publication {
            city: "second",
            exports: &second_paths,
            expires_at: &jiff::Timestamp::from_second(transit_now() + 86400)
                .unwrap()
                .to_string(),
            signing_key: &key(),
            trusted_keys: &keys(),
            now: transit_now(),
        },
    )
    .unwrap();
    let receipt = list(repo.path(), &["second", "fixture"], transit_now()).unwrap();
    assert_eq!(receipt.sequence, 1);
    let source = LocalRepository(repo.path().join("public"));
    let local = tempfile::tempdir().unwrap();
    let store = TransitStore::open(local.path()).unwrap();
    let discovery = store.discover(&source, &keys(), transit_now()).unwrap();
    assert_eq!(
        discovery
            .cities
            .iter()
            .map(|c| c.city.as_str())
            .collect::<Vec<_>>(),
        ["fixture", "second"]
    );
    assert!(
        discovery.cities[0].choices[1].selected_bytes
            > discovery.cities[0].choices[0].selected_bytes
    );
    publish(repo.path(), &paths, transit_now() + 1).unwrap();
    let policy = Policy {
        geometry: false,
        ..Default::default()
    };
    assert!(store
        .sync_discovered(&source, "fixture", &keys(), transit_now() + 2, &policy)
        .unwrap());
    assert_eq!(
        store
            .status("fixture")
            .unwrap()
            .unwrap()
            .checkpoint
            .sequence,
        1,
        "install discovery head, not newer mutable city alias"
    );
    assert!(store
        .sync_discovered(&source, "second", &keys(), transit_now() + 2, &policy)
        .unwrap());
    list(repo.path(), &["fixture"], transit_now() + 3).unwrap();
    assert!(store
        .sync_discovered(&source, "fixture", &keys(), transit_now() + 4, &policy)
        .unwrap());
    assert_eq!(
        store
            .status("fixture")
            .unwrap()
            .unwrap()
            .checkpoint
            .sequence,
        2
    );
    assert!(store
        .sync_discovered(&source, "second", &keys(), transit_now() + 4, &policy)
        .is_err());
    assert!(store
        .validate_current("second", &keys(), transit_now() + 4)
        .is_ok());
    assert_eq!(
        store
            .discover(&source, &keys(), transit_now() + 4)
            .unwrap()
            .cities
            .len(),
        1
    );
}

#[test]
fn listing_requires_complete_fresh_cities_and_preserves_old_snapshot_on_failure() {
    let fixture = Fixture::native();
    let (_exports, paths) = exports(&fixture, &[false]);
    let repo = tempfile::tempdir().unwrap();
    publish(repo.path(), &paths, transit_now()).unwrap();
    list(repo.path(), &["fixture"], transit_now()).unwrap();
    let before = snapshot(repo.path());
    let journal = fs::read(state(repo.path())).unwrap();
    for cities in [
        &[][..],
        &["missing"][..],
        &["fixture", "fixture"][..],
        &["../fixture"][..],
    ] {
        assert!(list(repo.path(), cities, transit_now() + 1).is_err());
    }
    let object = fs::read_dir(repo.path().join("public/transit/objects/sha256"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let original = fs::read(&object).unwrap();
    fs::write(&object, b"corrupt").unwrap();
    assert!(list(repo.path(), &["fixture"], transit_now() + 1).is_err());
    fs::write(object, original).unwrap();
    assert!(
        list(repo.path(), &["fixture"], transit_now() + 86400).is_err(),
        "expired city cannot be advertised"
    );
    assert!(
        transit_discovery_publish::publish(
            repo.path(),
            &Listing {
                cities: &["fixture".into()],
                expires_at: &jiff::Timestamp::from_second(transit_now() + 86401)
                    .unwrap()
                    .to_string(),
                signing_key: &key(),
                trusted_keys: &keys(),
                now: transit_now() + 1
            }
        )
        .is_err(),
        "listing expiry cannot outlive a city head"
    );
    assert_eq!(snapshot(repo.path()), before);
    assert_eq!(fs::read(state(repo.path())).unwrap(), journal);
}

#[test]
fn discovery_rejects_replay_equivocation_wrong_domain_and_malformed_signed_entries() {
    let fixture = Fixture::native();
    let (_exports, paths) = exports(&fixture, &[false]);
    let repo = tempfile::tempdir().unwrap();
    publish(repo.path(), &paths, transit_now()).unwrap();
    list(repo.path(), &["fixture"], transit_now()).unwrap();
    let (bytes, sig) = snapshot(repo.path());
    let valid = transit_discovery::verify(&bytes, &sig, &keys(), None, transit_now()).unwrap();
    let checkpoint = pt_artifacts::transit_catalog::Checkpoint {
        sequence: 1,
        sha256: digest(&bytes),
    };
    let mut changed = valid.clone();
    changed.published_at = jiff::Timestamp::from_second(transit_now() + 1)
        .unwrap()
        .to_string();
    let (alternate, alternate_sig) = signed(&changed);
    assert!(transit_discovery::verify(
        &alternate,
        &alternate_sig,
        &keys(),
        Some(&checkpoint),
        transit_now()
    )
    .is_err());
    list(repo.path(), &["fixture"], transit_now() + 1).unwrap();
    let newer = pt_artifacts::transit_catalog::Checkpoint {
        sequence: 2,
        sha256: digest(&snapshot(repo.path()).0),
    };
    assert!(
        transit_discovery::verify(&bytes, &sig, &keys(), Some(&newer), transit_now() + 2).is_err()
    );
    assert!(transit_discovery::verify(&bytes, &sig, &[[0; 32]], None, transit_now()).is_err());
    let wrong_domain = key()
        .sign(&pt_artifacts::transit_catalog::signing_message(&bytes).unwrap())
        .to_bytes();
    assert!(
        transit_discovery::verify(&bytes, &wrong_domain, &keys(), None, transit_now()).is_err()
    );
    assert!(transit_discovery::verify(&bytes, &sig, &keys(), None, transit_now() + 3600).is_err());
    assert!(transit_discovery::verify(
        &vec![0; transit_discovery::MAX_BYTES + 1],
        &sig,
        &keys(),
        None,
        transit_now()
    )
    .is_err());
    for case in 0..7 {
        let mut bad = valid.clone();
        match case {
            0 => bad.cities.push(bad.cities[0].clone()),
            1 => bad.cities[0].city = "../fixture".into(),
            2 => {
                let choice = bad.cities[0].choices[0].clone();
                bad.cities[0].choices.push(choice);
            }
            3 => bad.cities[0].head_sha256 = "invalid".into(),
            4 => {
                bad.expires_at = jiff::Timestamp::from_second(transit_now() + 86401)
                    .unwrap()
                    .to_string()
            }
            5 => {
                bad.published_at = jiff::Timestamp::from_second(transit_now() + 301)
                    .unwrap()
                    .to_string()
            }
            6 => bad.sequence = 0,
            _ => unreachable!(),
        }
        let (bytes, sig) = signed(&bad);
        assert!(
            transit_discovery::verify(&bytes, &sig, &keys(), None, transit_now()).is_err(),
            "case {case}"
        );
    }
}

#[test]
fn discovery_reservations_and_completion_recover_without_resetting_lost_state() {
    let fixture = Fixture::native();
    let (_exports, paths) = exports(&fixture, &[false]);
    let repo = tempfile::tempdir().unwrap();
    publish(repo.path(), &paths, transit_now()).unwrap();
    list(repo.path(), &["fixture"], transit_now()).unwrap();
    let before = snapshot(repo.path());
    let mut next: Discovery = serde_json::from_slice(&before.0).unwrap();
    next.sequence = 2;
    next.published_at = jiff::Timestamp::from_second(transit_now() + 1)
        .unwrap()
        .to_string();
    next.expires_at = jiff::Timestamp::from_second(transit_now() + 3601)
        .unwrap()
        .to_string();
    let (bytes, _) = transit_discovery::prepare(&next, &key(), transit_now() + 1).unwrap();
    let blocked = repo
        .path()
        .join("public/transit/discovery/heads")
        .join(digest(&bytes));
    fs::create_dir(blocked).unwrap();
    assert!(list(repo.path(), &["fixture"], transit_now() + 1).is_err());
    assert_eq!(snapshot(repo.path()), before);
    let reserved: Value = serde_json::from_slice(&fs::read(state(repo.path())).unwrap()).unwrap();
    assert_eq!(reserved["highestSequence"], 2);
    assert_eq!(
        list(repo.path(), &["fixture"], transit_now() + 2)
            .unwrap()
            .sequence,
        3
    );
    let mut completed: Value =
        serde_json::from_slice(&fs::read(state(repo.path())).unwrap()).unwrap();
    completed["pending"] = completed["published"].clone();
    completed["published"] = reserved["published"].clone();
    fs::write(state(repo.path()), serde_json::to_vec(&completed).unwrap()).unwrap();
    assert_eq!(
        list(repo.path(), &["fixture"], transit_now() + 3)
            .unwrap()
            .sequence,
        4
    );
    let saved = fs::read(state(repo.path())).unwrap();
    fs::remove_file(state(repo.path())).unwrap();
    assert!(list(repo.path(), &["fixture"], transit_now() + 4).is_err());
    let target = fs::read_link(alias(repo.path())).unwrap();
    fs::remove_file(alias(repo.path())).unwrap();
    assert!(list(repo.path(), &["fixture"], transit_now() + 4).is_err());
    symlink(target, alias(repo.path())).unwrap();
    fs::write(state(repo.path()), saved).unwrap();
}

#[test]
fn discovery_download_failures_preserve_city_and_replay_checkpoints_survive_restart() {
    let fixture = Fixture::native();
    let (_exports, paths) = exports(&fixture, &[false]);
    let repo = tempfile::tempdir().unwrap();
    publish(repo.path(), &paths, transit_now()).unwrap();
    list(repo.path(), &["fixture"], transit_now()).unwrap();
    let source = LocalRepository(repo.path().join("public"));
    let local = tempfile::tempdir().unwrap();
    let store = TransitStore::open(local.path()).unwrap();
    let policy = Policy {
        geometry: false,
        ..Default::default()
    };
    store
        .sync_discovered(&source, "fixture", &keys(), transit_now(), &policy)
        .unwrap();
    let city = serde_json::to_value(store.status("fixture").unwrap()).unwrap();
    let old = snapshot(repo.path());
    publish(repo.path(), &paths, transit_now() + 1).unwrap();
    list(repo.path(), &["fixture"], transit_now() + 1).unwrap();
    let mut listing: Discovery = serde_json::from_slice(&snapshot(repo.path()).0).unwrap();
    listing.sequence = 3;
    listing.cities[0].choices[0].selected_bytes += 1;
    let (bytes, sig) = signed(&listing);
    let hash = digest(&bytes);
    let staged = repo
        .path()
        .join("public/transit/discovery/heads")
        .join(&hash);
    fs::create_dir(&staged).unwrap();
    fs::write(staged.join("latest.json"), &bytes).unwrap();
    fs::write(staged.join("latest.json.sig"), sig).unwrap();
    fs::remove_file(alias(repo.path())).unwrap();
    symlink(format!("heads/{hash}"), alias(repo.path())).unwrap();
    assert!(store
        .sync_discovered(&source, "fixture", &keys(), transit_now() + 2, &policy)
        .is_err());
    assert_eq!(
        serde_json::to_value(store.status("fixture").unwrap()).unwrap(),
        city
    );
    drop(store);
    let store = TransitStore::open(local.path()).unwrap();
    // Restore an old public alias: the persisted discovery checkpoint rejects it.
    let old_hash = digest(&old.0);
    fs::remove_file(alias(repo.path())).unwrap();
    symlink(format!("heads/{old_hash}"), alias(repo.path())).unwrap();
    assert!(store.discover(&source, &keys(), transit_now() + 2).is_err());
    store.set_pinned("fixture", true).unwrap();
    fs::remove_file(alias(repo.path())).unwrap();
    assert!(
        !store
            .sync_discovered(&source, "fixture", &keys(), transit_now() + 3, &policy)
            .unwrap(),
        "pinned sync does not need discovery"
    );
}

#[test]
fn discovery_and_installer_clis_list_sizes_and_install_without_city_alias_reads() {
    let fixture = Fixture::native();
    let (_exports, paths) = exports(&fixture, &[false]);
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repository");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    publish(&repo, &paths, now).unwrap();
    let keyfile = root.path().join("key");
    fs::write(&keyfile, "11".repeat(32)).unwrap();
    let public_key: String = keys()[0].iter().map(|b| format!("{b:02x}")).collect();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_pt-pack-discovery"))
        .arg("--repository")
        .arg(&repo)
        .args(["--city", "fixture", "--trusted-key", &public_key])
        .arg("--signing-key")
        .arg(keyfile)
        .arg("--expires-at")
        .arg(
            jiff::Timestamp::from_second(now + 3600)
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
    let local = root.path().join("local");
    let public = repo.join("public");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_pt-transit"))
        .arg("--root")
        .arg(&local)
        .args(["--trusted-key", &public_key, "cities", "--source-directory"])
        .arg(&public)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let listing: Discovery = serde_json::from_slice(&output.stdout).unwrap();
    assert!(listing.cities[0].choices[0].selected_bytes > 0);
    fs::remove_file(channel(&repo)).unwrap(); // Installation must follow immutable discovery references.
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_pt-transit"))
        .arg("--root")
        .arg(&local)
        .args([
            "--city",
            "fixture",
            "--trusted-key",
            &public_key,
            "sync",
            "--from-discovery",
            "--without-geometry",
            "--source-directory",
        ])
        .arg(public)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
