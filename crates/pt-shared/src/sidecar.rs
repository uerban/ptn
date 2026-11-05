//! Shared binary-sidecar wire format (Stage C).
//!
//! All binary sidecars share a fixed 72-byte header: a 4-byte magic, a 1-byte
//! version, 3 pad bytes, then `tripsInternSha256` + `stopsInternSha256`. The
//! pad aligns the SHAs and the subsequent payload to a 4-byte boundary so a
//! consumer can `bytemuck::try_cast_slice` the `[u32]` payload after mmap.
//!
//! This module is the single source of truth for both the producer
//! (`pt-producer`) writer and the pt-serve consumer (Plan-C2) — they MUST
//! agree byte-for-byte, so the format lives here, not duplicated in each.

use std::fmt;

/// Fixed sidecar header size in bytes. magic[4] + version u8 + pad[3] + tripsInternSha256[32] +
/// stopsInternSha256[32].
pub const SIDECAR_HEADER_BYTES: usize = 72;

/// Current binary-sidecar format version. Bumped independently of PTB version.
pub const SIDECAR_VERSION: u8 = 1;

/// `departures-idx.bin` magic.
pub const DEPARTURES_IDX_MAGIC: [u8; 4] = *b"DPIX";

/// `shapes.bin` magic.
pub const SHAPES_MAGIC: [u8; 4] = *b"SHPB";

/// Parsed sidecar header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SidecarHeader {
    pub version: u8,
    pub trips_intern_sha256: [u8; 32],
    pub stops_intern_sha256: [u8; 32],
}

/// Errors from parsing/validating a binary sidecar.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SidecarError {
    /// File shorter than the bytes the header/payload requires.
    Truncated { need: usize, have: usize },
    /// Magic bytes did not match the expected sidecar kind.
    BadMagic { expected: [u8; 4], found: [u8; 4] },
    /// Header SHA fields did not match the bundle's interner SHAs.
    NamespaceShaMismatch { which: &'static str },
    /// CSR offsets array was not monotonically non-decreasing / out of range.
    MalformedCsr(&'static str),
}

/// DPIX payload layout from the untrusted header counts, overflow-checked:
/// `(entries_off, need)` or `None` when a product/sum would wrap `usize`.
fn dpix_layout(offsets_off: usize, num_stops: usize, num_entries: usize) -> Option<(usize, usize)> {
    let offsets_len = num_stops.checked_add(1)?.checked_mul(4)?;
    let entries_off = offsets_off.checked_add(offsets_len)?;
    let entries_len = num_entries.checked_mul(ENTRY_BYTES)?;
    let need = entries_off.checked_add(entries_len)?;
    Some((entries_off, need))
}

impl fmt::Display for SidecarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated { need, have } => {
                write!(f, "sidecar truncated: need {need} bytes, have {have}")
            }
            Self::BadMagic { expected, found } => {
                write!(
                    f,
                    "sidecar bad magic: expected {expected:?}, found {found:?}"
                )
            }
            Self::NamespaceShaMismatch { which } => {
                write!(f, "sidecar namespace SHA mismatch: {which}")
            }
            Self::MalformedCsr(why) => write!(f, "sidecar malformed CSR: {why}"),
        }
    }
}

impl std::error::Error for SidecarError {}

/// Write the 72-byte sidecar header into the front of `buf`.
///
/// `buf` must be at least `SIDECAR_HEADER_BYTES` long. Returns the header on
/// `Truncated` if not.
pub fn write_sidecar_header(
    buf: &mut [u8],
    magic: [u8; 4],
    version: u8,
    trips_intern_sha256: &[u8; 32],
    stops_intern_sha256: &[u8; 32],
) -> Result<(), SidecarError> {
    if buf.len() < SIDECAR_HEADER_BYTES {
        return Err(SidecarError::Truncated {
            need: SIDECAR_HEADER_BYTES,
            have: buf.len(),
        });
    }
    buf[0..4].copy_from_slice(&magic);
    buf[4] = version;
    buf[5..8].copy_from_slice(&[0, 0, 0]); // pad
    buf[8..40].copy_from_slice(trips_intern_sha256);
    buf[40..72].copy_from_slice(stops_intern_sha256);
    Ok(())
}

/// Parse + validate the 72-byte header. Rejects short input and a magic
/// mismatch; surfaces the version for the caller to gate on (a v2 sidecar
/// under a v1 reader is the caller's policy, not this function's).
pub fn parse_sidecar_header(
    bytes: &[u8],
    expected_magic: [u8; 4],
) -> Result<SidecarHeader, SidecarError> {
    if bytes.len() < SIDECAR_HEADER_BYTES {
        return Err(SidecarError::Truncated {
            need: SIDECAR_HEADER_BYTES,
            have: bytes.len(),
        });
    }
    let mut found = [0u8; 4];
    found.copy_from_slice(&bytes[0..4]);
    if found != expected_magic {
        return Err(SidecarError::BadMagic {
            expected: expected_magic,
            found,
        });
    }
    let mut trips = [0u8; 32];
    trips.copy_from_slice(&bytes[8..40]);
    let mut stops = [0u8; 32];
    stops.copy_from_slice(&bytes[40..72]);
    Ok(SidecarHeader {
        version: bytes[4],
        trips_intern_sha256: trips,
        stops_intern_sha256: stops,
    })
}

use sha2::{Digest, Sha256};

/// Canonical post-finalize byte form of an interner's key set: for each key, in sorted iteration
/// order, a `u32 LE` length prefix followed by the UTF-8 bytes. The caller passes keys already in
/// sorted post-finalize order (`InternTable::keys()` on the producer; the decoded interner on
/// pt-serve).
pub fn intern_canonical_bytes<S: AsRef<str>>(sorted_keys: &[S]) -> Vec<u8> {
    let mut out = Vec::new();
    for k in sorted_keys {
        let b = k.as_ref().as_bytes();
        out.extend_from_slice(&(b.len() as u32).to_le_bytes());
        out.extend_from_slice(b);
    }
    out
}

/// SHA-256 over `intern_canonical_bytes(sorted_keys)`.
pub fn intern_namespace_sha256<S: AsRef<str>>(sorted_keys: &[S]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for k in sorted_keys {
        let b = k.as_ref().as_bytes();
        hasher.update((b.len() as u32).to_le_bytes());
        hasher.update(b);
    }
    hasher.finalize().into()
}

const COUNTS_BYTES: usize = 8; // num_stops u32 + num_entries u32
const ENTRY_BYTES: usize = 8; // (trip_idx u32, stopTimeIdx u32)

/// Encode a per-stop CSR into a complete `departures-idx.bin` byte buffer.
///
/// `offsets.len()` must equal `num_stops + 1`; `entries` is flat
/// `(trip_idx, stopTimeIdx)` pairs (length `2 * num_entries`), already grouped
/// by stop and sorted within each stop. Returns `MalformedCsr` if the offsets
/// are inconsistent with `entries`.
pub fn encode_departures_idx(
    offsets: &[u32],
    entries: &[u32],
    trips_intern_sha256: &[u8; 32],
    stops_intern_sha256: &[u8; 32],
) -> Result<Vec<u8>, SidecarError> {
    if offsets.is_empty() {
        return Err(SidecarError::MalformedCsr("offsets must have >= 1 entry"));
    }
    if !entries.len().is_multiple_of(2) {
        return Err(SidecarError::MalformedCsr("entries length must be even"));
    }
    let num_stops = offsets.len() - 1;
    let num_entries = entries.len() / 2;
    if offsets[num_stops] as usize != num_entries {
        return Err(SidecarError::MalformedCsr("offsets[last] != num_entries"));
    }

    let total = SIDECAR_HEADER_BYTES + COUNTS_BYTES + offsets.len() * 4 + entries.len() * 4;
    let mut buf = vec![0u8; total];
    write_sidecar_header(
        &mut buf,
        DEPARTURES_IDX_MAGIC,
        SIDECAR_VERSION,
        trips_intern_sha256,
        stops_intern_sha256,
    )?;

    let mut cur = SIDECAR_HEADER_BYTES;
    buf[cur..cur + 4].copy_from_slice(&(num_stops as u32).to_le_bytes());
    buf[cur + 4..cur + 8].copy_from_slice(&(num_entries as u32).to_le_bytes());
    cur += COUNTS_BYTES;
    for &o in offsets {
        buf[cur..cur + 4].copy_from_slice(&o.to_le_bytes());
        cur += 4;
    }
    for &e in entries {
        buf[cur..cur + 4].copy_from_slice(&e.to_le_bytes());
        cur += 4;
    }
    debug_assert_eq!(cur, total);
    Ok(buf)
}

/// Borrowed, validated view over `departures-idx.bin` bytes (e.g. an mmap).
/// Parsing validates the header magic, the namespace SHAs, the length, and
/// the CSR offsets monotonicity up front, so the accessors are panic-free.
pub struct DeparturesIdx<'a> {
    num_stops: usize,
    offsets: &'a [u8], // (num_stops+1) u32 LE
    entries: &'a [u8], // num_entries * (u32, u32) LE
}

impl<'a> DeparturesIdx<'a> {
    pub fn parse(
        bytes: &'a [u8],
        expect_trips_sha: &[u8; 32],
        expect_stops_sha: &[u8; 32],
    ) -> Result<Self, SidecarError> {
        let header = parse_sidecar_header(bytes, DEPARTURES_IDX_MAGIC)?;
        // Length/truncation checks come BEFORE the namespace-SHA compare so a
        // truncated file reports `Truncated` (the primary integrity signal C2's
        // telemetry keys on), not a misleading `NamespaceShaMismatch`.
        let min = SIDECAR_HEADER_BYTES + COUNTS_BYTES;
        if bytes.len() < min {
            return Err(SidecarError::Truncated {
                need: min,
                have: bytes.len(),
            });
        }
        let num_stops = u32_at(bytes, SIDECAR_HEADER_BYTES) as usize;
        let num_entries = u32_at(bytes, SIDECAR_HEADER_BYTES + 4) as usize;
        let offsets_off = min;
        // Checked arithmetic on the untrusted u32 header counts: on a 32-bit
        // target (`usize == u32`, e.g. wasm) unchecked products can wrap to a
        // small `need`, slip past the truncation guard, and yield a
        // mis-sliced (in-bounds but wrong) view. Mirrors pt-core's reader.
        let Some((entries_off, need)) = dpix_layout(offsets_off, num_stops, num_entries) else {
            return Err(SidecarError::MalformedCsr("header counts overflow"));
        };
        if bytes.len() < need {
            return Err(SidecarError::Truncated {
                need,
                have: bytes.len(),
            });
        }
        // Namespace SHAs — only after the length is known sound.
        if &header.trips_intern_sha256 != expect_trips_sha {
            return Err(SidecarError::NamespaceShaMismatch { which: "trips" });
        }
        if &header.stops_intern_sha256 != expect_stops_sha {
            return Err(SidecarError::NamespaceShaMismatch { which: "stops" });
        }
        let offsets = &bytes[offsets_off..entries_off];
        let entries = &bytes[entries_off..need];
        // Validate offsets: offsets[0]==0, monotone non-decreasing,
        // offsets[last]==num_entries.
        if u32_at(offsets, 0) != 0 {
            return Err(SidecarError::MalformedCsr("offsets[0] != 0"));
        }
        for i in 0..num_stops {
            if u32_at(offsets, i * 4) > u32_at(offsets, (i + 1) * 4) {
                return Err(SidecarError::MalformedCsr("offsets not monotone"));
            }
        }
        if u32_at(offsets, num_stops * 4) as usize != num_entries {
            return Err(SidecarError::MalformedCsr("offsets[last] != num_entries"));
        }
        Ok(Self {
            num_stops,
            offsets,
            entries,
        })
    }

    /// Construct WITHOUT re-validating the namespace SHAs or the CSR
    /// monotonicity. The caller MUST have already proven the bytes parse via
    /// [`DeparturesIdx::parse`] (e.g. pt-serve validates once at generation
    /// load, then reconstructs per-request from the same retained mmap). The
    /// offsets/entries slices are split exactly as `parse` does, but the only
    /// guard here is the minimum-length truncation check on the counts +
    /// offsets/entries regions — enough to keep the accessors panic-free even
    /// if the caller's "already validated" contract were somehow violated
    /// (a malformed offset then yields empty/garbage entries, never a panic).
    pub fn parse_unchecked(bytes: &'a [u8]) -> Self {
        // Mirror `parse`'s offset arithmetic. If the bytes are too short (the
        // caller broke its contract), fall back to a 0-stop empty view rather
        // than indexing out of bounds.
        let min = SIDECAR_HEADER_BYTES + COUNTS_BYTES;
        if bytes.len() < min {
            return Self {
                num_stops: 0,
                offsets: &[],
                entries: &[],
            };
        }
        let num_stops = u32_at(bytes, SIDECAR_HEADER_BYTES) as usize;
        let num_entries = u32_at(bytes, SIDECAR_HEADER_BYTES + 4) as usize;
        let offsets_off = min;
        let Some((entries_off, need)) = dpix_layout(offsets_off, num_stops, num_entries) else {
            return Self {
                num_stops: 0,
                offsets: &[],
                entries: &[],
            };
        };
        if bytes.len() < need {
            return Self {
                num_stops: 0,
                offsets: &[],
                entries: &[],
            };
        }
        Self {
            num_stops,
            offsets: &bytes[offsets_off..entries_off],
            entries: &bytes[entries_off..need],
        }
    }

    pub fn num_stops(&self) -> usize {
        self.num_stops
    }

    /// `(trip_idx, stopTimeIdx)` pairs for a stop. Out-of-range `stop_idx`
    /// returns the empty slice via the leading bounds check.
    pub fn entries_for(&self, stop_idx: usize) -> Vec<(u32, u32)> {
        self.entries_iter(stop_idx).collect()
    }

    /// Zero-alloc iterator over a stop's `(trip_idx, stopTimeIdx)` pairs —
    /// identical results to [`entries_for`] without the intermediate `Vec`.
    /// Out-of-range `stop_idx` yields an empty iterator via the leading bounds
    /// check. Reuses the same CSR offset arithmetic as `parse`/`entries_for`.
    ///
    /// [`entries_for`]: DeparturesIdx::entries_for
    pub fn entries_iter(&self, stop_idx: usize) -> impl Iterator<Item = (u32, u32)> + '_ {
        // `parse` validates offset monotonicity + bounds at load, but
        // `parse_unchecked` (the per-request path) skips that, so clamp the
        // offset values against the available entry count here. This keeps the
        // iterator panic-free even on a malformed (already-mmapped) offset.
        let max_entries = self.entries.len() / ENTRY_BYTES;
        let (start, end) = if stop_idx >= self.num_stops {
            (0usize, 0usize)
        } else {
            let end = (u32_at(self.offsets, (stop_idx + 1) * 4) as usize).min(max_entries);
            let start = (u32_at(self.offsets, stop_idx * 4) as usize).min(end);
            (start, end)
        };
        (start..end).map(move |i| {
            let b = i * ENTRY_BYTES;
            (u32_at(self.entries, b), u32_at(self.entries, b + 4))
        })
    }
}

#[inline]
fn u32_at(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

/// ZigZag-encode a signed 32-bit int so small magnitudes (positive OR
/// negative) map to small unsigned values that varint-encode short. Inverse
/// of `zigzag_decode`.
#[inline]
pub fn zigzag_encode(n: i32) -> u32 {
    ((n << 1) ^ (n >> 31)) as u32
}

/// Inverse of `zigzag_encode`.
#[inline]
pub fn zigzag_decode(u: u32) -> i32 {
    ((u >> 1) as i32) ^ -((u & 1) as i32)
}

/// Append an unsigned LEB128 varint (1–5 bytes for a u32) to `out`.
pub fn write_varint(mut v: u32, out: &mut Vec<u8>) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
}

/// Read an unsigned LEB128 varint starting at `*cur`, advancing `*cur` past
/// it. Returns `None` if the buffer ends mid-varint (truncated) or the varint
/// runs longer than the 5 bytes a u32 can occupy (corrupt). The bounded loop
/// makes the reader panic-free on hostile/truncated mmap bytes.
pub fn read_varint(bytes: &[u8], cur: &mut usize) -> Option<u32> {
    let mut result: u32 = 0;
    let mut shift: u32 = 0;
    for _ in 0..5 {
        let byte = *bytes.get(*cur)?;
        *cur += 1;
        result |= ((byte & 0x7f) as u32) << shift;
        if byte & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
    }
    None // ran past 5 bytes without a terminator → corrupt
}

const SHAPES_COUNTS_BYTES: usize = 8; // num_shapes u32 + points_bytes u32

/// Quantize a degree value to 1e-5-degree integer units (~1.1 m). The f64
/// intermediate makes the rounding deterministic across architectures.
/// Shared by SHPB encoding and pack-manifest bboxes so both quantize identically.
#[inline]
pub fn quantize_deg(deg: f32) -> i32 {
    (deg as f64 * f64::from(crate::pack_manifest::E5)).round() as i32
}

/// Borrowed, crate-neutral view of one shape for `encode_shapes_bin`. Kept
/// free of any producer type so `pt-shared` does not depend on `pt-producer`.
/// `points` is `(lat, lon)` in degrees, in shape_pt_sequence order.
pub struct ShapeEncodeInput<'a> {
    pub shape_id: &'a str,
    pub points: &'a [(f32, f32)],
    pub trip_ref_count: u32,
}

/// Encode shapes into a complete `shapes.bin` byte buffer. `shapes` MUST be in
/// ascending `shape_id` order (the producer passes `parse_shapes_all`'s
/// BTreeMap order) so `ShapesBin::lookup` can binary-search the id pool.
pub fn encode_shapes_bin(
    shapes: &[ShapeEncodeInput<'_>],
    trips_intern_sha256: &[u8; 32],
    stops_intern_sha256: &[u8; 32],
) -> Result<Vec<u8>, SidecarError> {
    let num_shapes = shapes.len();
    debug_assert!(
        shapes.windows(2).all(|w| w[0].shape_id <= w[1].shape_id),
        "encode_shapes_bin: shapes must be in ascending shape_id order"
    );

    let mut id_pool: Vec<u8> = Vec::new();
    let mut id_offsets: Vec<u32> = Vec::with_capacity(num_shapes + 1);
    id_offsets.push(0);
    for s in shapes {
        id_pool.extend_from_slice(s.shape_id.as_bytes());
        let off = u32::try_from(id_pool.len())
            .map_err(|_| SidecarError::MalformedCsr("shapes id pool exceeds u32"))?;
        id_offsets.push(off);
    }

    let mut points: Vec<u8> = Vec::new();
    let mut point_byte_offsets: Vec<u32> = Vec::with_capacity(num_shapes + 1);
    let mut point_counts: Vec<u32> = Vec::with_capacity(num_shapes);
    point_byte_offsets.push(0);
    for s in shapes {
        let count = u32::try_from(s.points.len())
            .map_err(|_| SidecarError::MalformedCsr("shape point count exceeds u32"))?;
        point_counts.push(count);
        if let Some(&(lat0, lon0)) = s.points.first() {
            let (mut prev_lat, mut prev_lon) = (quantize_deg(lat0), quantize_deg(lon0));
            points.extend_from_slice(&prev_lat.to_le_bytes());
            points.extend_from_slice(&prev_lon.to_le_bytes());
            for &(lat, lon) in &s.points[1..] {
                let (qlat, qlon) = (quantize_deg(lat), quantize_deg(lon));
                write_varint(zigzag_encode(qlat.wrapping_sub(prev_lat)), &mut points);
                write_varint(zigzag_encode(qlon.wrapping_sub(prev_lon)), &mut points);
                prev_lat = qlat;
                prev_lon = qlon;
            }
        }
        let off = u32::try_from(points.len())
            .map_err(|_| SidecarError::MalformedCsr("shapes points region exceeds u32"))?;
        point_byte_offsets.push(off);
    }

    let trip_ref_counts: Vec<u32> = shapes.iter().map(|s| s.trip_ref_count).collect();
    let id_pool_len = id_pool.len();
    let pad = (4 - (id_pool_len % 4)) % 4;

    let mut buf = vec![0u8; SIDECAR_HEADER_BYTES];
    write_sidecar_header(
        &mut buf,
        SHAPES_MAGIC,
        SIDECAR_VERSION,
        trips_intern_sha256,
        stops_intern_sha256,
    )?;
    buf.extend_from_slice(&(num_shapes as u32).to_le_bytes());
    buf.extend_from_slice(&(points.len() as u32).to_le_bytes()); // points.len() validated u32-safe by the try_from in the loop above
    for &v in &id_offsets {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    for &v in &point_byte_offsets {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    for &v in &point_counts {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    for &v in &trip_ref_counts {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    buf.extend_from_slice(&id_pool);
    buf.resize(buf.len() + pad, 0); // zero-pad to the next 4-byte boundary
    debug_assert_eq!(buf.len() % 4, 0, "points region must start u32-aligned");
    buf.extend_from_slice(&points);
    Ok(buf)
}

/// Borrowed, validated view over `shapes.bin` bytes (e.g. an mmap). Parsing
/// validates the magic, namespace SHAs, and the full length up front, so the
/// accessors are panic-free for `0..num_shapes`.
pub struct ShapesBin<'a> {
    num_shapes: usize,
    id_offsets: &'a [u8],         // (num_shapes+1) u32 LE
    point_byte_offsets: &'a [u8], // (num_shapes+1) u32 LE
    point_counts: &'a [u8],       // num_shapes u32 LE
    trip_ref_counts: &'a [u8],    // num_shapes u32 LE
    id_pool: &'a [u8],
    points: &'a [u8],
}

impl<'a> ShapesBin<'a> {
    pub fn parse(
        bytes: &'a [u8],
        expect_trips_sha: &[u8; 32],
        expect_stops_sha: &[u8; 32],
    ) -> Result<Self, SidecarError> {
        let header = parse_sidecar_header(bytes, SHAPES_MAGIC)?;
        let min = SIDECAR_HEADER_BYTES + SHAPES_COUNTS_BYTES;
        if bytes.len() < min {
            return Err(SidecarError::Truncated {
                need: min,
                have: bytes.len(),
            });
        }
        let num_shapes = u32_at(bytes, SIDECAR_HEADER_BYTES) as usize;
        let points_bytes = u32_at(bytes, SIDECAR_HEADER_BYTES + 4) as usize;

        let id_off_at = min;
        let id_off_len = (num_shapes + 1) * 4;
        let pbo_at = id_off_at + id_off_len;
        let pbo_len = (num_shapes + 1) * 4;
        let pc_at = pbo_at + pbo_len;
        let pc_len = num_shapes * 4;
        let trc_at = pc_at + pc_len;
        let trc_len = num_shapes * 4;
        let pool_at = trc_at + trc_len;

        if bytes.len() < pool_at {
            return Err(SidecarError::Truncated {
                need: pool_at,
                have: bytes.len(),
            });
        }
        let id_offsets = &bytes[id_off_at..pbo_at];
        let id_pool_len = u32_at(id_offsets, num_shapes * 4) as usize; // sentinel
        let pad = (4 - (id_pool_len % 4)) % 4;
        let points_at = pool_at + id_pool_len + pad;
        let need = points_at + points_bytes;
        if bytes.len() < need {
            return Err(SidecarError::Truncated {
                need,
                have: bytes.len(),
            });
        }
        // Namespace SHAs are compared AFTER the length/truncation checks above so
        // a truncated file reports `Truncated` (the primary integrity signal C2's
        // telemetry keys on), not a misleading `NamespaceShaMismatch` — same
        // ordering as `DeparturesIdx::parse`.
        if &header.trips_intern_sha256 != expect_trips_sha {
            return Err(SidecarError::NamespaceShaMismatch { which: "trips" });
        }
        if &header.stops_intern_sha256 != expect_stops_sha {
            return Err(SidecarError::NamespaceShaMismatch { which: "stops" });
        }
        if num_shapes > 0 && u32_at(id_offsets, 0) != 0 {
            return Err(SidecarError::MalformedCsr("id_offsets[0] != 0"));
        }
        for i in 0..num_shapes {
            if u32_at(id_offsets, i * 4) > u32_at(id_offsets, (i + 1) * 4) {
                return Err(SidecarError::MalformedCsr("id_offsets not monotone"));
            }
        }
        let point_byte_offsets = &bytes[pbo_at..pc_at];
        // [0]==0 + sentinel + monotonicity (mirrors the id_offsets guards) so
        // every point_byte_offsets[i] is in `0..=points_bytes`. Without the [0]==0
        // check a non-zero-but-monotone pbo[0] (e.g. 4) would silently misalign
        // shape 0's anchor decode rather than being rejected.
        if num_shapes > 0 && u32_at(point_byte_offsets, 0) != 0 {
            return Err(SidecarError::MalformedCsr("point_byte_offsets[0] != 0"));
        }
        if num_shapes > 0 && u32_at(point_byte_offsets, num_shapes * 4) as usize != points_bytes {
            return Err(SidecarError::MalformedCsr(
                "point_byte_offsets sentinel != points_bytes",
            ));
        }
        for i in 0..num_shapes {
            if u32_at(point_byte_offsets, i * 4) > u32_at(point_byte_offsets, (i + 1) * 4) {
                return Err(SidecarError::MalformedCsr(
                    "point_byte_offsets not monotone",
                ));
            }
        }
        Ok(Self {
            num_shapes,
            id_offsets,
            point_byte_offsets,
            point_counts: &bytes[pc_at..trc_at],
            trip_ref_counts: &bytes[trc_at..pool_at],
            id_pool: &bytes[pool_at..pool_at + id_pool_len],
            points: &bytes[points_at..need],
        })
    }

    pub fn num_shapes(&self) -> usize {
        self.num_shapes
    }

    /// `shape_id` of shape `i`. Out-of-range `i` returns `""` (matching
    /// `points()`' empty-on-out-of-range convention) rather than panicking.
    pub fn shape_id(&self, i: usize) -> &'a str {
        if i >= self.num_shapes {
            return "";
        }
        let lo = u32_at(self.id_offsets, i * 4) as usize;
        let hi = u32_at(self.id_offsets, (i + 1) * 4) as usize;
        std::str::from_utf8(&self.id_pool[lo..hi]).unwrap_or("")
    }

    /// Trip-reference count of shape `i`. Out-of-range `i` returns 0.
    pub fn trip_ref_count(&self, i: usize) -> u32 {
        if i >= self.num_shapes {
            return 0;
        }
        u32_at(self.trip_ref_counts, i * 4)
    }

    /// Decode shape `i`'s points to `(lat_deg, lon_deg)` f64 pairs. Decoding is
    /// confined to shape `i`'s own byte range `[pbo[i], pbo[i+1])` (parse
    /// validated the offsets monotone + the sentinel `== points_bytes`), so a
    /// corrupt `point_counts[i]` can never read into a neighbouring shape, and
    /// the capacity is capped by that range's byte budget (no giant
    /// pre-allocation on hostile input). Mirrors C1b `DeparturesIdx::entries_for`,
    /// which is likewise bounded by its validated offsets. Out-of-range `i`
    /// returns empty.
    pub fn points(&self, i: usize) -> Vec<(f64, f64)> {
        if i >= self.num_shapes {
            return Vec::new();
        }
        let count = u32_at(self.point_counts, i * 4) as usize;
        if count == 0 {
            return Vec::new();
        }
        let start = u32_at(self.point_byte_offsets, i * 4) as usize;
        let end = u32_at(self.point_byte_offsets, (i + 1) * 4) as usize;
        // `.get` keeps this panic-free even if the parse invariants were somehow
        // bypassed; for a well-formed file start <= end <= points.len().
        let region = match self.points.get(start..end) {
            Some(r) => r,
            None => return Vec::new(),
        };
        if region.len() < 8 {
            return Vec::new(); // cannot hold even the absolute anchor
        }
        let mut lat = i32_at(region, 0);
        let mut lon = i32_at(region, 4);
        let mut cur = 8;
        // Each point past the anchor costs >= 2 varint bytes, so this range holds
        // at most `1 + (len - 8) / 2` points — cap the allocation accordingly.
        let max_pts = 1 + (region.len() - 8) / 2;
        let mut out = Vec::with_capacity(count.min(max_pts));
        out.push((lat as f64 / 1e5, lon as f64 / 1e5));
        for _ in 1..count {
            let dlat = match read_varint(region, &mut cur) {
                Some(v) => zigzag_decode(v),
                None => break,
            };
            let dlon = match read_varint(region, &mut cur) {
                Some(v) => zigzag_decode(v),
                None => break,
            };
            lat = lat.wrapping_add(dlat);
            lon = lon.wrapping_add(dlon);
            out.push((lat as f64 / 1e5, lon as f64 / 1e5));
        }
        out
    }

    /// Binary-search shapes by `shape_id` (the pool is the comparand, looked up
    /// per-index via `shape_id(mid)`). Returns the shape index, or `None`.
    pub fn lookup(&self, shape_id: &str) -> Option<usize> {
        let (mut lo, mut hi) = (0usize, self.num_shapes);
        while lo < hi {
            let mid = (lo + hi) / 2;
            match self.shape_id(mid).cmp(shape_id) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => return Some(mid),
            }
        }
        None
    }
}

#[inline]
fn i32_at(b: &[u8], off: usize) -> i32 {
    i32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

/// Encode `(lat, lon)` points as a Google Encoded Polyline (precision 5) — the
/// exact algorithm the frontend's `utils/polyline.ts` decodes and the backend's
/// `encodePolyline` produces. Deterministic; empty input → empty string.
pub fn encode_polyline(points: &[(f64, f64)]) -> String {
    let mut out = String::new();
    let (mut prev_lat, mut prev_lon) = (0i32, 0i32);
    for &(lat, lon) in points {
        let lat_e5 = (lat * 1e5).round() as i32;
        let lon_e5 = (lon * 1e5).round() as i32;
        encode_signed(lat_e5 - prev_lat, &mut out);
        encode_signed(lon_e5 - prev_lon, &mut out);
        prev_lat = lat_e5;
        prev_lon = lon_e5;
    }
    out
}

fn encode_signed(v: i32, out: &mut String) {
    // Google polyline: left-shift 1, invert if negative, then 5-bit chunks.
    let mut u = (v << 1) ^ (v >> 31);
    loop {
        let mut chunk = (u & 0x1f) as u8;
        u = ((u as u32) >> 5) as i32;
        if u != 0 {
            chunk |= 0x20;
        }
        out.push((chunk + 63) as char);
        if u == 0 {
            break;
        }
    }
}

/// Emit the canonical shapes JSON byte sequence into any `Write` sink.
///
/// The byte form is `{"shapes":[{"shapeId":..,"encodedPolyline":..,"source":"gtfs"},...]}`.
/// Orphan shapes (`trip_ref_count == 0`) are excluded; order follows the
/// ShapesBin's stored ascending `shape_id` order. Hand-built (no serde) so the
/// bytes are fully deterministic and identical whether materialised into a `Vec`
/// or streamed through a `Sha256` hasher.
fn shapes_json_write<W: std::io::Write>(sb: &ShapesBin<'_>, w: &mut W) -> std::io::Result<()> {
    w.write_all(b"{\"shapes\":[")?;
    let mut first = true;
    for i in 0..sb.num_shapes() {
        if sb.trip_ref_count(i) == 0 {
            continue;
        }
        if !first {
            w.write_all(b",")?;
        }
        first = false;
        w.write_all(b"{\"shapeId\":")?;
        write_json_string(sb.shape_id(i), w)?;
        w.write_all(b",\"encodedPolyline\":")?;
        write_json_string(&encode_polyline(&sb.points(i)), w)?;
        w.write_all(b",\"source\":\"gtfs\"}")?;
    }
    w.write_all(b"]}")?;
    Ok(())
}

/// Serialize a `ShapesBin` to the canonical shapes JSON body served at
/// `/shapes/<artifact>`: `{"shapes":[{"shapeId":..,"encodedPolyline":..,"source":"gtfs"}]}`.
/// Excludes orphan shapes (`trip_ref_count == 0`); emits in ascending `shape_id`
/// order (ShapesBin's stored order). Hand-built (no serde) so the byte form is
/// fully deterministic and identical between the producer (hash-recording) and
/// pt-serve (serving).
pub fn shapes_json_bytes(sb: &ShapesBin<'_>) -> Vec<u8> {
    let mut out = Vec::new();
    shapes_json_write(sb, &mut out).expect("Vec<u8> write is infallible");
    out
}

/// Hash the canonical shapes JSON byte sequence without materialising it.
///
/// Returns `(sha256_digest, byte_length)`. The digest is byte-identical to
/// `sha256(shapes_json_bytes(sb))` but avoids a full-body allocation, keeping
/// pt-serve's steady RSS independent of the shapes payload size.
pub fn shapes_json_sha256(sb: &ShapesBin<'_>) -> ([u8; 32], u64) {
    struct HashCounter {
        h: Sha256,
        n: u64,
    }
    impl std::io::Write for HashCounter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.h.update(buf);
            self.n += buf.len() as u64;
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut hc = HashCounter {
        h: Sha256::new(),
        n: 0,
    };
    shapes_json_write(sb, &mut hc).expect("HashCounter write is infallible");
    (hc.h.finalize().into(), hc.n)
}

/// Minimal RFC-8259 JSON string escaper (quotes, backslash, control chars, and
/// the forward-slash left unescaped to match JS `JSON.stringify`). shape_ids and
/// polyline chars are printable ASCII/UTF-8; this covers the escape cases.
fn write_json_string<W: std::io::Write>(s: &str, w: &mut W) -> std::io::Result<()> {
    w.write_all(b"\"")?;
    for c in s.chars() {
        match c {
            '"' => w.write_all(b"\\\"")?,
            '\\' => w.write_all(b"\\\\")?,
            '\n' => w.write_all(b"\\n")?,
            '\r' => w.write_all(b"\\r")?,
            '\t' => w.write_all(b"\\t")?,
            c if (c as u32) < 0x20 => w.write_all(format!("\\u{:04x}", c as u32).as_bytes())?,
            c => {
                let mut buf = [0u8; 4];
                w.write_all(c.encode_utf8(&mut buf).as_bytes())?;
            }
        }
    }
    w.write_all(b"\"")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_round_trips() {
        let trips = [0xAAu8; 32];
        let stops = [0xBBu8; 32];
        let mut buf = vec![0u8; SIDECAR_HEADER_BYTES];
        write_sidecar_header(
            &mut buf,
            DEPARTURES_IDX_MAGIC,
            SIDECAR_VERSION,
            &trips,
            &stops,
        )
        .unwrap();
        let h = parse_sidecar_header(&buf, DEPARTURES_IDX_MAGIC).unwrap();
        assert_eq!(h.version, SIDECAR_VERSION);
        assert_eq!(h.trips_intern_sha256, trips);
        assert_eq!(h.stops_intern_sha256, stops);
    }

    #[test]
    fn rejects_bad_magic() {
        let mut buf = vec![0u8; SIDECAR_HEADER_BYTES];
        write_sidecar_header(
            &mut buf,
            DEPARTURES_IDX_MAGIC,
            SIDECAR_VERSION,
            &[0; 32],
            &[0; 32],
        )
        .unwrap();
        assert!(matches!(
            parse_sidecar_header(&buf, *b"SHPB"),
            Err(SidecarError::BadMagic { .. })
        ));
    }

    #[test]
    fn rejects_truncated_header() {
        let buf = vec![0u8; SIDECAR_HEADER_BYTES - 1];
        assert!(matches!(
            parse_sidecar_header(&buf, DEPARTURES_IDX_MAGIC),
            Err(SidecarError::Truncated { .. })
        ));
    }

    #[test]
    fn surfaces_unknown_version() {
        let mut buf = vec![0u8; SIDECAR_HEADER_BYTES];
        write_sidecar_header(&mut buf, DEPARTURES_IDX_MAGIC, 99, &[0; 32], &[0; 32]).unwrap();
        // parse still succeeds (forward-compat); the version is surfaced for
        // the caller to gate on.
        assert_eq!(
            parse_sidecar_header(&buf, DEPARTURES_IDX_MAGIC)
                .unwrap()
                .version,
            99
        );
    }

    #[test]
    fn canonical_bytes_are_length_prefixed_in_order() {
        // Two keys "S1","S2" → [len=2 LE][S1][len=2 LE][S2].
        let keys = ["S1".to_string(), "S2".to_string()];
        let bytes = intern_canonical_bytes(&keys);
        assert_eq!(bytes, vec![2, 0, 0, 0, b'S', b'1', 2, 0, 0, 0, b'S', b'2']);
    }

    #[test]
    fn canonical_sha_is_order_sensitive() {
        let a = intern_namespace_sha256(&["A".to_string(), "B".to_string()]);
        let b = intern_namespace_sha256(&["B".to_string(), "A".to_string()]);
        assert_ne!(a, b, "reordering keys must change the namespace SHA");
    }

    #[test]
    fn canonical_sha_empty_is_stable() {
        let empty: [String; 0] = [];
        // Hash of zero bytes is deterministic; just assert it does not panic
        // and is distinct from a one-key set.
        let h0 = intern_namespace_sha256(&empty);
        let h1 = intern_namespace_sha256(&["".to_string()]);
        assert_ne!(h0, h1);
    }

    fn sample_csr() -> (Vec<u32>, Vec<u32>) {
        // 3 stops. stop0 → trip0@seq1, trip2@seq3 ; stop1 → trip1@seq2 ;
        // stop2 → (none). entries flat as (trip, seq) pairs.
        let offsets = vec![0u32, 2, 3, 3];
        let entries = vec![
            0u32, 1, /*stop0*/ 2, 3, /*stop0*/ 1, 2, /*stop1*/
        ];
        (offsets, entries)
    }

    #[test]
    fn departures_idx_round_trips() {
        let (offsets, entries) = sample_csr();
        let trips = [1u8; 32];
        let stops = [2u8; 32];
        let bytes = encode_departures_idx(&offsets, &entries, &trips, &stops).unwrap();
        // 72 header + 8 counts + 4*4 offsets + 8*3 entries = 72+8+16+24 = 120.
        assert_eq!(bytes.len(), 120);
        assert_eq!(bytes.len() % 4, 0, "payload must stay u32-aligned");

        let idx = DeparturesIdx::parse(&bytes, &trips, &stops).unwrap();
        assert_eq!(idx.num_stops(), 3);
        assert_eq!(idx.entries_for(0), &[(0u32, 1u32), (2, 3)]);
        assert_eq!(idx.entries_for(1), &[(1u32, 2u32)]);
        assert_eq!(idx.entries_for(2), &[]);
    }

    #[test]
    fn entries_iter_matches_entries_for() {
        let (offsets, entries) = sample_csr();
        // The existing DPIX tests pass non-zero SHAs to `parse`; mirror that
        // so this test exercises the same parse path.
        let trips = [7u8; 32];
        let stops = [9u8; 32];
        let bytes = encode_departures_idx(&offsets, &entries, &trips, &stops).unwrap();
        let idx = DeparturesIdx::parse(&bytes, &trips, &stops).unwrap();

        // For EVERY stop (incl. one past the end, which must be empty), the
        // zero-alloc iterator yields exactly what `entries_for` collects.
        for s in 0..=idx.num_stops() + 1 {
            let via_vec = idx.entries_for(s);
            let via_iter: Vec<(u32, u32)> = idx.entries_iter(s).collect();
            assert_eq!(
                via_iter, via_vec,
                "entries_iter != entries_for for stop {s}"
            );
        }

        // `parse_unchecked` (caller-guarantees-parse-succeeded) yields the same.
        let unchecked = DeparturesIdx::parse_unchecked(&bytes);
        assert_eq!(unchecked.num_stops(), idx.num_stops());
        for s in 0..=idx.num_stops() + 1 {
            let checked: Vec<(u32, u32)> = idx.entries_iter(s).collect();
            let unchecked_vec: Vec<(u32, u32)> = unchecked.entries_iter(s).collect();
            assert_eq!(
                unchecked_vec, checked,
                "parse_unchecked entries_iter != parse entries_iter for stop {s}"
            );
            assert_eq!(unchecked.entries_for(s), idx.entries_for(s));
        }
    }

    #[test]
    fn departures_idx_rejects_truncation() {
        let (offsets, entries) = sample_csr();
        let bytes = encode_departures_idx(&offsets, &entries, &[0; 32], &[0; 32]).unwrap();
        let chopped = &bytes[..bytes.len() - 1];
        assert!(matches!(
            DeparturesIdx::parse(chopped, &[0; 32], &[0; 32]),
            Err(SidecarError::Truncated { .. })
        ));
    }

    #[test]
    fn departures_idx_rejects_namespace_mismatch() {
        let (offsets, entries) = sample_csr();
        let bytes = encode_departures_idx(&offsets, &entries, &[1; 32], &[2; 32]).unwrap();
        // Parse with the wrong trips SHA.
        assert!(matches!(
            DeparturesIdx::parse(&bytes, &[9; 32], &[2; 32]),
            Err(SidecarError::NamespaceShaMismatch { which: "trips" })
        ));
    }

    #[test]
    fn empty_feed_encodes_min_size() {
        let bytes = encode_departures_idx(&[0u32], &[], &[0; 32], &[0; 32]).unwrap();
        assert_eq!(bytes.len(), 84); // 72 + 8 + 4*(0+1)
        let idx = DeparturesIdx::parse(&bytes, &[0; 32], &[0; 32]).unwrap();
        assert_eq!(idx.num_stops(), 0);
    }

    #[test]
    fn shapes_header_round_trips_with_shpb_magic() {
        let trips = [0xCDu8; 32];
        let stops = [0xEFu8; 32];
        let mut buf = vec![0u8; SIDECAR_HEADER_BYTES];
        write_sidecar_header(&mut buf, SHAPES_MAGIC, SIDECAR_VERSION, &trips, &stops).unwrap();
        let h = parse_sidecar_header(&buf, SHAPES_MAGIC).unwrap();
        assert_eq!(h.version, SIDECAR_VERSION);
        assert_eq!(h.trips_intern_sha256, trips);
        assert_eq!(h.stops_intern_sha256, stops);
        // A DPIX reader must reject SHPB bytes (magic gates the sidecar kind).
        assert!(matches!(
            parse_sidecar_header(&buf, DEPARTURES_IDX_MAGIC),
            Err(SidecarError::BadMagic { .. })
        ));
    }

    #[test]
    fn zigzag_round_trips_including_extremes() {
        for n in [
            0i32,
            1,
            -1,
            100,
            -100,
            i32::MAX,
            i32::MIN,
            8_999_999,
            -18_000_000,
        ] {
            assert_eq!(
                zigzag_decode(zigzag_encode(n)),
                n,
                "zigzag round-trip for {n}"
            );
        }
        assert_eq!(zigzag_encode(0), 0);
        assert_eq!(zigzag_encode(-1), 1);
        assert_eq!(zigzag_encode(1), 2);
    }

    #[test]
    fn varint_round_trips_across_width_boundaries() {
        let mut buf = Vec::new();
        let samples = [0u32, 1, 127, 128, 16_383, 16_384, 200, u32::MAX];
        for &v in &samples {
            buf.clear();
            write_varint(v, &mut buf);
            assert!(!buf.is_empty() && buf.len() <= 5);
            let mut cur = 0usize;
            let got = read_varint(&buf, &mut cur).unwrap();
            assert_eq!(got, v, "varint round-trip for {v}");
            assert_eq!(cur, buf.len(), "cursor advanced past the whole varint");
        }
    }

    #[test]
    fn read_varint_rejects_truncated_and_overlong() {
        let mut cur = 0usize;
        assert_eq!(read_varint(&[0x80], &mut cur), None);
        let mut cur = 0usize;
        assert_eq!(
            read_varint(&[0x80, 0x80, 0x80, 0x80, 0x80, 0x01], &mut cur),
            None
        );
    }

    fn sample_shapes() -> Vec<ShapeEncodeInput<'static>> {
        // Sorted by shape_id (parse_shapes_all emits BTreeMap order).
        vec![
            ShapeEncodeInput {
                shape_id: "SH_A",
                points: &[(54.69, 25.28), (54.691, 25.281), (54.692, 25.282)],
                trip_ref_count: 2,
            },
            ShapeEncodeInput {
                shape_id: "SH_B",
                points: &[(54.70, 25.30)],
                trip_ref_count: 1,
            },
        ]
    }

    #[test]
    fn shapes_bin_round_trips() {
        let trips = [3u8; 32];
        let stops = [4u8; 32];
        let bytes = encode_shapes_bin(&sample_shapes(), &trips, &stops).unwrap();
        // NB: total length is NOT 4-aligned in general — only the points-region
        // START is (the pad guarantees that). The variable-width varint payload
        // makes the tail unaligned, so don't assert `len % 4 == 0` here.

        let sb = ShapesBin::parse(&bytes, &trips, &stops).unwrap();
        assert_eq!(sb.num_shapes(), 2);
        assert_eq!(sb.shape_id(0), "SH_A");
        assert_eq!(sb.shape_id(1), "SH_B");
        assert_eq!(sb.trip_ref_count(0), 2);
        assert_eq!(sb.trip_ref_count(1), 1);

        assert_eq!(sb.lookup("SH_A"), Some(0));
        assert_eq!(sb.lookup("SH_B"), Some(1));
        assert_eq!(sb.lookup("SH_C"), None);
        assert_eq!(sb.lookup("SH"), None);

        let a = sb.points(0);
        assert_eq!(a.len(), 3);
        // Tolerance is the 1e-5 quantization step (a 10x dequant regression fails).
        assert!((a[0].0 - 54.69).abs() < 1e-5 && (a[0].1 - 25.28).abs() < 1e-5);
        assert!((a[1].0 - 54.691).abs() < 1e-5 && (a[1].1 - 25.281).abs() < 1e-5);
        assert!((a[2].0 - 54.692).abs() < 1e-5 && (a[2].1 - 25.282).abs() < 1e-5);
        let b = sb.points(1);
        assert_eq!(b.len(), 1);
        assert!((b[0].0 - 54.70).abs() < 1e-5 && (b[0].1 - 25.30).abs() < 1e-5);
    }

    #[test]
    fn shapes_bin_empty_feed_min_size() {
        let bytes = encode_shapes_bin(&[], &[0; 32], &[0; 32]).unwrap();
        assert_eq!(
            bytes.len(),
            88,
            "empty shapes = 72 header + 8 counts + 4 (id_offsets[1]) + 4 (point_byte_offsets[1])"
        );
        let sb = ShapesBin::parse(&bytes, &[0; 32], &[0; 32]).unwrap();
        assert_eq!(sb.num_shapes(), 0);
        assert_eq!(sb.lookup("anything"), None);
    }

    #[test]
    fn shapes_bin_rejects_truncation() {
        let bytes = encode_shapes_bin(&sample_shapes(), &[0; 32], &[0; 32]).unwrap();
        let chopped = &bytes[..bytes.len() - 1];
        assert!(matches!(
            ShapesBin::parse(chopped, &[0; 32], &[0; 32]),
            Err(SidecarError::Truncated { .. })
        ));
    }

    #[test]
    fn shapes_bin_rejects_namespace_mismatch() {
        let bytes = encode_shapes_bin(&sample_shapes(), &[1; 32], &[2; 32]).unwrap();
        assert!(matches!(
            ShapesBin::parse(&bytes, &[9; 32], &[2; 32]),
            Err(SidecarError::NamespaceShaMismatch { which: "trips" })
        ));
    }

    // For sample_shapes() (2 shapes): index layout is header(72) + counts(8) +
    // id_offsets[3] (80..92) + point_byte_offsets[3] (92..104) + ... So
    // id_offsets[0] is at byte 80, point_byte_offsets[0] at 92, the pbo sentinel
    // (pbo[2]) at 100. points_bytes for this fixture is 24 (SH_A 16 + SH_B 8).
    #[test]
    fn shapes_bin_rejects_id_offsets_first_nonzero() {
        let bytes = encode_shapes_bin(&sample_shapes(), &[0; 32], &[0; 32]).unwrap();
        let mut corrupt = bytes.clone();
        corrupt[80..84].copy_from_slice(&1u32.to_le_bytes());
        assert!(matches!(
            ShapesBin::parse(&corrupt, &[0; 32], &[0; 32]),
            Err(SidecarError::MalformedCsr("id_offsets[0] != 0"))
        ));
    }

    #[test]
    fn shapes_bin_rejects_pbo_first_nonzero() {
        // A small non-zero pbo[0] (4) is monotone-safe and < points_bytes, so it
        // slips past the sentinel + monotone guards — the [0]==0 guard is what
        // rejects it (without it, shape 0's anchor would decode 4 bytes misaligned).
        let bytes = encode_shapes_bin(&sample_shapes(), &[0; 32], &[0; 32]).unwrap();
        let mut corrupt = bytes.clone();
        corrupt[92..96].copy_from_slice(&4u32.to_le_bytes());
        assert!(matches!(
            ShapesBin::parse(&corrupt, &[0; 32], &[0; 32]),
            Err(SidecarError::MalformedCsr("point_byte_offsets[0] != 0"))
        ));
    }

    #[test]
    fn shapes_bin_rejects_pbo_sentinel_mismatch() {
        // pbo sentinel = 20 is monotone-OK (>= pbo[1]=16) but != points_bytes (24),
        // isolating the sentinel guard from the monotone guard.
        let bytes = encode_shapes_bin(&sample_shapes(), &[0; 32], &[0; 32]).unwrap();
        let mut corrupt = bytes.clone();
        corrupt[100..104].copy_from_slice(&20u32.to_le_bytes());
        assert!(matches!(
            ShapesBin::parse(&corrupt, &[0; 32], &[0; 32]),
            Err(SidecarError::MalformedCsr(
                "point_byte_offsets sentinel != points_bytes"
            ))
        ));
    }

    #[test]
    fn shapes_bin_round_trips_negative_deltas() {
        // A shape moving south-west (decreasing lat AND lon) exercises negative
        // anchors and negative zigzag-varint deltas, which the monotonically-NE
        // sample_shapes never hit.
        let shapes = vec![ShapeEncodeInput {
            shape_id: "S",
            points: &[(-33.86, -151.20), (-33.861, -151.201), (-33.862, -151.202)],
            trip_ref_count: 1,
        }];
        let trips = [5u8; 32];
        let stops = [6u8; 32];
        let bytes = encode_shapes_bin(&shapes, &trips, &stops).unwrap();
        let sb = ShapesBin::parse(&bytes, &trips, &stops).unwrap();
        let p = sb.points(0);
        assert_eq!(p.len(), 3);
        assert!((p[0].0 + 33.86).abs() < 1e-5 && (p[0].1 + 151.20).abs() < 1e-5);
        assert!((p[2].0 + 33.862).abs() < 1e-5 && (p[2].1 + 151.202).abs() < 1e-5);
    }

    #[test]
    fn encode_polyline_matches_google_reference() {
        // The canonical example from Google's Encoded Polyline Algorithm docs:
        // (38.5,-120.2),(40.7,-120.95),(43.252,-126.453) → "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
        let pts = [(38.5_f64, -120.2_f64), (40.7, -120.95), (43.252, -126.453)];
        assert_eq!(encode_polyline(&pts), "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
        assert_eq!(encode_polyline(&[]), "");
    }

    /// Builds the canonical shapes-bin fixture used by byte-stability and
    /// streaming-hash tests. SHAs are all-zero (the parse must use the same).
    fn sample_shapes_bin() -> Vec<u8> {
        let shapes = vec![
            ShapeEncodeInput {
                shape_id: "SH_A",
                points: &[(54.69, 25.28), (54.691, 25.281)],
                trip_ref_count: 2,
            },
            ShapeEncodeInput {
                shape_id: "SH_B",
                points: &[(54.70, 25.30)],
                trip_ref_count: 1,
            },
            ShapeEncodeInput {
                shape_id: "SH_ORPHAN",
                points: &[(54.71, 25.31)],
                trip_ref_count: 0,
            },
        ];
        encode_shapes_bin(&shapes, &[0; 32], &[0; 32]).unwrap()
    }

    #[test]
    fn shapes_json_bytes_orphan_filtered_and_ordered() {
        // SH_A (2 pts, 2 trips), SH_B (1 pt, 1 trip), SH_ORPHAN (1 pt, 0 trips).
        // Orphan excluded; SH_A before SH_B (ascending id).
        let bytes = sample_shapes_bin();
        let sb = ShapesBin::parse(&bytes, &[0; 32], &[0; 32]).unwrap();
        let json = shapes_json_bytes(&sb);
        let v: serde_json::Value = serde_json::from_slice(&json).unwrap();
        let arr = v["shapes"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "orphan (trip_ref_count==0) excluded");
        assert_eq!(arr[0]["shapeId"], "SH_A");
        assert_eq!(arr[0]["source"], "gtfs");
        assert!(!arr[0]["encodedPolyline"].as_str().unwrap().is_empty());
        assert_eq!(arr[1]["shapeId"], "SH_B");

        // Byte-stability golden: pin the EXACT serialized bytes — key order,
        // array framing, the literal `source` field, and orphan exclusion.
        // This is the producer(records shapesJsonSha256)↔pt-serve(serves) invariant;
        // any silent wire-format drift must fail here.
        let enc_a = encode_polyline(&sb.points(0));
        let enc_b = encode_polyline(&sb.points(1));
        let expected = format!(
            "{{\"shapes\":[\
{{\"shapeId\":\"SH_A\",\"encodedPolyline\":\"{enc_a}\",\"source\":\"gtfs\"}},\
{{\"shapeId\":\"SH_B\",\"encodedPolyline\":\"{enc_b}\",\"source\":\"gtfs\"}}]}}"
        );
        assert_eq!(
            String::from_utf8(json.clone()).unwrap(),
            expected,
            "shapes_json_bytes wire format must be byte-stable"
        );
    }

    #[test]
    fn shapes_json_sha256_matches_bytes() {
        let buf = sample_shapes_bin();
        let sb = ShapesBin::parse(&buf, &[0; 32], &[0; 32]).unwrap();

        let bytes = shapes_json_bytes(&sb);
        let (digest, len) = shapes_json_sha256(&sb);

        let expect: [u8; 32] = {
            use sha2::{Digest, Sha256};
            Sha256::digest(&bytes).into()
        };
        assert_eq!(digest, expect, "streaming digest must equal sha256(bytes)");
        assert_eq!(
            len,
            bytes.len() as u64,
            "streaming length must equal bytes.len()"
        );
    }

    #[test]
    fn shapes_bin_points_confined_to_shape_range_on_corrupt_count() {
        // `point_counts` is NOT validated at parse, so a corrupt count must be
        // contained at decode time by the shape's byte range. Inflate SH_B's
        // count (its range holds only an 8-byte anchor) to u32::MAX: points(1)
        // must return exactly 1 point, never read into prior bytes, never
        // over-allocate, and never panic/hang.
        let mut bytes = encode_shapes_bin(&sample_shapes(), &[0; 32], &[0; 32]).unwrap();
        // Layout for 2 shapes: header 72 + counts 8 + id_offsets 3*4 +
        // point_byte_offsets 3*4 = 104; point_counts[1] is at 104 + 4 = 108.
        let pc1 = 72 + 8 + (2 + 1) * 4 + (2 + 1) * 4 + 4;
        bytes[pc1..pc1 + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        let sb = ShapesBin::parse(&bytes, &[0; 32], &[0; 32]).unwrap();
        assert_eq!(
            sb.points(1).len(),
            1,
            "decode must be confined to SH_B's 8-byte anchor range"
        );
        // Out-of-range index is empty, not a panic.
        assert!(sb.points(99).is_empty());
    }
}
