use std::io::{BufRead as _, Read as _};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[path = "common/mod.rs"]
mod common;

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

fn tiny_ptb_path() -> PathBuf {
    // crates/pt-serve/ -> repo root -> packages/shared/.../tiny.ptb
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

fn tiny_transfers_path() -> PathBuf {

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/frontend/tests/services/__fixtures__/footpath-transfers.bin")
}



#[test]
fn builds_state_from_tiny_ptb() {
    let gen = pt_serve::Generation::from_paths(
        &tiny_ptb_path(),
        None, // no transfers
        "vilnius".to_string(),
        pt_core::PatternMode::Off,
    )
    .expect("generation builds from tiny.ptb");
    assert_eq!(gen.city_slug, "vilnius");
    assert!(gen.reader.num_stops() > 0);
    assert!(!gen.bundle_etag.is_empty());
}



struct Server {
    child: Child,
    pub base: String,
    // The TempDir holding the producer-shaped data_root for this test. Dropped
    // AFTER the child (child field is dropped first per Rust drop order rules
    // — fields drop in declaration order — so the child can read the
    // bundle.ptb mmap right up until kill returns).
    _data_root: tempfile::TempDir,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// Lay down a single-generation producer-shaped data_root: a manifest +
/// bundle.ptb (+ optional transfers.bin) at the path the loader expects.
/// Returns the TempDir (caller must keep it alive) and the published
/// generation id.
fn seed_data_root(with_transfers: bool) -> (tempfile::TempDir, String) {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let bundle_bytes = std::fs::read(tiny_ptb_path()).expect("read tiny.ptb");
    let bundle_sha = common::publisher::sha256_hex(&bundle_bytes);
    let id = pt_shared::manifest::publication_id(&bundle_sha, &"0".repeat(64));
    let gen_dir = dir.path().join("generations").join(&id);
    std::fs::create_dir_all(&gen_dir).expect("create gen dir");
    std::fs::write(gen_dir.join("bundle.ptb"), &bundle_bytes).expect("write bundle");

    let (transfers_sha, transfers_size): (Option<String>, Option<u64>) = if with_transfers {
        let tb = std::fs::read(tiny_transfers_path()).expect("read transfers");
        let sha = common::publisher::sha256_hex(&tb);
        std::fs::write(gen_dir.join("transfers.bin"), &tb).expect("write transfers");
        (Some(sha), Some(tb.len() as u64))
    } else {
        (None, None)
    };

    // The metadata validator's startup-mode clock-skew allowance is wide
    // enough that anchoring `createdAt` at the current wall-clock works
    // for the in-process server tests. The reload-runner tests anchor at
    // their MockClock; here we hand the bundle to a real subprocess so
    // SystemClock-now is the natural choice.
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
        "hasTransfers": with_transfers,
        "transfersSha256": transfers_sha,
        "transfersSizeBytes": transfers_size,
        "createdAt": created_at,
    });
    std::fs::write(
        gen_dir.join("generation.json"),
        serde_json::to_string_pretty(&manifest).expect("serialize manifest"),
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
        serde_json::to_string_pretty(&pointer).expect("serialize pointer"),
    )
    .expect("write current.json");

    (dir, id)
}

/// Like [`seed_data_root`] but also writes `color-config.json` and `shapes.bin`
/// (built from the tiny.ptb fixture) and records their SHAs in the manifest.
/// Returns (TempDir, generation_id, shapes_json_sha256).
fn seed_data_root_with_artifacts() -> (tempfile::TempDir, String, String) {
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

    // color-config.json — minimal well-formed body.
    let color_config_bytes: Vec<u8> = br#"{"colors":{}}"#.to_vec();
    let color_config_sha = common::publisher::sha256_hex(&color_config_bytes);
    std::fs::write(gen_dir.join("color-config.json"), &color_config_bytes)
        .expect("write color-config.json");

    // shapes.bin — built from tiny.ptb's interner SHAs so the X4 cross-check passes.
    let shapes_bin_bytes = common::publisher::encode_test_shapes_bin(&tiny_ptb_path());
    let shapes_bin_sha = common::publisher::sha256_hex(&shapes_bin_bytes);
    std::fs::write(gen_dir.join("shapes.bin"), &shapes_bin_bytes).expect("write shapes.bin");

    // Compute shapes JSON SHA for the manifest (streaming — matches load_color_artifacts).
    let (shapes_json_sha, shapes_json_size) = {
        let reader =
            pt_core::Reader::from_bytes(bundle_bytes.clone()).expect("reader for shapes SHAs");
        let (trips, stops) =
            pt_serve::bundle::integrity::bundle_namespace_shas(&reader).expect("recompute SHAs");
        let sb = pt_shared::sidecar::ShapesBin::parse(&shapes_bin_bytes, &trips, &stops)
            .expect("parse test shapes.bin");
        let (digest, len) = pt_shared::sidecar::shapes_json_sha256(&sb);
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        (hex, len)
    };

    let manifest = serde_json::json!({
        "manifestSchemaVersion": 2,
        "generationId": id,
        "citySlug": "vilnius",
        "bundleSha256": bundle_sha,
        "publicationInputsSha256": "0".repeat(64),
        "bundleSizeBytes": bundle_bytes.len() as u64,
        "feedStartDate": common::publisher::feed_start_date_of(&bundle_bytes),
        "hasTransfers": false,
        "transfersSha256": null,
        "transfersSizeBytes": null,
        "createdAt": created_at,
        "colorConfigSha256": color_config_sha,
        "routeStylesSha256": null,
        "shapesBinSha256": shapes_bin_sha,
        "shapesJsonSha256": shapes_json_sha,
        "shapesJsonSizeBytes": shapes_json_size,
    });
    std::fs::write(
        gen_dir.join("generation.json"),
        serde_json::to_string_pretty(&manifest).expect("serialize manifest"),
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
        serde_json::to_string_pretty(&pointer).expect("serialize pointer"),
    )
    .expect("write current.json");

    (dir, id, shapes_json_sha)
}

/// Core spawn logic shared by `spawn`, `spawn_with_pattern_mode`, and
/// `spawn_with_env`.
///
/// Builds a `Command` over a freshly seeded data_root, appending
/// `--pattern-mode <pattern_mode>` when `pattern_mode` is `Some(...)` and
/// setting `extra_env` on the child (GTFS-RT tests use this for
/// `PT_SERVE_RT_*`). The caller is responsible for piping stdout and
/// waiting for the "pt-serve listening on" line.
fn spawn_inner(
    with_transfers: bool,
    pattern_mode: Option<&str>,
    extra_env: &[(&str, &str)],
) -> Server {
    let bin = env!("CARGO_BIN_EXE_pt-serve");
    let (data_root, _gen_id) = seed_data_root(with_transfers);
    let mut cmd = Command::new(bin);
    // P4 is data-root-only. --bundle / --transfers / --city / --workers / --listen are now
    // --data-root / --city-slug / --worker-pool-size / --listen-addr. `--max-rss-bytes` and the
    // overhead bytes have no defaults — the operator pins them; tests pass a 1 GiB sentinel that no
    // fixture comes close to tripping.
    cmd.args([
        "--listen-addr",
        "127.0.0.1:0",
        // aux listener binds its own port; tests must pin to 127.0.0.1:0 (ephemeral) or parallel
        // cargo-test workers collide on the default 0.0.0.0:9001.
        "--metrics-listen-addr",
        "127.0.0.1:0",
        // Stage-C C2c: same ephemeral-port reasoning for the loopback
        // listener (default 0.0.0.0:9002) so parallel test binaries don't
        // collide on it.
        "--loopback-listen-addr",
        "127.0.0.1:0",
        "--data-root",
        data_root.path().to_str().unwrap(),
        "--pidfile-path",
        data_root.path().join("pt-serve.pid").to_str().unwrap(),
        "--city-slug",
        "vilnius",
        // v5 fixture manifest carries no cityTzIana; supply the operator
        // default so the T13 tz cross-check passes and the server boots.
        "--city-tz-iana-default",
        "Europe/Vilnius",
        "--worker-pool-size",
        "2",
        "--max-rss-bytes",
        "1073741824",
        "--process-fixed-overhead-bytes",
        "200000000",
        "--per-worker-overhead-bytes",
        "50000000",
    ]);
    // Append --pattern-mode only when explicitly requested; omitting it lets
    // the flag default to `off` so all existing tests are unchanged.
    if let Some(mode) = pattern_mode {
        cmd.args(["--pattern-mode", mode]);
    }
    let _ = with_transfers; // transfers come from the seeded data_root, no flag needed
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    cmd.stdout(Stdio::piped());
    let mut child = cmd.spawn().expect("spawn pt-serve");

    let base = await_listening(&mut child, "pt-serve");
    assert!(
        await_ready(&base),
        "pt-serve did not become ready within {READY_BUDGET:?}"
    );
    Server {
        child,
        base,
        _data_root: data_root,
    }
}

/// Startup budgets for a spawned pt-serve.
///
/// Both waits are poll/notify driven, so a healthy server costs only the time
/// it actually needs and just a genuinely broken one pays the full budget.
/// That makes a generous ceiling nearly free — and it needs to be generous:
/// cargo runs this file's tests in parallel and each one spawns its own
/// pt-serve, so on a machine that is also busy with other suites the previous
/// 5 s / 3 s pair timed out on whichever spawn happened to lose the race.
const LISTEN_BUDGET: Duration = Duration::from_secs(30);
const READY_BUDGET: Duration = Duration::from_secs(15);

/// Read `child`'s stdout line-by-line until it prints its bound address and
/// return that base URL (e.g. "http://127.0.0.1:54321"). The server prints
/// "pt-serve listening on http://HOST:PORT". The read happens on a helper
/// thread so a stuck child cannot hang the whole test; `what` names the child
/// in the panic messages. Bounded by [`LISTEN_BUDGET`].
fn await_listening(child: &mut Child, what: &str) -> String {
    let stdout = child.stdout.take().expect("stdout piped");
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(None);
                    break;
                } // EOF — child exited
                Ok(_) => {
                    let trimmed = line.trim();
                    if let Some(rest) = trimmed.strip_prefix("pt-serve listening on ") {
                        let _ = tx.send(Some(rest.to_string()));
                        break;
                    }
                }
                Err(_) => {
                    let _ = tx.send(None);
                    break;
                }
            }
        }
    });
    match rx.recv_timeout(LISTEN_BUDGET) {
        Ok(Some(base)) => base,
        Ok(None) => panic!("{what} exited before printing its bound address"),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            panic!("{what} did not print its bound address within {LISTEN_BUDGET:?}")
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let _ = child.kill();
            panic!("{what} startup log channel disconnected")
        }
    }
}

/// Poll `base`/ready every 50 ms until it answers 200. Bounded by
/// [`READY_BUDGET`]; returns false if the deadline passes first.
fn await_ready(base: &str) -> bool {
    let deadline = Instant::now() + READY_BUDGET;
    while Instant::now() < deadline {
        if ureq_get(&format!("{base}/ready"))
            .map(|(s, _)| s == 200)
            .unwrap_or(false)
        {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn spawn(with_transfers: bool) -> Server {
    spawn_inner(with_transfers, None, &[])
}

/// Spawn with extra `PT_SERVE_*` env (GTFS-RT tests). Other flags mirror `spawn`.
fn spawn_with_env(extra_env: &[(&str, &str)]) -> Server {
    spawn_inner(false, None, extra_env)
}

/// Spawn pt-serve with an explicit `--pattern-mode` flag. All other flags
/// mirror `spawn`. The production seam being exercised is:
///
///   `main.rs` → `load_initial_generation_with_force` → `build_generation`
///   → `Index::build(&reader, inputs.pattern_mode)` (handle.rs:212)
///
/// Reverting handle.rs:212 to hardcoded `PatternMode::Off` causes the
/// `/ready` body to report `"patternMode":"off"` even when the operator
/// configured `--pattern-mode unbounded`, and the
/// `ready_reports_unbounded_when_configured` test then fails.
fn spawn_with_pattern_mode(with_transfers: bool, pattern_mode: &str) -> Server {
    spawn_inner(with_transfers, Some(pattern_mode), &[])
}

/// Spawn a pt-serve process over a generation that includes color-config.json
/// and shapes.bin artifacts. Returns the `Server` handle and the
/// `shapes_json_sha256` hex string recorded in the manifest (used to construct
/// the content-addressed `/gtfs/shapes/shapes-<hash>.json` URL).
fn spawn_with_artifacts() -> (Server, String) {
    let bin = env!("CARGO_BIN_EXE_pt-serve");
    let (data_root, _gen_id, shapes_json_sha) = seed_data_root_with_artifacts();
    let mut cmd = Command::new(bin);
    cmd.args([
        "--listen-addr",
        "127.0.0.1:0",
        "--metrics-listen-addr",
        "127.0.0.1:0",
        // Same ephemeral-port reasoning as `spawn_inner`: without this the
        // loopback listener takes its default `0.0.0.0:9002` and two
        // artifact-backed tests running in parallel race for that port. The
        // loser exits before printing its bound address.
        "--loopback-listen-addr",
        "127.0.0.1:0",
        "--data-root",
        data_root.path().to_str().unwrap(),
        "--pidfile-path",
        data_root.path().join("pt-serve.pid").to_str().unwrap(),
        "--city-slug",
        "vilnius",
        "--city-tz-iana-default",
        "Europe/Vilnius",
        "--worker-pool-size",
        "2",
        "--max-rss-bytes",
        "1073741824",
        "--process-fixed-overhead-bytes",
        "200000000",
        "--per-worker-overhead-bytes",
        "50000000",
    ]);
    cmd.stdout(Stdio::piped());
    let mut child = cmd.spawn().expect("spawn pt-serve");

    let base = await_listening(&mut child, "pt-serve with artifacts");
    assert!(
        await_ready(&base),
        "pt-serve with artifacts did not become ready within {READY_BUDGET:?}"
    );
    let server = Server {
        child,
        base,
        _data_root: data_root,
    };
    (server, shapes_json_sha)
}

/// Blocking GET → (status_code, body_string). Returns Err on connection error.
fn ureq_get(url: &str) -> Result<(u16, String), Box<dyn std::error::Error>> {
    let resp = ureq::get(url).call();
    match resp {
        Ok(r) => {
            let status = r.status();
            let body = r.into_string()?;
            Ok((status, body))
        }
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            Ok((code, body))
        }
        Err(e) => Err(Box::new(e)),
    }
}



#[test]
fn health_ready_version() {
    let s = spawn(false);
    assert_eq!(ureq_get(&format!("{}/health", s.base)).unwrap().0, 200);
    assert_eq!(ureq_get(&format!("{}/ready", s.base)).unwrap().0, 200);
    let (code, body) = ureq_get(&format!("{}/version", s.base)).unwrap();
    assert_eq!(code, 200);
    assert!(
        body.contains("\"city\":\"vilnius\""),
        "body missing city: {body}"
    );
    assert!(
        body.contains("\"bundleHash\":"),
        "body missing bundleHash: {body}"
    );
}

/// the `/ready` body must surface the full readiness telemetry. Asserts every schema field is
/// present as valid JSON.
///
/// `feedStartDateAgeDays`/`feedWindowStale` are computed against the REAL
/// wall clock (`spawn` runs the actual binary, not a test harness with a
/// `MockClock`), while `tiny.ptb`'s `feedStartDate` is a fixed committed
/// value — so `feedWindowStale` drifts toward `true` as real time passes
/// since that date, independent of anything this test is actually
/// exercising. A generous `PT_SERVE_FEED_STALE_DAYS` override keeps the
/// assertion meaningful (this generation genuinely isn't stale relative to
/// its OWN configured threshold) without the test silently flipping months
/// after it was written.
#[test]
fn ready_body_carries_full_readiness_telemetry() {
    let s = spawn_with_env(&[("PT_SERVE_FEED_STALE_DAYS", "36500")]);
    let (code, body) = ureq_get(&format!("{}/ready", s.base)).unwrap();
    assert_eq!(code, 200, "body: {body}");
    let v: serde_json::Value = serde_json::from_str(&body).expect("ready body is JSON");
    assert_eq!(v["status"], "ready");
    assert_eq!(v["city"], "vilnius");
    // generation_id is non-empty (the loader populated it from the
    // manifest).
    assert!(
        v["servingGenerationId"]
            .as_str()
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        "servingGenerationId missing or empty: {body}"
    );
    assert!(v["servingLastGoodFallback"].is_boolean());
    assert!(v["reloadConsecutiveFailures"].as_u64().is_some());
    // lastSuccessfulReloadAt: no reload has happened yet → null.
    assert!(v["lastSuccessfulReloadAt"].is_null());
    assert_eq!(
        v["manifestSchemaVersionMax"].as_u64(),
        Some(2),
        "schema version max must be 2; body: {body}"
    );
    // generationAgeSecs: parsed from manifest.createdAt → non-null integer.
    assert!(
        v["generationAgeSecs"].as_u64().is_some(),
        "generationAgeSecs missing: {body}"
    );
    assert!(
        v["feedStartDate"].as_u64().unwrap_or(0) > 0,
        "feedStartDate must be a non-zero YYYYMMDD: {body}"
    );
    assert!(v["feedStartDateAgeDays"].as_u64().is_some());
    assert_eq!(v["feedWindowStale"].as_bool(), Some(false));
    assert_eq!(v["lastGoodAgeExceedsRetention"].as_bool(), Some(false));
    assert_eq!(
        v["patternMode"], "covering-merge",
        "ready body must report the live pattern mode (now the covering-merge default): {body}"
    );
}

/// MUST 1 — Production seam guard: when pt-serve is booted with
/// `--pattern-mode unbounded`, the `/ready` body must report
/// `"patternMode":"unbounded"`.
///
/// This test goes through the REAL production path:
///
///   `main.rs` → `load_initial_generation_with_force`
///   → `build_generation` → `Index::build(&reader, inputs.pattern_mode)`
///   (handle.rs:212) → `Generation.pattern_mode`
///   → `ready()` handler → `/ready` JSON body
///
/// Reverting handle.rs:212 to `Index::build(&reader, PatternMode::Off)`
/// causes this test to fail: the body would read `"patternMode":"off"`
/// despite the `--pattern-mode unbounded` flag.
#[test]
fn ready_reports_unbounded_when_configured() {
    let s = spawn_with_pattern_mode(false, "unbounded");
    let (code, body) = ureq_get(&format!("{}/ready", s.base)).unwrap();
    assert_eq!(code, 200, "body: {body}");
    let v: serde_json::Value = serde_json::from_str(&body).expect("ready body is JSON");
    assert_eq!(
        v["patternMode"], "unbounded",
        "ready body must report 'unbounded' when --pattern-mode unbounded is set; body: {body}"
    );
}

/// `/version` surfaces `generationId`, `createdAt`, `manifestSchemaVersionMax` in addition to the
/// P3 baseline fields.
#[test]
fn version_body_carries_generation_metadata() {
    let s = spawn(false);
    let (code, body) = ureq_get(&format!("{}/version", s.base)).unwrap();
    assert_eq!(code, 200);
    let v: serde_json::Value = serde_json::from_str(&body).expect("version body is JSON");
    assert!(v["version"].is_string());
    assert!(v["commit"].is_string());
    let built_at = v["builtAt"].as_str().expect("builtAt must be a string");
    let timestamp: jiff::Timestamp = built_at
        .parse()
        .expect("builtAt must be an RFC 3339 timestamp");
    assert!(
        timestamp.as_second() > 0,
        "build timestamp must not default to the Unix epoch: {body}"
    );
    assert!(
        v["bundleHash"]
            .as_str()
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        "bundleHash missing: {body}"
    );
    assert!(
        v["generationId"]
            .as_str()
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        "generationId missing: {body}"
    );
    assert!(
        v["createdAt"]
            .as_str()
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        "createdAt missing: {body}"
    );
    assert_eq!(v["manifestSchemaVersionMax"].as_u64(), Some(2));
    assert_eq!(v["city"], "vilnius");
}

/// the `/metrics` text exposition contains every series the full operability surface promises.
#[test]
fn metrics_exposes_full_operability_surface() {
    let s = spawn(false);
    let (code, out) = ureq_get(&format!("{}/metrics", s.base)).unwrap();
    assert_eq!(code, 200);
    // P3 baseline still present.
    assert!(out.contains("plan_requests_total "), "{out}");
    // P4 reload surface.
    assert!(out.contains("reload_consecutive_failures "));
    assert!(out.contains("reload_pending_coalesced_total "));
    assert!(out.contains("mapped_generation_count "));
    assert!(out.contains("generation_retired_total "));
    assert!(out.contains("current_generation_adopted_timestamp_seconds "));
    assert!(out.contains("current_generation_info{generation_id="));
    // P4 worker-pool surface.
    assert!(out.contains("inflight_requests "));
    assert!(out.contains("ready_503 "));
    // P4 transport-timeout surface.
    assert!(out.contains("request_timeouts_total "));
    // Assert absence.
    assert!(!out.contains("reload_signals_dropped_total"));
    assert!(out.contains("last_good_age_exceeds_retention_total "));
    assert!(out.contains("pt_serve_up 1\n"));
    // Linux-only series: only assert when /proc exists.
    #[cfg(target_os = "linux")]
    {
        if std::path::Path::new("/proc/self/status").exists() {
            assert!(
                out.contains("process_threads "),
                "process_threads missing on Linux: {out}"
            );
            assert!(
                out.contains("process_open_fds "),
                "process_open_fds missing on Linux: {out}"
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        assert!(
            !out.contains("process_threads"),
            "process_threads must not appear on macOS (cfg-gated to Linux): {out}"
        );
    }
}

#[test]
fn wrong_city_404() {
    let s = spawn(false);
    assert_eq!(
        ureq_get(&format!("{}/api/krakow/raptor-bundle", s.base))
            .unwrap()
            .0,
        404
    );
}



/// Blocking POST → (status_code, body_string). Returns Err on connection error.
fn ureq_post(url: &str, body: &str) -> Result<(u16, String), Box<dyn std::error::Error>> {
    let resp = ureq::post(url)
        .set("Content-Type", "application/json")
        .send_string(body);
    match resp {
        Ok(r) => {
            let status = r.status();
            let text = r.into_string()?;
            Ok((status, text))
        }
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            Ok((code, text))
        }
        Err(e) => Err(Box::new(e)),
    }
}

/// Happy path: S1 → S3, departing at 08:00 (28800s) on 20260505.
///
/// tiny.ptb fixture: stops S1(idx 0), S2(idx 1), S3(idx 2); route R1 (bus,
/// type 3) runs trips T1 (07:00) and T2 (08:00) on service WD (active on
/// 20260505 per bitmask 0xB0+j with feedStartDate=20260501). T2 boards S1@28800
/// and alights S3@29400 — a routable single-leg itinerary.
///
/// The non-negotiable assertion: every leg in every returned itinerary carries a non-empty `mode`
/// field (structural requirement).
#[test]
fn plan_happy_path_sets_mode_on_every_leg() {
    let s = spawn(false);
    // T2 departs S1 at 08:00 (28800), arrives S3 at 29400. Service WD is
    // active on 20260505 (day offset 4 from feedStartDate 20260501;
    // WD bitmask byte0=0xB0=0b10110000, bit4=1 → active).
    let body = r#"{"entryStops":[{"stopId":"S1","walkSecs":0}],
                   "exitStops":[{"stopId":"S3","walkSecs":0}],
                   "departureSecs":28800,"date":"20260505"}"#;
    let (code, out) = ureq_post(&format!("{}/api/vilnius/plan", s.base), body).unwrap();
    assert_eq!(code, 200, "expected 200; body: {out}");
    let v: serde_json::Value = serde_json::from_str(&out).expect("valid JSON");
    assert!(v.is_array(), "response must be an array");
    let itins = v.as_array().unwrap();
    assert!(
        !itins.is_empty(),
        "expected ≥1 itinerary for S1→S3 on 20260505@28800"
    );
    for itin in itins {
        for leg in itin["legs"].as_array().expect("legs array") {
            assert!(
                leg["mode"].as_str().map(|m| !m.is_empty()).unwrap_or(false),
                "every leg must carry a non-empty mode; leg={leg}"
            );
        }
    }
}

#[test]
fn plan_malformed_body_400() {
    let s = spawn(false);
    let (code, _) = ureq_post(&format!("{}/api/vilnius/plan", s.base), "{not json").unwrap();
    assert_eq!(code, 400, "malformed JSON body must return 400");
}

#[test]
fn plan_unknown_stop_400() {
    let s = spawn(false);
    let body = r#"{"entryStops":[{"stopId":"NOPE","walkSecs":0}],
                   "exitStops":[{"stopId":"S3","walkSecs":0}],
                   "departureSecs":28800,"date":"20260505"}"#;
    let (code, _) = ureq_post(&format!("{}/api/vilnius/plan", s.base), body).unwrap();
    assert_eq!(code, 400, "unknown stopId must return 400");
}

/// stopId containing a double-quote must return 400 with valid JSON body.
/// Regression for: hand-built JSON error format → JSON injection via client-controlled stopId.
#[test]
fn plan_stop_id_with_quote_returns_valid_json_400() {
    let s = spawn(false);
    // The stopId value contains a double-quote; the error body must still be valid JSON.
    let body = r#"{"entryStops":[{"stopId":"S\"1","walkSecs":0}],
                   "exitStops":[{"stopId":"S3","walkSecs":0}],
                   "departureSecs":28800,"date":"20260505"}"#;
    let (code, out) = ureq_post(&format!("{}/api/vilnius/plan", s.base), body).unwrap();
    assert_eq!(code, 400, "stopId with quote must return 400; body: {out}");
    let v: serde_json::Value = serde_json::from_str(&out).expect("error body must be valid JSON");
    assert!(
        v.get("error").is_some(),
        "error body must contain an 'error' field; body: {out}"
    );
}

/// `walkSpeedMps` and `minTransferSecs` reach the engine: in range they plan
/// (tiny.ptb has no transfer walk, so the journey is unchanged), out of range
/// they are a 400 with a JSON error body.
#[test]
fn plan_walk_params_validate() {
    let s = spawn(false);
    let body = |extra: &str| {
        format!(
            r#"{{"entryStops":[{{"stopId":"S1","walkSecs":0}}],"exitStops":[{{"stopId":"S3","walkSecs":0}}],"departureSecs":28800,"date":"20260505"{extra}}}"#
        )
    };
    let url = format!("{}/api/vilnius/plan", s.base);
    let (base_code, base) = ureq_post(&url, &body("")).unwrap();
    assert_eq!(base_code, 200, "{base}");
    let (code, out) = ureq_post(
        &url,
        &body(r#","walkSpeedMps":0.9722,"minTransferSecs":300"#),
    )
    .unwrap();
    assert_eq!(code, 200, "{out}");
    assert_eq!(out, base);
    for extra in [
        r#","walkSpeedMps":0"#,
        r#","walkSpeedMps":11"#,
        r#","minTransferSecs":3601"#,
    ] {
        let (code, out) = ureq_post(&url, &body(extra)).unwrap();
        assert_eq!(code, 400, "{extra}: {out}");
        let v: serde_json::Value =
            serde_json::from_str(&out).expect("error body must be valid JSON");
        assert!(v.get("error").is_some(), "{out}");
    }
}

/// An oversized `/plan` body must be rejected with 413 before parsing, capping
/// the per-worker allocation regardless of how much the client sends
/// (memory-DoS guard — MAX_PLAN_BODY_BYTES). The padded body is still
/// well-formed JSON, so a 413 (not a 400) proves the size cap fired first.
#[test]
fn plan_oversized_body_413() {
    let s = spawn(false);
    // 2 MiB of filler in an unused field, well past the 32 KiB cap (which is
    // mirrored in nginx/city-proxies.inc). Valid JSON.
    let filler = "x".repeat(2 * 1024 * 1024);
    let body = format!(
        r#"{{"entryStops":[{{"stopId":"S1","walkSecs":0}}],
            "exitStops":[{{"stopId":"S3","walkSecs":0}}],
            "departureSecs":28800,"date":"20260505","_pad":"{filler}"}}"#,
    );
    let (code, _) = ureq_post(&format!("{}/api/vilnius/plan", s.base), &body).unwrap();
    assert_eq!(code, 413, "oversized body must return 413");
}

/// After an oversized POST is rejected, the worker that handled it must drain the
/// unread body and return to the pool — a follow-up valid request on the same
/// server must still be served. This guards the body-cap drain path: if the
/// rejected request left bytes unconsumed (or tiny_http's EqualReader::drop
/// blew up the heap), the worker could wedge or the process could thrash.
#[test]
fn server_stays_live_after_oversized_body() {
    let s = spawn(false);
    let filler = "x".repeat(2 * 1024 * 1024);
    let big = format!(
        r#"{{"entryStops":[{{"stopId":"S1","walkSecs":0}}],
            "exitStops":[{{"stopId":"S3","walkSecs":0}}],
            "departureSecs":28800,"date":"20260505","_pad":"{filler}"}}"#,
    );
    let (big_code, _) = ureq_post(&format!("{}/api/vilnius/plan", s.base), &big).unwrap();
    assert_eq!(big_code, 413, "oversized body must return 413");

    // Same server, fresh connection: a normal request must still succeed.
    let ok_body = r#"{"entryStops":[{"stopId":"S1","walkSecs":0}],
                      "exitStops":[{"stopId":"S3","walkSecs":0}],
                      "departureSecs":28800,"date":"20260505"}"#;
    let (ok_code, out) = ureq_post(&format!("{}/api/vilnius/plan", s.base), ok_body).unwrap();
    assert_eq!(ok_code, 200, "server must stay live after 413; body: {out}");
}

/// No path → 200 with empty array. A date far outside the 90-day service window guarantees no
/// active service → empty result.
#[test]
fn plan_no_path_is_200_empty_array() {
    let s = spawn(false);
    // date 20990101 is far outside the 90-day anchor window (feedStartDate=20260501)
    // → no active service → no itineraries.
    let body = r#"{"entryStops":[{"stopId":"S1","walkSecs":0}],
                   "exitStops":[{"stopId":"S3","walkSecs":0}],
                   "departureSecs":28800,"date":"20990101"}"#;
    let (code, out) = ureq_post(&format!("{}/api/vilnius/plan", s.base), body).unwrap();
    assert_eq!(code, 200, "no-path must return 200; body: {out}");
    assert_eq!(out.trim(), "[]", "no-path body must be empty array");
}



/// Return type for the full HTTP helpers: (status, lowercase-headers, raw body).
type FullResp = Result<(u16, Vec<(String, String)>, Vec<u8>), Box<dyn std::error::Error>>;

/// GET → (status, headers-as-pairs, raw body bytes).
fn ureq_get_full(url: &str) -> FullResp {
    let resp = ureq::get(url).call();
    match resp {
        Ok(r) => {
            let status = r.status();
            let hdrs = r
                .headers_names()
                .into_iter()
                .filter_map(|name| {
                    r.header(&name)
                        .map(|val| (name.to_lowercase(), val.to_string()))
                })
                .collect();
            let mut body = Vec::new();
            r.into_reader().read_to_end(&mut body)?;
            Ok((status, hdrs, body))
        }
        Err(ureq::Error::Status(code, r)) => {
            let hdrs = r
                .headers_names()
                .into_iter()
                .filter_map(|name| {
                    r.header(&name)
                        .map(|val| (name.to_lowercase(), val.to_string()))
                })
                .collect();
            let mut body = Vec::new();
            r.into_reader().read_to_end(&mut body)?;
            Ok((code, hdrs, body))
        }
        Err(e) => Err(Box::new(e)),
    }
}

/// GET with `If-None-Match` header → (status, headers-as-pairs, raw body bytes).
fn ureq_get_inm(url: &str, etag: &str) -> FullResp {
    let resp = ureq::get(url).set("If-None-Match", etag).call();
    match resp {
        Ok(r) => {
            let status = r.status();
            let hdrs = r
                .headers_names()
                .into_iter()
                .filter_map(|name| {
                    r.header(&name)
                        .map(|val| (name.to_lowercase(), val.to_string()))
                })
                .collect();
            let mut body = Vec::new();
            r.into_reader().read_to_end(&mut body)?;
            Ok((status, hdrs, body))
        }
        Err(ureq::Error::Status(code, r)) => {
            let hdrs = r
                .headers_names()
                .into_iter()
                .filter_map(|name| {
                    r.header(&name)
                        .map(|val| (name.to_lowercase(), val.to_string()))
                })
                .collect();
            let mut body = Vec::new();
            r.into_reader().read_to_end(&mut body)?;
            Ok((code, hdrs, body))
        }
        Err(e) => Err(Box::new(e)),
    }
}

/// GET with `Accept-Encoding: gzip` → (status, headers-as-pairs, raw body bytes).
///
/// Uses a raw `TcpStream` so we see the server's actual `Content-Encoding` header
/// before any client-side transparent decompression (ureq v2 decompresses gzip
/// transparently and strips the header, which would defeat the assertion).
fn ureq_get_gzip(url: &str) -> FullResp {
    use std::io::{BufRead, BufReader, Write as IoWrite};
    use std::net::TcpStream;

    let parsed = url::Url::parse(url)?;
    let host = parsed.host_str().unwrap_or("127.0.0.1");
    let port = parsed.port().unwrap_or(80);
    let path = parsed.path();

    let mut stream = TcpStream::connect(format!("{host}:{port}"))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()?;

    let mut reader = BufReader::new(stream);

    // Parse status line.
    let mut status_line = String::new();
    reader.read_line(&mut status_line)?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    // Parse headers.
    let mut hdrs: Vec<(String, String)> = Vec::new();
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let trimmed = line.trim_end_matches("\r\n").trim_end_matches('\n');
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            let k = name.trim().to_lowercase();
            let v = value.trim().to_string();
            if k == "content-length" {
                content_length = v.parse().ok();
            }
            hdrs.push((k, v));
        }
    }

    // Read body.
    let mut body = Vec::new();
    if let Some(len) = content_length {
        body.resize(len, 0);
        reader.read_exact(&mut body)?;
    } else {
        reader.read_to_end(&mut body)?;
    }

    Ok((status, hdrs, body))
}

/// GET with an arbitrary `Accept-Encoding` value → (status, headers-as-pairs, raw body bytes).
fn ureq_get_ae(url: &str, accept_encoding: &str) -> FullResp {
    let resp = ureq::get(url)
        .set("Accept-Encoding", accept_encoding)
        .call();
    match resp {
        Ok(r) => {
            let status = r.status();
            let hdrs = r
                .headers_names()
                .into_iter()
                .filter_map(|name| {
                    r.header(&name)
                        .map(|val| (name.to_lowercase(), val.to_string()))
                })
                .collect();
            let mut body = Vec::new();
            r.into_reader().read_to_end(&mut body)?;
            Ok((status, hdrs, body))
        }
        Err(ureq::Error::Status(code, r)) => {
            let hdrs = r
                .headers_names()
                .into_iter()
                .filter_map(|name| {
                    r.header(&name)
                        .map(|val| (name.to_lowercase(), val.to_string()))
                })
                .collect();
            let mut body = Vec::new();
            r.into_reader().read_to_end(&mut body)?;
            Ok((code, hdrs, body))
        }
        Err(e) => Err(Box::new(e)),
    }
}

/// Case-insensitive header lookup from a `Vec<(String, String)>` (headers names are already
/// lowercased by our helpers above).
fn header(headers: &[(String, String)], name: &str) -> Option<String> {
    let name_lower = name.to_lowercase();
    headers
        .iter()
        .find(|(k, _)| k == &name_lower)
        .map(|(_, v)| v.clone())
}



#[test]
fn transfers_fetch_headers_and_304() {
    let s = spawn(true); // with transfers
    let (code, headers, _) =
        ureq_get_full(&format!("{}/api/vilnius/transfers/fetch", s.base)).unwrap();
    assert_eq!(code, 200);
    assert_eq!(
        header(&headers, "content-type"),
        Some("application/octet-stream".into())
    );
    assert_eq!(
        header(&headers, "cache-control"),
        Some("public, max-age=300".into())
    );
    assert_eq!(header(&headers, "vary"), Some("Accept-Encoding".into()));
    let etag = header(&headers, "etag").expect("ETag header must be present");

    // If-None-Match with the returned ETag → 304, Vary + ETag headers, empty body.
    let (code2, headers2, body2) =
        ureq_get_inm(&format!("{}/api/vilnius/transfers/fetch", s.base), &etag).unwrap();
    assert_eq!(code2, 304, "conditional GET must yield 304");
    assert!(body2.is_empty(), "304 body must be empty");
    assert_eq!(
        header(&headers2, "vary"),
        Some("Accept-Encoding".into()),
        "304 must echo Vary"
    );
    assert_eq!(
        header(&headers2, "etag").as_deref(),
        Some(etag.as_str()),
        "304 must echo ETag"
    );
}

#[test]
fn transfers_fetch_404_when_absent() {
    let s = spawn(false); // no transfers loaded
    assert_eq!(
        ureq_get(&format!("{}/api/vilnius/transfers/fetch", s.base))
            .unwrap()
            .0,
        404,
        "absent transfers must return 404"
    );
}

#[test]
fn route_geometry_fetch_404_when_absent() {
    let s = spawn(false);
    assert_eq!(
        ureq_get(&format!("{}/api/vilnius/route-geometry/fetch", s.base))
            .unwrap()
            .0,
        404,
        "absent SHPB must return 404"
    );
}

#[test]
fn route_geometry_provenance_fetch_bytes_and_304() {
    let (s, _shapes_json_sha) = spawn_with_artifacts();
    let expected = common::publisher::encode_test_shapes_bin(&tiny_ptb_path());
    let expected_hash = common::publisher::sha256_hex(&expected);

    let (bundle_code, bundle_headers, _) =
        ureq_get_full(&format!("{}/api/vilnius/raptor-bundle", s.base)).unwrap();
    assert_eq!(bundle_code, 200);
    assert_eq!(
        header(&bundle_headers, "x-pt-route-geometry-provenance").as_deref(),
        Some("shpb-v1")
    );
    assert_eq!(
        header(&bundle_headers, "x-pt-route-geometry-artifact-url").as_deref(),
        Some("/api/vilnius/route-geometry/fetch")
    );
    assert_eq!(
        header(&bundle_headers, "x-pt-route-geometry-artifact-hash").as_deref(),
        Some(expected_hash.as_str())
    );
    assert_eq!(
        header(&bundle_headers, "x-pt-route-geometry-artifact-size").as_deref(),
        Some(expected.len().to_string().as_str())
    );

    let url = format!("{}/api/vilnius/route-geometry/fetch", s.base);
    let (code, headers, body) = ureq_get_full(&url).unwrap();
    assert_eq!(code, 200);
    assert_eq!(body, expected, "served SHPB bytes must match shapes.bin");
    assert_eq!(
        header(&headers, "content-type").as_deref(),
        Some("application/octet-stream")
    );
    assert_eq!(
        header(&headers, "cache-control").as_deref(),
        Some("public, max-age=300")
    );
    let etag = header(&headers, "etag").expect("geometry ETag");
    assert_eq!(etag, format!("\"{expected_hash}\""));

    let (code, headers, body) = ureq_get_inm(&url, &etag).unwrap();
    assert_eq!(code, 304);
    assert!(body.is_empty());
    assert_eq!(header(&headers, "etag").as_deref(), Some(etag.as_str()));
}

#[test]
fn raptor_bundle_etag_and_gzip() {
    let s = spawn(false);
    let (code, headers, body) =
        ureq_get_gzip(&format!("{}/api/vilnius/raptor-bundle", s.base)).unwrap();
    assert_eq!(code, 200);
    assert_eq!(
        header(&headers, "content-encoding"),
        Some("gzip".into()),
        "must respond with Content-Encoding: gzip when client accepts gzip"
    );
    assert!(!body.is_empty(), "gzip body must not be empty");

    // Gunzip the body and verify it byte-equals the on-disk .ptb fixture.
    let mut decoder = flate2::read::GzDecoder::new(body.as_slice());
    let mut decompressed = Vec::new();
    decoder
        .read_to_end(&mut decompressed)
        .expect("gzip body must decompress without error");
    let expected = std::fs::read(tiny_ptb_path()).expect("tiny.ptb fixture must be readable");
    assert_eq!(
        decompressed, expected,
        "decompressed bundle must byte-equal the on-disk .ptb fixture"
    );

    let etag = header(&headers, "etag").expect("ETag header must be present");
    let (code2, _, _) =
        ureq_get_inm(&format!("{}/api/vilnius/raptor-bundle", s.base), &etag).unwrap();
    assert_eq!(code2, 304, "conditional GET must yield 304");
}

/// Timetable bytes and OSM sidecars version independently. `/ready` reports
/// the PTB content hash next to the publication id, and the PTB ETag is that
/// hash, so a sidecar-only publication revalidates the PTB with a 304.
#[test]
fn ready_reports_the_ptb_hash_that_the_bundle_etag_carries() {
    let s = spawn(false);
    let (_, ready) = ureq_get(&format!("{}/ready", s.base)).unwrap();
    let ready: serde_json::Value = serde_json::from_str(&ready).expect("ready body is JSON");
    let bundle_sha = common::publisher::sha256_hex(&std::fs::read(tiny_ptb_path()).unwrap());
    assert_eq!(ready["servingBundleSha256"], bundle_sha.as_str());
    assert_ne!(ready["servingGenerationId"], bundle_sha.as_str());
    let (code, headers, _) =
        ureq_get_full(&format!("{}/api/vilnius/raptor-bundle", s.base)).unwrap();
    assert_eq!(code, 200);
    assert_eq!(header(&headers, "etag"), Some(format!("\"{bundle_sha}\"")));
}

#[test]
fn raptor_bundle_no_gzip_when_not_accepted() {
    // No Content-Encoding when the client did not send Accept-Encoding: gzip.
    let s = spawn(false);
    let (code, headers, _) =
        ureq_get_full(&format!("{}/api/vilnius/raptor-bundle", s.base)).unwrap();
    assert_eq!(code, 200);
    assert_eq!(
        header(&headers, "content-encoding"),
        None,
        "must NOT set Content-Encoding when client did not accept gzip"
    );
}

/// `GET /api/<city>/raptor-bundle` must stamp `X-Ptb-Version` with the header
/// version of the served bundle. The integration fixture publishes `tiny.ptb`,
/// a current PTB v1 bundle, so the header must read `1`.
#[test]
fn raptor_bundle_emits_x_ptb_version_from_served_header() {
    let s = spawn(false);
    let (code, headers, _) =
        ureq_get_full(&format!("{}/api/vilnius/raptor-bundle", s.base)).unwrap();
    assert_eq!(code, 200);
    assert_eq!(
        header(&headers, "x-ptb-version"),
        Some("1".into()),
        "X-Ptb-Version must reflect the served tiny.ptb header"
    );
}

#[test]
fn gzip_token_is_not_substring_matched() {
    // `xgzip` must NOT be treated as gzip — token-aware match, like Node's /\bgzip\b/i.
    let s = spawn(false);
    let (code, headers, _) =
        ureq_get_ae(&format!("{}/api/vilnius/raptor-bundle", s.base), "xgzip").unwrap();
    assert_eq!(code, 200);
    assert_eq!(
        header(&headers, "content-encoding"),
        None,
        "xgzip must NOT trigger gzip response (must be an exact token match)"
    );
}

#[test]
fn gzip_q0_is_not_accepted() {
    // `gzip;q=0` explicitly disables gzip (RFC 7231 ) → must serve raw bytes.
    let s = spawn(false);
    let (code, headers, _) = ureq_get_ae(
        &format!("{}/api/vilnius/raptor-bundle", s.base),
        "gzip;q=0, identity",
    )
    .unwrap();
    assert_eq!(code, 200);
    assert_eq!(
        header(&headers, "content-encoding"),
        None,
        "gzip;q=0 must NOT trigger a gzip response"
    );
}



#[test]
fn metrics_exposes_resident_and_plan_counter() {
    let s = spawn(false);

    // Issue one /plan request to bump the counter.
    let body = r#"{"entryStops":[{"stopId":"S1","walkSecs":0}],
                   "exitStops":[{"stopId":"S3","walkSecs":0}],
                   "departureSecs":28800,"date":"20260505"}"#;
    let _ = ureq_post(&format!("{}/api/vilnius/plan", s.base), body);

    let (code, out) = ureq_get(&format!("{}/metrics", s.base)).unwrap();
    assert_eq!(code, 200, "/metrics must return 200; body: {out}");
    assert!(
        out.contains("plan_requests_total"),
        "/metrics body must contain plan_requests_total; body: {out}"
    );

    // resident_bytes is only emitted on Linux (smaps_rollup not present on macOS).
    #[cfg(target_os = "linux")]
    assert!(
        out.contains("resident_bytes "),
        "/metrics body must contain resident_bytes on Linux; body: {out}"
    );
}

/// A 413-rejected oversized `/plan` body must still bump `plan_requests_total`.
/// The counter is incremented by the dispatcher on receipt (before the body-size
/// check), so a flood of over-cap POSTs is visible in the metric — the scenario
/// the counter is most useful for. Regression guard: the increment used to live
/// in the handler, which the 413 path returns before reaching.
#[test]
fn metrics_counts_oversized_rejected_plan_requests() {
    let s = spawn(false);

    fn plan_count(out: &str) -> u64 {
        out.lines()
            .find_map(|l| l.strip_prefix("plan_requests_total "))
            .and_then(|v| v.trim().parse().ok())
            .expect("plan_requests_total line present")
    }
    fn oversized_count(out: &str) -> u64 {
        out.lines()
            .find_map(|l| l.strip_prefix("oversized_plan_requests_total "))
            .and_then(|v| v.trim().parse().ok())
            .expect("oversized_plan_requests_total line present")
    }

    // The counter lives on the per-server `Arc<Metrics>` (no longer a
    // process-global), and each test spawns its own child process via
    // `spawn(false)` — so cross-test pollution is already impossible. The
    // delta-based assertion is kept anyway as defence in depth: a real
    // regression (413 path not counting) drops the delta to ~0, while a true
    // pass yields exactly N.
    const N: u64 = 8;
    let (_, before) = ureq_get(&format!("{}/metrics", s.base)).unwrap();

    // Oversized, valid JSON → rejected with 413 before the handler runs.
    let filler = "x".repeat(2 * 1024 * 1024);
    let big = format!(
        r#"{{"entryStops":[{{"stopId":"S1","walkSecs":0}}],
            "exitStops":[{{"stopId":"S3","walkSecs":0}}],
            "departureSecs":28800,"date":"20260505","_pad":"{filler}"}}"#,
    );
    for _ in 0..N {
        let (big_code, _) = ureq_post(&format!("{}/api/vilnius/plan", s.base), &big).unwrap();
        assert_eq!(big_code, 413, "oversized body must return 413");
    }

    let (_, after) = ureq_get(&format!("{}/metrics", s.base)).unwrap();
    assert!(
        plan_count(&after) >= plan_count(&before) + N,
        "{N} 413-rejected /plan requests must each increment plan_requests_total; \
         before={before:?} after={after:?}"
    );
    assert!(
        oversized_count(&after) >= oversized_count(&before) + N,
        "{N} 413-rejected /plan requests must each increment \
         oversized_plan_requests_total; before={before:?} after={after:?}"
    );
}

#[test]
fn transfers_fetch_bytes_equal_artifact() {
    // The bytes served by pt-serve must be bit-for-bit identical to the PTFT artifact on disk.
    let s = spawn(true);
    let (_, _, body) = ureq_get_full(&format!("{}/api/vilnius/transfers/fetch", s.base)).unwrap();
    let raw = std::fs::read(tiny_transfers_path()).unwrap();
    assert_eq!(
        body, raw,
        "served bytes must equal the raw PTFT artifact bytes"
    );
}

// ---------------------------------------------------------------------------
// C2b HTTP-level dispatch tests
//
// Covers the dispatch→adapter→counter composition for the two C2b read
// routes (`color-config` and `shapes`) that is not exercised by the
// transport-free handler tests in handlers.rs.  The `Resp::CachedBytes`
// adapter arm is C2b-only; these tests confirm the full HTTP round-trip:
//   router::resolve → handler → adapter::to_tiny_http → wire headers.
// ---------------------------------------------------------------------------

/// `GET /api/<city>/color-config` on a generation WITH `color-config.json`:
///   - 200 OK
///   - Content-Type: application/json
///   - Cache-Control: public, max-age=86400
///   - X-API-Version: 1
///   - no ETag (backend spec)
///
/// Also asserts `pt_serve_requests_total{route="color-config",status="200"}`
/// appears in /metrics after the request (counter incremented through the
/// full dispatch path).
#[test]
fn color_config_200_headers_and_counter() {
    let (s, _shapes_sha) = spawn_with_artifacts();
    let (code, headers, body) =
        ureq_get_full(&format!("{}/api/vilnius/color-config", s.base)).unwrap();
    assert_eq!(code, 200, "color-config must return 200; body={body:?}");
    assert_eq!(
        header(&headers, "content-type"),
        Some("application/json".into()),
        "Content-Type must be application/json"
    );
    assert_eq!(
        header(&headers, "cache-control"),
        Some("public, max-age=86400".into()),
        "Cache-Control must be public, max-age=86400"
    );
    assert_eq!(
        header(&headers, "x-api-version"),
        Some("1".into()),
        "X-API-Version: 1 must be present on CachedBytes responses"
    );
    assert!(
        header(&headers, "etag").is_none(),
        "color-config must NOT set an ETag (backend spec)"
    );
    // Verify the counter incremented through the full dispatch path.
    let (_, metrics_body) = ureq_get(&format!("{}/metrics", s.base)).unwrap();
    assert!(
        metrics_body.contains("pt_serve_requests_total{route=\"color-config\",status=\"200\"}"),
        "color-config counter must appear in /metrics after a 200 request; metrics: {metrics_body}"
    );
}

/// `GET /api/<city>/gtfs/shapes/shapes-<hash>.json` with the CORRECT hash
/// (the one recorded in the manifest as `shapesJsonSha256`):
///   - 200 OK
///   - Cache-Control: public, max-age=2592000, immutable
///   - ETag: "<hash>" (strong)
///   - X-API-Version: 1
///
/// And with a WRONG (non-matching) hash → 404.
///
/// Asserts `pt_serve_requests_total{route="shapes",status="200"}` appears in
/// /metrics after the 200 request.
#[test]
fn shapes_json_found_ready_provenance_and_wrong_hash_404() {
    let (s, shapes_sha) = spawn_with_artifacts();

    // 1. Correct hash → 200 with immutable cache headers.
    let shapes_url = format!(
        "{}/api/vilnius/gtfs/shapes/shapes-{shapes_sha}.json",
        s.base
    );
    let (code, headers, body) = ureq_get_full(&shapes_url).unwrap();
    assert_eq!(code, 200, "shapes with correct hash must return 200");
    assert_eq!(
        header(&headers, "cache-control"),
        Some("public, max-age=2592000, immutable".into()),
        "shapes Cache-Control must be immutable (content-addressed)"
    );
    let etag = header(&headers, "etag").expect("ETag must be present on shapes 200");
    assert_eq!(
        etag,
        format!("\"{shapes_sha}\""),
        "ETag must be the quoted shapes JSON sha256"
    );
    assert_eq!(
        header(&headers, "x-api-version"),
        Some("1".into()),
        "X-API-Version: 1 must be present"
    );
    let (_, ready_body) = ureq_get(&format!("{}/ready", s.base)).unwrap();
    let ready: serde_json::Value = serde_json::from_str(&ready_body).expect("ready body is JSON");
    assert_eq!(ready["servingShapesJsonSha256"], shapes_sha);
    assert_eq!(
        ready["servingShapesJsonSizeBytes"].as_u64(),
        Some(body.len() as u64),
        "/ready must advertise the exact canonical shapes body size"
    );

    // 2. Wrong hash → 404.
    let wrong_url = format!(
        "{}/api/vilnius/gtfs/shapes/shapes-{}.json",
        s.base,
        "a".repeat(64)
    );
    let (code404, _, _) = ureq_get_full(&wrong_url).unwrap();
    assert_eq!(code404, 404, "shapes with wrong hash must return 404");

    // 3. Counter: /metrics must show shapes 200 incremented.
    let (_, metrics_body) = ureq_get(&format!("{}/metrics", s.base)).unwrap();
    assert!(
        metrics_body.contains("pt_serve_requests_total{route=\"shapes\",status=\"200\"}"),
        "shapes counter must appear in /metrics after a 200 request; metrics: {metrics_body}"
    );
}

// ---------------------------------------------------------------------------
// GTFS-RT: /health/rt end-to-end through the real binary (main.rs spawns the
// pt-serve-rt-poll thread; the feed is a local tiny_http fixture server).
// ---------------------------------------------------------------------------

#[test]
fn rt_health_disabled_by_default() {
    let s = spawn(false);
    let (code, body) = ureq_get(&format!("{}/health/rt", s.base)).unwrap();
    assert_eq!(code, 503);
    assert_eq!(body, r#"{"overall":"disabled","feeds":[]}"#);
}

#[test]
fn rt_health_end_to_end_against_local_feed() {
    // Fixture feed server: serves the committed dated_trip.bin on every GET,
    // forever (thread parks on incoming_requests; the test process exiting
    // reaps it — same pattern as other detached test helpers here).
    let feed = tiny_http::Server::http("127.0.0.1:0").expect("bind feed server");
    let feed_addr = feed.server_addr().to_ip().expect("ip listener");
    let feed_url = format!("http://{feed_addr}/trip_updates.pb");
    std::thread::spawn(move || {
        let body: &[u8] = include_bytes!("fixtures/rt/dated_trip.bin");
        for req in feed.incoming_requests() {
            let _ = req.respond(tiny_http::Response::from_data(body.to_vec()));
        }
    });

    let s = spawn_with_env(&[
        ("PT_SERVE_RT_TRIP_UPDATES_URLS", feed_url.as_str()),
        ("PT_SERVE_RT_POLL_INTERVAL_MS", "50"),
    ]);

    // First cycle fires immediately; allow up to 5 s for slow CI.
    let mut last = (0u16, String::new());
    for _ in 0..100 {
        last = ureq_get(&format!("{}/health/rt", s.base)).unwrap();
        if last.0 == 200 && last.1.contains(r#""overall":"ok""#) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(last.0, 200, "body: {}", last.1);
    assert!(last.1.contains(r#""overall":"ok""#), "body: {}", last.1);
    assert!(last.1.contains(r#""status":"ok""#), "body: {}", last.1);
    assert!(
        last.1.contains(&format!(r#""url":"{feed_url}""#)),
        "body: {}",
        last.1
    );
    assert!(
        !last.1.contains(r#""entryCount":0"#),
        "expected non-zero entryCount: {}",
        last.1
    );
}
