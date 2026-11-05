//!
//! Drives `pt-producer periodic-refresh` end-to-end through the same
//! `Command` pattern as `publish_protocol_faults.rs`:
//!
//! - **transfers_emitted_when_supplied** — `--transfers <path>` writes
//!   `transfers.bin` into the generation dir and the manifest carries
//!   `hasTransfers=true` + the matching SHA + size.
//! - **janitor_reaps_excess_after_publish** — with
//!   `--max-retained-generations 1`, publishing TWO distinct generations
//!   leaves exactly one on disk (the newest) — the older non-pinned one
//!   got reaped at end-of-publish (step 9b).
//!
//! Skips if the producer binary isn't built (mirrors the existing suite's
//! `require_producer` pattern).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn producer_binary() -> PathBuf {
    workspace_root().join("target/release/pt-producer")
}

fn tiny_gtfs() -> PathBuf {
    workspace_root().join("crates/pt-producer/tests/fixtures/tiny-gtfs.zip")
}

/// Hermetic Node stub for the producer's color-artifacts-gen step (publish step
/// 3e). Without `PT_COLOR_ARTIFACTS_SCRIPT` the producer falls back to the prod
/// image path, which is absent outside the container, so the publish fails
/// before adopting a generation. Same stub the producer's own unit tests use.
fn color_artifacts_stub() -> PathBuf {
    workspace_root().join("crates/pt-producer/tests/fixtures/color-artifacts-stub.mjs")
}

fn require_producer() -> bool {
    if !producer_binary().exists() {
        eprintln!(
            "publish_transfers_and_janitor: SKIP — producer binary not built at {:?}",
            producer_binary()
        );
        return false;
    }
    if !tiny_gtfs().exists() {
        eprintln!(
            "publish_transfers_and_janitor: SKIP — tiny-gtfs.zip missing at {:?}",
            tiny_gtfs()
        );
        return false;
    }
    true
}

/// Build a `Command` that runs the producer in `periodic-refresh` mode against
/// `data_root` with the supplied anchor date. The caller appends extra
/// flags (`--transfers`, `--max-retained-generations`, etc).
fn producer_periodic_refresh(data_root: &Path, anchor_yyyymmdd: &str) -> Command {
    // periodic-refresh is a long-running DAEMON (one tick per
    // `--refresh-interval-secs`, exits only on SIGTERM/SIGINT). Two setup steps
    // mirror `publish_protocol_faults.rs`:
    //  - Write the `pt-serve.version` sentinel up front so the step-2.5
    //    deploy-ordering gate permits immediately; otherwise the producer burns its
    //    60 s absent-retry window and blows the test timeout.
    //  - Use `--refresh-interval-secs 1` so SIGTERM lands quickly after the first
    //    tick's side-effect is observed (drive via `run_until_published`).
    std::fs::create_dir_all(data_root).ok();
    std::fs::write(
        data_root.join("pt-serve.version"),
        format!("{}\n", pt_core::PTB_VERSION),
    )
    .ok();
    let mut cmd = Command::new(producer_binary());
    cmd.env("PT_COLOR_ARTIFACTS_SCRIPT", color_artifacts_stub());
    cmd.args([
        "periodic-refresh",
        "--data-root",
        data_root.to_str().unwrap(),
        "--city",
        "vilnius",
        "--gtfs",
        tiny_gtfs().to_str().unwrap(),
        "--anchor-date",
        anchor_yyyymmdd,
        // PTB v2 publication requires the city zone; UTC needs no offset.
        "--city-tz-iana",
        "UTC",
        "--refresh-interval-secs",
        "1",
    ]);
    cmd
}

fn run_producer(mut cmd: Command, timeout: Duration) -> (std::process::ExitStatus, String) {
    let mut child = cmd
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("spawn producer");
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stderr = String::new();
                if let Some(mut s) = child.stderr.take() {
                    use std::io::Read as _;
                    let _ = s.read_to_string(&mut stderr);
                }
                return (status, stderr);
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("producer did not complete within {timeout:?}");
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => panic!("producer try_wait error: {e}"),
        }
    }
}

/// The `generationId` `current.json` points at, or `None` if the pointer is
/// absent / unreadable / not yet flipped to a complete generation.
fn current_generation_id(data_root: &Path) -> Option<String> {
    let bytes = std::fs::read(data_root.join("current.json")).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v["generationId"].as_str().map(str::to_owned)
}

/// Drive the periodic-refresh DAEMON until `current.json` points at a
/// generation id different from `prev` (pass `None` for the first publish),
/// then SIGTERM it and return the captured stderr. Unlike `run_producer`, this
/// does NOT expect self-exit: periodic-refresh loops forever and exits only on
/// SIGTERM. Mirrors `publish_protocol_faults.rs::run_producer_until_published`
/// (the daemon refactor in 5afc0e19 updated that file but not this one).
fn run_until_published(
    mut cmd: Command,
    data_root: &Path,
    prev: Option<&str>,
    timeout: Duration,
) -> String {
    let mut child = cmd
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("spawn producer");
    let pid = child.id();

    // Drain stderr in the background so we can both report it on failure and
    // not deadlock on a full pipe while polling for the on-disk side-effect.
    let stderr_pipe = child.stderr.take().expect("stderr piped");
    let stderr_buf: std::sync::Arc<std::sync::Mutex<String>> =
        std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let stderr_clone = std::sync::Arc::clone(&stderr_buf);
    std::thread::spawn(move || {
        use std::io::BufRead as _;
        let reader = std::io::BufReader::new(stderr_pipe);
        for line in reader.lines().map_while(Result::ok) {
            let mut b = stderr_clone.lock().unwrap();
            b.push_str(&line);
            b.push('\n');
        }
    });

    let deadline = std::time::Instant::now() + timeout;
    let mut published = false;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            // Unexpected self-exit (e.g. the publish errored out). Surface it.
            std::thread::sleep(Duration::from_millis(50));
            let stderr = stderr_buf.lock().unwrap().clone();
            panic!("producer self-exited ({status:?}) before publishing\nstderr:\n{stderr}");
        }
        if !published {
            if let Some(id) = current_generation_id(data_root) {
                if prev.map(|p| p != id).unwrap_or(true) {
                    published = true;
                }
            }
        }
        if published {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
            let _ = child.wait();
            std::thread::sleep(Duration::from_millis(150));
            return stderr_buf.lock().unwrap().clone();
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            std::thread::sleep(Duration::from_millis(50));
            let stderr = stderr_buf.lock().unwrap().clone();
            panic!(
                "producer did not publish a new generation within {timeout:?}\nstderr:\n{stderr}"
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

// ----------------------------------------------------------------------------
// Test — `--transfers <path>` plumbs through to the published manifest
// ----------------------------------------------------------------------------

#[test]
fn transfers_emitted_when_supplied() {
    if !require_producer() {
        return;
    }
    let dir = tempfile::TempDir::new().unwrap();

    // Make a fake transfers.bin. The PTFT wire-format validator pt-serve
    // would invoke at LOAD time is structural; the producer's step-7
    // metadata validator pt-shared::validate::metadata::validate_metadata
    // checks SHA + size + has_transfers flag — NOT the PTFT body. So a
    // plausible byte buffer is sufficient for the publish protocol.
    //
    // We use a fixed-size payload so the manifest's transfersSizeBytes
    // assertion below is deterministic.
    let transfers_path = dir.path().join("input-transfers.bin");
    let payload: Vec<u8> = (0..1024u32).map(|i| (i & 0xff) as u8).collect();
    std::fs::write(&transfers_path, &payload).unwrap();

    let mut cmd = producer_periodic_refresh(dir.path(), "20260524");
    cmd.args(["--transfers", transfers_path.to_str().unwrap()]);
    // periodic-refresh is a daemon: drive it until the first generation is
    // published, then SIGTERM. The on-disk assertions below are the test's
    // promise (not a self-exit code).
    let _stderr = run_until_published(cmd, dir.path(), None, Duration::from_secs(30));

    // Read current.json → resolve generation id → inspect generation.json.
    let pointer: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("current.json")).unwrap()).unwrap();
    let gen_id = pointer["generationId"].as_str().unwrap();
    let gen_dir = dir.path().join("generations").join(gen_id);
    assert!(
        gen_dir.join("transfers.bin").exists(),
        "transfers.bin must be staged into the generation dir"
    );

    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(gen_dir.join("generation.json")).unwrap()).unwrap();
    assert_eq!(manifest["hasTransfers"], serde_json::Value::Bool(true));
    assert_eq!(
        manifest["transfersSizeBytes"].as_u64(),
        Some(payload.len() as u64),
        "transfersSizeBytes must equal the input payload length",
    );
    let sha = manifest["transfersSha256"]
        .as_str()
        .expect("transfersSha256");
    assert_eq!(sha.len(), 64, "transfersSha256 must be 64 hex chars");
    assert!(
        sha.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "transfersSha256 must be lowercase hex",
    );

    // Belt-and-braces: the staged file's bytes match what we wrote.
    let staged = std::fs::read(gen_dir.join("transfers.bin")).unwrap();
    assert_eq!(
        staged, payload,
        "staged transfers.bin must equal source bytes"
    );
}

// ----------------------------------------------------------------------------
// Test — `--city-osm-dir` builds transfers.bin from the generation's own stops
// ----------------------------------------------------------------------------

/// A gzipped osmium-style GeoJSONSeq footway through tiny-gtfs's three stops
/// (S1 → S2 → S3, ~640 m apart, so each hop is inside the 900 s cap).
fn write_tiny_city_osm_dir(dir: &Path) {
    use std::io::Write as _;
    let line = "\u{1e}{\"type\":\"Feature\",\"geometry\":{\"type\":\"LineString\",\"coordinates\":[[25.2800,54.6900],[25.2850,54.6950],[25.2900,54.7000]]},\"properties\":{\"highway\":\"footway\"}}\n";
    std::fs::create_dir_all(dir).unwrap();
    let file = std::fs::File::create(dir.join("walking.geojsonseq.gz")).unwrap();
    let mut gz = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    gz.write_all(line.as_bytes()).unwrap();
    gz.finish().unwrap();
}

#[test]
fn city_osm_dir_builds_transfers_for_the_published_stops() {
    if !require_producer() {
        return;
    }
    let dir = tempfile::TempDir::new().unwrap();
    let osm_dir = dir.path().join("city-osm");
    write_tiny_city_osm_dir(&osm_dir);
    let data_root = dir.path().join("data");
    std::fs::create_dir_all(&data_root).unwrap();

    let mut cmd = producer_periodic_refresh(&data_root, "20260524");
    cmd.args(["--city-osm-dir", osm_dir.to_str().unwrap()]);
    let stderr = run_until_published(cmd, &data_root, None, Duration::from_secs(30));
    assert!(
        stderr.contains("address-search.fst missing"),
        "a missing optional artifact must be a warning, got:\n{stderr}"
    );

    let gen_id = current_generation_id(&data_root).expect("published");
    let gen_dir = data_root.join("generations").join(&gen_id);
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(gen_dir.join("generation.json")).unwrap()).unwrap();
    assert_eq!(manifest["hasTransfers"], serde_json::Value::Bool(true));
    assert!(!gen_dir.join("address-search.fst").exists());

    let bytes = std::fs::read(gen_dir.join("transfers.bin")).unwrap();
    assert_eq!(
        manifest["transfersSizeBytes"].as_u64(),
        Some(bytes.len() as u64)
    );
    let table = pt_core::Transfers::from_bytes(&bytes).expect("valid PTFT");
    let bundle = pt_core::Reader::from_bytes(std::fs::read(gen_dir.join("bundle.ptb")).unwrap())
        .expect("bundle");
    assert_eq!(
        table.stop_count(),
        bundle.num_stops(),
        "one PTFT entry per PTB stop"
    );
    let s1 = table.index_of("S1").expect("S1 in table");
    let s2 = table.index_of("S2").expect("S2 in table");
    let (nbrs, secs) = table.edges(s1);
    let s1_s2 = nbrs
        .iter()
        .zip(secs)
        .find(|(to, _)| **to == s2)
        .map(|(_, secs)| *secs)
        .expect("S1 → S2 walk along the footway");
    assert!(
        (400..700).contains(&s1_s2),
        "S1 → S2 ≈ 640 m at 1.25 m/s, got {s1_s2} s"
    );
}

// ----------------------------------------------------------------------------
// Test — janitor reaps excess generations after a successful publish
// ----------------------------------------------------------------------------

#[test]
fn janitor_reaps_excess_after_publish() {
    if !require_producer() {
        return;
    }
    let dir = tempfile::TempDir::new().unwrap();

    // Publish twice, with `--max-retained-generations 1` — each tick's
    // tail janitor must trim the older non-pinned generation. The PTB
    // build's `feed_start_date` (= --anchor-date) is part of the bundle
    // header, so two different anchors produce two different SHAs and
    // therefore two different generation ids.
    let cmd1 = {
        let mut c = producer_periodic_refresh(dir.path(), "20260524");
        c.args(["--max-retained-generations", "1"]);
        c
    };
    let _stderr1 = run_until_published(cmd1, dir.path(), None, Duration::from_secs(30));
    let gen1 = current_generation_id(dir.path()).expect("first publish flips current.json");

    // Sleep > 1 s so the second publish's createdAt is strictly greater
    // than the first's. The janitor's "newest first" sort tiebreaks
    // equal-second timestamps by alphabetic id — when both publishes land
    // in the same wall-clock second, the alphabetic order (not the actual
    // publish order) determines which one looks "newest", and the test
    // becomes nondeterministic on a fast machine. A 1.1 s gap is enough
    // for the rfc3339 strings to differ in the seconds field.
    std::thread::sleep(Duration::from_millis(1_100));
    let cmd2 = {
        let mut c = producer_periodic_refresh(dir.path(), "20260525");
        c.args(["--max-retained-generations", "1"]);
        c
    };
    // Drive until current.json flips to a generation id distinct from gen1.
    let _stderr2 = run_until_published(cmd2, dir.path(), Some(&gen1), Duration::from_secs(30));
    let gen2 = current_generation_id(dir.path()).expect("second publish flips current.json");
    assert_ne!(
        gen1, gen2,
        "two distinct anchors must produce two distinct generation ids"
    );

    // After the second publish completes, the janitor (run at end of step
    // 9) should have removed gen1: it's not pinned (current.json points at
    // gen2; no last-good.json yet), and `max_retained=1` excludes it.
    let gens_dir = dir.path().join("generations");
    let surviving: Vec<String> = std::fs::read_dir(&gens_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        surviving,
        vec![gen2.clone()],
        "janitor must leave exactly one generation (gen2={gen2}); saw {surviving:?}"
    );
    assert!(
        !gens_dir.join(&gen1).exists(),
        "older generation {gen1} must be reaped"
    );
}

// ----------------------------------------------------------------------------
// Test — republish DR mode publishes and adopts a new generation
// ----------------------------------------------------------------------------

#[test]
fn republish_publishes_a_new_generation() {
    if !require_producer() {
        return;
    }
    let dir = tempfile::TempDir::new().unwrap();
    let archive_dir = dir.path().join("archive");

    // First do a periodic-refresh (daemon) so there's a "current" state to
    // archive; drive it to the first publish, then SIGTERM.
    let cmd_seed = producer_periodic_refresh(dir.path(), "20260524");
    let _stderr_seed = run_until_published(cmd_seed, dir.path(), None, Duration::from_secs(30));
    let seed_gen = current_generation_id(dir.path()).expect("seed publish flips current.json");

    // Now republish a NEW generation (different anchor → different SHA).
    // republish is single-tick (self-exits; no step-2.5 version gate), but it
    // still runs `publish_inner` → the color-artifacts step (3e), so it needs
    // the stub too.
    let mut cmd = Command::new(producer_binary());
    cmd.env("PT_COLOR_ARTIFACTS_SCRIPT", color_artifacts_stub());
    cmd.args([
        "republish",
        "--data-root",
        dir.path().to_str().unwrap(),
        "--city",
        "vilnius",
        "--from-cache",
        tiny_gtfs().to_str().unwrap(),
        "--archive-to",
        archive_dir.to_str().unwrap(),
        "--anchor-date",
        "20260525",
        "--city-tz-iana",
        "UTC",
    ]);
    let (status, stderr) = run_producer(cmd, Duration::from_secs(30));
    assert!(
        status.success(),
        "republish must succeed; got {status:?}\nstderr:\n{stderr}"
    );

    // Archive must contain a single timestamped subdirectory with current.json
    // + the prior generation's bundle.
    assert!(
        archive_dir.exists(),
        "--archive-to directory must be created"
    );
    let stamps: Vec<_> = std::fs::read_dir(&archive_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    assert_eq!(stamps.len(), 1, "exactly one archive stamp dir");
    assert!(stamps[0].join("current.json").exists());

    // current.json now points at the republished generation, which exists
    // on disk with a generation.json — and it is a NEW generation (the
    // different anchor → different SHA → different id from the seed).
    let pointer: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("current.json")).unwrap()).unwrap();
    let gen_id = pointer["generationId"].as_str().unwrap();
    assert_ne!(
        gen_id, seed_gen,
        "republish must adopt a NEW generation, distinct from the seed"
    );
    assert!(
        dir.path()
            .join("generations")
            .join(gen_id)
            .join("generation.json")
            .exists(),
        "republished generation must be promoted to generations/<id>/"
    );
}

// ----------------------------------------------------------------------------
// Test — address-search.json is staged into EVERY generation
// ----------------------------------------------------------------------------

/// The regression this flag exists for: pt-serve reads the address corpus from
/// `<data-root>/generations/<sha>/address-search.json`, and periodic-refresh
/// builds a fresh generation dir per tick. Before `--address-search`, nothing
/// copied a sidecar into the staging dir, so a hand-placed file survived at
/// most one refresh interval and all three `/api/<city>/address-search*`
/// routes then 404'd silently.
///
/// Asserting it lands in ONE generation would not catch that. This publishes
/// TWO distinct generations from a single supplied source file and asserts the
/// sidecar is present, byte-identical, in both.
#[test]
fn address_search_staged_into_every_generation() {
    if !require_producer() {
        return;
    }
    let dir = tempfile::TempDir::new().unwrap();

    // A packed PTAS schema-version-1 corpus, built through the same `pack`
    // the producer's `pack-address-search` subcommand calls. The producer
    // does NOT parse this file when staging — it is a propagate-only
    // passthrough — but keeping it loadable means a pt-serve test can point
    // at the same bytes.
    let source = dir.path().join("input-address-search.fst");
    let payload = pt_geocode::AddrIndex::pack(
        &[pt_geocode::AddrRow {
            label: "Gedimino pr. 1".to_string(),
            lat: 54.6879,
            lon: 25.2757,
        }],
        &[pt_geocode::AddrKey {
            key: "gedimino prospektas 1".to_string(),
            row_id: 0,
        }],
        &pt_geocode::ArtifactMeta {
            city_id: Some("vilnius".to_string()),
            source: None,
            generated_at: "2026-05-01T00:00:00Z".to_string(),
        },
    )
    .expect("pack corpus");
    std::fs::write(&source, &payload).unwrap();

    let cmd1 = {
        let mut c = producer_periodic_refresh(dir.path(), "20260524");
        c.args(["--address-search", source.to_str().unwrap()]);
        c
    };
    let _stderr1 = run_until_published(cmd1, dir.path(), None, Duration::from_secs(30));
    let gen1 = current_generation_id(dir.path()).expect("first publish flips current.json");

    // Second tick, different anchor → different bundle SHA → different
    // generation dir. Same 1.1 s gap as the janitor test so the two
    // createdAt stamps differ.
    std::thread::sleep(Duration::from_millis(1_100));
    let cmd2 = producer_periodic_refresh(dir.path(), "20260525");
    let cmd2 = {
        let mut c = cmd2;
        c.args(["--address-search", source.to_str().unwrap()]);
        c
    };
    let _stderr2 = run_until_published(cmd2, dir.path(), Some(&gen1), Duration::from_secs(30));
    let gen2 = current_generation_id(dir.path()).expect("second publish flips current.json");
    assert_ne!(
        gen1, gen2,
        "two distinct anchors must produce two distinct generation ids"
    );

    for gen in [&gen1, &gen2] {
        let staged = dir
            .path()
            .join("generations")
            .join(gen)
            .join("address-search.fst");
        assert!(
            staged.exists(),
            "address-search.fst must be staged into generation {gen} — \
             a sidecar that lands in only one generation dies at the next \
             refresh tick",
        );
        assert_eq!(
            std::fs::read(&staged).unwrap(),
            payload,
            "staged address-search.fst in {gen} must equal source bytes",
        );
    }
}

/// Absent `--address-search` stays a supported state: the generation carries
/// no sidecar and the publish still succeeds. Guards against the flag becoming
/// accidentally required (every other city keeps publishing without it).
#[test]
fn address_search_absent_is_not_an_error() {
    if !require_producer() {
        return;
    }
    let dir = tempfile::TempDir::new().unwrap();

    let cmd = producer_periodic_refresh(dir.path(), "20260524");
    let _stderr = run_until_published(cmd, dir.path(), None, Duration::from_secs(30));
    let gen = current_generation_id(dir.path()).expect("publish flips current.json");

    assert!(
        !dir.path()
            .join("generations")
            .join(&gen)
            .join("address-search.fst")
            .exists(),
        "no --address-search must leave the generation with no sidecar",
    );
}
