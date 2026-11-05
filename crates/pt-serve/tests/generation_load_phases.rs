//! Per-phase timing lines for the generation load.
//!
//! Everything between `sentinel_verify_ok` and `rss_guard_accept` used to be a
//! single silent stretch. On a real paris generation that gap ran ~66 minutes
//! with no output at all — indistinguishable from a hang, and an incident went
//! into guessing which step was running. `build_generation_with_page_warm` now
//! emits one `generation_load_phase` line per completed phase plus a terminal
//! `generation_load_complete`.
//!
//! ## Why the over-limit RSS config
//!
//! The phases are emitted during the load, which `main.rs` runs BEFORE
//! `enforce_rss_budget`. So an RSS ceiling small enough to reject gives a
//! process that loads the generation completely (emitting every phase) and then
//! exits deterministically on its own — no port to discover, no readiness poll,
//! no kill, and stderr reaches EOF on its own. The setup mirrors
//! `rss_guard_process::over_limit_config_exits_non_zero_before_bind`.

use std::path::PathBuf;
use std::process::{Command, Stdio};

#[path = "common/mod.rs"]
mod common;

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

/// Mirror of `rss_guard_process::seed_data_root`. The duplication is the
/// existing convention here — each integration-test binary stays
/// self-contained so cargo's per-binary dead-code lint stays quiet.
fn seed_data_root() -> (tempfile::TempDir, String) {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let bundle_bytes = std::fs::read(tiny_ptb_path()).expect("read tiny.ptb");
    let bundle_sha = common::publisher::sha256_hex(&bundle_bytes);
    let id = pt_shared::manifest::publication_id(&bundle_sha, &"0".repeat(64));
    let gen_dir = dir.path().join("generations").join(&id);
    std::fs::create_dir_all(&gen_dir).expect("create gen dir");
    std::fs::write(gen_dir.join("bundle.ptb"), &bundle_bytes).expect("write bundle");

    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let created_at = common::publisher::rfc3339_format(now_unix);

    let manifest = serde_json::json!({
        "manifestSchemaVersion": 2,
        "generationId": id,
        "citySlug": "vilnius",
        "bundleSha256": bundle_sha,
        "publicationInputsSha256": "0".repeat(64),
        "bundleSizeBytes": bundle_bytes.len() as u64,
        "feedStartDate": common::publisher::feed_start_date_of(&bundle_bytes),
        "hasTransfers": false,
        "transfersSha256": serde_json::Value::Null,
        "transfersSizeBytes": serde_json::Value::Null,
        "createdAt": created_at,
    });
    std::fs::write(
        gen_dir.join("generation.json"),
        serde_json::to_string_pretty(&manifest).expect("manifest"),
    )
    .expect("write manifest");

    let pointer = serde_json::json!({
        "manifestSchemaVersion": 2,
        "generationId": id,
        "citySlug": "vilnius",
        "createdAt": created_at,
    });
    std::fs::write(
        dir.path().join("current.json"),
        serde_json::to_string_pretty(&pointer).expect("pointer"),
    )
    .expect("write current.json");

    (dir, id)
}

/// Run pt-serve far enough to load the generation, then let the RSS guard end
/// it. Returns stderr.
fn stderr_of_a_completed_load() -> String {
    let (data_root, _id) = seed_data_root();
    let bin = env!("CARGO_BIN_EXE_pt-serve");
    let output = Command::new(bin)
        .args([
            "--listen-addr",
            "127.0.0.1:0",
            "--metrics-listen-addr",
            "127.0.0.1:0",
            "--loopback-listen-addr",
            "127.0.0.1:0",
            "--data-root",
            data_root.path().to_str().unwrap(),
            "--pidfile-path",
            data_root.path().join("pt-serve.pid").to_str().unwrap(),
            "--city-slug",
            "vilnius",
            // The fixture's manifest carries no cityTzIana; supply the
            // operator default so the T13 cross-check passes and the load runs
            // to completion rather than aborting mid-phase.
            "--city-tz-iana-default",
            "Europe/Vilnius",
            "--worker-pool-size",
            "2",
            "--log-format=json",
            // 1 KiB ceiling against 1 MiB of declared overhead: the guard
            // rejects, but only after the load has already finished.
            "--max-rss-bytes",
            "1024",
            "--process-fixed-overhead-bytes",
            "1048576",
            "--per-worker-overhead-bytes",
            "524288",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .output()
        .expect("spawn + wait pt-serve");

    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    assert!(
        !output.status.success(),
        "expected the RSS guard to reject; stderr was:\n{stderr}"
    );
    assert!(
        stderr.contains("rss_guard_reject"),
        "expected the run to end at the RSS guard (i.e. the load itself succeeded); \
         stderr was:\n{stderr}"
    );
    stderr
}

/// The phases in the order `build_generation_with_page_warm` closes them.
/// Kept as a literal list rather than derived, so reordering the builder has
/// to be a deliberate edit here too.
const EXPECTED_PHASES: &[&str] = &[
    "mmap",
    "validate_structural",
    "reader_init",
    "validate_metadata",
    "tz_cross_check",
    "index_build",
    "transfers",
    "namespace_shas",
    "color_artifacts",
    "departures_idx",
    "page_warm",
    "schedule_tiles",
    "address_search",
];

fn phase_lines(stderr: &str) -> Vec<&str> {
    stderr
        .lines()
        .map(str::trim)
        .filter(|l| l.contains("\"msg\":\"generation_load_phase\""))
        .collect()
}

fn phase_of(line: &str) -> String {
    // Lines are JSON objects with every value quoted (see ops::log::log_event),
    // so a substring lift is enough and keeps this test serde-free like its
    // neighbours.
    let key = "\"phase\":\"";
    let start = line.find(key).expect("phase field") + key.len();
    let rest = &line[start..];
    let end = rest.find('"').expect("phase terminator");
    rest[..end].to_string()
}

#[test]
fn every_load_phase_is_reported_once_and_in_order() {
    let stderr = stderr_of_a_completed_load();
    let observed: Vec<String> = phase_lines(&stderr).iter().map(|l| phase_of(l)).collect();

    assert_eq!(
        observed,
        EXPECTED_PHASES
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>(),
        "generation_load_phase lines did not match the expected sequence; stderr was:\n{stderr}"
    );
}

#[test]
fn each_phase_carries_its_own_and_the_cumulative_duration() {
    let stderr = stderr_of_a_completed_load();
    let lines = phase_lines(&stderr);
    assert!(
        !lines.is_empty(),
        "no generation_load_phase lines at all; stderr was:\n{stderr}"
    );

    // elapsedMs is cumulative, so it must never go backwards. This is the
    // assertion that would catch a PhaseLog that reset the wrong clock — the
    // failure mode that would make the whole thing quietly useless while still
    // emitting plausible-looking lines.
    let mut previous_elapsed: u128 = 0;
    for line in &lines {
        assert!(
            line.contains("\"phaseMs\":\""),
            "phase line missing phaseMs: {line}"
        );
        let key = "\"elapsedMs\":\"";
        let start = line
            .find(key)
            .unwrap_or_else(|| panic!("elapsedMs in {line}"))
            + key.len();
        let rest = &line[start..];
        let end = rest.find('"').expect("elapsedMs terminator");
        let elapsed: u128 = rest[..end].parse().expect("elapsedMs is a number");
        assert!(
            elapsed >= previous_elapsed,
            "elapsedMs went backwards ({previous_elapsed} -> {elapsed}) at: {line}"
        );
        previous_elapsed = elapsed;
    }
}

#[test]
fn the_load_ends_with_a_single_completion_line() {
    let stderr = stderr_of_a_completed_load();
    let completions: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| l.contains("\"msg\":\"generation_load_complete\""))
        .collect();

    assert_eq!(
        completions.len(),
        1,
        "expected exactly one generation_load_complete; stderr was:\n{stderr}"
    );
    let line = completions[0];
    assert!(line.contains("\"totalMs\":\""), "missing totalMs: {line}");
    assert!(
        line.contains("\"isStartup\":\"true\""),
        "the initial load must be marked isStartup: {line}"
    );
    assert!(
        line.contains("\"generationId\":\""),
        "missing generationId: {line}"
    );
}

#[test]
fn index_build_names_the_pattern_mode_it_ran() {
    // The phase an operator is most likely to be staring at, and its cost is
    // mode-dependent — `off` over a carry-less bundle is orders of magnitude
    // slower than the production `covering-merge`. A duration without the mode
    // beside it is not actionable.
    let stderr = stderr_of_a_completed_load();
    let line = phase_lines(&stderr)
        .into_iter()
        .find(|l| phase_of(l) == "index_build")
        .unwrap_or_else(|| panic!("no index_build phase; stderr was:\n{stderr}"));
    assert!(
        line.contains("\"patternMode\":\""),
        "index_build must record the pattern mode it ran: {line}"
    );
}
