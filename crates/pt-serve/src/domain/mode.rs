//! GTFS `route_type` → wire `mode` string. Single source of truth lives in
//! `pt_core::engine::mode`; this is a thin convenience wrapper so callers keep
//! the `route_type_to_mode(u16) -> &str` shape. Parity is enforced by the
//! committed golden table tested in pt-core (spec A5).

/// Canonical UPPERCASE mode string for a GTFS route_type.
pub fn route_type_to_mode(route_type: u16) -> &'static str {
    pt_core::engine::mode::mode_to_wire_str(pt_core::engine::mode::route_type_to_mode(route_type))
}
