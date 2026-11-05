use std::io::Write;
use std::net::{SocketAddr, TcpListener};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn http_status(addr: SocketAddr, path: &str) -> Option<u16> {
    use std::io::Read;
    let mut stream = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(1)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let req = format!("GET {} HTTP/1.0\r\nHost: x\r\n\r\n", path);
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = String::new();
    stream.read_to_string(&mut buf).ok()?;
    let line = buf.lines().next()?;
    line.split_whitespace().nth(1)?.parse().ok()
}

/// End-to-end: when the producer runs against `--gtfs-path`, it emits exactly one
/// `[producer] gtfs_sha256=<hex> bytes=<N> path=<...>` line on stderr per zip.
/// The regex matches the documented format; a future field reorder would
/// break this test, which is the intent — downstream paragraph parsing
/// depends on the exact text.
#[test]
fn producer_emits_sha256_provenance_line() {
    let fixture =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny-gtfs.zip");
    let port = pick_free_port();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let bin = env!("CARGO_BIN_EXE_pt-producer");
    let mut child = Command::new(bin)
        .arg("--gtfs-path")
        .arg(&fixture)
        .arg("--listen-addr")
        .arg(addr.to_string())
        .arg("--idle-after-ingestion")
        .arg("30")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn producer");

    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if http_status(addr, "/api/health/ready") == Some(200) {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    let exit_deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait().expect("try_wait producer") {
            Some(_) => break,
            None if Instant::now() >= exit_deadline => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("producer did not exit within 15s of SIGTERM");
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    let out = child.wait_with_output().expect("wait_with_output");
    let stderr = String::from_utf8_lossy(&out.stderr);
    let re = regex::Regex::new(r"\[producer\] gtfs_sha256=([0-9a-f]{64}) bytes=(\d+)").unwrap();
    let cap = re.captures(&stderr).unwrap_or_else(|| {
        panic!("no gtfs_sha256 line in stderr:\n{stderr}");
    });
    let claimed_bytes: u64 = cap.get(2).unwrap().as_str().parse().unwrap();
    let actual_bytes = std::fs::metadata(&fixture).unwrap().len();
    assert_eq!(
        claimed_bytes, actual_bytes,
        "bytes mismatch between log line and fixture"
    );
    // Verify the SHA matches by re-hashing the fixture.
    use sha2::{Digest, Sha256};
    let data = std::fs::read(&fixture).unwrap();
    let mut h = Sha256::new();
    h.update(&data);
    let expected = h.finalize();
    let mut expected_hex = String::with_capacity(64);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for b in expected.iter() {
        expected_hex.push(HEX[(b >> 4) as usize] as char);
        expected_hex.push(HEX[(b & 0xF) as usize] as char);
    }
    assert_eq!(cap.get(1).unwrap().as_str(), expected_hex);
}

#[test]
fn log_gtfs_provenance_hashes_arbitrary_file() {
    // Unit-test the helper directly so we still catch regressions in CI
    // even if the e2e variant gets skipped for some reason.
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let payload = b"hello, gtfs provenance".to_vec();
    std::fs::write(tmp.path(), &payload).unwrap();
    pt_producer::download::log_gtfs_provenance(tmp.path()).expect("log");
    // Helper writes to stderr; the assertion is that it doesn't panic on
    // a small file. The hex+bytes correctness is checked in the e2e test.
}
