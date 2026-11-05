//! Frozen-registry parse-test: the region-id consts in
//! `pt_core::region_ids` MUST agree with the FROZEN registry doc
//! (`docs/ptb-region-ids.md` §4). The doc is the single source of truth; if a
//! const disagrees, the const is wrong.
//!
//! This checks the id->name mapping for the consts pt-core actually defines (`0x40`/`0x41`/`0x44`
//! only).

use pt_core::region_ids::{
    region_name_by_id, BLOCK_DERIVATION_COMMITMENT, COMPATIBILITY_ARTIFACT_COMMITMENT, FREQUENCIES,
    PATTERNS, PATTERNS_AT_STOP, PATTERN_SEMANTICS, PATTERN_STOPS, PATTERN_TRIPS, ROUTES_SOA,
    SERVICE_BITFIELD_POOL, SERVICE_DAY_ORIGINS, SERVICE_TO_BITFIELD, STOPS_SOA, STOP_INDEX,
    TRIP_META, TRIP_TIMES,
};

// The registry lives at the WORKSPACE ROOT. From `crates/pt-core/tests/` that
// is three levels up. (Verified to resolve at author time.)
const REGISTRY_DOC: &str = include_str!("../../../docs/ptb-region-ids.md");

/// One parsed table row: the `0x..` id and its (already first-letter-folded)
/// lowerCamel Region name, the Align column (parsed as `u32`, or `None` for the
/// `—` placeholder), plus the raw row text for tripwire matching.
struct Row {
    id: u16,
    folded_name: String,
    align: Option<u32>,
    raw: String,
}

/// Fold the first ASCII letter of `name` to lowercase (`StopsSoA` -> `stopsSoA`).
fn fold_first_lower(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => {
            let mut out = String::new();
            out.extend(first.to_lowercase());
            out.push_str(chars.as_str());
            out
        }
        None => String::new(),
    }
}

/// Parse the region-ID table by hand (no regex dep): keep only Markdown table
/// rows whose first cell is a backticked `0x..` hex id, take the second cell as
/// the Region name, strip backticks/whitespace, and fold the first letter.
fn parse_registry_rows(doc: &str) -> Vec<Row> {
    let mut rows = Vec::new();
    for line in doc.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('|') {
            continue;
        }
        // Split into cells; a leading `|` yields an empty first element.
        let cells: Vec<&str> = trimmed.split('|').collect();
        // Need at least: leading-empty | id | name | owner | tier | align ...
        if cells.len() < 6 {
            continue;
        }
        let id_cell = cells[1].trim().trim_matches('`').trim();
        let name_cell = cells[2].trim().trim_matches('`').trim();
        let align_cell = cells[5].trim().trim_matches('`').trim();
        let Some(hex) = id_cell.strip_prefix("0x") else {
            continue;
        };
        let Ok(id) = u16::from_str_radix(hex, 16) else {
            continue;
        };
        if name_cell.is_empty() {
            continue;
        }
        rows.push(Row {
            id,
            folded_name: fold_first_lower(name_cell),
            align: align_cell.parse::<u32>().ok(),
            raw: trimmed.to_string(),
        });
    }
    rows
}

/// For each const pt-core defines, the doc must carry a row whose folded name
/// equals `region_name_by_id(const)`.
#[test]
fn consts_agree_with_frozen_doc() {
    let rows = parse_registry_rows(REGISTRY_DOC);
    assert!(
        !rows.is_empty(),
        "parsed zero rows from the registry doc — parser or include_str! path broke"
    );

    for id in [
        STOPS_SOA,
        ROUTES_SOA,
        STOP_INDEX,
        SERVICE_BITFIELD_POOL,
        SERVICE_TO_BITFIELD,
        // B1.0: pattern-major band (allocated, not yet emitted/decoded).
        PATTERNS,
        PATTERN_STOPS,
        PATTERN_SEMANTICS,
        TRIP_TIMES,
        TRIP_META,
        PATTERNS_AT_STOP,
        PATTERN_TRIPS,
        // Frequencies.
        FREQUENCIES,
        // PTB v2 temporal/transfer foundation.
        SERVICE_DAY_ORIGINS,
        BLOCK_DERIVATION_COMMITMENT,
        COMPATIBILITY_ARTIFACT_COMMITMENT,
    ] {
        let expected = region_name_by_id(id);
        let row = rows
            .iter()
            .find(|r| r.id == id)
            .unwrap_or_else(|| panic!("no registry row for id 0x{id:02x}"));
        assert_eq!(
            row.folded_name, expected,
            "registry row for 0x{id:02x} folds to {:?}, but region_name_by_id says {:?}",
            row.folded_name, expected
        );
    }
}

/// the ServiceBitfieldPool / ServiceToBitfield rows must carry the
/// frozen alignment (`0x15` Align=1, `0x16` Align=4) — the byte-stride contract
/// B2 will emit/decode against. Asserted from the doc's Align column (the source
/// of truth) so a registry edit that retunes alignment trips here.
#[test]
fn service_bitfield_rows_have_frozen_alignment() {
    let rows = parse_registry_rows(REGISTRY_DOC);
    for (id, want_align) in [(SERVICE_BITFIELD_POOL, 1u32), (SERVICE_TO_BITFIELD, 4u32)] {
        let row = rows
            .iter()
            .find(|r| r.id == id)
            .unwrap_or_else(|| panic!("no registry row for id 0x{id:02x}"));
        assert_eq!(
            row.align,
            Some(want_align),
            "registry row for 0x{id:02x} has Align {:?}, expected {want_align}",
            row.align
        );
    }
}

/// B1.0: the pattern-major band rows must carry the frozen alignment — the
/// byte-stride contract B1.1+ will emit/decode against. Asserted from the doc's
/// Align column (the source of truth, `docs/ptb-region-ids.md` §4) so a registry
/// edit that retunes alignment trips here:
///   0x10 Patterns 4 · 0x11 PatternStops 4 · 0x12 PatternSemantics 1 ·
///   0x13 TripTimes 8 · 0x14 TripMeta 4 · 0x45 PatternsAtStop 4 · 0x46 PatternTrips 4.
#[test]
fn pattern_band_rows_have_frozen_alignment() {
    let rows = parse_registry_rows(REGISTRY_DOC);
    for (id, want_align) in [
        (PATTERNS, 4u32),
        (PATTERN_STOPS, 4u32),
        (PATTERN_SEMANTICS, 1u32),
        (TRIP_TIMES, 8u32),
        (TRIP_META, 4u32),
        (PATTERNS_AT_STOP, 4u32),
        (PATTERN_TRIPS, 4u32),
    ] {
        let row = rows
            .iter()
            .find(|r| r.id == id)
            .unwrap_or_else(|| panic!("no registry row for id 0x{id:02x}"));
        assert_eq!(
            row.align,
            Some(want_align),
            "registry row for 0x{id:02x} has Align {:?}, expected {want_align}",
            row.align
        );
    }
}

/// The Frequencies row must carry the frozen alignment
/// (`0x17` Align=4) — its first wire field is a `u32 tripIdx`, so the byte-stride
/// contract a later task emits/decodes against requires 4-byte alignment.
/// Asserted from the doc's Align column (the source of truth,
/// `docs/ptb-region-ids.md` §4) so a registry edit that retunes alignment trips here.
#[test]
fn frequencies_row_has_frozen_alignment() {
    let rows = parse_registry_rows(REGISTRY_DOC);
    let row = rows
        .iter()
        .find(|r| r.id == FREQUENCIES)
        .unwrap_or_else(|| panic!("no registry row for id 0x{:02x}", FREQUENCIES));
    assert_eq!(
        row.align,
        Some(4u32),
        "registry row for 0x{:02x} has Align {:?}, expected 4",
        FREQUENCIES,
        row.align
    );
}

/// Tripwire against a registry regression that re-introduces a derived
/// `mode`/palette/flags column into RoutesSoA (`0x41`). The frozen text says
/// "NO derived `mode`/palette/flags", so we match the *regressed* wording
/// precisely (a derived `mode` u8 column / a `palette idx` column) to avoid
/// false-tripping on the negation itself.
#[test]
fn routes_soa_row_has_no_derived_mode_or_palette() {
    let rows = parse_registry_rows(REGISTRY_DOC);
    let row = rows
        .iter()
        .find(|r| r.id == ROUTES_SOA)
        .expect("no registry row for 0x41 RoutesSoA");

    assert!(
        !row.raw.contains("derived `mode` u8"),
        "0x41 row regressed: re-introduced a derived `mode` u8 column"
    );
    assert!(
        !row.raw.contains("palette idx"),
        "0x41 row regressed: re-introduced a palette idx column"
    );
    // Positive guard: the frozen "NO derived" wording must still be present.
    assert!(
        row.raw.contains("NO derived `mode`/palette/flags"),
        "0x41 row lost the frozen 'NO derived `mode`/palette/flags' guarantee"
    );
}

/// PTB v2: the `0x18`/`0x19`/`0x1A` rows carry the 8-byte alignment their `i64`
/// / `u64` fields require (the reader rejects a misaligned region).
#[test]
fn ptb_v2_rows_have_frozen_alignment() {
    let rows = parse_registry_rows(REGISTRY_DOC);
    for id in [
        SERVICE_DAY_ORIGINS,
        BLOCK_DERIVATION_COMMITMENT,
        COMPATIBILITY_ARTIFACT_COMMITMENT,
    ] {
        let row = rows
            .iter()
            .find(|r| r.id == id)
            .unwrap_or_else(|| panic!("no registry row for id 0x{id:02x}"));
        assert_eq!(row.align, Some(8), "registry row for 0x{id:02x} align");
    }
}
