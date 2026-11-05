//! Constants copied from `packages/shared/src/constants/defaults.ts` (`RAPTOR_MAX_ROUNDS`,
//! `RAPTOR_MIN_TRANSFER_SECS`) and the walk rescale used by the engine's footpath relaxation. Must
//! not be re-derived.

pub const RAPTOR_MAX_ROUNDS: u32 = 4;
pub const RAPTOR_MIN_TRANSFER_SECS: i64 = 120;
// Source of the integer rescale ratio below (1.25/0.8 = 25/16). The engine
// itself never does float walk math (entry/exit reach scaling is the boundary's
// job, ) — kept for provenance; `allow(dead_code)` until a consumer
// references them, so `-D warnings` CI stays green.
#[allow(dead_code)]
pub const DEFAULT_WALK_SPEED_MPS: f64 = 1.25;
#[allow(dead_code)]
pub const WHEELCHAIR_WALK_SPEED_MPS: f64 = 0.8;

/// `Number.MAX_SAFE_INTEGER` — the EXACT numeric value the wire/host contract uses. Stored/compared
/// as an integer; NOT `i32::MAX` or `f64::INFINITY`.
pub const INF: i64 = 9_007_199_254_740_991;

/// `.ptb` StopTimes sentinel for a missing departure_time (`loader.ts:120`, `0xFFFFFFFF` as u32).
/// Mapped to the `-1` sentinel at the index-space edge so every `depart_here == -1` check holds.
pub const DEP_SECS_NOT_SERVED: u32 = 0xFFFF_FFFF;

/// Walking speed, in mm/s, at which the transfer table's walks are emitted
/// (`DEFAULT_WALK_SPEED_MPS`), so this speed rescales them by exactly 1.
pub const DEFAULT_WALK_SPEED_MM_S: u32 = 1250;
/// Transfer-walk speed of a wheelchair query that names none
/// (`WHEELCHAIR_WALK_SPEED_MPS`).
pub const WHEELCHAIR_WALK_SPEED_MM_S: u32 = 800;
/// Accepted range of a query's walking speed, mm/s (0.36 to 36 km/h). The
/// hosts reject a speed outside it.
pub const MIN_WALK_SPEED_MM_S: u32 = 100;
pub const MAX_WALK_SPEED_MM_S: u32 = 10_000;
/// Largest minimum transfer a query may set, seconds. The hosts reject more.
pub const MAX_MIN_TRANSFER_SECS: u32 = 3600;

/// Footpath walk rescale from the table's speed to `speed_mm_s`, as EXACT
/// INTEGER math.
///
/// `pt-core` is `no_std` — `f64::floor`/`f64::round` are NOT in `core` (they
/// need `std` or `libm`), and float math would add a wasm-vs-native
/// determinism risk. The walk at `speed_mm_s` is `raw * 1250 / speed_mm_s`;
/// half-up rounding of that non-negative ratio is the exact integer
/// `(2 * raw * 1250 + speed) / (2 * speed)`.
///
/// 1250 mm/s is the identity. 800 mm/s (wheelchair) is exactly the former
/// fixed `25/16` rescale `(raw * 25 + 8) / 16`, since both are the same
/// fraction scaled by 100; the gate case `200 → 313` holds.
///
/// `speed_mm_s` must be positive; queries carry it as a `NonZeroU32`.
pub fn rescale_walk_secs(raw: u32, speed_mm_s: u32) -> i64 {
    let speed = speed_mm_s as i64;
    (2 * (raw as i64) * DEFAULT_WALK_SPEED_MM_S as i64 + speed) / (2 * speed)
}

/// A host's walking speed in m/s as the engine's mm/s, rounded half up, or
/// `None` when it is not finite or outside
/// [`MIN_WALK_SPEED_MM_S`]..=[`MAX_WALK_SPEED_MM_S`]. IEEE multiply and add
/// round the same on every target, so wasm and native agree.
pub fn walk_speed_mm_s_from_mps(mps: f64) -> Option<core::num::NonZeroU32> {
    if !mps.is_finite() || mps <= 0.0 {
        return None;
    }
    // `as` saturates, so a huge speed lands on u32::MAX and fails the range.
    let v = (mps * 1000.0 + 0.5) as u32;
    if !(MIN_WALK_SPEED_MM_S..=MAX_WALK_SPEED_MM_S).contains(&v) {
        return None;
    }
    core::num::NonZeroU32::new(v)
}

/// A host's optional walking speed (m/s) and minimum transfer (s), checked
/// for a [`crate::engine::Query`]. Every host (wasm, mobile, server) calls
/// this, so they accept and reject the same values with the same message.
pub fn parse_walk_params(
    walk_speed_mps: Option<f64>,
    min_transfer_secs: Option<u32>,
) -> Result<(Option<core::num::NonZeroU32>, Option<u32>), alloc::string::String> {
    let speed = match walk_speed_mps {
        None => None,
        Some(v) => Some(walk_speed_mm_s_from_mps(v).ok_or_else(|| {
            alloc::format!(
                "walkSpeedMps must be between {} and {} m/s, got: {}",
                MIN_WALK_SPEED_MM_S as f64 / 1000.0,
                MAX_WALK_SPEED_MM_S as f64 / 1000.0,
                v
            )
        })?),
    };
    if let Some(m) = min_transfer_secs {
        if m > MAX_MIN_TRANSFER_SECS {
            return Err(alloc::format!(
                "minTransferSecs must be at most {}, got: {}",
                MAX_MIN_TRANSFER_SECS,
                m
            ));
        }
    }
    Ok((speed, min_transfer_secs))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rescale_gate_case() {
        assert_eq!(rescale_walk_secs(200, WHEELCHAIR_WALK_SPEED_MM_S), 313);
    }
    #[test]
    fn rescale_default_identity() {
        for raw in [0u32, 1, 30, 200, 3600, 86_400] {
            assert_eq!(rescale_walk_secs(raw, DEFAULT_WALK_SPEED_MM_S), raw as i64);
        }
    }
    #[test]
    fn rescale_zero_wheelchair() {
        assert_eq!(rescale_walk_secs(0, WHEELCHAIR_WALK_SPEED_MM_S), 0);
    }
    /// The speed form reproduces the former fixed wheelchair rescale exactly.
    #[test]
    fn rescale_wheelchair_matches_former_fixed_ratio() {
        for raw in 0u32..=100_000 {
            let former = ((raw as i64) * 25 + 8) / 16;
            assert_eq!(
                rescale_walk_secs(raw, WHEELCHAIR_WALK_SPEED_MM_S),
                former,
                "raw {raw}"
            );
        }
    }
    /// Half-up at an odd speed: 3.5 km/h is 972 mm/s; 300 s at 1250 mm/s is
    /// 375 m, 375 / 0.972 = 385.80 → 386.
    #[test]
    fn rescale_rounds_half_up_at_odd_speed() {
        assert_eq!(rescale_walk_secs(300, 972), 386);
        // 1 s at 2500 mm/s is exactly 0.5 s → 1 (half up).
        assert_eq!(rescale_walk_secs(1, 2500), 1);
        assert_eq!(rescale_walk_secs(100, 2500), 50);
    }
    #[test]
    fn walk_speed_from_mps() {
        let mm = |v: f64| walk_speed_mm_s_from_mps(v).map(|n| n.get());
        assert_eq!(mm(1.25), Some(1250));
        assert_eq!(mm(0.8), Some(800));
        assert_eq!(mm(3.5 / 3.6), Some(972));
        assert_eq!(mm(0.1), Some(100));
        assert_eq!(mm(10.0), Some(10_000));
        assert_eq!(mm(0.09), None);
        assert_eq!(mm(10.1), None);
        assert_eq!(mm(1e300), None);
        assert_eq!(mm(0.0), None);
        assert_eq!(mm(-1.25), None);
        assert_eq!(mm(f64::NAN), None);
        assert_eq!(mm(f64::INFINITY), None);
    }
    #[test]
    fn walk_params_parse_and_reject_with_one_message() {
        assert_eq!(parse_walk_params(None, None), Ok((None, None)));
        let (speed, min) = parse_walk_params(Some(0.8), Some(300)).unwrap();
        assert_eq!(speed.map(|v| v.get()), Some(800));
        assert_eq!(min, Some(300));
        assert_eq!(parse_walk_params(None, Some(3600)), Ok((None, Some(3600))));
        assert_eq!(
            parse_walk_params(Some(0.0), None),
            Err("walkSpeedMps must be between 0.1 and 10 m/s, got: 0".into())
        );
        assert_eq!(
            parse_walk_params(None, Some(3601)),
            Err("minTransferSecs must be at most 3600, got: 3601".into())
        );
    }
}
