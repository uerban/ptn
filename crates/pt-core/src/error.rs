use core::fmt;

pub type Result<T> = core::result::Result<T, PtbError>;

/// All decode failures. No panics on malformed input — every fallible path
/// returns one of these (mirrors the throws in loader.ts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtbError {
    BufferTooSmall {
        got: usize,
        need: usize,
    },
    BadMagic {
        got: [u8; 4],
    },
    UnsupportedVersion {
        got: u16,
    },
    RegionOutOfBounds {
        region: &'static str,
        offset: u64,
        length: u64,
        buf: usize,
    },
    RegionOffsetTooLarge {
        region: &'static str,
    },
    SliceOutOfBounds {
        what: &'static str,
    },
    StringPoolMalformed {
        detail: &'static str,
    },
    StringIndexOutOfRange {
        idx: u32,
        count: usize,
    },
    Utf8,
    CountExceedsRegion {
        region: &'static str,
    },
    CsrInvalid {
        detail: &'static str,
    },
    /// A page-aligned u32 array failed the checked `bytemuck::try_cast_slice`
    /// (misaligned start or `len % 4 != 0`) — corruption, never on a valid bundle.
    Misaligned {
        what: &'static str,
    },
    /// A bundle is missing a mandatory data region (e.g. `StopsSoA 0x40` /
    /// `RoutesSoA 0x41`). Unlike the regenerable `StopIndex 0x44` cache, these
    /// carry the feed's stops/routes — their absence is a hard error, not a
    /// fallback. `region` is the lowerCamel name (`region_ids::region_name_by_id`).
    MissingRequiredRegion {
        region: &'static str,
    },
    /// A decoded SoA coordinate column fell outside the WGS84 range (`lat_e7 ∉ [-900_000_000,
    /// 900_000_000]` or `lon_e7 ∉ [-1_800_000_000, 1_800_000_000]`). `axis` is `"lat_e7"` or
    /// `"lon_e7"`.
    CoordOutOfRange {
        axis: &'static str,
    },
    /// The tagged region table is structurally malformed (duplicate regionId, or
    /// the table did not terminate within the fixed header prefix).
    MalformedRegionTable {
        reason: &'static str,
    },
    /// The `0x01 WindowMeta` region is present but its content is invalid: a
    /// region shorter than the 2-byte `windowDays u16` (`"too_short"`, which must
    /// NOT masquerade as absent), or a decoded `windowDays` above
    /// `WINDOW_HARD_CEILING` (`"over_ceiling"`, the I7 corrupt-stride guard).
    WindowMetaInvalid {
        reason: &'static str,
    },
    /// The B2 service-bitfield storage is invalid: `"absent"` — a bundle MUST
    /// carry BOTH the `0x15 ServiceBitfieldPool` and `0x16 ServiceToBitfield`
    /// regions (the C3 absence hard-error, NOT a default-empty like the optional
    /// `0xFA`) — or one of the exact-size / capacity gates (C1/C2):
    /// `"pool_length"`, `"index_length"`, `"empty_pool"`, `"index_oob"`.
    ServiceBitfieldPoolInvalid {
        reason: &'static str,
    },
    /// The pattern band (`0x10`-`0x14` / `0x45`/`0x46`) is structurally
    /// malformed at load (B1.2 Task A). The band is OPTIONAL — when the `0x10`
    /// region is absent the reader resolves to no-band (Task B dispatches), so
    /// this fires only when a PRESENT band fails a hard gate: a count mismatch
    /// between `0x10` and `0x46`, a non-monotonic / wrong-terminal CSR, an
    /// out-of-range ordinal, a `0x13` length that disagrees with the per-pattern
    /// `T*(4 + 4S + ceil(S/8))` sum, or a too-short `0x10`/CSR prefix. `reason`
    /// names which gate failed.
    PatternBandInvalid {
        reason: &'static str,
    },
    /// A PTB v2 header sets a global `featureFlags` bit the reader does not
    /// understand (v2 readers fail closed on unknown bits).
    FeatureFlagsInvalid {
        flags: u16,
    },
    /// The mandatory PTB v2 `0x18 ServiceDayOrigins` region is absent,
    /// misaligned, the wrong length (`(effectiveWindowDays + 1) * 8`), or not
    /// strictly increasing. `reason` names the gate.
    ServiceDayOriginsInvalid {
        reason: &'static str,
    },
    /// A mandatory PTB v2 commitment region (`0x19 BlockDerivationCommitment`
    /// or `0x1A CompatibilityArtifactCommitment`) is absent, misaligned, the
    /// wrong size, has nonzero reserved bytes, or names an unknown algorithm.
    CommitmentInvalid {
        region: &'static str,
        reason: &'static str,
    },
    /// A PTB v2 `0xF8 Transfers` row violates the v2 row contract (nonzero
    /// reserved bytes, unknown `transfer_type`, an absent stop on a type 0-3
    /// row, a type 4/5 row without both trips, an out-of-range ordinal, or a
    /// trip that does not belong to the row's route). `row` is the PTB row
    /// ordinal.
    TransferRowInvalid {
        row: u32,
        reason: &'static str,
    },
    /// A PTB v2 `0x17 Frequencies` row breaks the v2 frequency contract.
    /// `row` is the PTB row ordinal.
    FrequencyRowInvalid {
        row: u32,
        reason: &'static str,
    },
    /// A PTB v2 `0x14 TripMeta` `block_idx` names no StringPool entry.
    TripMetaInvalid {
        reason: &'static str,
    },
}

impl fmt::Display for PtbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PtbError::BufferTooSmall { got, need } => {
                write!(f, "ptb: buffer too small — got {got} bytes, need ≥ {need}")
            }
            PtbError::BadMagic { got } => write!(f, "ptb: bad magic — got {got:?}"),
            PtbError::UnsupportedVersion { got } => write!(
                f,
                "ptb: unsupported version {got} — supported {} and {}",
                crate::PTB_VERSION_V1,
                crate::PTB_VERSION_V2
            ),
            PtbError::RegionOutOfBounds {
                region,
                offset,
                length,
                buf,
            } => write!(
                f,
                "ptb: {region} region out of bounds — offset={offset} length={length} buf={buf}"
            ),
            PtbError::RegionOffsetTooLarge { region } => {
                write!(f, "ptb: {region} region offset exceeds usize")
            }
            PtbError::SliceOutOfBounds { what } => write!(f, "ptb: {what} out of bounds"),
            PtbError::StringPoolMalformed { detail } => write!(f, "ptb: stringPool {detail}"),
            PtbError::StringIndexOutOfRange { idx, count } => write!(
                f,
                "ptb: string index out of range — idx={idx} count={count}"
            ),
            PtbError::Utf8 => write!(f, "ptb: invalid UTF-8 in StringPool"),
            PtbError::CountExceedsRegion { region } => {
                write!(f, "ptb: {region} count exceeds region capacity")
            }
            PtbError::CsrInvalid { detail } => write!(f, "ptb: CSR {detail}"),
            PtbError::Misaligned { what } => write!(f, "ptb: {what} misaligned for u32 cast"),
            PtbError::MissingRequiredRegion { region } => {
                write!(f, "ptb: required region {region} is absent")
            }
            PtbError::CoordOutOfRange { axis } => {
                write!(f, "ptb: {axis} coordinate column out of WGS84 range")
            }
            PtbError::MalformedRegionTable { reason } => {
                write!(f, "ptb: malformed region table ({reason})")
            }
            PtbError::WindowMetaInvalid { reason } => {
                write!(f, "ptb: invalid windowMeta region ({reason})")
            }
            PtbError::ServiceBitfieldPoolInvalid { reason } => {
                write!(f, "ptb: invalid serviceBitfieldPool ({reason})")
            }
            PtbError::PatternBandInvalid { reason } => {
                write!(f, "ptb: invalid pattern band ({reason})")
            }
            PtbError::FeatureFlagsInvalid { flags } => {
                write!(f, "ptb: v2 featureFlags {flags:#06x} set an unknown bit")
            }
            PtbError::ServiceDayOriginsInvalid { reason } => {
                write!(f, "ptb: invalid serviceDayOrigins ({reason})")
            }
            PtbError::CommitmentInvalid { region, reason } => {
                write!(f, "ptb: invalid {region} ({reason})")
            }
            PtbError::TransferRowInvalid { row, reason } => {
                write!(f, "ptb: invalid v2 transfer row {row} ({reason})")
            }
            PtbError::FrequencyRowInvalid { row, reason } => {
                write!(f, "ptb: invalid v2 frequency row {row} ({reason})")
            }
            PtbError::TripMetaInvalid { reason } => {
                write!(f, "ptb: invalid tripMeta ({reason})")
            }
        }
    }
}

impl core::error::Error for PtbError {}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;

    #[test]
    fn display_is_actionable() {
        let e = PtbError::UnsupportedVersion { got: 3 };
        assert_eq!(
            format!("{e}"),
            "ptb: unsupported version 3 — supported 1 and 2"
        );
    }
}
