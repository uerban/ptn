//! Current PTB v1 ServiceBitfieldPool end-to-end producer proof.
//!
//! Mirrors the window-emission integration coverage: spawn the producer over the committed
//! `tiny-gtfs.zip` at a pinned anchor and assert the freshly emitted v1 bytes are
//! byte-identical to a pinned `COMMITTED_SHA256`, and decode back to a v1
//! ServiceBitfieldPool bundle through `pt_core::Reader` (the SAME reader pt-serve
//! uses). This proves the real producer pipeline emits the `0x15
//! ServiceBitfieldPool` / `0x16 ServiceToBitfield` pool pair deterministically —
//! not just that a hand-built fixture reads back.
//!
//! Pinned anchor `20260505` + `--city-tz-iana UTC` make this a deterministic,
//! network-free emit. Do not replace
//! the anchor with "today": a rolling anchor changes the bitmask window and breaks
//! the byte-identical reproducibility this test asserts.

use pt_core::Reader;
use sha2::{Digest, Sha256};
use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// sha256 of the producer-emitted v1 tiny-gtfs bundle at the pinned anchor — the
/// byte-identical reproducibility anchor. A re-emit at the SAME args must
/// reproduce these bytes; if the v1 0x15/0x16 byte layout (or any upstream emit)
/// drifts, update this deliberately.
const COMMITTED_SHA256: &str = "dbb32ab29e38bc4c5f52be32c0339bcfe53fa31ea9eb4d625b851ae337899766";
const COMMITTED_PTB: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../pt-core/tests/fixtures/producer-current.ptb"
));
/// Pinned anchor — see the module doc; do NOT replace with "today".
const ANCHOR_DATE: &str = "20260505";

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn tiny_gtfs_zip() -> PathBuf {
    manifest_dir().join("tests/fixtures/tiny-gtfs.zip")
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

/// Producer-derive proof + byte-identical reproducibility: spawn the producer over
/// the committed tiny-gtfs feed at the pinned anchor and
/// assert the freshly emitted bytes hash to `COMMITTED_SHA256`, the header stamps
/// version 1, the producer logged the ServiceBitfieldPool re-encode, and the bytes
/// decode through `pt_core::Reader` to a v1 bundle whose service masks resolve via
/// the pool. (tiny-gtfs has 2 services with 2 distinct calendars ⇒ pool count 2 —
/// `count == num_services`, the no-fold real-feed-shaped case the producer must
/// still emit correctly; the genuine-fold path is covered by the dedicated
/// current-format fixture generator.)
#[test]
fn producer_reemits_v1_byte_identically() {
    let bin = env!("CARGO_BIN_EXE_pt-producer");
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("tiny-v1.ptb");
    let port = pick_free_port();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();

    let mut child = Command::new(bin)
        .arg("--gtfs-path")
        .arg(tiny_gtfs_zip())
        .arg("--out")
        .arg(&out)
        .arg("--anchor-date")
        .arg(ANCHOR_DATE)
        .arg("--city-tz-iana")
        .arg("UTC")
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
    // The v1 re-encode log line carries serviceBitfieldPoolCount — its presence
    // proves the 0x15 dedup actually ran.
    assert!(
        stderr.contains("PTB v1 re-encode done") && stderr.contains("serviceBitfieldPoolCount="),
        "producer must log the PTB v1 ServiceBitfieldPool re-encode\nstderr:\n{stderr}"
    );

    let emitted = std::fs::read(&out).expect("read emitted tiny-v1.ptb");
    assert_eq!(
        sha256_hex(&emitted),
        COMMITTED_SHA256,
        "re-emit at --anchor-date {ANCHOR_DATE} is not byte-identical to the pinned v1 SHA"
    );
    assert_eq!(
        emitted.as_slice(),
        COMMITTED_PTB,
        "re-emitted bytes differ from producer-current.ptb"
    );

    // Decode through the same reader pt-serve uses: a PTB v1 bundle.
    let reader = Reader::from_bytes(emitted).expect("pt_core::Reader decodes the v1 bundle");
    assert_eq!(reader.header().version, pt_core::PTB_VERSION_V1);
    assert!(reader.num_services() > 0, "feed has services");
    // tiny-gtfs: 2 services, 2 distinct calendars ⇒ pool count 2 (no fold). The
    // pool must still resolve every service's mask through 0x16 → 0x15.
    assert_eq!(
        reader.service_bitfield_pool_count(),
        2,
        "tiny-gtfs v1 pool holds 2 distinct bitfields"
    );
    for s in 0..reader.num_services() {
        assert!(
            !reader.service_bitmask(s).is_empty(),
            "service {s} mask must resolve via the pool"
        );
    }
}
