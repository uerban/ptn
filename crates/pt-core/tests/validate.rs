//! Structural validator coverage — one test per `StructuralError` variant.
//!
//! Builds corrupt PTB bytes via `tests/util.rs` (the same builder the `corruption` integration
//! suite uses) and round-trips them through `pt_core::validate::structural::validate_structural`.

use pt_core::validate::errors::StructuralError;
use pt_core::validate::structural::{validate_header_quick, validate_ptnt, validate_structural};

mod util; // tests/util.rs

// ---------------------------------------------------------------------------
// 1. TruncatedBundle: buffer shorter than the 4 KiB PTB header.
// ---------------------------------------------------------------------------

#[test]
fn truncated_bundle_is_classified() {
    // A 100-byte buffer is well below the 4 KiB header minimum.
    let err = validate_structural(&[0u8; 100]).unwrap_err();
    match err {
        StructuralError::TruncatedBundle {
            expected_min,
            actual,
        } => {
            assert_eq!(actual, 100);
            assert!(
                expected_min >= 4096,
                "expected_min should be at least the header size"
            );
        }
        other => panic!("expected TruncatedBundle, got {other:?}"),
    }
    // The header-quick path produces the same class.
    let err2 = validate_header_quick(&[0u8; 100]).unwrap_err();
    assert!(matches!(err2, StructuralError::TruncatedBundle { .. }));
}

// ---------------------------------------------------------------------------
// 2. WrongMagic: first 4 bytes != "PTB\0".
// ---------------------------------------------------------------------------

#[test]
fn wrong_magic_is_classified() {
    let mut b = util::assemble_empty();
    b[0..4].copy_from_slice(b"PTNB"); // the v3-era magic, now rejected.
    assert!(matches!(
        validate_structural(&b),
        Err(StructuralError::WrongMagic)
    ));
    assert!(matches!(
        validate_header_quick(&b),
        Err(StructuralError::WrongMagic)
    ));
}

// ---------------------------------------------------------------------------
// 3. WrongVersion: header.version other than PTB_VERSION.
// ---------------------------------------------------------------------------

#[test]
fn wrong_version_is_classified() {
    let mut b = util::assemble_empty();
    b[4..6].copy_from_slice(&3u16.to_le_bytes());
    match validate_structural(&b) {
        Err(StructuralError::WrongVersion { found, supported }) => {
            assert_eq!(found, 3);
            // `supported` reports the one accepted version.
            assert_eq!(supported, pt_core::PTB_VERSION as u32);
        }
        other => panic!("expected WrongVersion, got {other:?}"),
    }
    // Header-quick path also classifies it.
    match validate_header_quick(&b) {
        Err(StructuralError::WrongVersion { found, supported }) => {
            assert_eq!(found, 3);
            // `supported` reports the one accepted version.
            assert_eq!(supported, pt_core::PTB_VERSION as u32);
        }
        other => panic!("expected WrongVersion from quick, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 4. RegionBoundsExceeded: a region offset past end of buffer.
// ---------------------------------------------------------------------------

#[test]
fn region_bounds_exceeded_is_classified() {
    let mut b = util::assemble_empty();
    let past = b.len() as u64 + 4096;
    util::set_region_offset(&mut b, util::STOPS_SOA, past);
    match validate_structural(&b) {
        Err(StructuralError::RegionBoundsExceeded { region_idx }) => {
            assert_eq!(region_idx, 11, "expected region_idx for stopsSoA");
        }
        other => panic!("expected RegionBoundsExceeded, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 5. CsrBoundsExceeded: srValues references a route index >= num_routes.
// ---------------------------------------------------------------------------

#[test]
fn csr_bounds_exceeded_is_classified() {
    let b = util::assemble_with_bad_csr();
    assert!(matches!(
        validate_structural(&b),
        Err(StructuralError::CsrBoundsExceeded)
    ));
}

// ---------------------------------------------------------------------------
// 6. PtntBoundsExceeded: PTFT magic missing.
// ---------------------------------------------------------------------------

#[test]
fn ptnt_bounds_exceeded_is_classified() {
    // Random bytes — fails PTFT magic check inside `Transfers::from_bytes`.
    let bytes = [0u8; 16];
    assert!(matches!(
        validate_ptnt(&bytes),
        Err(StructuralError::PtntBoundsExceeded)
    ));
    // Empty PTFT also fails (no magic).
    assert!(matches!(
        validate_ptnt(&[]),
        Err(StructuralError::PtntBoundsExceeded)
    ));
}

// ---------------------------------------------------------------------------
// 7. ZeroServicesInWindow: bundle parses but every per-service byte is zero.
// ---------------------------------------------------------------------------

#[test]
fn zero_services_in_window_is_classified() {
    // The `tiny.ptb` fixture has at least one active service; assemble a
    // minimal bundle whose one service maps to an all-zero pool bitfield (no
    // day active).
    let mut service_pool = util::u32s(&[1]);
    service_pool.extend_from_slice(&[0u8; 12]);
    let bytes = util::assemble_bundle(&util::Bundle {
        num_stops: 1,
        num_services: 1,
        stops_soa: util::stops_soa(&[1], &[2]),
        service_pool,
        service_to_bitfield: util::u32s(&[0]),
        csr: util::u32s(&[0, 0, 0]),
        string_pool: util::string_pool(&["", "S1", "Stop One"]),
        ..util::Bundle::empty()
    });
    assert!(matches!(
        validate_structural(&bytes),
        Err(StructuralError::ZeroServicesInWindow)
    ));
}

// ---------------------------------------------------------------------------
// Negative / happy path: tiny.ptb fixture validates cleanly.
// ---------------------------------------------------------------------------

#[test]
fn tiny_ptb_fixture_validates_clean() {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/ptb/__fixtures__/tiny.ptb"
    ))
    .expect("read tiny.ptb");
    validate_structural(&bytes).expect("tiny.ptb must pass structural validation");
    validate_header_quick(&bytes).expect("tiny.ptb header must pass quick check");
}

// ---------------------------------------------------------------------------
// 9. Every other version is rejected — the pre-v1 layouts (4..=9) and the
//    next version up alike.
// ---------------------------------------------------------------------------

#[test]
fn legacy_and_future_versions_are_rejected() {
    for v in [4u16, 9] {
        let mut b = util::assemble_empty();
        b[4..6].copy_from_slice(&v.to_le_bytes());
        assert!(matches!(
            validate_structural(&b),
            Err(StructuralError::WrongVersion { found, .. }) if found == v as u32
        ));
    }
    let mut b = util::assemble_empty();
    b[4..6].copy_from_slice(&10u16.to_le_bytes());
    match validate_structural(&b) {
        Err(StructuralError::WrongVersion {
            found: 10,
            supported,
        }) => {
            assert_eq!(supported, pt_core::PTB_VERSION as u32);
        }
        other => panic!("expected WrongVersion{{found:10, ..}}, got {other:?}"),
    }
    // validate_header_quick must also reject it.
    match validate_header_quick(&b) {
        Err(StructuralError::WrongVersion {
            found: 10,
            supported,
        }) => {
            assert_eq!(supported, pt_core::PTB_VERSION as u32);
        }
        other => panic!("header_quick: expected WrongVersion{{found:10, ..}}, got {other:?}"),
    }
}
