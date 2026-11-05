//! End-to-end producer proof for a non-default service window.
//!
//! `tests/window_derive.rs` pins the pure horizon→window_days arithmetic; this
//! suite proves the FULL producer pipeline emits a `0x01 WindowMeta` region at
//! the derived stride AND that the SAME committed bytes decode back to
//! `window_days() == 400` / `bytes_per_service() == 50` through `pt_core::Reader`
//! (the cross-language anchor for `packages/shared/scripts/assert-ptb-cross-parity.ts`).
//!
//! The committed fixture is `packages/shared/src/ptb/__fixtures__/window400.ptb`,
//! emitted by the producer over `tests/fixtures/window400-gtfs.zip` at
//! `--anchor-date 20260619` (whose calendar end_date=20270710 derives
//! windowDays = 386 + 14 = 400 exactly → `WindowClampEvent::None`, NOT
//! ClampedHigh). A hand-built fixture would only exercise the reader; this one
//! drives the real derive.
//!
//! I13 — the `--anchor-date 20260619` literal is INTENTIONALLY pinned and will
//! eventually fall in the past relative to "today". Do NOT "fix" it to today: a
//! rolling anchor would change the horizon and break the deterministic 400
//! derive (and the byte-identical reproducibility this test asserts).

use pt_core::Reader;
use sha2::{Digest, Sha256};
use std::net::{SocketAddr, TcpListener};
use std::path::Path;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The committed, producer-emitted 400-day cross-parity fixture.
const COMMITTED_FIXTURE: &str = "../../packages/shared/src/ptb/__fixtures__/window400.ptb";
/// sha256 of the committed fixture — the byte-identical reproducibility anchor.
/// A re-emit at the SAME `--anchor-date 20260619` must reproduce these bytes.
const COMMITTED_SHA256: &str = "55cfa3f31642acef3314cdf7fcd3a3f0c76d4ed9f0108d90074cf879c72486c6";
/// Pinned anchor (I13) — see the module doc; do NOT replace with "today".
const ANCHOR_DATE: &str = "20260619";

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn committed_fixture_path() -> PathBuf {
    manifest_dir().join(COMMITTED_FIXTURE)
}

fn window400_zip() -> PathBuf {
    manifest_dir().join("tests/fixtures/window400-gtfs.zip")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn http_status(addr: SocketAddr, path: &str) -> Option<u16> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(1)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let req = format!("GET {} HTTP/1.0\r\nHost: x\r\n\r\n", path);
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = String::new();
    stream.read_to_string(&mut buf).ok()?;
    let line = buf.lines().next()?;
    line.split_whitespace().nth(1)?.parse().ok()
}

fn wait_until_ready(addr: SocketAddr, deadline: Instant) -> bool {
    while Instant::now() < deadline {
        if http_status(addr, "/api/health/ready") == Some(200) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// Cross-language anchor: the committed bytes MUST decode to windowDays 400 /
/// stride 50 through `pt_core::Reader` (the SAME reader pt-serve uses). The
/// A successful decode at stride 50 proves the current pool was written at the
/// derived stride; we cross-check the arithmetic too.
#[test]
fn committed_window400_fixture_decodes_to_400_stride_50() {
    let path = committed_fixture_path();
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("read committed fixture {}: {e}", path.display()));

    assert_eq!(
        sha256_hex(&bytes),
        COMMITTED_SHA256,
        "committed window400.ptb sha256 drifted — re-emit at --anchor-date {ANCHOR_DATE} and update COMMITTED_SHA256 deliberately"
    );

    let reader = Reader::from_bytes(bytes).expect("pt_core::Reader decodes window400.ptb");
    assert_eq!(reader.window_days(), 400, "Rust reader window_days");
    assert_eq!(
        reader.bytes_per_service(),
        50,
        "Rust reader bytes_per_service"
    );
    // Independent of the reader's own stride: the pure helper agrees.
    assert_eq!(
        pt_core::bytes_per_service(reader.window_days()),
        50,
        "ceil(windowDays/8)"
    );
    assert!(reader.num_services() > 0, "fixture has services");
}

/// Producer-derive proof + byte-identical reproducibility (mirrors the Oslo
/// committed-feed `--anchor-date` pattern): spawn the producer over the synthetic
/// 400-day feed at the pinned anchor and assert the freshly emitted bytes equal
/// the committed fixture exactly. Proves the real derive emits the 0x01 region
/// at stride 50, not just that a committed fixture reads back.
#[test]
fn producer_reemits_window400_byte_identically() {
    let bin = env!("CARGO_BIN_EXE_pt-producer");
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("window400.ptb");
    let port = pick_free_port();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();

    let mut child = Command::new(bin)
        .arg("--gtfs-path")
        .arg(window400_zip())
        .arg("--out")
        .arg(&out)
        .arg("--anchor-date")
        .arg(ANCHOR_DATE)
        .arg("--city-tz-iana")
        .arg("Europe/Vilnius")
        .arg("--city-tz-offset-seconds")
        .arg("7200")
        .arg("--listen-addr")
        .arg(addr.to_string())
        .arg("--idle-after-ingestion")
        .arg("0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn producer");

    let deadline = Instant::now() + Duration::from_secs(30);
    let ready = wait_until_ready(addr, deadline);
    // --idle-after-ingestion 0 → the producer exits on its own shortly after ready.
    let exit_deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        match child.try_wait().expect("try_wait") {
            Some(s) => break s,
            None if Instant::now() >= exit_deadline => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("producer did not exit within 15s");
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    let collected = child.wait_with_output().expect("wait_with_output");
    let stderr = String::from_utf8_lossy(&collected.stderr);
    assert!(
        ready || out.exists(),
        "producer never reached ready and wrote no artifact\nstderr:\n{stderr}"
    );
    assert!(
        status.success(),
        "producer exited non-zero\nstderr:\n{stderr}"
    );
    assert!(
        stderr.contains("derived window_days=400"),
        "producer must log the derived window_days=400\nstderr:\n{stderr}"
    );

    let emitted = std::fs::read(&out).expect("read emitted window400.ptb");
    assert_eq!(
        sha256_hex(&emitted),
        COMMITTED_SHA256,
        "re-emit at --anchor-date {ANCHOR_DATE} is not byte-identical to the committed fixture"
    );
    assert_committed_equals(&out);
}

fn assert_committed_equals(emitted: &Path) {
    let a = std::fs::read(emitted).unwrap();
    let b = std::fs::read(committed_fixture_path()).unwrap();
    assert_eq!(a.len(), b.len(), "emitted/committed length differ");
    assert!(a == b, "emitted bytes differ from committed window400.ptb");
}
