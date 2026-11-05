//! Wire-format tests for the packed address artifact (PTAS, schema version 1).
//!
//! The artifact is read straight out of an untrusted buffer — pt-serve maps a
//! file from the generation dir, the PWA hands over bytes it fetched — so every
//! header field is a bounds check waiting to be skipped. These tests corrupt
//! one field at a time and assert the loader refuses rather than slices.

use pt_geocode::artifact::{ArtifactError, HEADER_BYTES, MAGIC, ROW_RECORD_BYTES, SCHEMA_VERSION};
use pt_geocode::{AddrIndex, AddrKey, AddrRow, ArtifactMeta};
use std::sync::Arc;

fn rows() -> Vec<AddrRow> {
    vec![
        AddrRow {
            label: "Gedimino pr. 23".into(),
            lat: 54.6879651,
            lon: 25.2757668,
        },
        AddrRow {
            label: "Šeimyniškių g. 12".into(),
            lat: 54.6945572,
            lon: 25.2853740,
        },
    ]
}

fn keys() -> Vec<AddrKey> {
    vec![
        AddrKey {
            key: "gedimino prospektas 23".into(),
            row_id: 0,
        },
        AddrKey {
            key: "seimyniskiu gatve 12".into(),
            row_id: 1,
        },
    ]
}

fn meta() -> ArtifactMeta {
    ArtifactMeta {
        city_id: Some("vilnius".into()),
        source: Some("https://example.invalid/lithuania.osm.pbf".into()),
        generated_at: "2026-05-01T00:00:00Z".into(),
    }
}

fn packed() -> Vec<u8> {
    AddrIndex::pack(&rows(), &keys(), &meta()).expect("pack")
}

fn load(bytes: Vec<u8>) -> Result<AddrIndex, ArtifactError> {
    AddrIndex::from_bytes(Arc::from(bytes.into_boxed_slice()))
}

#[test]
fn header_is_well_formed() {
    let bytes = packed();
    assert_eq!(&bytes[0..4], &MAGIC);
    // Literal, not just the constant: the on-disk version byte is the contract,
    // and comparing the writer against itself would pin nothing.
    assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), 1, "version");
    assert_eq!(SCHEMA_VERSION, 1);
    assert_eq!(u16::from_le_bytes([bytes[6], bytes[7]]), 0, "flags");
    assert_eq!(
        u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]),
        2,
        "row_count",
    );
    assert!(bytes.len() > HEADER_BYTES);
}

#[test]
fn round_trip_preserves_labels_coordinates_and_meta() {
    let index = load(packed()).expect("load");

    assert_eq!(index.row_count(), 2);
    assert_eq!(index.meta(), &meta());

    let hits = index.prefix_search("gedimino", 10);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].label, "Gedimino pr. 23");
    // Exact, not approximate: OSM carries 7 decimals and the row table stores
    // degrees * 1e7, so the extractor's f64 survives the trip bit-for-bit.
    assert_eq!(hits[0].lat, 54.6879651);
    assert_eq!(hits[0].lon, 25.2757668);

    let utf8 = index.prefix_search("seimyniskiu", 10);
    assert_eq!(utf8.len(), 1);
    assert_eq!(
        utf8[0].label, "Šeimyniškių g. 12",
        "multi-byte labels must survive the labels blob",
    );
}

#[test]
fn negative_coordinates_survive() {
    // Southern/western hemispheres: lat_e7 is signed and must not be read back
    // through a u32 cast.
    let index = AddrIndex::build(
        &[AddrRow {
            label: "Test 1".into(),
            lat: -33.8688197,
            lon: -70.6692655,
        }],
        &[AddrKey {
            key: "test 1".into(),
            row_id: 0,
        }],
    )
    .expect("build");

    let hits = index.prefix_search("test", 5);
    assert_eq!(hits[0].lat, -33.8688197);
    assert_eq!(hits[0].lon, -70.6692655);
}

#[test]
fn the_json_intermediate_is_rejected_with_a_pointed_error() {
    // The most likely wrong input by far: someone stages the extractor's JSON
    // instead of running it through the packer. Its own `schemaVersion` field
    // has nothing to do with the packed artifact's.
    let err = load(br#"{"schemaVersion":1,"rows":[],"keys":[]}"#.to_vec()).unwrap_err();
    match err {
        ArtifactError::BadMagic { found } => assert_eq!(&found, b"{\"sc"),
        other => panic!("expected BadMagic, got {other:?}"),
    }
    assert!(
        err.to_string().contains("pack-address-search"),
        "the error must name the way out: {err}",
    );
}

#[test]
fn truncated_below_the_header_is_rejected() {
    // Correct magic, but the header is cut short — this is the case TooShort
    // exists for, and it must survive the magic-first ordering above.
    let bytes = packed();
    let err = load(bytes[..HEADER_BYTES - 1].to_vec()).unwrap_err();
    assert!(matches!(err, ArtifactError::TooShort { .. }), "{err:?}");
}

#[test]
fn a_file_shorter_than_the_magic_is_rejected() {
    assert!(matches!(
        load(b"PT".to_vec()).unwrap_err(),
        ArtifactError::TooShort { len: 2 },
    ));
}

#[test]
fn unsupported_version_is_rejected() {
    // Version 1 is the only version this reader accepts, so every other value
    // is refused outright — there is no second layout to fall back to. 2 gets
    // its own test below.
    for found in [0u16, 99, u16::MAX] {
        let mut bytes = packed();
        bytes[4..6].copy_from_slice(&found.to_le_bytes());
        assert_eq!(
            load(bytes).unwrap_err(),
            ArtifactError::UnsupportedVersion { found },
        );
    }
}

#[test]
fn version_two_has_no_compatibility_reader() {
    // Called out on its own because 2 is the one wrong value that could
    // plausibly be tried: a header that claims it must fail like any other
    // unknown version, not be read leniently.
    let mut bytes = packed();
    bytes[4..6].copy_from_slice(&2u16.to_le_bytes());
    let err = load(bytes).unwrap_err();
    assert_eq!(err, ArtifactError::UnsupportedVersion { found: 2 });
    assert!(
        err.to_string().contains("is not supported"),
        "the error must say so plainly: {err}",
    );
}

#[test]
fn reserved_flag_bits_are_rejected() {
    // A future version may use flags to signal an optional section. A reader
    // that ignored them would silently serve a partial corpus.
    let mut bytes = packed();
    bytes[6..8].copy_from_slice(&1u16.to_le_bytes());
    assert_eq!(
        load(bytes).unwrap_err(),
        ArtifactError::UnknownFlags { found: 1 },
    );
}

#[test]
fn section_running_past_the_file_is_rejected() {
    let mut bytes = packed();
    let huge = 1u64 << 40;
    bytes[24..32].copy_from_slice(&huge.to_le_bytes()); // fst_len
    let err = load(bytes).unwrap_err();
    assert!(
        matches!(
            err,
            ArtifactError::SectionOutOfBounds { section: "fst", .. }
        ),
        "{err:?}",
    );
}

#[test]
fn section_offset_that_overflows_is_rejected() {
    // off + len wrapping past u64::MAX would pass a naive `off + len <= total`.
    let mut bytes = packed();
    bytes[16..24].copy_from_slice(&u64::MAX.to_le_bytes()); // fst_off
    bytes[24..32].copy_from_slice(&8u64.to_le_bytes()); // fst_len
    let err = load(bytes).unwrap_err();
    assert!(
        matches!(
            err,
            ArtifactError::SectionOutOfBounds { section: "fst", .. }
        ),
        "{err:?}",
    );
}

#[test]
fn row_table_size_must_match_row_count() {
    let mut bytes = packed();
    bytes[8..12].copy_from_slice(&7u32.to_le_bytes()); // row_count, rows_len unchanged
    let err = load(bytes).unwrap_err();
    assert!(
        matches!(
            err,
            ArtifactError::RowTableSizeMismatch { row_count: 7, .. }
        ),
        "{err:?}",
    );
}

#[test]
fn label_range_escaping_the_labels_section_is_rejected() {
    let mut bytes = packed();
    let rows_off = u64::from_le_bytes(bytes[32..40].try_into().unwrap()) as usize;
    // Row 0's label_len -> absurd, so label_off + label_len leaves the section.
    bytes[rows_off + 4..rows_off + 8].copy_from_slice(&u32::MAX.to_le_bytes());
    let err = load(bytes).unwrap_err();
    assert!(
        matches!(err, ArtifactError::LabelOutOfBounds { row_id: 0 }),
        "{err:?}",
    );
}

#[test]
fn label_that_is_not_utf8_is_rejected() {
    let mut bytes = packed();
    let labels_off = u64::from_le_bytes(bytes[48..56].try_into().unwrap()) as usize;
    bytes[labels_off] = 0xff;
    let err = load(bytes).unwrap_err();
    assert!(
        matches!(err, ArtifactError::LabelNotUtf8 { row_id: 0 }),
        "{err:?}",
    );
}

#[test]
fn corrupt_fst_section_is_rejected() {
    let mut bytes = packed();
    let fst_off = u64::from_le_bytes(bytes[16..24].try_into().unwrap()) as usize;
    bytes[fst_off..fst_off + 8].copy_from_slice(&[0xde; 8]);
    let err = load(bytes).unwrap_err();
    assert!(matches!(err, ArtifactError::Fst(_)), "{err:?}");
}

#[test]
fn corrupt_meta_section_is_rejected() {
    let mut bytes = packed();
    let meta_off = u64::from_le_bytes(bytes[64..72].try_into().unwrap()) as usize;
    bytes[meta_off] = b'x';
    let err = load(bytes).unwrap_err();
    assert!(matches!(err, ArtifactError::Meta(_)), "{err:?}");
}

#[test]
fn sections_are_eight_byte_aligned() {
    // The row table is read with fixed-width integer loads; keeping every
    // section 8-aligned means a future zero-copy reader can cast instead of
    // byte-assembling.
    let bytes = packed();
    for (name, at) in [("fst", 16), ("rows", 32), ("labels", 48), ("meta", 64)] {
        let off = u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
        assert_eq!(off % 8, 0, "{name} section offset {off} is not 8-aligned");
    }
    assert_eq!(HEADER_BYTES % 8, 0);
    assert_eq!(ROW_RECORD_BYTES % 8, 0);
}

#[test]
fn packing_is_deterministic() {
    // Two packs of the same input must be byte-identical, or the artifact SHA
    // in the manifest churns on every publish and every client re-downloads.
    assert_eq!(packed(), packed());
}

#[test]
fn rows_sharing_a_lookup_key_all_survive_the_narrow_suffix() {
    // The suffix is what keeps `fst::Map` from collapsing two rows under one
    // key. Narrowing it must not start losing rows.
    let rows: Vec<AddrRow> = (0..12)
        .map(|i| AddrRow {
            label: format!("Gedimino pr. {i}"),
            lat: 54.0 + f64::from(i),
            lon: 25.0,
        })
        .collect();
    let keys: Vec<AddrKey> = (0..12)
        .map(|i| AddrKey {
            key: "gedimino prospektas".into(),
            row_id: i as usize,
        })
        .collect();

    let index = AddrIndex::build(&rows, &keys).expect("build");
    let hits = index.prefix_search("gedimino", 50);
    assert_eq!(
        hits.len(),
        12,
        "every row sharing the key must be reachable"
    );
    assert_eq!(
        hits.iter()
            .map(|h| h.row_id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        12,
    );
}
