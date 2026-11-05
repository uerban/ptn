//! crates/pt-core/src/strip_regions.rs — drop named regions from a `.ptb`
//! bundle, RE-PACKING the kept bodies at fresh page-aligned offsets.
//!
//! B1.5 carry-teardown tooling. The producer derives the pattern band from a
//! staging bundle that still carries the flat `0xF4 StopTimes` / `0xF5
//! TripStarts` / `0xF6 Csr` / `0xFA StopTimeBoarding` regions, then strips them
//! HERE so the published bundle is carry-less. The fixture writers use the same
//! call.
//!
//! `no_std` + `alloc`. The 4096-byte header PREFIX scalar fields (magic, version,
//! counts, dates, tz, featureFlags) are preserved verbatim; only the 24-byte
//! tagged region table (offset 32, regionId-0 terminator) is rewritten with the
//! kept entries pointing at recomputed offsets.
//!
//! Tagged-table entry layout (mirrors `header.rs::Header::parse`):
//! `regionId u16 @+0` · `entryFlags u16 @+2` · `reserved u32 @+4` ·
//! `offset u64 @+8` · `length u64 @+16` (24 B/entry); `regionId == 0` terminates.

use alloc::vec;
use alloc::vec::Vec;

use crate::error::{PtbError, Result};
use crate::{PTB_HEADER_BYTES, PTB_MAGIC};

const REGION_TABLE_OFFSET: usize = 32;
const ENTRY_BYTES: usize = 24;
const PAGE: usize = 4096;

#[inline]
fn align_up(n: usize, a: usize) -> usize {
    n.div_ceil(a) * a
}

/// Drop the regions named in `drop_ids` from the `.ptb` `buf`,
/// re-packing the KEPT region bodies into a fresh buffer at recomputed
/// PAGE-aligned offsets and rewriting the tagged table to match.
///
/// The 4096-byte header prefix scalar fields (version / counts / dates / tz /
/// featureFlags — everything in `[0..32)`) are copied verbatim; the tagged region
/// table (`[32..)`) is rewritten with the kept entries (new offsets, preserved
/// `entryFlags`/`reserved`) + a `regionId == 0` terminator. Kept bodies are
/// emitted in their ORIGINAL table order, each placed at the next page boundary
/// (matching every `.ptb` writer's page-aligned body discipline), so a
/// `Reader::from_bytes` over the result exposes all kept regions and none of the
/// dropped ones.
///
/// Errors: an unsupported version (`UnsupportedVersion`), a header shorter
/// than 4096 B (`BufferTooSmall`), a bad magic (`BadMagic`), an unterminated /
/// overlong table (`MalformedRegionTable`), or a kept body whose recorded
/// offset/length falls outside `buf` (`RegionOutOfBounds`).
pub fn strip_regions(buf: Vec<u8>, drop_ids: &[u16]) -> Result<Vec<u8>> {
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
    let version = u16::from_le_bytes(buf[4..6].try_into().unwrap());
    if !crate::header::is_supported_version(version) {
        return Err(PtbError::UnsupportedVersion { got: version });
    }

    // Parse the tagged table: 24 B entries from offset 32, regionId 0 terminates.
    // Keep the (id, entryFlags, offset, length) of every entry whose id is NOT in
    // `drop_ids`, in table order. Bounds-check each kept body against `buf`.
    let mut kept: Vec<(u16, u16, usize, usize)> = Vec::new();
    let mut i = 0usize;
    loop {
        let e = REGION_TABLE_OFFSET + i * ENTRY_BYTES;
        if e + ENTRY_BYTES > PTB_HEADER_BYTES {
            // A well-formed table hits its regionId-0 terminator before the header
            // prefix ends; running off it means the table is unterminated.
            return Err(PtbError::MalformedRegionTable {
                reason: "unterminated",
            });
        }
        let region_id = u16::from_le_bytes(buf[e..e + 2].try_into().unwrap());
        if region_id == 0 {
            break; // terminator
        }
        let entry_flags = u16::from_le_bytes(buf[e + 2..e + 4].try_into().unwrap());
        let offset = u64::from_le_bytes(buf[e + 8..e + 16].try_into().unwrap());
        let length = u64::from_le_bytes(buf[e + 16..e + 24].try_into().unwrap());
        let (offset, length) = match (usize::try_from(offset), usize::try_from(length)) {
            (Ok(o), Ok(l)) => (o, l),
            _ => {
                return Err(PtbError::RegionOffsetTooLarge {
                    region: "strip_regions entry",
                })
            }
        };
        if !drop_ids.contains(&region_id) {
            if offset.checked_add(length).is_none_or(|end| end > buf.len()) {
                return Err(PtbError::RegionOutOfBounds {
                    region: "strip_regions kept body",
                    offset: offset as u64,
                    length: length as u64,
                    buf: buf.len(),
                });
            }
            kept.push((region_id, entry_flags, offset, length));
        }
        i += 1;
    }

    // The rewritten table must still fit a kept-entries + terminator table inside
    // the 4096-byte header. Kept count <= original count, so this holds for any
    // bundle a real producer emitted, but guard it explicitly.
    let table_bytes = (kept.len() + 1) * ENTRY_BYTES; // +1 for the regionId-0 terminator
    if REGION_TABLE_OFFSET + table_bytes > PTB_HEADER_BYTES {
        return Err(PtbError::MalformedRegionTable {
            reason: "kept_table_overflow",
        });
    }

    // Lay out the new buffer: 4096 B header, then each kept body page-aligned in
    // table order. Compute the new offsets first so the table can be written with
    // them.
    let mut cursor = PTB_HEADER_BYTES;
    let mut new_off: Vec<usize> = Vec::with_capacity(kept.len());
    for &(_, _, _, length) in &kept {
        let off = align_up(cursor, PAGE);
        new_off.push(off);
        cursor = off + length;
    }
    let total = align_up(cursor, PAGE);

    let mut out = vec![0u8; total];
    // Header prefix scalar fields [0..32) verbatim (magic/version/counts/dates/tz).
    out[0..REGION_TABLE_OFFSET].copy_from_slice(&buf[0..REGION_TABLE_OFFSET]);

    // Rewrite the tagged table with the kept entries at their new offsets; the
    // remaining header bytes stay zero, so the entry AFTER the last kept one is
    // the regionId-0 terminator by construction.
    for (idx, &(region_id, entry_flags, src_off, length)) in kept.iter().enumerate() {
        let dst = new_off[idx];
        out[dst..dst + length].copy_from_slice(&buf[src_off..src_off + length]);
        let e = REGION_TABLE_OFFSET + idx * ENTRY_BYTES;
        out[e..e + 2].copy_from_slice(&region_id.to_le_bytes());
        out[e + 2..e + 4].copy_from_slice(&entry_flags.to_le_bytes());
        // reserved u32 @+4 stays 0.
        out[e + 8..e + 16].copy_from_slice(&(dst as u64).to_le_bytes());
        out[e + 16..e + 24].copy_from_slice(&(length as u64).to_le_bytes());
    }

    Ok(out)
}

/// One edit for [`rewrite_regions`].
#[derive(Debug, Clone)]
pub enum RegionEdit<'a> {
    /// Replace an existing region's body (keeping its table position and
    /// `entryFlags`), or append it at the end of the table when absent.
    Set(u16, &'a [u8]),
    /// As [`RegionEdit::Set`], also setting the entry's `entryFlags` (e.g. the
    /// `0x13 TripTimes` i32-delta width bit).
    SetWithFlags(u16, u16, &'a [u8]),
    /// Drop the region (a no-op when absent).
    Remove(u16),
}

/// Re-pack a `.ptb` bundle with region edits and new header scalars.
///
/// Kept bodies keep their table order; a `Set` of an absent id is appended
/// after them in edit order. Every body lands page-aligned (so the 8-byte
/// alignment the PTB v2 `0x18`/`0x19`/`0x1A` regions require holds by
/// construction). `version` and `feature_flags` overwrite header bytes `[4..8)`;
/// every other prefix byte is copied verbatim. This is how the producer and the
/// fixture writers assemble a PTB v2 bundle from the v1-layout staging bytes
/// without a second hand-written layout.
pub fn rewrite_regions(
    buf: &[u8],
    version: u16,
    feature_flags: u16,
    edits: &[RegionEdit<'_>],
) -> Result<Vec<u8>> {
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
    if !crate::header::is_supported_version(version) {
        return Err(PtbError::UnsupportedVersion { got: version });
    }
    // (id, entryFlags, body)
    let mut out_regions: Vec<(u16, u16, &[u8])> = Vec::new();
    let mut i = 0usize;
    loop {
        let e = REGION_TABLE_OFFSET + i * ENTRY_BYTES;
        if e + ENTRY_BYTES > PTB_HEADER_BYTES {
            return Err(PtbError::MalformedRegionTable {
                reason: "unterminated",
            });
        }
        let region_id = u16::from_le_bytes(buf[e..e + 2].try_into().unwrap());
        if region_id == 0 {
            break;
        }
        let entry_flags = u16::from_le_bytes(buf[e + 2..e + 4].try_into().unwrap());
        let offset = u64::from_le_bytes(buf[e + 8..e + 16].try_into().unwrap());
        let length = u64::from_le_bytes(buf[e + 16..e + 24].try_into().unwrap());
        let (offset, length) = match (usize::try_from(offset), usize::try_from(length)) {
            (Ok(o), Ok(l)) => (o, l),
            _ => {
                return Err(PtbError::RegionOffsetTooLarge {
                    region: "rewrite_regions entry",
                })
            }
        };
        if offset.checked_add(length).is_none_or(|end| end > buf.len()) {
            return Err(PtbError::RegionOutOfBounds {
                region: "rewrite_regions body",
                offset: offset as u64,
                length: length as u64,
                buf: buf.len(),
            });
        }
        out_regions.push((region_id, entry_flags, &buf[offset..offset + length]));
        i += 1;
    }
    for edit in edits {
        match *edit {
            RegionEdit::Remove(id) => out_regions.retain(|(rid, _, _)| *rid != id),
            RegionEdit::Set(id, body) => {
                if let Some(slot) = out_regions.iter_mut().find(|(rid, _, _)| *rid == id) {
                    slot.2 = body;
                } else {
                    out_regions.push((id, 0, body));
                }
            }
            RegionEdit::SetWithFlags(id, flags, body) => {
                if let Some(slot) = out_regions.iter_mut().find(|(rid, _, _)| *rid == id) {
                    slot.1 = flags;
                    slot.2 = body;
                } else {
                    out_regions.push((id, flags, body));
                }
            }
        }
    }
    let table_bytes = (out_regions.len() + 1) * ENTRY_BYTES;
    if REGION_TABLE_OFFSET + table_bytes > PTB_HEADER_BYTES {
        return Err(PtbError::MalformedRegionTable {
            reason: "kept_table_overflow",
        });
    }
    let mut cursor = PTB_HEADER_BYTES;
    let mut new_off: Vec<usize> = Vec::with_capacity(out_regions.len());
    for &(_, _, body) in &out_regions {
        let off = align_up(cursor, PAGE);
        new_off.push(off);
        cursor = off + body.len();
    }
    let total = align_up(cursor, PAGE);
    let mut out = vec![0u8; total];
    out[0..REGION_TABLE_OFFSET].copy_from_slice(&buf[0..REGION_TABLE_OFFSET]);
    out[4..6].copy_from_slice(&version.to_le_bytes());
    out[6..8].copy_from_slice(&feature_flags.to_le_bytes());
    for (idx, &(region_id, entry_flags, body)) in out_regions.iter().enumerate() {
        let dst = new_off[idx];
        out[dst..dst + body.len()].copy_from_slice(body);
        let e = REGION_TABLE_OFFSET + idx * ENTRY_BYTES;
        out[e..e + 2].copy_from_slice(&region_id.to_le_bytes());
        out[e + 2..e + 4].copy_from_slice(&entry_flags.to_le_bytes());
        out[e + 8..e + 16].copy_from_slice(&(dst as u64).to_le_bytes());
        out[e + 16..e + 24].copy_from_slice(&(body.len() as u64).to_le_bytes());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::testkit::{SoaRoute, SoaStop};
    use crate::header::Region;

    fn band_stops(n: u32) -> Vec<SoaStop<'static>> {
        const IDS: [&str; 5] = ["s0", "s1", "s2", "s3", "s4"];
        (0..n as usize)
            .map(|i| SoaStop {
                id: IDS[i],
                name: IDS[i],
                lat: 54.0 + i as f64 * 0.01,
                lon: 25.0 + i as f64 * 0.01,
                parent: None,
                wheelchair: 0,
            })
            .collect()
    }
    fn band_route() -> Vec<SoaRoute<'static>> {
        vec![SoaRoute {
            id: "R0",
            agency: "A0",
            short: "1",
            long: "Band",
            color: "",
            text_color: "",
            route_type: 3,
        }]
    }

    /// Round-trip: a `Reader` over `strip_regions(buf, &[ids])` exposes every kept
    /// region and none of the dropped, and the kept region bytes are byte-identical
    /// to the original. Exercised over a band bundle stripped of the four carry
    /// regions (`0xF4`/`0xF5`/`0xF6`/`0xFA`) — the B1.5 carry-teardown shape.
    #[test]
    fn strips_named_regions_and_keeps_the_rest() {
        // A band bundle that carries BOTH the flat carry and the band, plus a
        // non-default boarding column so `0xFA` is actually present to drop.
        let trips: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
        ];
        let stops = band_stops(3);
        let routes = band_route();
        // boarding: forbid pickup on the very first row so 0xFA is non-default.
        let boarding = {
            let st_rows: usize = trips.iter().map(|t| t.len()).sum();
            let mut b = vec![0x50u8; st_rows];
            b[0] = 0x51; // pickup_type=1 (forbidden) — non-default ⇒ 0xFA emitted
            b
        };
        let full = crate::engine::testkit::build_pattern_band_ptb_with_boarding(
            &stops,
            &routes,
            trips,
            &[],
            &boarding,
            &[],
        );

        // Sanity: the full bundle carries all four carries + the band.
        let rfull = crate::Reader::from_bytes(full.clone()).expect("full bundle decodes");
        assert!(rfull.pattern_band_present(), "full carries the band");
        assert!(rfull.has_boarding(), "full carries 0xFA");
        assert!(rfull.num_stop_times() > 0, "full carries 0xF4");

        let dropped: &[u16] = &[0xF4, 0xF5, 0xF6, 0xFA];
        let stripped = strip_regions(full.clone(), dropped).expect("strip succeeds");

        // The header prefix (version/counts/tz) is preserved verbatim.
        assert_eq!(&stripped[0..32], &full[0..32], "header prefix verbatim");

        // The stripped buffer no longer has any of the dropped tagged entries.
        let h = crate::header::Header::parse(&stripped).expect("stripped header parses");
        for &id in dropped {
            assert!(
                h.region_by_id(id).is_none(),
                "dropped region 0x{id:02X} absent from the table"
            );
        }
        // The kept regions are still addressable AND byte-identical.
        let hfull = crate::header::Header::parse(&full).expect("full header parses");
        for &id in &[
            crate::region_ids::STOPS_SOA,
            crate::region_ids::ROUTES_SOA,
            crate::region_ids::PATTERNS,
            crate::region_ids::PATTERN_STOPS,
            crate::region_ids::TRIP_TIMES,
            crate::region_ids::TRIP_META,
            crate::region_ids::PATTERNS_AT_STOP,
            crate::region_ids::PATTERN_TRIPS,
            0xF2u16, // TripsIntern carry — NOT dropped, must survive
            0xF7u16, // StringPool carry — NOT dropped
        ] {
            let kept = h
                .region_by_id(id)
                .unwrap_or_else(|| panic!("kept 0x{id:02X}"));
            let orig = hfull
                .region_by_id(id)
                .unwrap_or_else(|| panic!("orig 0x{id:02X}"));
            assert_eq!(kept.length, orig.length, "kept 0x{id:02X} length");
            assert_eq!(
                &stripped[kept.offset..kept.offset + kept.length],
                &full[orig.offset..orig.offset + orig.length],
                "kept 0x{id:02X} bytes identical"
            );
        }

        // The dropped carries are gone: their positional slots are zero-length, and
        // the band survives. (A full Reader load over the stripped bundle is the
        // carry-less reader's job — exercised in the equivalence test once the
        // load-time synthesis lands; here we only prove the strip mechanics.)
        assert_eq!(h.region(Region::StopTimes).length, 0, "0xF4 stripped");
        assert_eq!(h.region(Region::TripStarts).length, 0, "0xF5 stripped");
        assert_eq!(h.region(Region::Csr).length, 0, "0xF6 stripped");
        assert!(h.region_by_id(0xFA).is_none(), "0xFA stripped");
        assert!(
            h.region_by_id(crate::region_ids::PATTERNS).is_some(),
            "band survives"
        );
    }

    /// Any version other than the current one is a clean error, not a
    /// best-effort rewrite of a table layout this build does not read.
    #[test]
    fn rejects_unsupported_version() {
        let mut bytes = crate::engine::testkit::build_two_trip_ptb(
            2,
            &[(1, 0, 25200), (2, 1, 25500)],
            &[(1, 0, 28800), (2, 1, 29100)],
        );
        bytes[4..6].copy_from_slice(&5u16.to_le_bytes());
        let err = strip_regions(bytes, &[0xF4]).unwrap_err();
        assert!(
            matches!(err, PtbError::UnsupportedVersion { got: 5 }),
            "got {err:?}"
        );
    }
}
