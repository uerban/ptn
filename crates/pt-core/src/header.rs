use crate::error::{PtbError, Result};
use crate::records::{rd_u16, rd_u32};
use crate::region_ids;
use crate::{PTB_HEADER_BYTES, PTB_MAGIC};

const REGION_TABLE_OFFSET: usize = 32;
/// Tagged region table entry: `regionId u16, entryFlags u16, reserved u32,
/// offset u64, length u64`. docs/ptb-region-ids.md §1–§2.
const REGION_ENTRY_BYTES: usize = 24;

/// The record-format regions the reader addresses through [`Header::region`]:
/// the retained carries of the tagged `0xF2+` band (see [`CARRY_REGIONS`]). Every
/// other region (the SoA columns, the service pool, the pattern band, …) is
/// addressed by its frozen registry id through [`Header::region_by_id`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Region {
    TripsIntern = 0,
    StopTimes = 1,
    TripStarts = 2,
    Csr = 3,
    StringPool = 4,
    Transfers = 5,
}

impl Region {
    /// Stable wire-name for error messages. Total + compiler-checked (a new
    /// variant won't compile until it has a name here).
    pub fn name(self) -> &'static str {
        match self {
            Region::TripsIntern => "tripsIntern",
            Region::StopTimes => "stopTimes",
            Region::TripStarts => "tripStarts",
            Region::Csr => "csr",
            Region::StringPool => "stringPool",
            Region::Transfers => "transfers",
        }
    }
}

/// Carry region ids — NOT the frozen `docs/ptb-region-ids.md` registry. These
/// record regions keep their pre-SoA byte format under a distinct `0xF2+` band
/// that can never collide with the registry's allocations:
///
/// - `0xF2` TripsIntern (24 B trip records) and `0xF7` StringPool / `0xF8`
///   Transfers ride every bundle;
/// - `0xF4` StopTimes (SoA columns) / `0xF5` TripStarts / `0xF6` Csr ride the
///   producer's staging bundle only. The published bundle strips them once the
///   pattern band is derived (the carry-less layout).
pub const CARRY_REGIONS: [(u16, Region); 6] = [
    (0xF2, Region::TripsIntern),
    (0xF4, Region::StopTimes),
    (0xF5, Region::TripStarts),
    (0xF6, Region::Csr),
    (0xF7, Region::StringPool),
    (0xF8, Region::Transfers),
];

/// The `Region` a carry `regionId` maps to, or `None` if it is not a carry id
/// (read those via `region_by_id`).
#[inline]
pub fn carry_region(region_id: u16) -> Option<Region> {
    CARRY_REGIONS
        .iter()
        .find(|(id, _)| *id == region_id)
        .map(|(_, r)| *r)
}

/// Wire name of a tagged region id, for error messages.
fn tagged_region_name(region_id: u16) -> &'static str {
    match carry_region(region_id) {
        Some(r) => r.name(),
        None => region_ids::region_name_by_id(region_id),
    }
}

/// The ONE accept/reject gate `Header::parse` and `validate_header_quick` both
/// call, so the two can't drift. Versions 1 (frozen legacy semantics) and 2
/// (GTFS temporal/transfer foundation) are accepted; every other value fails
/// closed, including the pre-release 4..=9 layouts.
#[inline]
pub(crate) const fn is_supported_version(version: u16) -> bool {
    version == crate::PTB_VERSION_V1 || version == crate::PTB_VERSION_V2
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RegionEntry {
    pub offset: usize,
    pub length: usize,
    /// The tagged-table entry's `entryFlags u16` (at entry byte +2). Captured
    /// verbatim so consumers can branch on per-region feature bits (e.g. the
    /// B1.2 `0x13 TripTimes` dense/ragged selector — see
    /// `Reader::trip_times_entry_flags`). `0` for the zero-init defaults.
    pub entry_flags: u16,
}

#[derive(Debug, Clone)]
pub struct Header {
    pub version: u16,
    pub feed_start_date: u32,
    pub num_stops: u32,
    pub num_routes: u32,
    pub num_trips: u32,
    pub num_services: u32,
    /// STATIC UTC offset (seconds) at `feed_start_date`'s midnight UTC. This is an
    /// anchor-date snapshot, NOT a DST-correct runtime offset — for a DST city it
    /// is only valid for the half of the year matching `feed_start_date`'s DST
    /// state. It exists for pt-serve's load-time cross-check against Jiff's bundled tzdb;
    /// do NOT use it for wall-clock math (runtime tz must be IANA-driven).
    pub city_tz_offset_seconds: i32,
    /// Feature flags (`[6..8]`): bit0 hasFlex, bit1 hasFares. Per
    /// docs/ptb-region-ids.md §1.
    pub feature_flags: u16,
    /// Length (days) of the per-service service-bitmask window. Decoded from the
    /// `0x01 WindowMeta` region's LE `u16` at offset 0; the per-service bitmask
    /// stride is `bytes_per_service(window_days)`. Defaults to
    /// `WINDOW_DEFAULT_DAYS` (90) when the region is absent. A present region
    /// shorter than 2 bytes, or a value above `WINDOW_HARD_CEILING`, is a hard
    /// `PtbError::WindowMetaInvalid` at parse, never a silent fallback.
    pub window_days: u16,
    /// Carry entries indexed by `Region` discriminant (zero when absent).
    regions: [RegionEntry; 6],
    /// Every tagged-table entry: `(regionId, entry)`.
    tagged: alloc::vec::Vec<(u16, RegionEntry)>,
}

impl Header {
    pub fn parse(buf: &[u8]) -> Result<Header> {
        if buf.len() < PTB_HEADER_BYTES {
            return Err(PtbError::BufferTooSmall {
                got: buf.len(),
                need: PTB_HEADER_BYTES,
            });
        }
        let magic: [u8; 4] = buf[0..4].try_into().unwrap();
        if magic != PTB_MAGIC {
            return Err(PtbError::BadMagic { got: magic });
        }
        let version = rd_u16(buf, 4)?;
        if !is_supported_version(version) {
            return Err(PtbError::UnsupportedVersion { got: version });
        }

        let num_stops = rd_u32(buf, 8)?;
        let num_routes = rd_u32(buf, 12)?;
        let num_trips = rd_u32(buf, 16)?;
        let feed_start_date = rd_u32(buf, 20)?;
        let num_services = rd_u32(buf, 24)?;
        let city_tz_offset_seconds =
            i32::from_le_bytes(buf.get(28..32).and_then(|s| s.try_into().ok()).ok_or(
                PtbError::SliceOutOfBounds {
                    what: "city_tz_offset_seconds",
                },
            )?);
        // featureFlags @ [6..8]: bit0 hasFlex / bit1 hasFares / bit2 (v2 only)
        // DERIVE_BLOCK_INSEAT. docs/ptb-region-ids.md §1. A v2 reader rejects
        // every unknown global bit; v1 keeps its historical interpretation.
        let feature_flags = rd_u16(buf, 6)?;
        if version == crate::PTB_VERSION_V2 && feature_flags & !crate::FEATURE_FLAGS_KNOWN_V2 != 0 {
            return Err(PtbError::FeatureFlagsInvalid {
                flags: feature_flags,
            });
        }

        // Self-describing tagged table — 24 B entries addressed by regionId;
        // regionId 0 terminates the table. docs/ptb-region-ids.md §1–§2.
        let mut regions = [RegionEntry::default(); 6];
        let mut tagged: alloc::vec::Vec<(u16, RegionEntry)> = alloc::vec::Vec::new();
        let mut i = 0usize;
        loop {
            let e = REGION_TABLE_OFFSET + i * REGION_ENTRY_BYTES;
            if e + REGION_ENTRY_BYTES > PTB_HEADER_BYTES {
                // A well-formed table hits its regionId == 0 terminator well
                // before the 4096 B header prefix ends; running off the prefix
                // means the table is unterminated. Entries are scanned at the
                // fixed 24-byte stride.
                return Err(PtbError::MalformedRegionTable {
                    reason: "unterminated",
                });
            }
            let region_id = rd_u16(buf, e)?;
            if region_id == 0 {
                break; // regionId 0 is reserved as the table terminator
            }
            // entryFlags u16 @ e+2: per-region feature bits, e.g. the B1.2 `0x13`
            // dense/ragged TripTimes selector. docs/ptb-region-ids.md §1–§2.
            let entry_flags = rd_u16(buf, e + 2)?;
            // Uniqueness over ALL ids. Bounded by PTB_HEADER_BYTES / 24 (~170)
            // since the scan caps at the header.
            if tagged.iter().any(|(id, _)| *id == region_id) {
                return Err(PtbError::MalformedRegionTable {
                    reason: "dup_region_id",
                });
            }
            let name = tagged_region_name(region_id);
            let field = |at: usize| -> Result<u64> {
                Ok(u64::from_le_bytes(
                    buf.get(at..at + 8).and_then(|s| s.try_into().ok()).ok_or(
                        PtbError::SliceOutOfBounds {
                            what: "region table",
                        },
                    )?,
                ))
            };
            let (off, len) = (field(e + 8)?, field(e + 16)?);
            let (offset, length) = match (usize::try_from(off), usize::try_from(len)) {
                (Ok(o), Ok(l)) => (o, l),
                _ => return Err(PtbError::RegionOffsetTooLarge { region: name }),
            };
            if offset.checked_add(length).is_none_or(|end| end > buf.len()) {
                return Err(PtbError::RegionOutOfBounds {
                    region: name,
                    offset: off,
                    length: len,
                    buf: buf.len(),
                });
            }
            let entry = RegionEntry {
                offset,
                length,
                entry_flags,
            };
            if let Some(r) = carry_region(region_id) {
                regions[r as usize] = entry;
            }
            tagged.push((region_id, entry));
            i += 1;
        }

        // windowDays from the `0x01 WindowMeta` region. The LE u16 read at offset
        // 0 mirrors the `0xFA` decode precedent (reader.rs). A present region
        // shorter than the u16, or a value above the hard ceiling, is a hard
        // error: a malformed region must NOT masquerade as absent (silent 90),
        // and a real producer never emits above the ceiling (I7 corrupt-stride
        // guard). Frozen registry: docs/ptb-region-ids.md §4.
        let window_days = match tagged
            .iter()
            .find(|(id, _)| *id == region_ids::WINDOW_META)
            .map(|(_, e)| *e)
        {
            None => crate::WINDOW_DEFAULT_DAYS,
            Some(e) => {
                if e.length < 2 {
                    return Err(PtbError::WindowMetaInvalid {
                        reason: "too_short",
                    });
                }
                let w = rd_u16(buf, e.offset)?;
                if w > crate::WINDOW_HARD_CEILING {
                    return Err(PtbError::WindowMetaInvalid {
                        reason: "over_ceiling",
                    });
                }
                w
            }
        };

        Ok(Header {
            version,
            feed_start_date,
            num_stops,
            num_routes,
            num_trips,
            num_services,
            city_tz_offset_seconds,
            feature_flags,
            window_days,
            regions,
            tagged,
        })
    }

    /// Whether this is a PTB v2 bundle (full GTFS temporal/transfer semantics).
    #[inline]
    pub fn is_v2(&self) -> bool {
        self.version == crate::PTB_VERSION_V2
    }

    /// PTB v2 `DERIVE_BLOCK_INSEAT` (`featureFlags` bit2). Always `false` on a v1
    /// bundle, whose block derivation is producer-emitted rows.
    #[inline]
    pub fn derive_block_inseat(&self) -> bool {
        self.is_v2() && self.feature_flags & crate::FEATURE_DERIVE_BLOCK_INSEAT != 0
    }

    /// A carry region's entry (zero-length when the bundle omits it).
    #[inline]
    pub fn region(&self, r: Region) -> RegionEntry {
        self.regions[r as usize]
    }

    /// Region lookup by `regionId` (absent ⇒ `None`, i.e. an empty region).
    #[inline]
    pub fn region_by_id(&self, region_id: u16) -> Option<RegionEntry> {
        self.tagged
            .iter()
            .find(|(id, _)| *id == region_id)
            .map(|(_, e)| *e)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use alloc::vec;

    /// `is_supported_version` — the single accept/reject gate — accepts only
    /// the current layout version.
    #[test]
    fn is_supported_version_accepts_only_current() {
        assert!(is_supported_version(crate::PTB_VERSION_V1));
        assert!(is_supported_version(crate::PTB_VERSION_V2));
        for v in [0u16, 3, 4, 5, 6, 7, 8, 9, 10, u16::MAX] {
            assert!(!is_supported_version(v), "version {v} must be rejected");
        }
    }

    /// A 4096 B header with the given `feature_flags` and an EMPTY tagged table
    /// (the first 24 B entry at `[32..56]` is all-zero ⇒ regionId 0 terminates
    /// immediately).
    fn min_header(feature_flags: u16) -> alloc::vec::Vec<u8> {
        let mut b = vec![0u8; 4096];
        b[0..4].copy_from_slice(&crate::PTB_MAGIC);
        b[4..6].copy_from_slice(&crate::PTB_VERSION_V1.to_le_bytes());
        b[6..8].copy_from_slice(&feature_flags.to_le_bytes());
        b[8..12].copy_from_slice(&3u32.to_le_bytes()); // stops
        b[12..16].copy_from_slice(&2u32.to_le_bytes()); // routes
        b[16..20].copy_from_slice(&4u32.to_le_bytes()); // trips
        b[20..24].copy_from_slice(&20260501u32.to_le_bytes());
        b[24..28].copy_from_slice(&2u32.to_le_bytes()); // services
        b[28..32].copy_from_slice(&7200i32.to_le_bytes()); // city_tz_offset_seconds
        b
    }

    /// Write `(regionId, entryFlags, offset, length)` entries into the table.
    fn write_entries(b: &mut [u8], entries: &[(u16, u16, u64, u64)]) {
        for (i, &(id, flags, off, len)) in entries.iter().enumerate() {
            let e = 32 + i * 24;
            b[e..e + 2].copy_from_slice(&id.to_le_bytes());
            b[e + 2..e + 4].copy_from_slice(&flags.to_le_bytes());
            b[e + 8..e + 16].copy_from_slice(&off.to_le_bytes());
            b[e + 16..e + 24].copy_from_slice(&len.to_le_bytes());
        }
    }

    #[test]
    fn parses_header_fields() {
        let h = Header::parse(&min_header(0)).expect("header should parse");
        assert_eq!(h.version, crate::PTB_VERSION_V1);
        assert_eq!(h.num_stops, 3);
        assert_eq!(h.num_routes, 2);
        assert_eq!(h.num_trips, 4);
        assert_eq!(h.num_services, 2);
        assert_eq!(h.feed_start_date, 20260501);
        assert_eq!(h.city_tz_offset_seconds, 7200);
    }

    #[test]
    fn rejects_bad_magic_and_every_other_version() {
        let mut b = min_header(0);
        b[2] = 0x4E; // -> "PTNB"-ish, breaks magic
        assert!(matches!(
            Header::parse(&b),
            Err(crate::PtbError::BadMagic { .. })
        ));
        // The pre-v1 layouts (4..=9) and every other value fail closed.
        for bad in [0u16, 3, 4, 5, 6, 7, 8, 9, 10] {
            let mut b = min_header(0);
            b[4..6].copy_from_slice(&bad.to_le_bytes());
            assert!(
                matches!(Header::parse(&b), Err(PtbError::UnsupportedVersion { got }) if got == bad),
                "version {bad} must be rejected"
            );
        }
    }

    #[test]
    fn v2_rejects_unknown_feature_bits_and_v1_keeps_its_interpretation() {
        let mut b = min_header(crate::FEATURE_DERIVE_BLOCK_INSEAT | 0b11);
        b[4..6].copy_from_slice(&crate::PTB_VERSION_V2.to_le_bytes());
        let h = Header::parse(&b).expect("known v2 bits parse");
        assert!(h.is_v2());
        assert!(h.derive_block_inseat());
        for bit in 3..16 {
            let mut b = min_header(1 << bit);
            b[4..6].copy_from_slice(&crate::PTB_VERSION_V2.to_le_bytes());
            assert!(
                matches!(Header::parse(&b), Err(PtbError::FeatureFlagsInvalid { .. })),
                "v2 bit {bit} must be rejected"
            );
        }
        // v1 never interprets bit2 as derivation authority and keeps its
        // historical unchecked reserved bits.
        let h = Header::parse(&min_header(crate::FEATURE_DERIVE_BLOCK_INSEAT | 0x80)).unwrap();
        assert!(!h.is_v2());
        assert!(!h.derive_block_inseat());
    }

    #[test]
    fn parses_tagged_region_table_and_feature_flags() {
        let mut b = min_header(0b11); // hasFlex | hasFares
        write_entries(&mut b, &[(0x44, 0, 2048, 128)]);
        let h = Header::parse(&b).expect("header should parse");
        assert_eq!(h.feature_flags, 0b11, "featureFlags read from [6..8]");
        let si = h.region_by_id(0x44).expect("StopIndex region present");
        assert_eq!(si.offset, 2048);
        assert_eq!(si.length, 128);
        assert!(h.region_by_id(0x99).is_none(), "absent regionId => None");
    }

    #[test]
    fn captures_entry_flags_from_tagged_entry() {
        // B1.2 Task A: the 24 B region-table entry carries `entryFlags u16 @2`,
        // which `Header::parse` MUST capture into `RegionEntry.entry_flags`. Two
        // entries: 0x13 TripTimes with a NON-zero entryFlags, and 0x44 with zero.
        let mut b = min_header(0);
        write_entries(&mut b, &[(0x13, 0x0001, 2048, 64), (0x44, 0, 2112, 32)]);
        let h = Header::parse(&b).expect("header should parse");
        let tt = h.region_by_id(0x13).expect("0x13 region present");
        assert_eq!(tt.entry_flags, 0x0001, "0x13 entryFlags captured from @+2");
        let si = h.region_by_id(0x44).expect("0x44 region present");
        assert_eq!(si.entry_flags, 0, "0x44 entryFlags is the default 0");
    }

    /// Carry ids fold into the `Region`-indexed slots so `region(Region::…)`
    /// resolves them; a non-carry id (StopIndex 0x44) is reached only via
    /// `region_by_id`.
    #[test]
    fn carry_ids_populate_carry_regions() {
        let mut b = min_header(0);
        let carry_id = |r: Region| CARRY_REGIONS.iter().find(|(_, rr)| *rr == r).unwrap().0;
        write_entries(
            &mut b,
            &[
                (carry_id(Region::TripsIntern), 0, 1000, 200),
                (carry_id(Region::StringPool), 0, 2000, 300),
                (0x44, 0, 3000, 120), // StopIndex — not a carry
            ],
        );
        let h = Header::parse(&b).expect("header should parse");
        assert_eq!(h.region(Region::TripsIntern).offset, 1000);
        assert_eq!(h.region(Region::TripsIntern).length, 200);
        assert_eq!(h.region(Region::StringPool).offset, 2000);
        assert_eq!(h.region(Region::StringPool).length, 300);
        // A carry absent from the table stays an empty slot.
        assert_eq!(h.region(Region::Csr).length, 0);
        let si = h.region_by_id(0x44).expect("StopIndex present");
        assert_eq!((si.offset, si.length), (3000, 120));
    }

    #[test]
    fn rejects_duplicate_region_id() {
        // Offsets/lengths are in-bounds so the ONLY rejection path is the dup
        // check, which fires on the 2nd 0x44 before the terminator is reached.
        let mut b = min_header(0);
        write_entries(&mut b, &[(0x44, 0, 1000, 12), (0x44, 0, 2000, 12)]);
        assert!(matches!(
            Header::parse(&b),
            Err(PtbError::MalformedRegionTable {
                reason: "dup_region_id"
            })
        ));
    }

    #[test]
    fn region_out_of_bounds_names_the_region() {
        let mut b = min_header(0);
        write_entries(&mut b, &[(crate::region_ids::STOPS_SOA, 0, 8192, 21)]);
        assert!(matches!(
            Header::parse(&b),
            Err(PtbError::RegionOutOfBounds {
                region: "stopsSoA",
                ..
            })
        ));
        let mut b = min_header(0);
        write_entries(&mut b, &[(0xF6, 0, 8192, 4)]);
        assert!(matches!(
            Header::parse(&b),
            Err(PtbError::RegionOutOfBounds { region: "csr", .. })
        ));
    }

    #[test]
    fn rejects_table_unterminated_within_header() {
        // Fill EVERY 24-B slot from offset 32 to 4096 with a UNIQUE nonzero
        // regionId so the loop never sees a 0 terminator inside the header
        // prefix. Offsets/lengths must be IN-BOUNDS, else the per-entry bounds
        // check fires first and returns RegionOutOfBounds instead.
        let mut b = min_header(0);
        b.resize(16384, 0);
        let mut e = 32;
        let mut id = 0x50u16;
        while e + 24 <= crate::PTB_HEADER_BYTES {
            b[e..e + 2].copy_from_slice(&id.to_le_bytes());
            b[e + 8..e + 16].copy_from_slice(&8192u64.to_le_bytes());
            b[e + 16..e + 24].copy_from_slice(&1u64.to_le_bytes());
            e += 24;
            id += 1; // unique ids so uniqueness doesn't trip first
        }
        assert!(matches!(
            Header::parse(&b),
            Err(PtbError::MalformedRegionTable {
                reason: "unterminated"
            })
        ));
    }

    /// Write a single `0x01 WindowMeta` tagged entry at table slot 0, pointing
    /// at an in-bounds region whose first `payload.len()` bytes are `payload`.
    fn with_window_meta(payload: &[u8]) -> alloc::vec::Vec<u8> {
        let mut b = min_header(0);
        b.resize(8192, 0);
        let region_off = 4096usize;
        write_entries(
            &mut b,
            &[(
                region_ids::WINDOW_META,
                0,
                region_off as u64,
                payload.len() as u64,
            )],
        );
        b[region_off..region_off + payload.len()].copy_from_slice(payload);
        b
    }

    #[test]
    fn window_meta_absent_defaults_to_90() {
        let h = Header::parse(&min_header(0)).expect("header should parse");
        assert_eq!(h.window_days, crate::WINDOW_DEFAULT_DAYS);
        assert_eq!(h.window_days, 90);
    }

    #[test]
    fn window_meta_present_reads_le_u16() {
        // 0x01 = {400, reserved 0}: read the LE u16 at offset 0 ⇒ 400.
        let payload = [0x90u8, 0x01u8]; // 400 LE
        let h = Header::parse(&with_window_meta(&payload)).expect("parses");
        assert_eq!(h.window_days, 400);
    }

    #[test]
    fn window_meta_one_byte_is_hard_error_not_silent_90() {
        // A present-but-malformed (length < 2) region must NOT masquerade as
        // absent (silent 90) — it is a hard load error.
        let res = Header::parse(&with_window_meta(&[0x07u8]));
        assert!(
            matches!(res, Err(PtbError::WindowMetaInvalid { .. })),
            "expected WindowMetaInvalid, got {res:?}"
        );
    }

    #[test]
    fn window_meta_over_ceiling_is_hard_error() {
        // I7: a decoded windowDays just over WINDOW_HARD_CEILING (400) ⇒ hard
        // error. A real producer never emits above the ceiling; this blocks a
        // corrupt huge stride.
        let payload = (crate::WINDOW_HARD_CEILING + 1).to_le_bytes(); // 401 LE
        let res = Header::parse(&with_window_meta(&payload));
        assert!(
            matches!(res, Err(PtbError::WindowMetaInvalid { .. })),
            "expected WindowMetaInvalid, got {res:?}"
        );
    }

    #[test]
    fn window_meta_at_ceiling_is_accepted() {
        // Exactly the ceiling (400) is valid (the guard is `> ceiling`).
        let payload = crate::WINDOW_HARD_CEILING.to_le_bytes(); // 400 LE
        let h = Header::parse(&with_window_meta(&payload)).expect("parses");
        assert_eq!(h.window_days, 400);
    }
}
