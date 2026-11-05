// Current PTB SoA region-body tests. Mirrors the in-crate
// `interns::tests` SoA coverage but exercises the route column writer.

use pt_producer::interns::{write_routes_soa, ROUTES_SOA_BYTES_PER_ROUTE};
use pt_producer::pass1::RouteAttrs;
use pt_producer::strpool::StringPool;

/// The `0x41 RoutesSoA` body is column-major: six `u32` columns first
/// (id·agency·short·long·color·text) at bases id@0, agency@4m, short@8m,
/// long@12m, color@16m, text@20m, then a `u16 route_type` column LAST at
/// 24m; total `m * 26` bytes. Uses `m == 2` with distinct per-column,
/// per-route strings so a column transposition or a row-major (AoS) layout
/// bug is glaring (the `m == 1` case cannot distinguish them — every column
/// base collapses to a contiguous stride). Mirrors the `N == 2` discipline of
/// `write_stops_soa_quantizes_from_f64_not_f32`.
#[test]
fn write_routes_soa_round_trips_columns() {
    let keys = vec!["R0".to_string(), "R1".to_string()];
    let attrs = vec![
        RouteAttrs {
            agency_id: "AG0".into(),
            short_name: "S0".into(),
            long_name: "L0".into(),
            route_type: 3,
            route_color: "C0".into(),
            route_text_color: "T0".into(),
        },
        RouteAttrs {
            agency_id: "AG1".into(),
            short_name: "S1".into(),
            long_name: "L1".into(),
            route_type: 715,
            route_color: "C1".into(),
            route_text_color: "T1".into(),
        },
    ];
    let mut pool = StringPool::new();
    for k in &keys {
        pool.intern(k);
    }
    for a in &attrs {
        pool.intern(&a.agency_id);
        pool.intern(&a.short_name);
        pool.intern(&a.long_name);
        pool.intern(&a.route_color);
        pool.intern(&a.route_text_color);
    }

    let m = keys.len();
    let mut buf = vec![0u8; m * ROUTES_SOA_BYTES_PER_ROUTE];
    write_routes_soa(&mut buf, &keys, &attrs, &pool).unwrap();

    let col_u32 = |base: usize, i: usize| {
        u32::from_le_bytes(buf[base + i * 4..base + i * 4 + 4].try_into().unwrap())
    };
    // Every one of the six u32 columns, both rows — distinct values catch a
    // transpose between columns and a row-major layout bug.
    for i in 0..m {
        assert_eq!(col_u32(0, i), pool.index_of(&keys[i]), "id col row {i}");
        assert_eq!(
            col_u32(4 * m, i),
            pool.index_of(&attrs[i].agency_id),
            "agency col row {i}"
        );
        assert_eq!(
            col_u32(8 * m, i),
            pool.index_of(&attrs[i].short_name),
            "short col row {i}"
        );
        assert_eq!(
            col_u32(12 * m, i),
            pool.index_of(&attrs[i].long_name),
            "long col row {i}"
        );
        assert_eq!(
            col_u32(16 * m, i),
            pool.index_of(&attrs[i].route_color),
            "color col row {i}"
        );
        assert_eq!(
            col_u32(20 * m, i),
            pool.index_of(&attrs[i].route_text_color),
            "text col row {i}"
        );
    }
    // route_type u16 column LAST at 24*m, both rows (distinct 3 vs 715).
    let rt = 24 * m;
    assert_eq!(
        u16::from_le_bytes(buf[rt..rt + 2].try_into().unwrap()),
        3,
        "route_type row 0"
    );
    assert_eq!(
        u16::from_le_bytes(buf[rt + 2..rt + 4].try_into().unwrap()),
        715,
        "route_type row 1"
    );
}

#[test]
fn transpose_aos_to_soa_roundtrips() {
    let aos: Vec<u8> = {
        let mut v = vec![0u8; 24];
        v[0..4].copy_from_slice(&25_200u32.to_le_bytes());
        v[4..6].copy_from_slice(&(-1i16).to_le_bytes());
        v[6..10].copy_from_slice(&7u32.to_le_bytes());
        v[10..12].copy_from_slice(&1u16.to_le_bytes());
        v[12..16].copy_from_slice(&25_800u32.to_le_bytes());
        v[16..18].copy_from_slice(&300i16.to_le_bytes());
        v[18..22].copy_from_slice(&42u32.to_le_bytes());
        v[22..24].copy_from_slice(&2u16.to_le_bytes());
        v
    };
    let soa = pt_producer::current_emit::transpose_stop_times_aos_to_soa(&aos);
    let n = 2;
    assert_eq!(u32::from_le_bytes(soa[0..4].try_into().unwrap()), 25_200);
    assert_eq!(
        u32::from_le_bytes(soa[4 * n..4 * n + 4].try_into().unwrap()),
        7
    ); // stop_idx[0]
    assert_eq!(
        i16::from_le_bytes(soa[8 * n..8 * n + 2].try_into().unwrap()),
        -1
    ); // arr[0]
    assert_eq!(
        u16::from_le_bytes(soa[10 * n + 2..10 * n + 4].try_into().unwrap()),
        2
    ); // seq[1]
}
