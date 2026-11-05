//! PTB v2 wire structures: `0x18 ServiceDayOrigins`, `0x19
//! BlockDerivationCommitment`, `0x1A CompatibilityArtifactCommitment`, the v2
//! `0xF8 Transfers` row contract and the source-scoped `TripMeta.block_idx`.
//!
//! Every function here is a pure decode/validate step over bytes the header has
//! already bounds-checked; `Reader::from_bytes` calls [`resolve_v2_regions`]
//! once for a version-2 bundle and fails closed on any violation. A v1 bundle
//! never reaches this module (its frozen legacy rules stay in the reader).
//!
//! ("PTB Version And Storage Contract"). GTFS `Time` is measured from local noon
//! minus 12 hours: <https://gtfs.org/documentation/schedule/reference/#field-types>.

use crate::error::{PtbError, Result};
use crate::header::{Header, Region, RegionEntry};
use crate::records::{rd_u16, rd_u32, rd_u8, TRANSFER_ABSENT, TRANSFER_RECORD_BYTES};
use crate::region_ids;

/// The only `0x19`/`0x1A` algorithm version this build understands.
pub const COMMITMENT_ALGORITHM_V1: u16 = 1;
/// Exact byte size of `0x19 BlockDerivationCommitment`.
pub const BLOCK_DERIVATION_COMMITMENT_BYTES: usize = 48;
/// Exact byte size of `0x1A CompatibilityArtifactCommitment`.
pub const COMPATIBILITY_ARTIFACT_COMMITMENT_BYTES: usize = 88;
/// SHA-256 of the empty byte sequence: the `0x19` hash of a disabled or empty
/// block derivation.
pub const SHA256_EMPTY: [u8; 32] = [
    0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f, 0xb9, 0x24,
    0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c, 0xa4, 0x95, 0x99, 0x1b, 0x78, 0x52, 0xb8, 0x55,
];

/// Decoded `0x19 BlockDerivationCommitment`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockDerivationCommitment {
    pub algorithm_version: u16,
    /// Number of `(source_trip, service_date_ordinal, target_trip)` tuples (not
    /// distinct trip pairs).
    pub pair_date_count: u64,
    pub tuples_sha256: [u8; 32],
}

impl BlockDerivationCommitment {
    /// The commitment of a disabled or empty derivation.
    pub const EMPTY: BlockDerivationCommitment = BlockDerivationCommitment {
        algorithm_version: COMMITMENT_ALGORITHM_V1,
        pair_date_count: 0,
        tuples_sha256: SHA256_EMPTY,
    };

    /// Encode to the exact 48-byte region body.
    pub fn to_bytes(&self) -> [u8; BLOCK_DERIVATION_COMMITMENT_BYTES] {
        let mut b = [0u8; BLOCK_DERIVATION_COMMITMENT_BYTES];
        b[0..2].copy_from_slice(&self.algorithm_version.to_le_bytes());
        b[8..16].copy_from_slice(&self.pair_date_count.to_le_bytes());
        b[16..48].copy_from_slice(&self.tuples_sha256);
        b
    }
}

/// Decoded `0x1A CompatibilityArtifactCommitment`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompatibilityArtifactCommitment {
    pub algorithm_version: u16,
    pub v1_identity_size: u64,
    pub v1_gzip_size: u64,
    pub v1_identity_sha256: [u8; 32],
    pub v1_gzip_sha256: [u8; 32],
}

impl CompatibilityArtifactCommitment {
    /// Encode to the exact 88-byte region body.
    pub fn to_bytes(&self) -> [u8; COMPATIBILITY_ARTIFACT_COMMITMENT_BYTES] {
        let mut b = [0u8; COMPATIBILITY_ARTIFACT_COMMITMENT_BYTES];
        b[0..2].copy_from_slice(&self.algorithm_version.to_le_bytes());
        b[8..16].copy_from_slice(&self.v1_identity_size.to_le_bytes());
        b[16..24].copy_from_slice(&self.v1_gzip_size.to_le_bytes());
        b[24..56].copy_from_slice(&self.v1_identity_sha256);
        b[56..88].copy_from_slice(&self.v1_gzip_sha256);
        b
    }
}

/// Validated PTB v2 regions, resolved once by `Reader::from_bytes`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct V2Regions {
    /// Byte offset of `origins[0]` and the number of `i64` entries
    /// (`effectiveWindowDays + 1`).
    pub origins_off: usize,
    pub origins_len: usize,
    pub block_commitment: BlockDerivationCommitment,
    pub compat_commitment: CompatibilityArtifactCommitment,
}

fn rd_u64(b: &[u8], off: usize, what: &'static str) -> Result<u64> {
    Ok(u64::from_le_bytes(
        b.get(off..off + 8)
            .and_then(|s| s.try_into().ok())
            .ok_or(PtbError::SliceOutOfBounds { what })?,
    ))
}

fn rd_hash(b: &[u8], off: usize, what: &'static str) -> Result<[u8; 32]> {
    b.get(off..off + 32)
        .and_then(|s| s.try_into().ok())
        .ok_or(PtbError::SliceOutOfBounds { what })
}

/// A mandatory cold commitment region: present, 8-byte aligned, exact size,
/// reserved bytes `[2..8)` zero and algorithm version 1.
fn commitment_region<'a>(buf: &'a [u8], header: &Header, id: u16, size: usize) -> Result<&'a [u8]> {
    let region = region_ids::region_name_by_id(id);
    let e = header.region_by_id(id).ok_or(PtbError::CommitmentInvalid {
        region,
        reason: "absent",
    })?;
    if e.offset % 8 != 0 {
        return Err(PtbError::CommitmentInvalid {
            region,
            reason: "misaligned",
        });
    }
    if e.length != size {
        return Err(PtbError::CommitmentInvalid {
            region,
            reason: "length",
        });
    }
    let body = &buf[e.offset..e.offset + e.length];
    if rd_u16(body, 0)? != COMMITMENT_ALGORITHM_V1 {
        return Err(PtbError::CommitmentInvalid {
            region,
            reason: "unknown_algorithm",
        });
    }
    if body[2..8].iter().any(|&b| b != 0) {
        return Err(PtbError::CommitmentInvalid {
            region,
            reason: "reserved_nonzero",
        });
    }
    Ok(body)
}

/// Decode a `0x19` body (already size/alignment/reserved/algorithm checked).
pub fn decode_block_commitment(body: &[u8]) -> Result<BlockDerivationCommitment> {
    Ok(BlockDerivationCommitment {
        algorithm_version: rd_u16(body, 0)?,
        pair_date_count: rd_u64(body, 8, "blockDerivationCommitment")?,
        tuples_sha256: rd_hash(body, 16, "blockDerivationCommitment")?,
    })
}

/// Decode a `0x1A` body (already size/alignment/reserved/algorithm checked).
pub fn decode_compat_commitment(body: &[u8]) -> Result<CompatibilityArtifactCommitment> {
    Ok(CompatibilityArtifactCommitment {
        algorithm_version: rd_u16(body, 0)?,
        v1_identity_size: rd_u64(body, 8, "compatibilityArtifactCommitment")?,
        v1_gzip_size: rd_u64(body, 16, "compatibilityArtifactCommitment")?,
        v1_identity_sha256: rd_hash(body, 24, "compatibilityArtifactCommitment")?,
        v1_gzip_sha256: rd_hash(body, 56, "compatibilityArtifactCommitment")?,
    })
}

/// `Number.MAX_SAFE_INTEGER` (2^53 - 1): the largest origin both readers accept.
const MAX_SAFE_ORIGIN: i64 = (1 << 53) - 1;

/// Validate and resolve the three mandatory v2 regions. `effectiveWindowDays`
/// is the header's `window_days` (the `0x01` value, or the 90-day default when
/// that region is omitted).
pub(crate) fn resolve_v2_regions(buf: &[u8], header: &Header) -> Result<V2Regions> {
    let e = header
        .region_by_id(region_ids::SERVICE_DAY_ORIGINS)
        .ok_or(PtbError::ServiceDayOriginsInvalid { reason: "absent" })?;
    if e.offset % 8 != 0 {
        return Err(PtbError::ServiceDayOriginsInvalid {
            reason: "misaligned",
        });
    }
    let entries = header.window_days as usize + 1;
    if e.length != entries * 8 {
        return Err(PtbError::ServiceDayOriginsInvalid { reason: "length" });
    }
    let mut prev: Option<i64> = None;
    for i in 0..entries {
        let v = rd_u64(buf, e.offset + i * 8, "serviceDayOrigins")? as i64;
        // JS safe-integer bound: the TypeScript reader rejects the same
        // values, and differences between origins can never overflow i64.
        if !(-MAX_SAFE_ORIGIN..=MAX_SAFE_ORIGIN).contains(&v) {
            return Err(PtbError::ServiceDayOriginsInvalid {
                reason: "out_of_range",
            });
        }
        if let Some(p) = prev {
            if v <= p {
                return Err(PtbError::ServiceDayOriginsInvalid {
                    reason: "not_increasing",
                });
            }
        }
        prev = Some(v);
    }
    let block = commitment_region(
        buf,
        header,
        region_ids::BLOCK_DERIVATION_COMMITMENT,
        BLOCK_DERIVATION_COMMITMENT_BYTES,
    )?;
    let compat = commitment_region(
        buf,
        header,
        region_ids::COMPATIBILITY_ARTIFACT_COMMITMENT,
        COMPATIBILITY_ARTIFACT_COMMITMENT_BYTES,
    )?;
    let block_commitment = decode_block_commitment(block)?;
    let compat_commitment = decode_compat_commitment(compat)?;
    if !header.derive_block_inseat() && block_commitment != BlockDerivationCommitment::EMPTY {
        // Disabled derivation must commit to the canonical empty index.
        return Err(PtbError::CommitmentInvalid {
            region: "blockDerivationCommitment",
            reason: "disabled_not_empty",
        });
    }
    Ok(V2Regions {
        origins_off: e.offset,
        origins_len: entries,
        block_commitment,
        compat_commitment,
    })
}

/// One decoded `0xF8` row with the v2 absent-stop contract applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransferRowV2 {
    pub from_stop: Option<u32>,
    pub to_stop: Option<u32>,
    pub from_route: Option<u32>,
    pub to_route: Option<u32>,
    pub from_trip: Option<u32>,
    pub to_trip: Option<u32>,
    pub min_transfer_secs: Option<u32>,
    pub transfer_type: u8,
}

#[inline]
fn opt(v: u32) -> Option<u32> {
    (v != TRANSFER_ABSENT).then_some(v)
}

/// Decode and validate one v2 transfer row at `off` within the `0xF8` body.
/// `trip_route(t)` returns the trip's route ordinal (used for the GTFS rule that
/// a present trip must belong to the present route on the same side).
pub(crate) fn decode_transfer_v2(
    region: &[u8],
    row: usize,
    counts: (u32, u32, u32),
    trip_route: &dyn Fn(u32) -> Result<u32>,
) -> Result<TransferRowV2> {
    let off = row * TRANSFER_RECORD_BYTES;
    let bad = |reason| PtbError::TransferRowInvalid {
        row: row as u32,
        reason,
    };
    let (num_stops, num_routes, num_trips) = counts;
    let r = TransferRowV2 {
        from_stop: opt(rd_u32(region, off)?),
        to_stop: opt(rd_u32(region, off + 4)?),
        from_route: opt(rd_u32(region, off + 8)?),
        to_route: opt(rd_u32(region, off + 12)?),
        from_trip: opt(rd_u32(region, off + 16)?),
        to_trip: opt(rd_u32(region, off + 20)?),
        min_transfer_secs: opt(rd_u32(region, off + 24)?),
        transfer_type: rd_u8(region, off + 28)?,
    };
    if region[off + 29..off + 32].iter().any(|&b| b != 0) {
        return Err(bad("reserved_nonzero"));
    }
    if r.transfer_type > 5 {
        return Err(bad("transfer_type"));
    }
    let linked = r.transfer_type >= 4;
    if linked {
        if r.from_trip.is_none() || r.to_trip.is_none() {
            return Err(bad("linked_without_trips"));
        }
    } else if r.from_stop.is_none() || r.to_stop.is_none() {
        return Err(bad("stopless_ordinary"));
    }
    if r.transfer_type == 2 && r.min_transfer_secs.is_none() {
        return Err(bad("type2_without_min"));
    }
    for s in [r.from_stop, r.to_stop].into_iter().flatten() {
        if s >= num_stops {
            return Err(bad("stop_out_of_range"));
        }
    }
    for rt in [r.from_route, r.to_route].into_iter().flatten() {
        if rt >= num_routes {
            return Err(bad("route_out_of_range"));
        }
    }
    for t in [r.from_trip, r.to_trip].into_iter().flatten() {
        if t >= num_trips {
            return Err(bad("trip_out_of_range"));
        }
    }
    for (route, trip) in [(r.from_route, r.from_trip), (r.to_route, r.to_trip)] {
        if let (Some(route), Some(trip)) = (route, trip) {
            if trip_route(trip)? != route {
                return Err(bad("trip_route_mismatch"));
            }
        }
    }
    Ok(r)
}

/// Validate every `0xF8` row of a v2 bundle (structural corruption fails the
/// whole load).
pub(crate) fn validate_transfers_v2(
    buf: &[u8],
    header: &Header,
    trip_route: &dyn Fn(u32) -> Result<u32>,
) -> Result<()> {
    let tr: RegionEntry = header.region(Region::Transfers);
    if !tr.length.is_multiple_of(TRANSFER_RECORD_BYTES) {
        return Err(PtbError::CountExceedsRegion {
            region: "transfers",
        });
    }
    let body = &buf[tr.offset..tr.offset + tr.length];
    let counts = (header.num_stops, header.num_routes, header.num_trips);
    for row in 0..tr.length / TRANSFER_RECORD_BYTES {
        decode_transfer_v2(body, row, counts, trip_route)?;
    }
    Ok(())
}

/// PTB v2 `0x17 Frequencies` row byte 15 (`flags`; reserved in v1): bit0 marks
/// a quarantined frequency trip. A quarantined trip carries exactly one
/// canonical marker row (`start 0`, `end 1`, `headway 1`, `exact_times 0`) and
/// is never routed: neither its frequency instances nor its scheduled template.
pub const FREQUENCY_FLAG_QUARANTINED: u8 = 1;

/// Validate every `0x17` row under the v2 frequency contract
/// (<https://gtfs.org/documentation/schedule/reference/#frequenciestxt>):
/// only known flag bits; a quarantined trip is exactly one canonical marker
/// row; every other row has `headway >= 1`, `start < end`, `exact_times` in
/// {0, 1}, and rows of one trip are sorted by start and never overlap (a row
/// may start at the prior end).
///
/// `end` is exclusive for every window, `exact_times=1` included: a departure
/// exactly at `end` is not generated. A window whose `end` falls on a departure
/// (`(end - start) % headway == 0`) breaks GTFS's strict
/// `end_time < last_departure + headway_secs`, but its meaning is unambiguous
/// under the exclusive end, so it is accepted rather than quarantining the
/// whole trip.
pub(crate) fn validate_frequencies_v2(buf: &[u8], header: &Header) -> Result<()> {
    let Some(e) = header.region_by_id(region_ids::FREQUENCIES) else {
        return Ok(());
    };
    let count = rd_u32(buf, e.offset)? as usize;
    let rows = e.offset + 4;
    let mut prev: Option<(u32, u32, bool)> = None; // (trip, end, quarantined)
    for row in 0..count {
        let o = rows + row * 16;
        let bad = |reason| PtbError::FrequencyRowInvalid {
            row: row as u32,
            reason,
        };
        let trip = rd_u32(buf, o)?;
        let start = rd_u32(buf, o + 4)?;
        let end = rd_u32(buf, o + 8)?;
        let headway = rd_u16(buf, o + 12)? as u32;
        let exact = rd_u8(buf, o + 14)?;
        let flags = rd_u8(buf, o + 15)?;
        if trip >= header.num_trips {
            return Err(bad("trip_out_of_range"));
        }
        if flags & !FREQUENCY_FLAG_QUARANTINED != 0 {
            return Err(bad("unknown_flags"));
        }
        let quarantined = flags & FREQUENCY_FLAG_QUARANTINED != 0;
        if let Some((pt, pend, pq)) = prev {
            if trip < pt {
                return Err(bad("unsorted"));
            }
            if trip == pt {
                if quarantined || pq {
                    return Err(bad("quarantine_marker_not_alone"));
                }
                if start < pend {
                    return Err(bad("overlapping_windows"));
                }
            }
        }
        if quarantined {
            if (start, end, headway, exact) != (0, 1, 1, 0) {
                return Err(bad("noncanonical_quarantine_marker"));
            }
        } else {
            if headway == 0 {
                return Err(bad("zero_headway"));
            }
            if start >= end {
                return Err(bad("empty_window"));
            }
            if exact > 1 {
                return Err(bad("exact_times"));
            }
        }
        prev = Some((trip, end, quarantined));
    }
    Ok(())
}

/// The internal StringPool key for a source-feed-scoped GTFS `block_id`:
/// `ptn:block:<feed_rank-decimal>:<base64url-no-pad(raw-utf8)>`. Never exposed
/// as a rider-facing id; equal raw text in two component feeds yields two keys,
/// so separate feeds never merge vehicles.
pub fn block_key(feed_rank: u32, raw_block_id: &str) -> alloc::string::String {
    use alloc::string::String;
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let bytes = raw_block_id.as_bytes();
    let mut out = String::with_capacity(16 + bytes.len() * 4 / 3 + 4);
    out.push_str("ptn:block:");
    {
        use core::fmt::Write;
        let _ = write!(out, "{feed_rank}");
    }
    out.push(':');
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((n >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 63) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_commitment_hash_is_sha256_of_nothing() {
        // e3b0c442...b855 is the canonical SHA-256("").
        assert_eq!(SHA256_EMPTY[0], 0xe3);
        assert_eq!(SHA256_EMPTY[31], 0x55);
        let b = BlockDerivationCommitment::EMPTY.to_bytes();
        assert_eq!(
            decode_block_commitment(&b).unwrap(),
            BlockDerivationCommitment::EMPTY
        );
        assert!(b[2..8].iter().all(|&x| x == 0));
    }

    #[test]
    fn compat_commitment_round_trips() {
        let c = CompatibilityArtifactCommitment {
            algorithm_version: 1,
            v1_identity_size: 123_456,
            v1_gzip_size: 45_678,
            v1_identity_sha256: [7u8; 32],
            v1_gzip_sha256: [9u8; 32],
        };
        assert_eq!(decode_compat_commitment(&c.to_bytes()).unwrap(), c);
    }

    #[test]
    fn block_key_is_feed_scoped_base64url_no_pad() {
        assert_eq!(block_key(0, ""), "ptn:block:0:");
        assert_eq!(block_key(0, "f"), "ptn:block:0:Zg");
        assert_eq!(block_key(0, "fo"), "ptn:block:0:Zm8");
        assert_eq!(block_key(0, "foo"), "ptn:block:0:Zm9v");
        assert_eq!(block_key(2, "foob"), "ptn:block:2:Zm9vYg");
        // URL-safe alphabet: 0xFB 0xFF -> "-_8"
        assert_eq!(block_key(1, "\u{fbff}"), block_key(1, "\u{fbff}"));
        let k = block_key(1, core::str::from_utf8(&[0xEF, 0xBF, 0xBF]).unwrap());
        assert_eq!(k, "ptn:block:1:77-_");
        assert_ne!(block_key(0, "B1"), block_key(1, "B1"));
    }

    fn row(fields: [u32; 7], ty: u8) -> [u8; 32] {
        let mut b = [0u8; 32];
        for (i, f) in fields.iter().enumerate() {
            b[i * 4..i * 4 + 4].copy_from_slice(&f.to_le_bytes());
        }
        b[28] = ty;
        b
    }

    const A: u32 = TRANSFER_ABSENT;

    #[test]
    fn v2_row_contract() {
        let tr = |t: u32| -> Result<u32> { Ok(t % 2) };
        let counts = (10, 2, 10);
        // Stopless type-4 with both trips is legal.
        let r = row([A, A, A, A, 2, 4, A], 4);
        let d = decode_transfer_v2(&r, 0, counts, &tr).unwrap();
        assert_eq!(d.from_stop, None);
        assert_eq!(d.from_trip, Some(2));
        // Stopless type 0 is not.
        let r = row([A, 1, A, A, A, A, A], 0);
        assert!(matches!(
            decode_transfer_v2(&r, 0, counts, &tr),
            Err(PtbError::TransferRowInvalid {
                reason: "stopless_ordinary",
                ..
            })
        ));
        // Linked row without both trips.
        let r = row([1, 1, A, A, 2, A, A], 5);
        assert!(matches!(
            decode_transfer_v2(&r, 0, counts, &tr),
            Err(PtbError::TransferRowInvalid {
                reason: "linked_without_trips",
                ..
            })
        ));
        // Type 2 needs a minimum.
        let r = row([1, 2, A, A, A, A, A], 2);
        assert!(matches!(
            decode_transfer_v2(&r, 0, counts, &tr),
            Err(PtbError::TransferRowInvalid {
                reason: "type2_without_min",
                ..
            })
        ));
        // Unknown type.
        let r = row([1, 2, A, A, A, A, A], 6);
        assert!(decode_transfer_v2(&r, 0, counts, &tr).is_err());
        // Reserved bytes.
        let mut r = row([1, 2, A, A, A, A, A], 0);
        r[30] = 1;
        assert!(matches!(
            decode_transfer_v2(&r, 0, counts, &tr),
            Err(PtbError::TransferRowInvalid {
                reason: "reserved_nonzero",
                ..
            })
        ));
        // Trip 3 belongs to route 1, not 0.
        let r = row([1, 2, 0, A, 3, A, A], 0);
        assert!(matches!(
            decode_transfer_v2(&r, 0, counts, &tr),
            Err(PtbError::TransferRowInvalid {
                reason: "trip_route_mismatch",
                ..
            })
        ));
        let r = row([1, 2, 1, A, 3, A, A], 0);
        assert!(decode_transfer_v2(&r, 0, counts, &tr).is_ok());
        // Out-of-range ordinals.
        let r = row([10, 2, A, A, A, A, A], 0);
        assert!(decode_transfer_v2(&r, 0, counts, &tr).is_err());
    }
}
