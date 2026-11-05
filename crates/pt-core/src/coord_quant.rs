//! deg<->i32@1e7. Kept dependency-free so the no_std engine and the workspace
//! producer share one implementation. ENCODE is producer-side; pt-core links DECODE (+ uses
//! encode in gen_fixtures). Core-only rounding — libm/f64::round deliberately
//! avoided (consts.rs:26-34: no_std + wasm-vs-native FP-determinism). NOT the
//! f32/1e5 quantize_deg in pt-shared/src/sidecar.rs.
const SCALE: f64 = 1e7;
fn encode_e7_bounded(deg: f64, max_abs: f64) -> Option<i32> {
    if !deg.is_finite() || deg < -max_abs || deg > max_abs {
        return None;
    }
    let s = deg * SCALE;
    let q = (s + 0.5_f64.copysign(s)) as i64; // `as i64` truncates toward zero in core
    if q < i32::MIN as i64 || q > i32::MAX as i64 {
        return None;
    }
    Some(q as i32)
}
pub fn encode_lat_e7(deg: f64) -> Option<i32> {
    encode_e7_bounded(deg, 90.0)
}
pub fn encode_lon_e7(deg: f64) -> Option<i32> {
    encode_e7_bounded(deg, 180.0)
}
pub fn decode_e7(e7: i32) -> f64 {
    e7 as f64 / SCALE
}
