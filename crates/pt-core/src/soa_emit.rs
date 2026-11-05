//! crates/pt-core/src/soa_emit.rs — always-compiled SoA column encoders.
//! ONE source of the frozen column layout, shared by the testkit writer
//! (`build_v1_ptb`), the fixture emitter, and the producer.
//!
//! These encoders write the TIGHT column bodies in the NORMATIVE column order.
//! Coord quantization (f64 → `*_e7` i32 via `coord_quant::encode_{lat,lon}_e7`)
//! is done by the CALLER, which owns the out-of-range error policy; the encoder
//! takes the already-quantized slices.
use alloc::vec::Vec;

/// StopsSoA `0x40` body: the five 4-byte columns first
/// (`id_idx·name_idx·lat_e7·lon_e7·parent_idx`, `u32`/`i32` little-endian), then
/// the narrow `wheelchair` `u8` column LAST. Tight `N*21` (`N*(4*5) + N`).
///
/// All column slices MUST have the same length `N`; `parent_idx` already carries
/// the `u32::MAX` sentinel for "no parent" (the caller maps `None ⇒ u32::MAX`).
pub fn encode_stops_soa_columns(
    out: &mut Vec<u8>,
    id_idx: &[u32],
    name_idx: &[u32],
    lat_e7: &[i32],
    lon_e7: &[i32],
    parent_idx: &[u32],
    wheelchair: &[u8],
) {
    for &v in id_idx {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for &v in name_idx {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for &v in lat_e7 {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for &v in lon_e7 {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for &v in parent_idx {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for &v in wheelchair {
        out.push(v);
    }
}

/// RoutesSoA `0x41` body: the six `u32` columns first
/// (`id·agency·short·long·color·text_color`, little-endian), then the narrow
/// `route_type` `u16` column LAST. Tight `M*26` (`M*(4*6) + M*2`).
///
/// All column slices MUST have the same length `M`.
#[allow(clippy::too_many_arguments)]
pub fn encode_routes_soa_columns(
    out: &mut Vec<u8>,
    id: &[u32],
    agency: &[u32],
    short: &[u32],
    long: &[u32],
    color: &[u32],
    text: &[u32],
    route_type: &[u16],
) {
    for cols in [id, agency, short, long, color, text] {
        for &v in cols {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    for &v in route_type {
        out.extend_from_slice(&v.to_le_bytes());
    }
}
