//! Current PTB v1 producer integration for the deduplicated service-bitfield
//! pool (`0x15` / `0x16`), including the zero-service boundary.

use pt_core::Reader;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Deterministic anchor inside the tiny fixture's service window.
const ANCHOR_DATE: &str = "20260518";

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn tiny_zip() -> PathBuf {
    manifest_dir().join("tests/fixtures/tiny-gtfs.zip")
}

fn pick_free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Emit the current PTB over the tiny fixture, returning its bytes.
fn emit_current() -> Vec<u8> {
    emit_zip_current(tiny_zip())
}

/// Emit the current PTB over an arbitrary `zip`, returning its bytes.
fn emit_zip_current(zip: PathBuf) -> Vec<u8> {
    let bin = env!("CARGO_BIN_EXE_pt-producer");
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("emit-v1.ptb");
    let port = pick_free_port();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();

    let mut child = Command::new(bin)
        .arg("--gtfs-path")
        .arg(zip)
        .arg("--out")
        .arg(&out)
        .arg("--anchor-date")
        .arg(ANCHOR_DATE)
        .arg("--listen-addr")
        .arg(addr.to_string())
        .arg("--idle-after-ingestion")
        .arg("0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn producer");

    // `--idle-after-ingestion 0` makes the producer write the `--out` PTB then exit
    // on its own; the HTTP readiness wait is best-effort (used only to bound the
    // poll) — we primarily wait for the process to exit and read the artifact.
    let exit_deadline = Instant::now() + Duration::from_secs(45);
    let _ = addr; // listen-addr is supplied but we don't require a ready HTTP hit
    loop {
        match child.try_wait().expect("try_wait") {
            Some(s) => {
                let collected = child.wait_with_output().expect("wait_with_output");
                let stderr = String::from_utf8_lossy(&collected.stderr);
                assert!(s.success(), "producer exited non-zero\nstderr:\n{stderr}");
                break;
            }
            None if Instant::now() >= exit_deadline => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("producer did not exit within 15s");
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }

    std::fs::read(&out).unwrap_or_else(|e| panic!("read emitted PTB v1: {e}"))
}

/// Parse the tagged region table out of a PTB header prefix, returning
/// `(region_id, offset, length)` triples up to the `regionId == 0` terminator.
fn parse_region_table(buf: &[u8]) -> Vec<(u16, u64, u64)> {
    let mut out = Vec::new();
    let mut i = 0usize;
    loop {
        let e = 32 + i * 24;
        let region_id = u16::from_le_bytes(buf[e..e + 2].try_into().unwrap());
        if region_id == 0 {
            break;
        }
        let off = u64::from_le_bytes(buf[e + 8..e + 16].try_into().unwrap());
        let len = u64::from_le_bytes(buf[e + 16..e + 24].try_into().unwrap());
        out.push((region_id, off, len));
        i += 1;
    }
    out
}

/// Collect every service's full-window activity bitfield through the same
/// reader path used by pt-serve and RAPTOR.
fn collect_activity<B: AsRef<[u8]> + Send + Sync + 'static>(reader: &Reader<B>) -> Vec<Vec<bool>> {
    let n = reader.num_services();
    let window = reader.window_days() as usize;
    (0..n)
        .map(|s| {
            let mask = reader.service_bitmask(s);
            (0..window)
                .map(|d| pt_core::reader::service_active_bit(mask, d as u32))
                .collect()
        })
        .collect()
}

/// The current bundle carries the pool pair with exact lengths and no obsolete
/// flat service-bitmask region, then resolves every service through Reader.
#[test]
fn current_pool_emit_has_exact_shape_and_decodes() {
    let bytes = emit_current();
    assert_eq!(
        u16::from_le_bytes(bytes[4..6].try_into().unwrap()),
        pt_core::PTB_VERSION_V1
    );

    let table = parse_region_table(&bytes);
    let ids: Vec<u16> = table.iter().map(|(id, _, _)| *id).collect();
    assert!(!ids.contains(&0xF3), "PTB v1 must not carry flat bitmasks");
    assert!(ids.contains(&0x15), "PTB v1 carries ServiceBitfieldPool");
    assert!(ids.contains(&0x16), "PTB v1 carries ServiceToBitfield");

    // 0x15 count prefix (first 4 bytes of the pool body) + the exact lengths;
    // captured BEFORE the bytes move into the Reader below.
    let p15 = table.iter().find(|(id, _, _)| *id == 0x15).unwrap();
    let (o15, l15) = (p15.1 as usize, p15.2 as usize);
    let count = u32::from_le_bytes(bytes[o15..o15 + 4].try_into().unwrap()) as usize;
    let p16 = table.iter().find(|(id, _, _)| *id == 0x16).unwrap();
    let (o16, l16) = (p16.1 as usize, p16.2 as usize);

    let reader = Reader::from_bytes(bytes).expect("pt_core::Reader decodes PTB v1");
    assert!(reader.num_services() > 0, "fixture has services");

    let n_services = reader.num_services() as usize;
    let s = reader.bytes_per_service();
    assert_eq!(l15, 4 + count * s, "0x15 length == 4 + count*S");
    assert_eq!(l16, n_services * 4, "0x16 length == numServices*4");
    assert_eq!(o16 % 4, 0, "0x16 is 4-aligned (I4)");
    // Dedup actually deduped (or at most identity): count <= numServices.
    assert!(
        count <= n_services,
        "distinct count cannot exceed numServices"
    );

    let activity = collect_activity(&reader);
    assert_eq!(activity.len(), n_services);
    assert!(activity
        .iter()
        .all(|days| days.len() == reader.window_days() as usize));
}

/// Sanity: the committed tiny fixture path exists (a missing fixture would
/// otherwise surface as an opaque producer failure).
#[test]
fn tiny_fixture_present() {
    assert!(
        Path::new(&tiny_zip()).exists(),
        "tiny-gtfs.zip fixture must exist at {}",
        tiny_zip().display()
    );
}

/// Write a degenerate ZERO-SERVICE GTFS feed to `dir` (no `calendar.txt` /
/// `calendar_dates.txt`, and a header-only `trips.txt`/`stop_times.txt`) — so
/// `num_services == 0` after pass 1. Returns the zip path.
fn write_zero_service_zip(dir: &Path) -> PathBuf {
    use std::io::Write;
    use zip::write::FileOptions;
    let path = dir.join("zero-service.zip");
    let f = std::fs::File::create(&path).unwrap();
    let mut zw = zip::ZipWriter::new(f);
    let opts: FileOptions<'_, '_, ()> = FileOptions::default();
    let mut add = |fname: &str, body: &str| {
        zw.start_file(fname, opts).unwrap();
        zw.write_all(body.as_bytes()).unwrap();
    };
    add(
        "agency.txt",
        "agency_id,agency_name,agency_url,agency_timezone\nA,A,http://a,Europe/Vilnius\n",
    );
    add(
        "stops.txt",
        "stop_id,stop_name,stop_lat,stop_lon\ns0,Zero,54.69,25.28\n",
    );
    add(
        "routes.txt",
        "route_id,agency_id,route_short_name,route_type\nR1,A,1,3\n",
    );
    // Header-only: no trips reference any service_id, and there is no
    // calendar.txt / calendar_dates.txt → the services interner stays empty.
    add("trips.txt", "route_id,service_id,trip_id\n");
    add(
        "stop_times.txt",
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n",
    );
    zw.finish().unwrap();
    path
}

/// A zero-service feed must still produce a well-formed PTB v1 pool — `0x15`
/// carries just its count prefix (`count == 0`, length 4), the `0x16`
/// per-service index is empty (length 0), the header stamps v1, and the
/// bytes re-decode through `pt_core::Reader` (`service_bitfield_pool_count() ==
/// 0`, `num_services() == 0`). Guards against the dedup/emit path panicking
/// or mis-sizing the regions on the `numServices == 0` boundary.
#[test]
fn current_emit_handles_zero_service_feed() {
    let tmp = tempfile::tempdir().unwrap();
    let zip = write_zero_service_zip(tmp.path());
    let bytes = emit_zip_current(zip);

    // Current PTB v1 header.
    assert_eq!(
        u16::from_le_bytes(bytes[4..6].try_into().unwrap()),
        pt_core::PTB_VERSION_V1,
        "zero-service emit stamps PTB v1"
    );

    // Region table: 0x15 length 4 (count prefix only), 0x16 length 0, no 0xF3.
    let table = parse_region_table(&bytes);
    let ids: Vec<u16> = table.iter().map(|(id, _, _)| *id).collect();
    assert!(!ids.contains(&0xF3), "PTB v1 must not carry flat bitmasks");
    let p15 = table
        .iter()
        .find(|(id, _, _)| *id == 0x15)
        .expect("PTB v1 carries ServiceBitfieldPool even when empty");
    assert_eq!(
        p15.2, 4,
        "0x15 length == 4 (count prefix only, no bitfields)"
    );
    let o15 = p15.1 as usize;
    let count = u32::from_le_bytes(bytes[o15..o15 + 4].try_into().unwrap());
    assert_eq!(count, 0, "0x15 count prefix == 0 (empty pool)");
    let p16 = table
        .iter()
        .find(|(id, _, _)| *id == 0x16)
        .expect("PTB v1 carries ServiceToBitfield even when empty");
    assert_eq!(p16.2, 0, "0x16 length == 0 (no per-service indices)");

    // Decode through the same reader pt-serve uses: a valid v1 bundle with no
    // services and an empty pool.
    let reader = Reader::from_bytes(bytes).expect("pt_core::Reader decodes the empty v1 bundle");
    assert_eq!(reader.header().version, pt_core::PTB_VERSION_V1);
    assert_eq!(
        reader.num_services(),
        0,
        "zero-service feed → numServices 0"
    );
    assert_eq!(
        reader.service_bitfield_pool_count(),
        0,
        "empty pool decodes to a zero count"
    );
}
