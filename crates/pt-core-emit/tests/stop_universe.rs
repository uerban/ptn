use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

#[test]
fn exports_sorted_compiled_ids_exact_e7_and_observed_ptb_hash() {
    let path = fixture();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_pt-core-emit"))
            .arg("stop-universe")
            .arg(&path)
            .output()
            .unwrap()
    };
    let first = run();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert_eq!(first.stdout, run().stdout);
    let value: serde_json::Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(value["format"], "ptn-search-stop-universe");
    assert_eq!(
        value["ptbSha256"],
        format!("{:x}", Sha256::digest(std::fs::read(path).unwrap()))
    );
    let stops = value["stops"].as_array().unwrap();
    assert_eq!(
        stops
            .iter()
            .map(|s| s["stopId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["S1", "S2", "S3"]
    );
    for stop in stops {
        assert!(stop["latE7"].as_i64().is_some());
        assert!(stop["lonE7"].as_i64().is_some());
    }
}

#[test]
fn bad_input_and_extra_arguments_produce_no_population() {
    for args in [
        vec!["stop-universe"],
        vec!["stop-universe", "missing.ptb"],
        vec!["stop-universe", "missing.ptb", "extra"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_pt-core-emit"))
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn corrupt_ptb_does_not_become_an_empty_valid_universe() {
    let path = std::env::temp_dir().join(format!(
        "stop-universe-{}-{}.ptb",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    file.write_all(b"not a PTB snapshot").unwrap();
    drop(file);
    let output = Command::new(env!("CARGO_BIN_EXE_pt-core-emit"))
        .arg("stop-universe")
        .arg(&path)
        .output()
        .unwrap();
    std::fs::remove_file(path).unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

#[test]
fn review_context_adds_compiled_names_without_changing_sampling_export() {
    let run = |command: &str| {
        Command::new(env!("CARGO_BIN_EXE_pt-core-emit"))
            .arg(command)
            .arg(fixture())
            .output()
            .unwrap()
    };
    let output = run("review-stop-context");
    assert!(output.status.success());
    assert_eq!(output.stdout, run("review-stop-context").stdout);
    let context: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let universe: serde_json::Value = serde_json::from_slice(&run("stop-universe").stdout).unwrap();
    assert_eq!(context["format"], "ptn-search-review-stop-context");
    assert_eq!(context["ptbSha256"], universe["ptbSha256"]);
    let reader = pt_core::Reader::from_bytes(std::fs::read(fixture()).unwrap()).unwrap();
    for stop in context["stops"].as_array().unwrap() {
        let index = (0..reader.num_stops())
            .find(|&i| reader.stop_id(i).unwrap() == stop["stopId"].as_str().unwrap())
            .unwrap();
        assert_eq!(stop["name"], reader.stop_name(index).unwrap());
    }
    for stop in universe["stops"].as_array().unwrap() {
        assert!(stop.get("name").is_none());
    }
}
