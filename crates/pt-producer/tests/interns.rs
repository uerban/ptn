use pt_producer::interns::{write_trips_intern, TRIP_RECORD_BYTES};
use pt_producer::pass1::TripAttrs;
use pt_producer::strpool::StringPool;

#[test]
fn write_trips_intern_round_trips_indices() {
    // idIdx@0 | headsignIdx@4 | routeIdx@8 | serviceIdx@12 | wheelchair@16 |
    // direction_id@17 | bikes_allowed u8@18 | reserved[19] | shapeIdIdx u32@20
    let keys = vec!["T1".to_string()];
    let attrs = vec![TripAttrs {
        route_idx: 7,
        service_idx: 42,
        headsign: "Centras".to_string(),
        wheelchair_accessible: 2,
        direction_id: 1,
        bikes_allowed: 0,
        shape_id: "shp_X".to_string(),
        block_id: String::new(),
        feed_rank: 0,
    }];
    let mut pool = StringPool::new();
    for (k, a) in keys.iter().zip(&attrs) {
        pool.intern(k);
        pool.intern(&a.headsign);
        pool.intern(&a.shape_id);
    }
    let mut buf = vec![0u8; TRIP_RECORD_BYTES];
    write_trips_intern(&mut buf, &keys, &attrs, &pool).unwrap();

    assert_eq!(
        u32::from_le_bytes(buf[0..4].try_into().unwrap()),
        pool.index_of("T1")
    );
    assert_eq!(
        u32::from_le_bytes(buf[4..8].try_into().unwrap()),
        pool.index_of("Centras")
    );
    assert_eq!(u32::from_le_bytes(buf[8..12].try_into().unwrap()), 7);
    assert_eq!(u32::from_le_bytes(buf[12..16].try_into().unwrap()), 42);
    assert_eq!(buf[16], 2);
    assert_eq!(buf[17], 1);
    assert_eq!(&buf[18..20], &[0u8, 0u8]);
    assert_eq!(
        u32::from_le_bytes(buf[20..24].try_into().unwrap()),
        pool.index_of("shp_X")
    );
}
