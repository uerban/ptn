use pt_producer::layout::{Layout, Region};

const REGIONS_IN_ORDER: [Region; 7] = [
    Region::TripsIntern,
    Region::ServiceBitmasks,
    Region::StopTimes,
    Region::TripStarts,
    Region::Csr,
    Region::StringPool,
    Region::Transfers,
];

fn align_up_4k(n: u64) -> u64 {
    (n + 4095) & !4095
}

#[test]
fn layout_offsets_are_page_aligned_and_disjoint() {
    let l = Layout::compute(3000, 80, 10_000, 500_000, 90, 200, 0, 0);

    for region in REGIONS_IN_ORDER {
        let off = l.offset(region);
        assert_eq!(off % 4096, 0, "{:?} not 4 KiB aligned: {off}", region);
    }
    assert_eq!(l.length(Region::StopTimes), 500_000 * 12);
    let mut last_end = 0u64;
    for region in REGIONS_IN_ORDER {
        let off = l.offset(region);
        let len = l.length(region);
        assert!(off >= last_end, "{:?} overlaps previous", region);
        last_end = off + len;
    }
    assert_eq!(l.total_bytes(), align_up_4k(last_end));
}

#[test]
fn layout_stop_times_region_is_exactly_total_times_row_stride() {

    let l = Layout::compute(3, 2, 4, 12, 90, 2, 0, 0);
    assert_eq!(l.length(Region::StopTimes), 12 * 12);
}

#[test]
fn layout_trip_starts_region_holds_num_trips_plus_one_offsets() {
    // TripStarts carries num_trips+1 u32 prefix-sum offsets (populates them). It sits between
    // StopTimes and Csr and is page-aligned.
    let num_trips = 10_000u64;
    let l = Layout::compute(3000, 80, num_trips, 500_000, 90, 200, 0, 0);
    assert_eq!(l.length(Region::TripStarts), (num_trips + 1) * 4);
    assert_eq!(
        l.offset(Region::TripStarts) % 4096,
        0,
        "TripStarts not 4 KiB aligned"
    );
    assert!(
        l.offset(Region::StopTimes) < l.offset(Region::TripStarts),
        "TripStarts must follow StopTimes"
    );
    assert!(
        l.offset(Region::TripStarts) < l.offset(Region::Csr),
        "TripStarts must precede Csr"
    );
}

#[test]
fn layout_total_bytes_is_page_aligned() {
    let l = Layout::compute(3000, 80, 10_000, 500_000, 90, 200, 0, 0);
    assert_eq!(l.total_bytes() % 4096, 0);
}

#[test]
fn layout_csr_region_fits_four_packed_arrays_at_city_scale() {
    // The CSR region packs four u32 arrays back-to-back (rt_offsets,
    // rt_neighbors, sr_offsets, sr_neighbors). The sr_neighbors slice is
    // bounded by `total_stop_times`.
    let num_stops = 3000u64;
    let num_routes = 80u64;
    let num_trips = 10_000u64;
    let total_stop_times = 500_000u64;
    let needed = (num_routes + 1) * 4 + num_trips * 4 + (num_stops + 1) * 4 + total_stop_times * 4;
    let l = Layout::compute(
        num_stops,
        num_routes,
        num_trips,
        total_stop_times,
        90,
        200,
        0,
        0,
    );
    assert!(
        l.length(Region::Csr) >= needed,
        "CSR region {} < required {needed}",
        l.length(Region::Csr)
    );
    assert_eq!(l.length(Region::Csr), align_up_4k(needed));
}
