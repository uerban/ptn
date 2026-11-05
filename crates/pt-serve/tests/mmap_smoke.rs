#![cfg(target_os = "linux")]
use std::path::PathBuf;

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

fn vmrss_kb() -> u64 {
    let s = std::fs::read_to_string("/proc/self/status").unwrap();
    s.lines()
        .find_map(|l| {
            l.strip_prefix("VmRSS:")
                .and_then(|r| r.split_whitespace().next())
                .and_then(|n| n.parse().ok())
        })
        .unwrap()
}

#[test]
fn mmap_resident_tracks_touched_pages_not_file_size() {
    // Use a fixture large enough that "whole file resident" vs "touched pages only" is
    // distinguishable. tiny.ptb is too small (a few pages) to tell them apart, so this test
    // is meaningful only against a multi-MB bundle — point it at the pinned snapshot when
    // PT_SERVE_SMOKE_PTB is set (the LXC job sets it); otherwise fall back to tiny.ptb and
    // only assert the parser works (documented below).
    let path = std::env::var_os("PT_SERVE_SMOKE_PTB")
        .map(PathBuf::from)
        .unwrap_or_else(tiny_ptb_path);
    let file_len = std::fs::metadata(&path).unwrap().len();

    let before = vmrss_kb();
    let mbytes = pt_serve::mmap::open_mmap(&path).unwrap();
    let reader = pt_core::Reader::from_bytes(mbytes).unwrap();
    let _index = pt_core::Index::build(&reader, pt_core::PatternMode::Off).unwrap();
    let _ = reader.num_stops();
    let after = vmrss_kb();
    let delta_bytes = after.saturating_sub(before) * 1024;
    eprintln!("file_len={file_len} vmrss_delta_bytes={delta_bytes}");

    // (1) The instrument must work on this libc/target.
    let rollup = std::fs::read_to_string("/proc/self/smaps_rollup").unwrap();
    let pss = pt_serve::ops::metrics::parse_smaps_rollup_pss(&rollup)
        .expect("smaps_rollup Pss must be parseable on this libc/target");
    assert!(pss > 0);

    // (2) Residency behaviour — only assert the scaled claim on a large enough bundle. tiny.ptb is
    // a few pages, so "whole file resident" vs "touched pages only" is indistinguishable on it; the
    // assertion below is meaningful ONLY against a multi-MB bundle (wire PT_SERVE_SMOKE_PTB to the
    // pinned snapshot).
    if file_len > 8 * 1024 * 1024 {
        assert!(
            delta_bytes > 0,
            "touching the reader regions must make some pages resident"
        );
        // The whole file must NOT be resident — generous 60% ceiling keeps it non-flaky on CI.
        assert!(
            delta_bytes < (file_len as f64 * 0.60) as u64,
            "resident delta {delta_bytes} should be well below file_len {file_len} (touched pages, not whole file)"
        );
    } else {
        eprintln!(
            "SKIP residency assertion: file_len={file_len} <= 8 MiB (PT_SERVE_SMOKE_PTB unset \
             or pointed at a small fixture). The smaps_rollup instrument was still validated \
             above; the large-bundle residency property was NOT exercised on this run."
        );
    }
}
