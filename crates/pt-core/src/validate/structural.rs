//! Structural validation — read PTB (and optionally PTFT) bytes through the
//! existing reader, then translate the result into the small 8-variant
//! [`StructuralError`] taxonomy. On top of what `from_bytes` checks, this adds
//! the dense `parent_idx`-column shape check, classified into an existing
//! variant — no new public class.
//!
//! **Why wrap, not reimplement.** `Reader::from_bytes` already performs every check this validator
//! owes the caller (magic, version, region bounds, CSR invariants, string-pool well-formedness, SoA
//! column ranges, and the coord range). Re-walking the byte format here would be a second source
//! of truth that could silently drift. Instead we re-use `Reader::from_bytes` and classify its
//! [`PtbError`] into the public 8-variant enum ("single validator for server + bench").
//!
//! **Zero-services-in-window** is a soft check derivable from the header alone
//! (peer-review of the service bitmask region after parse). A bundle whose
//! every per-service byte is zero would serve empty departures for every
//! query, so we surface it as a distinct variant rather than letting it
//! masquerade as a runtime "no itinerary" result. This is the one PTB-internal
//! sanity check the engine itself does NOT make (the engine treats "no
//! services" as a normal empty result on the assumption that the caller
//! validated upstream).
//!
//! **PTFT** is a separate artifact (transfers.bin) and a separate buffer; we
//! expose [`validate_ptnt`] for callers (pt-serve, the bench harness) that
//! want the same `StructuralError` taxonomy applied to it.

use crate::error::PtbError;
use crate::reader::Reader;
use crate::transfers::Transfers;
use crate::validate::errors::StructuralError;
use crate::{PTB_HEADER_BYTES, PTB_VERSION};

/// Validate the structural shape of a PTB buffer.
///
/// On success the bytes form a parseable `.ptb` bundle with at least one
/// per-service bitmask byte set somewhere in the service window. On failure the
/// returned [`StructuralError`] is one of the eight public classes.
///
/// This also validates the dense `parent_idx` column (bounds + self-ref) — the
/// coord-range check runs in `from_bytes`, so a bundle that reaches this
/// function already has in-range coords. This makes `pt-core` self-protecting
/// regardless of which shell wraps it — pt-wasm consumes pt-core directly
/// without pt-serve's layer.
///
/// This re-parses the header and does NOT keep the resulting `Reader` — it is
/// a fast-path validator the caller can run BEFORE constructing the long-lived
/// reader (e.g. during the producer publish protocol's pre-rename verify).
/// Production load paths can still rely on `Reader::from_bytes` to surface the
/// SAME errors via [`from_ptb_error`].
pub fn validate_structural(bytes: &[u8]) -> Result<(), StructuralError> {
    // Bytes flow through `Reader::from_bytes` so we share the existing decode
    // contract. We then accept the reader to assert the parent column and the
    // soft ZeroServicesInWindow invariant.
    match Reader::from_bytes(bytes.to_vec()) {
        Ok(reader) => {
            // Parent-column integrity is checked first: a corrupt column is a
            // harder error than "no active services", and ordering ensures a torn
            // producer write is not silently shadowed by the softer
            // ZeroServicesInWindow variant.
            validate_stops_soa_structural(&reader)?;
            if !has_any_active_service(&reader) {
                return Err(StructuralError::ZeroServicesInWindow);
            }
            Ok(())
        }
        Err(e) => Err(from_ptb_error(e)),
    }
}

/// Structural validation of the dense `parent_idx` column:
///
/// - each non-sentinel (`!= u32::MAX`) value must be `< num_stops` ("bounds")
///   and `!= its own index` ("self_ref"), reported as `ParentIdxInvalid`.
///
/// The `lat_e7`/`lon_e7` coordinate-range check is NO LONGER here: it is mandatory-at-LOAD for all
/// consumers, so it now runs in `resolve_stops_soa` (raised as `PtbError::CoordOutOfRange`, which
/// `from_ptb_error` maps to the same `stopsSoA` `RegionBoundsExceeded` class). A bundle that
/// reaches this function has already passed `from_bytes`, so its coords are in-range by
/// construction.
fn validate_stops_soa_structural<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
) -> Result<(), StructuralError> {
    let parents = reader
        .soa_parent_column()
        .map_err(|_| StructuralError::ParentIdxInvalid { reason: "bounds" })?;
    let n = parents.len() as u32;
    for (i, &p) in parents.iter().enumerate() {
        if p == u32::MAX {
            continue; // sentinel: no parent
        }
        if p >= n {
            return Err(StructuralError::ParentIdxInvalid { reason: "bounds" });
        }
        if p == i as u32 {
            return Err(StructuralError::ParentIdxInvalid { reason: "self_ref" });
        }
    }
    Ok(())
}

/// Validate the structural shape of a PTFT (transfers.bin) buffer.
///
/// PTFT corruption — bad magic, varint overrun, neighbor index past stop_count
/// — collapses into [`StructuralError::PtntBoundsExceeded`].  Callers that
/// need finer granularity can call [`Transfers::from_bytes`] directly.
pub fn validate_ptnt(bytes: &[u8]) -> Result<(), StructuralError> {
    match Transfers::from_bytes(bytes) {
        Ok(_) => Ok(()),
        Err(_) => Err(StructuralError::PtntBoundsExceeded),
    }
}

/// Translate a `PtbError` into the corresponding [`StructuralError`] class.
///
/// The mapping is `pt-shared`-callable too: validators in the metadata layer
/// that get a [`PtbError`] back from `Reader::from_bytes` can run it through
/// this helper to land in the unified `ValidationError::Structural` variant.
pub fn from_ptb_error(e: PtbError) -> StructuralError {
    match e {
        PtbError::BufferTooSmall { got, need } => StructuralError::TruncatedBundle {
            expected_min: need,
            actual: got,
        },
        PtbError::BadMagic { .. } => StructuralError::WrongMagic,
        PtbError::UnsupportedVersion { got } => StructuralError::WrongVersion {
            found: got as u32,
            supported: PTB_VERSION as u32,
        },
        // Region-table-anchored shape errors: try to recover the ordinal from
        // the region name. `RegionBoundsExceeded` carries `region_idx: u8`
        // (0..=10 for known regions, 0xFF for the "no specific region" cases
        // like a bare `SliceOutOfBounds` or `Misaligned` over a CSR sub-array
        // — those are still structural, they just don't pin to one region).
        PtbError::RegionOutOfBounds { region, .. } | PtbError::RegionOffsetTooLarge { region } => {
            StructuralError::RegionBoundsExceeded {
                region_idx: region_name_to_idx(region),
            }
        }
        PtbError::CountExceedsRegion { region } => StructuralError::RegionBoundsExceeded {
            region_idx: region_name_to_idx(region),
        },
        // A bundle missing a mandatory data region (0x40/0x41) is a hard
        // shape error pinned to that region's reserved ordinal (11/12).
        PtbError::MissingRequiredRegion { region } => StructuralError::RegionBoundsExceeded {
            region_idx: region_name_to_idx(region),
        },
        // A decoded SoA coord column outside WGS84 (now raised at `from_bytes`) maps to the same
        // StopsSoA region class the coord failure used before it was hoisted out of
        // `validate_stops_soa_structural` — no new public StructuralError variant.
        PtbError::CoordOutOfRange { .. } => StructuralError::RegionBoundsExceeded {
            region_idx: region_name_to_idx("stopsSoA"),
        },
        PtbError::StringPoolMalformed { .. }
        | PtbError::Utf8
        | PtbError::StringIndexOutOfRange { .. } => StructuralError::RegionBoundsExceeded {
            region_idx: region_name_to_idx("stringPool"),
        },
        PtbError::SliceOutOfBounds { .. } | PtbError::Misaligned { .. } => {
            StructuralError::RegionBoundsExceeded { region_idx: 0xFF }
        }
        // A structurally-malformed region table, a present-but-invalid
        // 0x01 WindowMeta region (too short / over the hard ceiling), an
        // invalid 0x15/0x16 service-bitfield pool, or a malformed
        // pattern band (0x10-0x14 / 0x45/0x46) are all shape errors with no
        // single-region ordinal → the 0xFF sentinel.
        PtbError::MalformedRegionTable { .. }
        | PtbError::WindowMetaInvalid { .. }
        | PtbError::ServiceBitfieldPoolInvalid { .. }
        | PtbError::PatternBandInvalid { .. }
        | PtbError::FeatureFlagsInvalid { .. }
        | PtbError::ServiceDayOriginsInvalid { .. }
        | PtbError::CommitmentInvalid { .. }
        | PtbError::TripMetaInvalid { .. } => {
            StructuralError::RegionBoundsExceeded { region_idx: 0xFF }
        }
        PtbError::CsrInvalid { .. } => StructuralError::CsrBoundsExceeded,
        PtbError::TransferRowInvalid { .. } => StructuralError::RegionBoundsExceeded {
            region_idx: region_name_to_idx("transfers"),
        },
        PtbError::FrequencyRowInvalid { .. } => StructuralError::RegionBoundsExceeded {
            region_idx: region_name_to_idx("frequencies"),
        },
    }
}

/// Map a wire-name (as emitted by `Region::name` / `region_ids::region_name_by_id`)
/// back to its enum ordinal. Returns `0xFF` for unknown / synthetic names so a
/// future region addition surfaces as an obviously-distinct sentinel rather than
/// misattributed. The ordinals are stable: 0, 1, 3, 9 and 10 belonged to regions
/// that no longer exist and are not reused.
fn region_name_to_idx(name: &str) -> u8 {
    match name {
        "tripsIntern" => 2,
        "stopTimes" => 4,
        "tripStarts" => 5,
        "csr" => 6,
        "stringPool" => 7,
        "transfers" => 8,
        "stopsSoA" => 11,
        "routesSoA" => 12,
        _ => 0xFF,
    }
}

/// True iff at least one `service_bitmask` byte in the bundle has any bit set.
///
/// The 90-day window is the union of all per-service bitmasks (12 bytes
/// each); a bundle where every byte is zero serves an empty itinerary for
/// every query and is the closest thing to a "soft" structural error we can
/// detect without a query. Mirrors the "no active services" guard the
/// scheduler logs on the Node side.
fn has_any_active_service<B: AsRef<[u8]> + Send + Sync + 'static>(r: &Reader<B>) -> bool {
    for s in 0..r.num_services() {
        if r.service_bitmask(s).iter().any(|&b| b != 0) {
            return true;
        }
    }
    false
}

// ---- Internal: also surface raw PtbError -> StructuralError unmapped variants
//      in the `Vec<u8>` -> `Reader::from_bytes` round-trip without forcing
//      callers to pay the clone. The std-side wrapper in pt-shared uses this. ----

/// Fast pre-check for the bare header — no `Vec` clone needed. Returns the
/// first structural problem found in the header alone, or `Ok(())` if the
/// header's magic/version pass. Useful for validators that want to short-
/// circuit on the cheapest checks before paying the full reader cost (e.g.
/// the producer publish protocol's pre-rename verify).
pub fn validate_header_quick(bytes: &[u8]) -> Result<(), StructuralError> {
    if bytes.len() < PTB_HEADER_BYTES {
        return Err(StructuralError::TruncatedBundle {
            expected_min: PTB_HEADER_BYTES,
            actual: bytes.len(),
        });
    }
    let magic: [u8; 4] = bytes[0..4].try_into().expect("4-byte slice");
    if magic != crate::PTB_MAGIC {
        return Err(StructuralError::WrongMagic);
    }
    // version is at offset 4, u16 LE.
    let version = u16::from_le_bytes([bytes[4], bytes[5]]);
    if !crate::header::is_supported_version(version) {
        return Err(StructuralError::WrongVersion {
            found: version as u32,
            supported: PTB_VERSION as u32,
        });
    }
    Ok(())
}

#[cfg(test)]
mod region_idx_tests {
    use super::region_name_to_idx;

    #[test]
    fn soa_region_names_map_to_reserved_ordinals() {
        // The SoA regions get reserved ordinals 11/12 (NOT the 0xFF fallthrough),
        // so a `MissingRequiredRegion` classifies to a distinct, named region_idx.
        assert_eq!(region_name_to_idx("stopsSoA"), 11);
        assert_eq!(region_name_to_idx("routesSoA"), 12);
    }

    #[test]
    fn unknown_region_name_still_falls_through_to_sentinel() {
        assert_eq!(region_name_to_idx("nope"), 0xFF);
    }
}

#[cfg(test)]
mod from_ptb_error_tests {
    #[test]
    fn malformed_region_table_maps_to_region_bounds_exceeded() {
        use crate::error::PtbError;
        use crate::validate::errors::StructuralError;
        use crate::validate::structural::from_ptb_error;
        let e = from_ptb_error(PtbError::MalformedRegionTable {
            reason: "dup_region_id",
        });
        assert!(matches!(
            e,
            StructuralError::RegionBoundsExceeded { region_idx: 0xFF }
        ));
    }
}
