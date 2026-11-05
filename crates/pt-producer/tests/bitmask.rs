use pt_producer::pass1::ServiceAttrs;
use pt_producer::service::bitmask::{
    compute_service_bitmasks, dedup_service_bitfields, SERVICE_WINDOW_DAYS,
};

/// The historical fixed window length, now passed explicitly per call (the
/// `compute_service_bitmasks` takes the derived window — the
/// caller threads the DERIVED `window_days`). Most of these tests still exercise
/// the 90-day case, so pin the constant here for readability.
const W90: u16 = 90;

fn bit(mask: &[u8], day: usize) -> bool {
    (mask[day / 8] >> (day % 8)) & 1 != 0
}

#[test]
fn anchored_weekday_monday_lights_up_day_zero_for_monday_service() {
    // 2026-05-18 is a Monday; the anchor formula must yield bit 0 for that
    // day. Service WD runs Mon..Fri (weekdays = 0b0001_1111).
    let services = vec![ServiceAttrs {
        weekdays: 0b0001_1111,
        start_date: 20260518,
        end_date: 20260817,
        additions: vec![],
        removals: vec![],
    }];
    let bitmasks = compute_service_bitmasks(&services, 20260518, W90).unwrap();
    assert_eq!(bitmasks.len(), 1);
    // day 0 = 2026-05-18 (Mon) — bit should be set.
    assert!(bit(&bitmasks[0], 0), "Mon at day 0 should be set");
    // day 5 = 2026-05-23 (Sat) — bit should NOT be set.
    assert!(!bit(&bitmasks[0], 5), "Sat at day 5 should be clear");
    // day 6 = 2026-05-24 (Sun) — bit should NOT be set.
    assert!(!bit(&bitmasks[0], 6), "Sun at day 6 should be clear");
    // day 7 = 2026-05-25 (Mon) — bit should be set.
    assert!(bit(&bitmasks[0], 7), "Mon at day 7 should be set");
}

#[test]
fn exception_type_1_addition_sets_bit_on_off_day() {
    // Service runs Mon..Fri only, but addition on a Sat. Day 5 = 2026-05-23 (Sat).
    let services = vec![ServiceAttrs {
        weekdays: 0b0001_1111,
        start_date: 20260518,
        end_date: 20260817,
        additions: vec![20260523],
        removals: vec![],
    }];
    let bitmasks = compute_service_bitmasks(&services, 20260518, W90).unwrap();
    assert!(
        bit(&bitmasks[0], 5),
        "Sat 2026-05-23 added by exception → bit 5 set"
    );
    // Adjacent days respect the weekday mask: Fri (day 4) on, Sun (day 6) off.
    assert!(bit(&bitmasks[0], 4));
    assert!(!bit(&bitmasks[0], 6));
}

#[test]
fn exception_type_2_removal_clears_bit_on_on_day() {
    // Service runs Mon..Fri. Day 2 = Wed 2026-05-20 — removal clears it.
    let services = vec![ServiceAttrs {
        weekdays: 0b0001_1111,
        start_date: 20260518,
        end_date: 20260817,
        additions: vec![],
        removals: vec![20260520],
    }];
    let bitmasks = compute_service_bitmasks(&services, 20260518, W90).unwrap();
    assert!(
        !bit(&bitmasks[0], 2),
        "Wed 2026-05-20 removed → bit 2 clear"
    );
    // Surrounding weekdays still set.
    assert!(bit(&bitmasks[0], 0)); // Mon
    assert!(bit(&bitmasks[0], 1)); // Tue
    assert!(bit(&bitmasks[0], 3)); // Thu
}

#[test]
fn service_starting_after_window_is_all_zero() {
    // Window is 90 days from 2026-05-18 = up to 2026-08-16. Service starts
    // 2026-09-01 — no bit can be set.
    let services = vec![ServiceAttrs {
        weekdays: 0b0111_1111, // every day
        start_date: 20260901,
        end_date: 20261231,
        additions: vec![],
        removals: vec![],
    }];
    let bitmasks = compute_service_bitmasks(&services, 20260518, W90).unwrap();
    assert!(
        bitmasks[0].iter().all(|&b| b == 0),
        "service starting after window must yield all-zero bitmask"
    );
    assert_eq!(bitmasks[0].len(), SERVICE_WINDOW_DAYS.div_ceil(8));
}

#[test]
fn service_ending_before_window_is_all_zero() {
    // Service ended 2026-05-01 — window starts 2026-05-18 → no bit set.
    let services = vec![ServiceAttrs {
        weekdays: 0b0111_1111,
        start_date: 20260101,
        end_date: 20260501,
        additions: vec![],
        removals: vec![],
    }];
    let bitmasks = compute_service_bitmasks(&services, 20260518, W90).unwrap();
    assert!(
        bitmasks[0].iter().all(|&b| b == 0),
        "service ending before window must yield all-zero bitmask"
    );
}

#[test]
fn empty_service_attrs_yields_empty_output() {
    let services: Vec<ServiceAttrs> = vec![];
    let bitmasks = compute_service_bitmasks(&services, 20260518, W90).unwrap();
    assert!(bitmasks.is_empty());
}

#[test]
fn bitmask_byte_count_is_ceiling_of_window_div_8() {
    let services = vec![ServiceAttrs::default()];
    let bitmasks = compute_service_bitmasks(&services, 20260518, W90).unwrap();
    assert_eq!(bitmasks[0].len(), SERVICE_WINDOW_DAYS.div_ceil(8));
}

#[test]
fn stride_follows_window_days_400_is_50_bytes() {
    // The stride is `ceil(window_days/8)`, driven by the derived
    // window_days passed in — NOT the fixed 90-day const. window 400 → 50 B.
    let services = vec![ServiceAttrs::default()];
    let bitmasks = compute_service_bitmasks(&services, 20260518, 400).unwrap();
    assert_eq!(bitmasks[0].len(), 50, "ceil(400/8) == 50");
}

#[test]
fn stride_follows_window_days_330_is_42_bytes() {
    let services = vec![ServiceAttrs::default()];
    let bitmasks = compute_service_bitmasks(&services, 20260518, 330).unwrap();
    assert_eq!(bitmasks[0].len(), 42, "ceil(330/8) == 42");
}

#[test]
fn wider_window_lights_days_past_ninety() {
    // A daily service whose end_date is well past day 90 must have bits set in
    // the [90, window) tail — proving the loop iterates the WIDER window, not
    // the old fixed 90. anchor 20260518; daily; end_date far in 2027.
    let services = vec![ServiceAttrs {
        weekdays: 0b0111_1111, // every day
        start_date: 20260518,
        end_date: 20270518,
        additions: vec![],
        removals: vec![],
    }];
    let bitmasks = compute_service_bitmasks(&services, 20260518, 200).unwrap();
    assert_eq!(bitmasks[0].len(), 25, "ceil(200/8) == 25");
    // day 150 is past the old 90-day window but inside the 200-day window.
    assert!(bit(&bitmasks[0], 150), "daily service must run on day 150");
    assert!(
        bit(&bitmasks[0], 199),
        "daily service must run on last day 199"
    );
}

// ---------------------------------------------------------------------------
// dedup_service_bitfields — first-seen dedup of identical service
// bitfields into a distinct pool + per-service index. The single property the
// 0x15/0x16 wire format hinges on is the round-trip (I6): for every service `s`,
// the pool slice at `idx[s]*S .. idx[s]*S + S` byte-equals `masks[s]`.
// ---------------------------------------------------------------------------

/// `S`-byte stride for these dedup tests (fixed 12 B = the historical 90-day
/// stride; the property is stride-agnostic so any constant works).
const S12: usize = 12;

/// Helper: slice the pool back out for service `s` (the I6 round-trip slice).
fn pool_slice<'a>(pool: &'a [u8], idx: &[u32], s: usize, stride: usize) -> &'a [u8] {
    let base = idx[s] as usize * stride;
    &pool[base..base + stride]
}

#[test]
fn dedup_empty_input_is_empty_pool() {
    let masks: Vec<Vec<u8>> = vec![];
    let (pool, idx, count) = dedup_service_bitfields(&masks);
    assert!(pool.is_empty(), "empty input → empty pool");
    assert!(idx.is_empty(), "empty input → empty index");
    assert_eq!(count, 0, "empty input → count 0");
}

#[test]
fn dedup_all_identical_collapses_to_one() {
    // Three identical all-zero bitfields collapse to a single pool entry; every
    // service maps to pool index 0.
    let masks = vec![vec![0u8; S12], vec![0u8; S12], vec![0u8; S12]];
    let (pool, idx, count) = dedup_service_bitfields(&masks);
    assert_eq!(count, 1, "all-identical → 1 distinct bitfield");
    assert_eq!(pool.len(), S12, "pool holds exactly one S-byte bitfield");
    assert_eq!(idx, vec![0, 0, 0], "every service points at pool[0]");
    // Round-trip (I6).
    for s in 0..masks.len() {
        assert_eq!(pool_slice(&pool, &idx, s, S12), masks[s].as_slice());
    }
}

#[test]
fn dedup_all_distinct_is_identity_i7() {
    // I7: N all-distinct bitfields → count == N, idx == 0..N, pool == the
    // input-order concatenation (the first-seen off-by-one boundary guard).
    let masks: Vec<Vec<u8>> = (0u8..4)
        .map(|b| {
            let mut m = vec![0u8; S12];
            m[0] = b + 1; // 1,2,3,4 — all distinct, all non-zero
            m
        })
        .collect();
    let (pool, idx, count) = dedup_service_bitfields(&masks);
    assert_eq!(count, masks.len() as u32, "all-distinct → count == N");
    assert_eq!(idx, vec![0, 1, 2, 3], "all-distinct → idx == 0..N");
    let expected: Vec<u8> = masks.iter().flatten().copied().collect();
    assert_eq!(pool, expected, "all-distinct → pool is input-order concat");
    for s in 0..masks.len() {
        assert_eq!(pool_slice(&pool, &idx, s, S12), masks[s].as_slice());
    }
}

#[test]
fn dedup_interleaved_repeats_preserve_first_seen_order() {
    // Pattern A,B,A,C,B,A — distinct {A,B,C} in first-seen order; pool is
    // [A,B,C] and idx maps each service back. Round-trip (I6) over every slot.
    let a = {
        let mut m = vec![0u8; S12];
        m[0] = 0xAA;
        m
    };
    let b = {
        let mut m = vec![0u8; S12];
        m[1] = 0xBB;
        m
    };
    let c = {
        let mut m = vec![0u8; S12];
        m[2] = 0xCC;
        m
    };
    let masks = vec![
        a.clone(),
        b.clone(),
        a.clone(),
        c.clone(),
        b.clone(),
        a.clone(),
    ];
    let (pool, idx, count) = dedup_service_bitfields(&masks);
    assert_eq!(count, 3, "{{A,B,C}} → 3 distinct");
    assert_eq!(idx, vec![0, 1, 0, 2, 1, 0], "first-seen index mapping");
    // Pool is exactly [A,B,C] in first-seen order.
    assert_eq!(&pool[0..S12], a.as_slice());
    assert_eq!(&pool[S12..2 * S12], b.as_slice());
    assert_eq!(&pool[2 * S12..3 * S12], c.as_slice());
    for s in 0..masks.len() {
        assert_eq!(pool_slice(&pool, &idx, s, S12), masks[s].as_slice());
    }
}

#[test]
fn dedup_is_deterministic_pure_function_of_input_order_i5() {
    // I5: dedup of the same input twice yields byte-identical (pool, idx, count)
    // — the clone-on-HIT-free path must not perturb ordering, and the result is
    // a pure function of input order (independent of any internal map type).
    let mk = |seed: u8| {
        let mut m = vec![0u8; S12];
        m[3] = seed;
        m
    };
    let masks = vec![mk(1), mk(2), mk(1), mk(3), mk(2), mk(2), mk(4)];
    let r1 = dedup_service_bitfields(&masks);
    let r2 = dedup_service_bitfields(&masks);
    assert_eq!(
        r1, r2,
        "dedup is a deterministic pure function of input order"
    );
}

#[test]
fn dedup_all_zero_single_collapses_round_trips() {
    // All-zero edge: a lone all-zero bitfield is a valid distinct entry (NOT
    // dropped) and round-trips (I6).
    let masks = vec![vec![0u8; S12]];
    let (pool, idx, count) = dedup_service_bitfields(&masks);
    assert_eq!(count, 1);
    assert_eq!(idx, vec![0]);
    assert_eq!(pool_slice(&pool, &idx, 0, S12), masks[0].as_slice());
}
