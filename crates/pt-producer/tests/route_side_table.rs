//! GTFS route metadata and networks survive into published PTB v1 and v2 bundles.

use pt_core::header::Header;
use pt_core::region_ids::ROUTE_SIDE_TABLE;
use pt_core::route_side::RouteSideTable;
use pt_core::strpool::StringPool;
use pt_producer::cli::DeriveInseat;
use pt_producer::download::record_for_local;
use std::io::Write;
use std::path::{Path, PathBuf};
use zip::write::FileOptions;

const PLAIN_ROUTES: &str = "route_id,route_type\nR1,3\nR2,3\n";
const RICH_ROUTES: &str = "route_id,route_type,route_desc,route_url,route_sort_order\nR1,3,Night line,https://r.example/1,5\nR2,3,,,\n";
const NETWORKS: (&str, &str) = ("networks.txt", "network_id,network_name\nb,Beta\na,Alpha\n");
const ASSIGNMENTS: (&str, &str) = ("route_networks.txt", "network_id,route_id\na,R1\nb,R2\n");

fn feed_zip(tmp: &Path, routes: &str, extra: &[(&str, &str)]) -> PathBuf {
    let path = tmp.join("feed.zip");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    let files = [
        ("stops.txt", "stop_id,stop_name,stop_lat,stop_lon\nS1,One,48.85,2.35\nS2,Two,48.86,2.36\n"),
        ("routes.txt", routes),
        ("calendar.txt", "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nALL,1,1,1,1,1,1,1,20260401,20261231\n"),
        ("trips.txt", "route_id,service_id,trip_id\nR1,ALL,T1\nR2,ALL,T2\n"),
        ("stop_times.txt", "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,S1,1\nT1,08:10:00,08:10:00,S2,2\nT2,09:00:00,09:00:00,S1,1\nT2,09:10:00,09:10:00,S2,2\n"),
    ];
    let options: FileOptions<'_, '_, ()> = FileOptions::default();
    for (name, body) in files.iter().chain(extra) {
        zip.start_file(*name, options).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
    path
}

fn build_v1(tmp: &Path, routes: &str, extra: &[(&str, &str)]) -> Vec<u8> {
    let zip = feed_zip(tmp, routes, extra);
    let dest = tmp.join("v1.ptb");
    pt_producer::build::build_ptb(
        vec![record_for_local(&zip).unwrap()],
        &tmp.join("extract"),
        &dest,
        Some(20260504),
        Some(7200),
        Some("Europe/Paris"),
        DeriveInseat::Auto,
    )
    .unwrap();
    std::fs::read(dest).unwrap()
}

fn build_v2(tmp: &Path, routes: &str, extra: &[(&str, &str)]) -> Vec<u8> {
    let zip = feed_zip(tmp, routes, extra);
    pt_producer::ptb_v2::stage(
        vec![record_for_local(&zip).unwrap()],
        &tmp.join("extract"),
        &tmp.join("out"),
        20260504,
        "Europe/Paris",
        DeriveInseat::Auto,
    )
    .unwrap();
    std::fs::read(tmp.join("out/bundle.ptb")).unwrap()
}

fn assert_preserved(bytes: &[u8]) {
    let header = Header::parse(bytes).unwrap();
    let entry = header.region_by_id(ROUTE_SIDE_TABLE).expect("0x23 present");
    let pool_entry = header.region_by_id(0xF7).expect("pool present");
    let pool_bytes = &bytes[pool_entry.offset..pool_entry.offset + pool_entry.length];
    let pool = StringPool::parse(pool_bytes, pool_entry.length).unwrap();
    let body = &bytes[entry.offset..entry.offset + entry.length];
    let table = RouteSideTable::decode(body, 2, pool.count())
        .unwrap()
        .unwrap();
    let text = |idx| pool.str_at(idx).unwrap();
    assert_eq!(table.network_count(), 2);
    assert_eq!(
        (text(table.network(0).0), text(table.network(0).1)),
        ("a", "Alpha")
    );
    assert_eq!(
        (text(table.network(1).0), text(table.network(1).1)),
        ("b", "Beta")
    );
    let first = table.route(0);
    assert_eq!(text(first.desc_idx), "Night line");
    assert_eq!(text(first.url_idx), "https://r.example/1");
    assert_eq!(first.sort_order, Some(5));
    assert_eq!(first.network_ord, Some(0));
    let second = table.route(1);
    assert_eq!((second.desc_idx, second.url_idx), (0, 0));
    assert_eq!(second.sort_order, None);
    assert_eq!(second.network_ord, Some(1));
}

#[test]
fn v1_bundle_preserves_route_side_table() {
    let tmp = tempfile::tempdir().unwrap();
    assert_preserved(&build_v1(tmp.path(), RICH_ROUTES, &[NETWORKS, ASSIGNMENTS]));
}

#[test]
fn v2_bundle_preserves_route_side_table_and_validates() {
    let tmp = tempfile::tempdir().unwrap();
    let bytes = build_v2(tmp.path(), RICH_ROUTES, &[NETWORKS, ASSIGNMENTS]);
    assert_preserved(&bytes);
    let reader = pt_core::Reader::from_bytes(bytes).unwrap();
    assert_eq!(reader.route_short_name(0).unwrap(), "");
}

#[test]
fn feed_without_fields_omits_the_region() {
    let tmp = tempfile::tempdir().unwrap();
    let bytes = build_v1(tmp.path(), PLAIN_ROUTES, &[]);
    assert!(Header::parse(&bytes)
        .unwrap()
        .region_by_id(ROUTE_SIDE_TABLE)
        .is_none());
}

#[test]
fn unused_network_table_omits_the_region() {
    let tmp = tempfile::tempdir().unwrap();
    let bytes = build_v1(tmp.path(), PLAIN_ROUTES, &[NETWORKS]);
    assert!(Header::parse(&bytes)
        .unwrap()
        .region_by_id(ROUTE_SIDE_TABLE)
        .is_none());
}
