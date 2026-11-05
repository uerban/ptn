use pt_producer::pass1::run_pass1;
use pt_producer::source::extract_zip;
use std::path::PathBuf;

fn fixture_zip() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny-gtfs.zip")
}

#[test]
fn pass1_parses_calendar_weekdays_and_dates() {
    let tmp = tempfile::tempdir().unwrap();
    extract_zip(&fixture_zip(), tmp.path()).unwrap();
    let r = run_pass1(tmp.path()).unwrap();

    assert_eq!(r.services.len(), 2);
    let wd = r.services.lookup("WD").unwrap() as usize;
    let sa = r.services.lookup("SA").unwrap() as usize;
    // WD: mon..fri = 1, sat = sun = 0 → bits 0..4 set = 0b0001_1111.
    assert_eq!(r.service_attrs[wd].weekdays, 0b0001_1111);
    // SA: only saturday → bit 5 set.
    assert_eq!(r.service_attrs[sa].weekdays, 0b0010_0000);
    assert_eq!(r.service_attrs[wd].start_date, 20260501);
    assert_eq!(r.service_attrs[wd].end_date, 20260801);
}

#[test]
fn pass1_records_calendar_dates_removals() {
    let tmp = tempfile::tempdir().unwrap();
    extract_zip(&fixture_zip(), tmp.path()).unwrap();
    let r = run_pass1(tmp.path()).unwrap();

    let wd = r.services.lookup("WD").unwrap() as usize;
    assert_eq!(r.service_attrs[wd].removals, vec![20260520]);
    assert!(r.service_attrs[wd].additions.is_empty());
}

#[test]
fn pass1_feed_start_date_is_min_of_service_starts() {
    let tmp = tempfile::tempdir().unwrap();
    extract_zip(&fixture_zip(), tmp.path()).unwrap();
    let r = run_pass1(tmp.path()).unwrap();
    assert_eq!(r.feed_start_date, 20260501);
}

#[test]
fn pass1_parses_calendar_dates_additions() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    std::fs::write(
        dir.join("agency.txt"),
        "agency_id,agency_name,agency_url,agency_timezone\nA,A,https://example.com,UTC\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("stops.txt"),
        "stop_id,stop_name,stop_lat,stop_lon\nS1,A,0,0\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("routes.txt"),
        "route_id,agency_id,route_short_name,route_long_name,route_type\nR1,A,1,One,3\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("calendar.txt"),
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
         WD,1,1,1,1,1,0,0,20260601,20260901\n",
    )
    .unwrap();
    // exception_type=1 → service added on that date even though weekday is off.
    std::fs::write(
        dir.join("calendar_dates.txt"),
        "service_id,date,exception_type\nWD,20260615,1\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("trips.txt"),
        "route_id,service_id,trip_id\nR1,WD,T1\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("stop_times.txt"),
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
         T1,07:00:00,07:00:00,S1,1\n",
    )
    .unwrap();

    let r = run_pass1(dir).unwrap();
    let wd = r.services.lookup("WD").unwrap() as usize;
    assert_eq!(r.service_attrs[wd].additions, vec![20260615]);
    assert!(r.service_attrs[wd].removals.is_empty());
}

#[test]
fn pass1_tolerates_calendar_dates_only_service() {
    // GTFS allows a service_id to appear ONLY in calendar_dates.txt
    // (weekday mask is then implicitly all-zeros and the service runs
    // exactly on its `additions` dates).
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    std::fs::write(
        dir.join("agency.txt"),
        "agency_id,agency_name,agency_url,agency_timezone\nA,A,https://example.com,UTC\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("stops.txt"),
        "stop_id,stop_name,stop_lat,stop_lon\nS1,A,0,0\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("routes.txt"),
        "route_id,agency_id,route_short_name,route_long_name,route_type\nR1,A,1,One,3\n",
    )
    .unwrap();
    // No calendar.txt — start with calendar_dates.txt only.
    std::fs::write(
        dir.join("calendar_dates.txt"),
        "service_id,date,exception_type\nSPECIAL,20260615,1\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("trips.txt"),
        "route_id,service_id,trip_id\nR1,SPECIAL,T1\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("stop_times.txt"),
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
         T1,07:00:00,07:00:00,S1,1\n",
    )
    .unwrap();

    let r = run_pass1(dir).unwrap();
    assert_eq!(r.services.len(), 1);
    let sp = r.services.lookup("SPECIAL").unwrap() as usize;
    assert_eq!(r.service_attrs[sp].weekdays, 0);
    assert_eq!(r.service_attrs[sp].additions, vec![20260615]);
    // feed_start_date must come from `additions` when no service has a
    // calendar.txt start_date — without this, compute_service_bitmasks's
    // short-circuit produces an all-zero mask and the addition's bit is lost.
    assert_eq!(r.feed_start_date, 20260615);
    let bitmasks = pt_producer::service::bitmask::compute_service_bitmasks(
        &r.service_attrs,
        r.feed_start_date,
        90,
    )
    .unwrap();
    assert!(
        bitmasks[sp].iter().any(|&b| b != 0),
        "calendar-dates-only addition must set at least one bit"
    );
    // day 0 of the window IS the addition date — bit 0 must be set.
    assert_eq!(bitmasks[sp][0] & 1, 1, "addition at day 0 must light bit 0");
}

#[test]
fn cross_feed_calendar_preserves_calendar_dates_exceptions() {
    // Multi-feed: feed-0 has calendar_dates.txt populating exceptions for WD;
    // feed-1 has calendar.txt for the same WD service_id. The second feed's
    // calendar.txt must NOT wipe the first feed's exceptions.
    use pt_producer::pass1::run_pass1_union;
    let tmp = tempfile::tempdir().unwrap();
    let f0 = tmp.path().join("feed-0");
    let f1 = tmp.path().join("feed-1");
    for d in [&f0, &f1] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(
            d.join("agency.txt"),
            "agency_id,agency_name,agency_url,agency_timezone\nA,A,https://example.com,UTC\n",
        )
        .unwrap();
        std::fs::write(
            d.join("stops.txt"),
            "stop_id,stop_name,stop_lat,stop_lon\nS1,A,0,0\n",
        )
        .unwrap();
        std::fs::write(
            d.join("routes.txt"),
            "route_id,agency_id,route_short_name,route_long_name,route_type\nR1,A,1,One,3\n",
        )
        .unwrap();
        std::fs::write(
            d.join("trips.txt"),
            "route_id,service_id,trip_id\nR1,WD,T1\n",
        )
        .unwrap();
        std::fs::write(
            d.join("stop_times.txt"),
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
             T1,07:00:00,07:00:00,S1,1\n",
        )
        .unwrap();
    }
    // Only feed-0 has calendar_dates.txt (addition + removal).
    std::fs::write(
        f0.join("calendar_dates.txt"),
        "service_id,date,exception_type\nWD,20260615,1\nWD,20260616,2\n",
    )
    .unwrap();
    // Only feed-1 has calendar.txt (weekday mask + start/end).
    std::fs::write(
        f1.join("calendar.txt"),
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
         WD,1,1,1,1,1,0,0,20260601,20260901\n",
    )
    .unwrap();

    let r = run_pass1_union(&[f0.clone(), f1.clone()]).unwrap();
    let wd = r.services.lookup("WD").unwrap() as usize;
    assert_eq!(
        r.service_attrs[wd].weekdays, 0b0001_1111,
        "weekdays from feed-1"
    );
    assert_eq!(
        r.service_attrs[wd].start_date, 20260601,
        "start_date from feed-1"
    );
    assert_eq!(
        r.service_attrs[wd].additions,
        vec![20260615],
        "additions from feed-0 must survive feed-1's calendar.txt"
    );
    assert_eq!(
        r.service_attrs[wd].removals,
        vec![20260616],
        "removals from feed-0 must survive feed-1's calendar.txt"
    );
}
