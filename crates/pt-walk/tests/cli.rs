use std::path::{Path, PathBuf};
use std::process::Command;

use pt_walk::format::{decode, WayClass};

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny.geojsonseq")
}

fn run(out: &Path) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_pt-walk-build"))
        .args([
            "--input",
            fixture().to_str().unwrap(),
            "--city",
            "vilnius",
            "--generated-at",
            "2026-10-26",
        ])
        .args(["--out", out.to_str().unwrap()])
        .output()
        .expect("spawn pt-walk-build");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

/// Temp output path that is removed (with its `.tmp` sibling) on drop, so a
/// failing assertion does not leak files.
struct TmpFile(PathBuf);

impl TmpFile {
    fn new(name: &str) -> Self {
        Self(std::env::temp_dir().join(format!("pt-walk-cli-{}-{name}", std::process::id())))
    }
}

impl std::ops::Deref for TmpFile {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for TmpFile {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TmpFile {
    fn drop(&mut self) {
        std::fs::remove_file(&self.0).ok();
        std::fs::remove_file(format!("{}.tmp", self.0.display())).ok();
    }
}

#[test]
fn builds_the_fixture() {
    let out = TmpFile::new("a.ptwg");
    let stats: serde_json::Value = serde_json::from_str(run(&out).trim()).unwrap();
    assert_eq!(stats["city"], "vilnius");
    assert_eq!(stats["nodes"], 7);
    assert_eq!(stats["edges"], 6);
    assert_eq!(stats["names"], 2);
    // 1-3-6 is one Path chain; 2 is a junction because its attr changes.
    assert_eq!(stats["junctions"], 6);
    assert_eq!(stats["chains"], 5);

    let g = decode(&std::fs::read(&out).unwrap()).unwrap();
    assert_eq!(g.meta().city_id, "vilnius");
    assert_eq!(g.meta().generated_at, "2026-10-26");
    assert_eq!(g.meta().source, "openstreetmap");
    assert_eq!(g.name_count(), 2);
    assert_eq!((g.name(0), g.name(1)), ("", "Gedimino pr."));

    // Builder node order: the fixture's points as (lon, lat).
    let node = [
        (25.28, 54.68),
        (25.281, 54.68),
        (25.282, 54.68),
        (25.281, 54.681),
        (25.281, 54.679),
        (25.282, 54.6805),
        (25.28, 54.681),
    ]
    .map(|(lon, lat): (f64, f64)| ((lat * 1e7).round() as i32, (lon * 1e7).round() as i32));
    let attr = |u: usize, v: usize| {
        let (pu, pv) = (node[u], node[v]);
        (0..g.chain_count() as u32)
            .flat_map(|c| (0..g.chain_segments(c)).map(move |k| (c, k)))
            .find_map(|(c, k)| {
                let (p, q) = (g.chain_point_e7(c, k), g.chain_point_e7(c, k + 1));
                ((p, q) == (pu, pv) || (p, q) == (pv, pu))
                    .then(|| (g.chain_name_id(c), g.chain_class(c)))
            })
            .expect("edge")
    };
    assert_eq!(attr(0, 1), (1, WayClass::Street));
    assert_eq!(attr(1, 2), (1, WayClass::Street));
    assert_eq!(attr(1, 3), (0, WayClass::Path));
    assert_eq!(attr(1, 4), (0, WayClass::Steps));
    assert_eq!(attr(2, 5), (0, WayClass::Crossing));
    assert_eq!(attr(3, 6), (0, WayClass::Path));
}

/// The PTWG v2 bytes for the fixture: the encoder's output must not change
/// without a deliberate format change.
const FIXTURE_PTWG_HEX: &str = "505457470200000006000000050000000100000002000000680000000000000023000000000000008b000000000000001e00000000000000a9000000000000000100000000000000aa000000000000000e00000000000000b80000000000000021000000000000008086bc890480b08bf10100a09c0100a09c019f9c019f9c01b0ea01a09c01904ebfb802010101000003010100000100030002000101a09c0100010200020000000000000c476564696d696e6f2070722e0776696c6e6975730a323032362d31302d32360d6f70656e7374726565746d6170";

#[test]
fn fixture_bytes_are_pinned() {
    let out = TmpFile::new("pin.ptwg");
    run(&out);
    let hex: String = std::fs::read(&out)
        .unwrap()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(hex, FIXTURE_PTWG_HEX);
}

#[test]
fn output_is_byte_reproducible() {
    let (a, b) = (TmpFile::new("r1.ptwg"), TmpFile::new("r2.ptwg"));
    run(&a);
    run(&b);
    let (ba, bb) = (std::fs::read(&a).unwrap(), std::fs::read(&b).unwrap());
    assert_eq!(ba, bb);
}

#[test]
fn rejects_bad_arguments() {
    let status = Command::new(env!("CARGO_BIN_EXE_pt-walk-build"))
        .args([
            "--input",
            fixture().to_str().unwrap(),
            "--city",
            "Vilnius!",
            "--generated-at",
            "x",
            "--out",
            "/dev/null",
        ])
        .output()
        .unwrap();
    assert!(!status.status.success());
    assert!(String::from_utf8_lossy(&status.stderr).contains("invalid city id"));

    let status = Command::new(env!("CARGO_BIN_EXE_pt-walk-build"))
        .output()
        .unwrap();
    assert!(!status.status.success());
    assert!(String::from_utf8_lossy(&status.stderr).contains("usage"));
}

fn stderr_of(args: &[&str]) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_pt-walk-build"))
        .args(args)
        .output()
        .unwrap();
    assert!(!output.status.success());
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn rejects_flag_as_value() {
    let err = stderr_of(&["--out", "--source", "x"]);
    assert!(err.contains("--out needs a value"), "stderr: {err}");
}

#[test]
fn rejects_duplicate_flags() {
    let err = stderr_of(&["--city", "a", "--city", "b"]);
    assert!(err.contains("duplicate flag --city"), "stderr: {err}");
}

#[test]
fn help_prints_usage() {
    assert!(stderr_of(&["--help"]).contains("usage"));
}

#[test]
fn leaves_no_tmp_file_behind() {
    let out = TmpFile::new("t.ptwg");
    run(&out);
    assert!(out.exists());
    assert!(!Path::new(&format!("{}.tmp", out.display())).exists());
}

#[test]
fn refuses_output_the_router_cannot_load() {
    // Two short footways at opposite corners of the world: valid PTWG, but
    // the segment grid over it is refused, so the build must fail.
    let input = TmpFile::new("far.geojsonseq");
    let way = |lon: f64, lat: f64| {
        format!(
            "{{\"type\":\"Feature\",\"geometry\":{{\"type\":\"LineString\",\"coordinates\":[[{lon},{lat}],[{},{lat}]]}},\"properties\":{{\"highway\":\"footway\"}}}}\n",
            lon + 0.001
        )
    };
    std::fs::write(&input, way(-170.0, -80.0) + &way(170.0, 80.0)).unwrap();
    let out = TmpFile::new("far.ptwg");
    let err = stderr_of(&[
        "--input",
        input.to_str().unwrap(),
        "--city",
        "far",
        "--generated-at",
        "2026-10-26",
        "--out",
        out.to_str().unwrap(),
    ]);
    assert!(err.contains("TooLarge(\"grid\")"), "stderr: {err}");
    assert!(!out.exists());
}

#[test]
fn refuses_more_points_than_the_artifact_cap() {
    // One footway with one point more than the cap, 1e-6° (~0.1 m) apart.
    let input = TmpFile::new("cap.geojsonseq");
    let n = pt_walk::MAX_ARTIFACT_POINTS + 1;
    let mut line = String::with_capacity(n * 24 + 128);
    line.push_str("{\"type\":\"Feature\",\"geometry\":{\"type\":\"LineString\",\"coordinates\":[");
    for i in 0..n {
        if i > 0 {
            line.push(',');
        }
        line.push_str(&format!("[{:.7},54.68]", 25.0 + i as f64 * 1e-6));
    }
    line.push_str("]},\"properties\":{\"highway\":\"footway\"}}\n");
    std::fs::write(&input, line).unwrap();
    let out = TmpFile::new("cap.ptwg");
    let err = stderr_of(&[
        "--input",
        input.to_str().unwrap(),
        "--city",
        "cap",
        "--generated-at",
        "2026-10-27",
        "--out",
        out.to_str().unwrap(),
    ]);
    assert!(
        err.contains("1000001 points exceed the per-artifact cap of 1000000"),
        "stderr: {err}"
    );
    assert!(!out.exists());
    assert!(!Path::new(&format!("{}.tmp", out.display())).exists());
}
