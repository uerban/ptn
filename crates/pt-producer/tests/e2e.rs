use pt_core::{Reader, PTB_MAGIC, PTB_VERSION_V1};
use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
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

fn fixture_zip() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny-gtfs.zip")
}

fn spawn_producer(fixture: &Path, addr: SocketAddr, out: Option<&Path>) -> std::process::Child {
    spawn_producer_with_anchor(fixture, addr, out, None)
}

fn spawn_producer_with_anchor(
    fixture: &Path,
    addr: SocketAddr,
    out: Option<&Path>,
    anchor_date: Option<u32>,
) -> std::process::Child {
    let bin = env!("CARGO_BIN_EXE_pt-producer");
    let mut cmd = Command::new(bin);
    cmd.arg("--gtfs-path")
        .arg(fixture)
        .arg("--listen-addr")
        .arg(addr.to_string())
        .arg("--idle-after-ingestion")
        .arg("30");
    if let Some(p) = out {
        cmd.arg("--out").arg(p);
    }
    if let Some(anchor) = anchor_date {
        cmd.arg("--anchor-date").arg(anchor.to_string());
    }
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn producer")
}

/// Spawn the producer with an explicit UTC timezone for current-format checks.
fn spawn_current_producer(
    fixture: &Path,
    addr: SocketAddr,
    out: Option<&Path>,
    anchor_date: u32,
) -> std::process::Child {
    let bin = env!("CARGO_BIN_EXE_pt-producer");
    let mut cmd = Command::new(bin);
    cmd.arg("--gtfs-path")
        .arg(fixture)
        .arg("--listen-addr")
        .arg(addr.to_string())
        .arg("--idle-after-ingestion")
        .arg("30")
        .arg("--anchor-date")
        .arg(anchor_date.to_string())
        .arg("--city-tz-iana")
        .arg("UTC");
    if let Some(p) = out {
        cmd.arg("--out").arg(p);
    }
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn producer")
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

fn shutdown_producer(mut child: std::process::Child) -> (bool, String, String) {
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    let exit_deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        match child.try_wait().expect("try_wait producer") {
            Some(s) => break s,
            None if Instant::now() >= exit_deadline => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("producer did not exit within 15s of SIGTERM");
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    let out = child.wait_with_output().expect("wait_with_output");
    (
        status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn producer_drives_full_pipeline_against_fixture() {
    let port = pick_free_port();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let fixture = fixture_zip();

    let mut child = spawn_producer(&fixture, addr, None);

    let deadline = Instant::now() + Duration::from_secs(30);
    let got_ready = wait_until_ready(addr, deadline);
    if !got_ready {
        let _ = child.kill();
        let out = child.wait_with_output().expect("wait_with_output");
        panic!(
            "producer never reached ready=200\n--- stderr ---\n{}\n--- stdout ---\n{}",
            String::from_utf8_lossy(&out.stderr),
            String::from_utf8_lossy(&out.stdout)
        );
    }
    let (ok, _stdout, _stderr) = shutdown_producer(child);
    assert!(ok, "producer exited non-zero");
}

#[test]
fn producer_persists_valid_ptnb_via_out_flag() {
    let port = pick_free_port();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let fixture = fixture_zip();
    let tmp = tempfile::tempdir().unwrap();
    // nested dir to exercise mkdir -p
    let dest = tmp.path().join("nested/dir/p1.ptnb");

    // Use a fixed --anchor-date so feedStartDate is deterministic in CI.
    // 20260501 matches the tiny-gtfs fixture's calendar.txt min start_date.
    let child = spawn_producer_with_anchor(&fixture, addr, Some(&dest), Some(20260501));
    let deadline = Instant::now() + Duration::from_secs(30);
    let got_ready = wait_until_ready(addr, deadline);
    assert!(got_ready, "producer never reached ready=200");
    let (ok, _stdout, stderr) = shutdown_producer(child);
    assert!(ok, "producer exited non-zero\nstderr:\n{stderr}");
    assert!(
        dest.exists(),
        "persisted ptnb missing at {}",
        dest.display()
    );

    assert!(
        stderr.contains("[producer] interns written"),
        "missing interns log line:\n{stderr}"
    );
    assert!(
        stderr.contains("[producer] mid-pass done"),
        "missing mid-pass log line:\n{stderr}"
    );
    assert!(
        stderr.contains("[producer] string_pool written"),
        "missing string_pool log line:\n{stderr}"
    );
    assert!(
        stderr.contains("[producer] PTB v1 re-encode done"),
        "missing current PTB emit log line:\n{stderr}"
    );
    assert!(
        stderr.contains("[producer] pass1 state dropped before idle"),
        "missing drop(p1) log line:\n{stderr}"
    );
    assert!(
        !stderr.contains("materialize done"),
        "materialize loop log line should be gone:\n{stderr}"
    );

    let bytes = std::fs::read(&dest).unwrap();
    assert_eq!(&bytes[0..4], PTB_MAGIC, "magic bytes wrong");
    let version = u16::from_le_bytes(bytes[4..6].try_into().unwrap());
    assert_eq!(version, PTB_VERSION_V1);
    // Bytes 6..8: reserved u16 = 0
    assert_eq!(bytes[6], 0, "byte 6 (reserved u16 hi) non-zero");
    assert_eq!(bytes[7], 0, "byte 7 (reserved u16 hi) non-zero");
    let reader = Reader::from_bytes(bytes).expect("decode producer-emitted PTB v1");
    assert!(reader.num_stops() > 0, "num_stops must be > 0");
    assert!(reader.num_routes() > 0, "num_routes must be > 0");
    assert!(reader.num_trips() > 0, "num_trips must be > 0");
    assert_eq!(
        reader.header().feed_start_date,
        20260501,
        "feed_start_date must equal the --anchor-date supplied above"
    );
    assert!(
        reader.header().num_services > 0,
        "num_services in header must be > 0 for a real feed"
    );
    assert_eq!(
        reader.header().city_tz_offset_seconds,
        0,
        "default timezone offset is UTC"
    );

    let stop0 = reader.stop(0).expect("decode stop 0");
    let stop1 = reader.stop(1).expect("decode stop 1");
    assert!((stop0.stop_lat - 54.69).abs() < 0.001);
    assert!((stop0.stop_lon - 25.28).abs() < 0.001);
    assert_eq!(stop0.wheelchair_boarding, 0);
    assert_eq!(stop1.wheelchair_boarding, 1);

    let stop_time0 = reader.stop_time(0).expect("decode stop time 0");
    assert_eq!(stop_time0.arr_diff, 0, "arr equals dep in fixture");
    assert!(
        (3600..=11 * 3600).contains(&stop_time0.dep_secs),
        "dep_secs row0 looks valid: {}",
        stop_time0.dep_secs
    );
    assert_eq!(stop_time0.stop_idx, 0, "row 0 references S1");
}

#[test]
fn producer_writes_trip_starts_region_matching_prefix_sum() {
    use pt_producer::pass1::{compute_trip_starts, run_pass1};
    use pt_producer::source::extract_zip;

    // Compute the expected prefix-sum directly from Pass 1 so the assertion
    // tracks the fixture rather than hardcoding [0,3,6,9,12].
    let tmp_p1 = tempfile::tempdir().unwrap();
    extract_zip(&fixture_zip(), tmp_p1.path()).unwrap();
    let p1 = run_pass1(tmp_p1.path()).unwrap();
    let expected = compute_trip_starts(&p1);
    // Sanity: the tiny fixture has 4 trips of 3 rows each.
    assert_eq!(expected, vec![0, 3, 6, 9, 12], "fixture prefix-sum changed");

    let port = pick_free_port();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("p1.ptnb");
    let child = spawn_producer(&fixture_zip(), addr, Some(&dest));
    let deadline = Instant::now() + Duration::from_secs(30);
    assert!(
        wait_until_ready(addr, deadline),
        "producer never reached ready=200"
    );
    let (ok, _stdout, stderr) = shutdown_producer(child);
    assert!(ok, "producer exited non-zero\nstderr:\n{stderr}");

    let reader = Reader::from_bytes(std::fs::read(&dest).unwrap()).expect("decode PTB v1");
    let decoded = reader.trip_starts().expect("current trip starts");
    assert_eq!(decoded, expected, "TripStarts region bytes != prefix-sum");
}

#[test]
fn producer_overwrites_existing_ptnb_at_out_path() {
    let fixture = fixture_zip();
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("p1.ptnb");
    // Write a placeholder that should be replaced.
    std::fs::write(&dest, b"OLD").unwrap();
    let old_mtime = std::fs::metadata(&dest).unwrap().modified().unwrap();
    // Sleep briefly to ensure mtime granularity reflects the overwrite even
    // on filesystems with second-resolution mtime.
    std::thread::sleep(Duration::from_millis(1100));

    let port = pick_free_port();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let child = spawn_producer(&fixture, addr, Some(&dest));
    let deadline = Instant::now() + Duration::from_secs(30);
    let got_ready = wait_until_ready(addr, deadline);
    assert!(got_ready, "producer never reached ready=200");
    let (ok, _stdout, _stderr) = shutdown_producer(child);
    assert!(ok, "producer exited non-zero");

    let bytes = std::fs::read(&dest).unwrap();
    assert!(bytes.len() > 3, "overwritten file must be > 3 bytes");
    assert_eq!(&bytes[0..4], PTB_MAGIC, "must be a valid PTB now");
    let new_mtime = std::fs::metadata(&dest).unwrap().modified().unwrap();
    assert!(new_mtime > old_mtime, "mtime must advance on overwrite");
}

/// Full-pipeline proof that the producer stamps
/// the `0x13 TripTimes` `entryFlags` bit1 (`TRIP_TIMES_FLAG_I32_DELTAS`) whenever
/// the band widened to i32 deltas — and that a reader therefore decodes the wide
/// span at the CORRECT (4-byte) stride.
///
/// The committed `tiny-gtfs.zip` has trip T4 (10:00:00 → 25:30:00 → 25:35:00): a
/// span of ~15.5h that overflows the i16 ±32767 s (~9.1h) delta cap, forcing the
/// region-level i32 variant. The producer emits the current carry-less PTB v1
/// contract. We load the EMITTED bytes back with
/// `pt_core::Reader` and assert:
///   1. the `0x13` entry declares the i32-delta variant (the stamp landed),
///   2. the bundle is carry-less (no `0xF4/0xF5/0xF6/0xFA`),
///   3. T4's 25:30:00 stop decodes to EXACTLY 91800 s somewhere in the band.
///
/// (3) is the mutation-resistant check: had the stamp NOT landed while the body
/// holds i32 bytes, every reader would decode at the i16 (2-byte) stride and
/// 91800 would mis-decode — it would NOT appear at any band position.
///
#[test]
fn producer_v1_stamps_i32_entry_flags_and_long_span_roundtrips() {
    const LONG_DEP: i64 = 91_800; // 25:30:00 — T4's overnight stop; delta > i16::MAX

    let port = pick_free_port();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("producer-v1.ptb");
    // 20260501 matches the fixture calendar's min start_date; T4's service
    // (SA) is in-window for a deterministic emit.
    let child = spawn_current_producer(&fixture_zip(), addr, Some(&dest), 20260501);
    let deadline = Instant::now() + Duration::from_secs(30);
    assert!(
        wait_until_ready(addr, deadline),
        "producer never reached ready=200"
    );
    let (ok, _stdout, stderr) = shutdown_producer(child);
    assert!(ok, "producer exited non-zero\nstderr:\n{stderr}");
    assert!(dest.exists(), "v1 bundle missing at {}", dest.display());

    // The producer warns ONCE that the 0x13 region widened to i32 deltas.
    assert!(
        stderr.contains("trip_times_i32"),
        "missing i32-widening warning line:\n{stderr}"
    );

    let bytes = std::fs::read(&dest).unwrap();
    assert_eq!(&bytes[0..4], b"PTB\0", "valid PTB magic");
    assert_eq!(
        u16::from_le_bytes(bytes[4..6].try_into().unwrap()),
        1,
        "header version 1"
    );

    // (2) Carry-less: the flat carry regions are stripped in PTB v1.
    // The band regions (0x10/0x11/0x13/…) are appended AFTER the carry table, so
    // we scan the live emitted table (not the static `region_table_order`, which
    // lists only the 11 carry/structural slots and would mis-locate 0x13).
    let table = parse_region_table(&bytes);
    let ids: Vec<u16> = table.iter().map(|(id, _)| *id).collect();
    for carry in [0xF4u16, 0xF5, 0xF6, 0xFA] {
        assert!(
            !ids.contains(&carry),
            "v1 bundle must be carry-less (found {carry:#x})\nregions: {ids:?}"
        );
    }

    // (1) The 0x13 TripTimes entry MUST declare the i32-delta variant. entryFlags
    // is the u16 at the entry's +2 offset.
    let tt_entry_off = table
        .iter()
        .find(|(id, _)| *id == 0x13)
        .map(|(_, off)| *off)
        .expect("0x13 TripTimes region present in v1 band bundle");
    let entry_flags = u16::from_le_bytes(
        bytes[tt_entry_off + 2..tt_entry_off + 4]
            .try_into()
            .unwrap(),
    );
    assert_eq!(
        entry_flags, 0x0002,
        "0x13 entryFlags == TRIP_TIMES_FLAG_I32_DELTAS (bit1) for the overnight feed"
    );

    // (3) THE CORRECTNESS PROOF: load the emitted bytes with pt_core::Reader and
    // assert the long span decodes to EXACTLY 91800 s. The Reader reads the i32
    // stride iff entryFlags bit1 is set — so this round-trips ONLY because (1)
    // landed in the producer.
    let reader = pt_core::Reader::from_bytes(bytes).expect("pt_core::Reader over emitted v1 bytes");
    assert_eq!(
        reader.trip_times_is_i32_deltas(),
        Some(true),
        "Reader sees the i32-delta variant"
    );
    let patterns = reader.patterns().expect("band present ⇒ patterns()");
    let mut found_long = false;
    'outer: for p in 0..patterns.len() {
        let stop_count = reader.pattern_stops(p).map(|s| s.len()).unwrap_or(0);
        let trips = reader.pattern_trips(p).map(|t| t.len()).unwrap_or(0);
        for t in 0..trips {
            for pos in 0..stop_count {
                if reader.band_dep_secs(p, t, pos) == Some(LONG_DEP) {
                    found_long = true;
                    break 'outer;
                }
            }
        }
    }
    assert!(
        found_long,
        "T4's 25:30:00 stop must decode to 91800 s via the i32 stride — \
         absent ⇒ the producer mis-flagged the i32 region as i16 (silent corruption)"
    );
}

/// Parse a PTB header's 24 B tagged region table, returning `(regionId, entry
/// byte-offset)` pairs up to (excluding) the regionId-0 terminator (entries at
/// offset 32, 24 B each). The entry offset lets a caller read that entry's
/// `entryFlags` (u16 at +2). Local copy so the e2e suite need not depend on the
/// current-emitter unit-test parser.
fn parse_region_table(buf: &[u8]) -> Vec<(u16, usize)> {
    let mut out = Vec::new();
    let mut i = 0usize;
    loop {
        let e = 32 + i * 24;
        let region_id = u16::from_le_bytes(buf[e..e + 2].try_into().unwrap());
        if region_id == 0 {
            break;
        }
        out.push((region_id, e));
        i += 1;
    }
    out
}
