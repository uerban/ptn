//! Structural validation errors — `no_std`, no `String` payloads.
//!
//! These cover the eight structural failure modes a PTB buffer can exhibit
//! before any metadata or engine logic runs: truncated buffer, bad magic,
//! unsupported version, region table out of bounds, CSR shape invalid, PTFT
//! adjacency out of bounds, zero active services in the service window, and
//! an invalid `parent_idx` column.
//!
//! Lives in `pt-core` so the bench/differential harnesses share the SAME validator the server's
//! load path uses ("single source of truth"). Anything that needs `String` payloads or `thiserror`
//! goes through the `pt-shared::validate::ValidationError` wrapper.

use core::fmt;

/// Structural failure classes. Variants carry only integer payloads so this
/// enum stays usable from `no_std` callers (no `String`, no `&str` heap
/// references).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StructuralError {
    /// Buffer shorter than the minimum the PTB header requires.
    TruncatedBundle { expected_min: usize, actual: usize },
    /// First four bytes do not match `PTB\0`.
    WrongMagic,
    /// `version` field in the header is not a value pt-core can decode.
    WrongVersion { found: u32, supported: u32 },
    /// A region in the tagged region table extends past the buffer, has an
    /// offset that wouldn't fit in `usize`, or otherwise resolves to an
    /// out-of-bounds range. `region_idx` is a stable per-region ordinal
    /// (`validate::structural::region_name_to_idx`; tripsIntern=2, stopTimes=4,
    /// tripStarts=5, csr=6, stringPool=7, transfers=8, stopsSoA=11,
    /// routesSoA=12), or `0xFF` when the error names no single region.
    RegionBoundsExceeded { region_idx: u8 },
    /// CSR (route→trips and stop→routes) failed its shape checks: offsets not
    /// monotonic, `offsets[last] != values.len()`, or a value out of range.
    CsrBoundsExceeded,
    /// PTFT (transfers.bin) adjacency references a stop index beyond the
    /// stop_count, or the per-stop record's varint-length runs off the end.
    PtntBoundsExceeded,
    /// The PTB header parses, but every per-service bitmask byte is zero
    /// across the entire 90-day window. A bundle with no active services
    /// would serve empty departures for every query.
    ZeroServicesInWindow,
    /// The dense `parent_idx` column of `0x40 StopsSoA` is invalid: a parent
    /// index is ≥ `num_stops` or the column is unreadable ("bounds"), or a stop
    /// is its own parent ("self_ref").
    ParentIdxInvalid { reason: &'static str },
}

impl fmt::Display for StructuralError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TruncatedBundle {
                expected_min,
                actual,
            } => write!(
                f,
                "truncated bundle: expected ≥{expected_min}, got {actual}"
            ),
            Self::WrongMagic => write!(f, "wrong magic bytes"),
            Self::WrongVersion { found, supported } => {
                write!(f, "unsupported PTB version {found}, supported={supported}")
            }
            Self::RegionBoundsExceeded { region_idx } => {
                write!(f, "region {region_idx} bounds exceeded")
            }
            Self::CsrBoundsExceeded => write!(f, "CSR bounds exceeded"),
            Self::PtntBoundsExceeded => write!(f, "PTFT bounds exceeded"),
            Self::ZeroServicesInWindow => write!(f, "no active services in the 90-day window"),
            Self::ParentIdxInvalid { reason } => {
                write!(f, "parent_idx invalid: {reason}")
            }
        }
    }
}

impl core::error::Error for StructuralError {}
