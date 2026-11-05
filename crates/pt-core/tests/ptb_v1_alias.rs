//! Regression for the committed `pattern-band-tiny.ptb` fixture as the
//! current PTB v1 source of truth: this fixture is the shipped bytes that
//! prove it.
//!
//! Reads the committed fixture directly (no in-memory version mutation —
//! the fixture itself is already stored as v1) and proves it passes
//! quick/full validation, decodes, exposes every current-layout capability
//! (tagged/SoA regions, the service-bitfield pool, the pattern band, and the
//! carry-less layout), and indexes under all three `PatternMode`s.

use pt_core::validate::structural::{validate_header_quick, validate_structural};
use pt_core::{region_ids, Index, PatternMode, Reader};

fn read_fixture() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/frontend/tests/services/__fixtures__/pattern-band-tiny.ptb"
    ))
    .expect("read pattern-band-tiny.ptb")
}

#[test]
fn committed_v1_fixture_decodes_validates_and_indexes() {
    let bytes = read_fixture();
    assert_eq!(
        u16::from_le_bytes([bytes[4], bytes[5]]),
        1,
        "committed fixture is the current PTB v1 layout"
    );

    validate_header_quick(&bytes).expect("committed v1 fixture must pass the quick header check");
    validate_structural(&bytes).expect("committed v1 fixture must pass full structural validation");

    let r = Reader::from_bytes(bytes).expect("committed v1 fixture must decode");
    let h = r.header();
    assert_eq!(h.version, 1);

    // Current-layout capabilities: tagged/SoA regions, the service-bitfield
    // pool, the pattern band, and the carry-less layout.
    assert!(
        h.region_by_id(region_ids::STOPS_SOA).is_some(),
        "v1 fixture must carry the tagged StopsSoA region"
    );
    assert!(
        h.region_by_id(region_ids::ROUTES_SOA).is_some(),
        "v1 fixture must carry the tagged RoutesSoA region"
    );
    assert!(
        r.service_bitfield_pool_count() > 0,
        "v1 fixture must carry the service-bitfield pool"
    );
    assert!(
        r.pattern_band_present(),
        "v1 fixture must expose the pattern band"
    );
    assert!(r.is_carry_less_band(), "v1 fixture must read as carry-less");

    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        Index::build(&r, mode).unwrap_or_else(|e| {
            panic!("Index::build({mode:?}) must succeed on the committed v1 fixture: {e:?}")
        });
    }
}
