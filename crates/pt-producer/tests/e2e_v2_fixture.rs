//! Regenerates the frontend E2E mock bundle as PTB v2.
//!
//! `packages/frontend/e2e/fixtures/tiny.ptb` is the v1 producer output for
//! `tests/fixtures/tiny-gtfs.zip` and stays frozen for the v1 goldens. The
//! browser now only plans on v2, so the mock serves `tiny-v2.ptb`: the v2
//! staging of the same feed at the same pinned anchor and zone.
//! Regenerate with `PTN_REGEN_E2E_V2=1 cargo test -p pt-producer --test e2e_v2_fixture`.

use std::path::PathBuf;

use pt_producer::cli::DeriveInseat;
use pt_producer::download::record_for_local;

const ANCHOR: u32 = 20260505;
const ZONE: &str = "UTC";

#[test]
fn regenerate_e2e_v2_fixture() {
    if std::env::var_os("PTN_REGEN_E2E_V2").is_none() {
        return;
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let zip = manifest.join("tests/fixtures/tiny-gtfs.zip");
    let tmp = tempfile::tempdir().unwrap();
    let outcome = pt_producer::ptb_v2::stage(
        vec![record_for_local(&zip).unwrap()],
        &tmp.path().join("extract"),
        &tmp.path().join("out"),
        ANCHOR,
        ZONE,
        DeriveInseat::Auto,
    )
    .expect("stage tiny-gtfs as v2");
    let dest = manifest.join("../../packages/frontend/e2e/fixtures/tiny-v2.ptb");
    std::fs::copy(tmp.path().join("out/bundle.ptb"), &dest).unwrap();
    eprintln!(
        "wrote {} ({} bytes)",
        dest.display(),
        outcome.bundle_size_bytes
    );
}
