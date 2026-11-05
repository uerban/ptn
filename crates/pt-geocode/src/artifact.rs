//! `PTAS` — the packed address-search artifact (schema version 1).
//!
//! This is the artifact that ships. Do not confuse its version with the
//! `schemaVersion` field of the extractor's JSON intermediate
//! (`packages/backend/scripts/extract-addr-fixture.ts`), which is a separate,
//! separately-versioned contract that never leaves the build machine.
//!
//! The file IS the built index: an `fst::Map`, a fixed-width row table and a
//! label blob. pt-serve maps it and the PWA hands the bytes to wasm, so neither
//! consumer parses or rebuilds anything and both read the *same* artifact, as
//! the local address search notes requires. Shipping the index
//! rather than a corpus is also what keeps it small: on vilnius the artifact is
//! 5.2 MB, against 21.4 MB of JSON for the intermediate that merely describes
//! the same index.
//!
//! ## Layout
//!
//! All integers little-endian. Sections are 8-byte aligned and appear in the
//! order listed; the header records explicit offsets so a later version can
//! reorder or insert sections without breaking a reader that bounds-checks.
//!
//! ```text
//! 0   magic       [u8; 4]  b"PTAS"
//! 4   version     u16      1
//! 6   flags       u16      0 (reserved; a reader MUST reject unknown bits)
//! 8   row_count   u32
//! 12  key_count   u32      informational — the FST is the authority
//! 16  fst_off     u64
//! 24  fst_len     u64
//! 32  rows_off    u64
//! 40  rows_len    u64      == row_count * ROW_RECORD_BYTES
//! 48  labels_off  u64
//! 56  labels_len  u64
//! 64  meta_off    u64
//! 72  meta_len    u64      small JSON: cityId, generatedAt, source, stats
//! 80  <sections>
//! ```
//!
//! Row record, [`ROW_RECORD_BYTES`] each:
//!
//! ```text
//! 0   label_off   u32      byte offset into the labels section
//! 4   label_len   u32
//! 8   lat_e7      i32      degrees * 1e7
//! 12  lon_e7      i32
//! ```
//!
//! ## Why 1e7 fixed-point coordinates
//!
//! OSM stores 7 decimal places, so `lat_e7` is *lossless* for this data while
//! halving what f64 would cost — and unlike f32 (≈1 m at these magnitudes) it
//! cannot move an address to the wrong side of a street. Round-tripping the
//! real corpora reproduces the extractor's f64 values exactly; a test pins that.

use std::sync::Arc;

/// Magic at offset 0. "PT Address Search".
pub const MAGIC: [u8; 4] = *b"PTAS";
/// Packed-artifact schema version this module reads and writes. The only
/// version there has ever been in public: anything else is rejected outright,
/// there is no compatibility reader.
pub const SCHEMA_VERSION: u16 = 1;
/// Bytes per row record: label offset + length + lat_e7 + lon_e7.
pub const ROW_RECORD_BYTES: usize = 16;
/// Fixed header size; the first section starts here.
pub const HEADER_BYTES: usize = 80;

const COORD_SCALE: f64 = 1e7;

/// Anything that makes a byte range unusable as an address artifact.
#[derive(Debug, PartialEq, Eq)]
pub enum ArtifactError {
    /// Shorter than the fixed header.
    TooShort { len: usize },
    /// Magic is not `PTAS` — almost always the extractor's JSON intermediate,
    /// staged in place of the packed artifact.
    BadMagic { found: [u8; 4] },
    /// A version this build does not read.
    UnsupportedVersion { found: u16 },
    /// Reserved flag bits were set.
    UnknownFlags { found: u16 },
    /// A section's `off + len` runs past the end of the buffer, or overflows.
    SectionOutOfBounds {
        section: &'static str,
        off: u64,
        len: u64,
        total: usize,
    },
    /// `rows_len` disagrees with `row_count * ROW_RECORD_BYTES`.
    RowTableSizeMismatch { row_count: u32, rows_len: u64 },
    /// A row's label range escapes the labels section.
    LabelOutOfBounds { row_id: usize },
    /// A label is not valid UTF-8.
    LabelNotUtf8 { row_id: usize },
    /// The FST section is not a well-formed `fst::Map`.
    Fst(String),
    /// The metadata section is not the small JSON object it must be.
    Meta(String),
}

impl std::fmt::Display for ArtifactError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooShort { len } => {
                write!(f, "address artifact is {len} bytes, shorter than the {HEADER_BYTES}-byte header")
            }
            Self::BadMagic { found } => write!(
                f,
                "address artifact magic is {found:?}, expected {MAGIC:?} \
                 (the extractor's JSON intermediate starts with '{{' — pack it with \
                 `pt-producer pack-address-search`)"
            ),
            Self::UnsupportedVersion { found } => write!(
                f,
                "address artifact schema version {found} is not supported (this build reads {SCHEMA_VERSION})"
            ),
            Self::UnknownFlags { found } => {
                write!(f, "address artifact sets reserved flag bits {found:#06x}")
            }
            Self::SectionOutOfBounds {
                section,
                off,
                len,
                total,
            } => write!(
                f,
                "address artifact {section} section at {off}+{len} runs past the {total}-byte file"
            ),
            Self::RowTableSizeMismatch {
                row_count,
                rows_len,
            } => write!(
                f,
                "address artifact row table is {rows_len} bytes, expected {row_count} * {ROW_RECORD_BYTES}"
            ),
            Self::LabelOutOfBounds { row_id } => {
                write!(f, "address artifact row {row_id} label escapes the labels section")
            }
            Self::LabelNotUtf8 { row_id } => {
                write!(f, "address artifact row {row_id} label is not valid UTF-8")
            }
            Self::Fst(e) => write!(f, "address artifact FST section is malformed: {e}"),
            Self::Meta(e) => write!(f, "address artifact metadata section is malformed: {e}"),
        }
    }
}

impl std::error::Error for ArtifactError {}

/// A borrowed view of one section, shared with the whole-artifact allocation.
///
/// `fst::Map` is generic over `AsRef<[u8]>`, so handing it one of these lets the
/// map read straight out of the artifact buffer — no copy of the FST section,
/// and the `Arc` keeps the backing bytes alive for as long as the map does.
#[derive(Clone)]
pub struct Section {
    buf: Arc<[u8]>,
    off: usize,
    len: usize,
}

impl AsRef<[u8]> for Section {
    fn as_ref(&self) -> &[u8] {
        &self.buf[self.off..self.off + self.len]
    }
}

/// Metadata carried alongside the index. Kept as JSON because it is tiny, rarely
/// read, and the fields are exactly the ones the HTTP manifest re-exposes —
/// a bespoke binary encoding here would buy nothing and cost a migration.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub city_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub generated_at: String,
}

pub(crate) struct Header {
    pub row_count: u32,
    pub key_count: u32,
    pub fst: (u64, u64),
    pub rows: (u64, u64),
    pub labels: (u64, u64),
    pub meta: (u64, u64),
}

fn u16_at(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([b[off], b[off + 1]])
}
fn u32_at(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}
fn u64_at(b: &[u8], off: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[off..off + 8]);
    u64::from_le_bytes(a)
}

/// Bounds-check one section against the whole buffer.
///
/// Uses `checked_add` rather than `off + len <= total`: a crafted header with
/// `off = u64::MAX` would wrap and pass the naive form, then slice out of range.
fn check_section(
    section: &'static str,
    off: u64,
    len: u64,
    total: usize,
) -> Result<(usize, usize), ArtifactError> {
    let end = off
        .checked_add(len)
        .filter(|end| *end <= total as u64)
        .ok_or(ArtifactError::SectionOutOfBounds {
            section,
            off,
            len,
            total,
        })?;
    let _ = end;
    Ok((off as usize, len as usize))
}

pub(crate) fn parse_header(bytes: &[u8]) -> Result<Header, ArtifactError> {
    // Magic before length, deliberately. The likeliest wrong input is the
    // extractor's JSON intermediate, and a small or truncated one is shorter
    // than this header — reporting "too short" for it would bury the one error
    // message that tells the operator what to actually do.
    if bytes.len() >= MAGIC.len() {
        let magic: [u8; 4] = [bytes[0], bytes[1], bytes[2], bytes[3]];
        if magic != MAGIC {
            return Err(ArtifactError::BadMagic { found: magic });
        }
    }
    if bytes.len() < HEADER_BYTES {
        return Err(ArtifactError::TooShort { len: bytes.len() });
    }
    let version = u16_at(bytes, 4);
    if version != SCHEMA_VERSION {
        return Err(ArtifactError::UnsupportedVersion { found: version });
    }
    let flags = u16_at(bytes, 6);
    if flags != 0 {
        return Err(ArtifactError::UnknownFlags { found: flags });
    }
    Ok(Header {
        row_count: u32_at(bytes, 8),
        key_count: u32_at(bytes, 12),
        fst: (u64_at(bytes, 16), u64_at(bytes, 24)),
        rows: (u64_at(bytes, 32), u64_at(bytes, 40)),
        labels: (u64_at(bytes, 48), u64_at(bytes, 56)),
        meta: (u64_at(bytes, 64), u64_at(bytes, 72)),
    })
}

/// The row table and label blob, read in place out of the artifact buffer.
pub(crate) struct RowStore {
    buf: Arc<[u8]>,
    rows_off: usize,
    labels_off: usize,
    labels_len: usize,
    count: usize,
}

impl RowStore {
    pub(crate) fn len(&self) -> usize {
        self.count
    }

    fn record(&self, row_id: usize) -> (usize, usize, i32, i32) {
        let at = self.rows_off + row_id * ROW_RECORD_BYTES;
        let b = &self.buf;
        (
            u32_at(b, at) as usize,
            u32_at(b, at + 4) as usize,
            u32_at(b, at + 8) as i32,
            u32_at(b, at + 12) as i32,
        )
    }

    pub(crate) fn label(&self, row_id: usize) -> Option<&str> {
        if row_id >= self.count {
            return None;
        }
        let (off, len, _, _) = self.record(row_id);
        let start = self.labels_off + off;
        // Validated eagerly at load, so this cannot fail on a loaded artifact.
        std::str::from_utf8(self.buf.get(start..start + len)?).ok()
    }

    pub(crate) fn lat_lon(&self, row_id: usize) -> Option<(f64, f64)> {
        if row_id >= self.count {
            return None;
        }
        let (_, _, lat, lon) = self.record(row_id);
        Some((f64::from(lat) / COORD_SCALE, f64::from(lon) / COORD_SCALE))
    }

    /// Validate every row's label range and UTF-8 up front.
    ///
    /// Eager rather than per-query: a malformed corpus must fail the generation
    /// load — the same reason the packer cross-checks the intermediate's stats
    /// against its own arrays — instead of surfacing as a mysteriously missing
    /// search result later.
    fn validate(&self) -> Result<(), ArtifactError> {
        for row_id in 0..self.count {
            let (off, len, _, _) = self.record(row_id);
            let end = off
                .checked_add(len)
                .ok_or(ArtifactError::LabelOutOfBounds { row_id })?;
            if end > self.labels_len {
                return Err(ArtifactError::LabelOutOfBounds { row_id });
            }
            let start = self.labels_off + off;
            std::str::from_utf8(&self.buf[start..start + len])
                .map_err(|_| ArtifactError::LabelNotUtf8 { row_id })?;
        }
        Ok(())
    }
}

/// Everything a loaded artifact yields, before the index wraps it.
pub(crate) struct Parsed {
    pub map_section: Section,
    pub rows: RowStore,
    pub meta: ArtifactMeta,
    pub key_count: usize,
    pub fst_size_bytes: usize,
}

pub(crate) fn parse(bytes: Arc<[u8]>) -> Result<Parsed, ArtifactError> {
    let total = bytes.len();
    let h = parse_header(&bytes)?;

    let (fst_off, fst_len) = check_section("fst", h.fst.0, h.fst.1, total)?;
    let (rows_off, rows_len) = check_section("rows", h.rows.0, h.rows.1, total)?;
    let (labels_off, labels_len) = check_section("labels", h.labels.0, h.labels.1, total)?;
    let (meta_off, meta_len) = check_section("meta", h.meta.0, h.meta.1, total)?;

    let expected_rows_len = (h.row_count as u64) * ROW_RECORD_BYTES as u64;
    if h.rows.1 != expected_rows_len {
        return Err(ArtifactError::RowTableSizeMismatch {
            row_count: h.row_count,
            rows_len: h.rows.1,
        });
    }
    let _ = rows_len;

    let rows = RowStore {
        buf: Arc::clone(&bytes),
        rows_off,
        labels_off,
        labels_len,
        count: h.row_count as usize,
    };
    rows.validate()?;

    let meta: ArtifactMeta = serde_json::from_slice(&bytes[meta_off..meta_off + meta_len])
        .map_err(|e| ArtifactError::Meta(e.to_string()))?;

    Ok(Parsed {
        map_section: Section {
            buf: Arc::clone(&bytes),
            off: fst_off,
            len: fst_len,
        },
        rows,
        meta,
        key_count: h.key_count as usize,
        fst_size_bytes: fst_len,
    })
}

/// Pad `out` to the next 8-byte boundary and return the resulting offset.
fn align8(out: &mut Vec<u8>) -> u64 {
    while !out.len().is_multiple_of(8) {
        out.push(0);
    }
    out.len() as u64
}

/// Assemble a PTAS artifact from a built FST plus the display rows.
///
/// `fst_bytes` comes from `AddrIndex`'s builder; keeping the two steps separate
/// means the packer never has to know how keys are encoded.
pub(crate) fn encode(
    fst_bytes: &[u8],
    labels: &[&str],
    coords: &[(f64, f64)],
    key_count: usize,
    meta: &ArtifactMeta,
) -> Vec<u8> {
    debug_assert_eq!(labels.len(), coords.len());
    let meta_json = serde_json::to_vec(meta).expect("ArtifactMeta serializes infallibly");

    let mut out = vec![0u8; HEADER_BYTES];

    let fst_off = align8(&mut out);
    out.extend_from_slice(fst_bytes);

    // Labels are written before the row table is finalised so each record can
    // carry its final offset; the row table itself is fixed-width so it can be
    // laid out afterwards without a second pass.
    let mut label_spans = Vec::with_capacity(labels.len());
    let mut labels_blob: Vec<u8> = Vec::new();
    for label in labels {
        let off = labels_blob.len() as u32;
        labels_blob.extend_from_slice(label.as_bytes());
        label_spans.push((off, label.len() as u32));
    }

    let rows_off = align8(&mut out);
    for (i, (off, len)) in label_spans.iter().enumerate() {
        let (lat, lon) = coords[i];
        out.extend_from_slice(&off.to_le_bytes());
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&((lat * COORD_SCALE).round() as i32).to_le_bytes());
        out.extend_from_slice(&((lon * COORD_SCALE).round() as i32).to_le_bytes());
    }
    let rows_len = (labels.len() * ROW_RECORD_BYTES) as u64;

    let labels_off = align8(&mut out);
    out.extend_from_slice(&labels_blob);

    let meta_off = align8(&mut out);
    out.extend_from_slice(&meta_json);

    out[0..4].copy_from_slice(&MAGIC);
    out[4..6].copy_from_slice(&SCHEMA_VERSION.to_le_bytes());
    out[6..8].copy_from_slice(&0u16.to_le_bytes());
    out[8..12].copy_from_slice(&(labels.len() as u32).to_le_bytes());
    out[12..16].copy_from_slice(&(key_count as u32).to_le_bytes());
    out[16..24].copy_from_slice(&fst_off.to_le_bytes());
    out[24..32].copy_from_slice(&(fst_bytes.len() as u64).to_le_bytes());
    out[32..40].copy_from_slice(&rows_off.to_le_bytes());
    out[40..48].copy_from_slice(&rows_len.to_le_bytes());
    out[48..56].copy_from_slice(&labels_off.to_le_bytes());
    out[56..64].copy_from_slice(&(labels_blob.len() as u64).to_le_bytes());
    out[64..72].copy_from_slice(&meta_off.to_le_bytes());
    out[72..80].copy_from_slice(&(meta_json.len() as u64).to_le_bytes());
    out
}
