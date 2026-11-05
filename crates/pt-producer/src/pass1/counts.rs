use crate::error::{Error, Result};
use crate::pass1::attrs::{remap_attrs, RouteAttrs, StopAttrs, TripAttrs};
use crate::pass1::calendar::{parse_calendar, parse_calendar_dates, ServiceAttrs};
use crate::pass1::identity::{IdentityInterner, InternTable};
use crate::pass1::stop_sequences::{scan_trip_stop_triples, TripEndpoint, TripStopTriple};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub struct Pass1Result {
    pub stops: InternTable<String>,
    pub routes: InternTable<String>,
    pub services: InternTable<String>,
    pub trips: InternTable<String>,
    pub stops_attrs: Vec<StopAttrs>,
    /// Sorted by `child_idx`, using post-finalize stop indices. Stops whose
    /// `parent_station` references an unknown stop_id are dropped + logged.
    /// `Vec::is_empty()` for feeds with no parent_station column.
    pub stop_parent_map: Vec<(u32, u32)>,
    pub routes_attrs: Vec<RouteAttrs>,
    pub service_attrs: Vec<ServiceAttrs>,
    pub trips_attrs: Vec<TripAttrs>,
    pub stop_times_per_trip: Vec<u32>,
    pub total_stop_times: u32,
    /// Min `start_date` (YYYYMMDD) across all service entries; 0 if none. Used by the service
    /// bitmask builder to anchor the 90-day window.
    pub feed_start_date: u32,
    /// Max service-horizon date (YYYYMMDD) across all services: the latest of
    /// every `calendar.end_date` AND every `calendar_dates` ADD date
    /// (`exception_type == 1`). REMOVE rows (`exception_type == 2`) do NOT
    /// extend it. `0` when the feed has NO end dates and NO ADD rows (the
    /// empty-fold sentinel → the window derive floors to 90).
    ///
    /// Consumed at build time by `service::bitmask::derive_window` (the anchor
    /// `feed_start_date` is overridden post-pass1, so the horizon is computed
    /// from this `max_end_date` against the FINAL anchor — not here).
    ///
    /// GTFS reference: https://gtfs.org/documentation/schedule/reference/#calendar_datestxt
    pub max_end_date: u32,
    /// `(trip_idx, stop_idx, stop_sequence)` triples post-finalize. Consumed by the stop→routes CSR
    /// builder and the route→trips CSR builder.
    pub trip_stop_triples: Vec<TripStopTriple>,
    /// Per-trip first/last stop + time, indexed by post-finalize trip ordinal.
    /// Populated during the same Pass-1b stop_times scan as `trip_stop_triples`.
    /// `first`/`last` chosen by min/max `stop_sequence` (not file order).
    /// `u32::MAX` = time missing/unparseable.
    ///
    /// GTFS reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
    pub trip_endpoints: Vec<TripEndpoint>,
    /// One packed GTFS boarding byte per stop_time row, in the SAME global-row
    /// order as the PTB StopTimes region (`boarding[off / stride]`). Packs
    /// `pickup_type`/`drop_off_type`/`continuous_pickup`/`continuous_drop_off`
    /// 2 bits each:
    /// `(cont_drop_off << 6) | (cont_pickup << 4) | (drop_off << 2) | pickup`;
    /// default byte `0x50` (pickup/drop_off 0, continuous_* 1).
    ///
    /// NOT populated by `run_pass1_union` (pass1 doesn't write stop_times) — it
    /// is left empty here and FILLED by the Pass-2 caller
    /// (`build::build_ptb` / `main::run`) after `parse_and_write_stop_times`
    /// threads the same `&mut [u8]` across all feeds. Consumed by the current
    /// emitter when it constructs PatternSemantics.
    pub stop_time_boarding: Vec<u8>,
}

pub fn run_pass1(dir: &Path) -> Result<Pass1Result> {
    run_pass1_union(&[dir.to_path_buf()])
}

pub fn run_pass1_union(feed_dirs: &[PathBuf]) -> Result<Pass1Result> {
    if feed_dirs.is_empty() {
        return Err(Error::Config("run_pass1_union: empty feed list".into()));
    }

    let mut stops = IdentityInterner::<String>::new();
    let mut routes = IdentityInterner::<String>::new();
    let mut services = IdentityInterner::<String>::new();
    let mut trips = IdentityInterner::<String>::new();

    let mut pre_stops_attrs: Vec<StopAttrs> = Vec::new();
    let mut pre_routes_attrs: Vec<RouteAttrs> = Vec::new();
    let mut pre_service_attrs: Vec<ServiceAttrs> = Vec::new();
    let mut pre_trips_attrs: Vec<TripAttrs> = Vec::new();
    // Parallel "written" flags so a real row whose fields happen to match
    // `Default` (e.g. a GTFS stop with empty lat/lon, parsed to 0.0) is not
    // mistaken for an unfilled slot by a subsequent feed's scan. Without
    // these the first-feed-wins guard would silently overwrite such rows.
    let mut pre_stops_seen: Vec<bool> = Vec::new();
    let mut pre_routes_seen: Vec<bool> = Vec::new();

    // Pass 1a: per-feed CSV scans. Order matters — calendar/calendar_dates
    // populate services BEFORE trips.txt references service_id; routes.txt
    // populates routes BEFORE trips.txt references route_id. Otherwise we
    // get pre_attrs/interner length mismatches.
    for (feed_rank, dir) in feed_dirs.iter().enumerate() {
        scan_stops(
            &dir.join("stops.txt"),
            &mut stops,
            &mut pre_stops_attrs,
            &mut pre_stops_seen,
        )?;
        scan_routes(
            &dir.join("routes.txt"),
            &mut routes,
            &mut pre_routes_attrs,
            &mut pre_routes_seen,
        )?;
        parse_calendar(
            &dir.join("calendar.txt"),
            &mut services,
            &mut pre_service_attrs,
        )?;
        parse_calendar_dates(
            &dir.join("calendar_dates.txt"),
            &mut services,
            &mut pre_service_attrs,
        )?;
        scan_trips(
            &dir.join("trips.txt"),
            &mut trips,
            &mut routes,
            &mut services,
            &mut pre_trips_attrs,
            feed_rank as u32,
        )?;
    }

    // Defensive padding: if any later scan extended an interner without
    // pushing a matching attrs entry (e.g. trips.txt references a service_id
    // that wasn't in calendar.txt), pad with defaults so remap is safe.
    pad_defaults(&mut pre_stops_attrs, stops.len());
    pad_defaults(&mut pre_routes_attrs, routes.len());
    pad_defaults(&mut pre_service_attrs, services.len());
    pad_defaults(&mut pre_trips_attrs, trips.len());

    // Finalize all interners. After this point, all keys are sorted and
    // `remap()` returns the pre→post mapping for each.
    let stops_t = stops.finalize();
    let routes_t = routes.finalize();
    let services_t = services.finalize();
    let trips_t = trips.finalize();

    // Remap attrs vectors from pre-finalize to post-finalize indexing.
    let stops_attrs = remap_attrs(pre_stops_attrs, stops_t.remap());
    let routes_attrs = remap_attrs(pre_routes_attrs, routes_t.remap());
    let service_attrs = remap_attrs(pre_service_attrs, services_t.remap());
    let mut trips_attrs = remap_attrs(pre_trips_attrs, trips_t.remap());

    // Remap cross-references inside trip_attrs through the *target*
    // interner's remap. Without this, route_idx still references the
    // pre-finalize route table — the canary test
    // `finalize_remap_preserves_attribute_alignment` catches the mistake.
    let routes_remap = routes_t.remap();
    let services_remap = services_t.remap();
    for t in &mut trips_attrs {
        t.route_idx = routes_remap[t.route_idx as usize];
        t.service_idx = services_remap[t.service_idx as usize];
    }

    // Resolve each post-finalize stop's raw
    // parent_station stop_id against the finalized stops interner.
    // Unknown parent (typo in feed) → counter + drop. Self-parent → counter +
    // drop. Telemetry is aggregated and emitted as a single summary line at
    // the end of the block (was per-row, which spammed stderr on real feeds).
    // Output is sorted by child_idx (which is already the case since we walk
    // stops_attrs in order, and each child appears at most once).
    let mut stop_parent_map: Vec<(u32, u32)> = Vec::new();
    let mut dropped_unknown: u32 = 0;
    let mut dropped_self: u32 = 0;
    let mut sample_unknown: Vec<(u32, String)> = Vec::new(); // up to 5 examples
    for (child_idx, attrs) in stops_attrs.iter().enumerate() {
        if attrs.parent_station.is_empty() {
            continue;
        }
        match stops_t.lookup(&attrs.parent_station) {
            Some(parent_idx) => {
                if parent_idx as usize == child_idx {
                    dropped_self += 1;
                    continue;
                }
                stop_parent_map.push((child_idx as u32, parent_idx));
            }
            None => {
                dropped_unknown += 1;
                if sample_unknown.len() < 5 {
                    sample_unknown.push((child_idx as u32, attrs.parent_station.clone()));
                }
            }
        }
    }
    // Invariant: child_idx values are strictly increasing because we walk
    // stops_attrs 0..n exactly once and push at most one (child, _) per
    // index. Documented for the binary-search reader; trust by construction.
    debug_assert!(
        stop_parent_map.windows(2).all(|w| w[0].0 < w[1].0),
        "stop_parent_map child_idx values must be strictly increasing"
    );

    // Cycle detection (round-3 data-plane #M2 + QA #Q5). A self-parent is
    // already dropped above; this catches longer cycles (A->B->A,
    // A->B->C->A, …). RAPTOR's footpath relaxation traversing parent_station
    // siblings would loop forever on a cycle. Build a parent_of[child] lookup
    // from the sorted map; walk each entry's parent chain with a step bound.
    // Skip entirely when no parent_station rows exist — most feeds.
    if !stop_parent_map.is_empty() {
        let parent_of: HashMap<u32, u32> = stop_parent_map.iter().map(|&(c, p)| (c, p)).collect();
        let mut bad: Vec<u32> = Vec::new();
        let max_depth = parent_of.len() + 1; // any cycle is < n+1 long
        for &(child, _) in &stop_parent_map {
            let mut cur = child;
            for _ in 0..max_depth {
                match parent_of.get(&cur) {
                    Some(&next) if next == child => {
                        bad.push(child);
                        break;
                    }
                    Some(&next) => cur = next,
                    None => break,
                }
            }
        }
        if !bad.is_empty() {
            bad.sort();
            bad.dedup();
            // HashSet for O(1) lookup in retain — the prior Vec::contains was
            // O(n²) on cycle-heavy feeds.
            let bad_set: HashSet<u32> = bad.iter().copied().collect();
            stop_parent_map.retain(|(c, _)| !bad_set.contains(c));
            eprintln!(
                "[producer] stop_parent_map: dropped {} cycle members (first 10): {:?}",
                bad_set.len(),
                bad_set.iter().take(10).copied().collect::<Vec<_>>()
            );
        }
    }

    // Aggregate drop summary — at most one line for unknown/self drops,
    // regardless of how many rows triggered them.
    if dropped_unknown > 0 || dropped_self > 0 {
        eprintln!(
            "[producer] stop_parent_map: dropped {} unknown-parent, {} self-parent (unknown sample: {:?})",
            dropped_unknown, dropped_self, sample_unknown,
        );
    }

    // Include addition dates in the min so calendar_dates-only services (which
    // legally have no `start_date`) still anchor the 90-day bitmask window
    // around their first run date — otherwise the addition falls outside the
    // window and the bit is silently dropped.
    //
    // This value (min start_date across all services) is the library contract:
    // `Pass1Result.feed_start_date` is a real output of `run_pass1` and is used
    // by tests (e.g. pass1_tolerates_calendar_dates_only_service in
    // tests/calendar.rs). In the binary, main.rs overrides it on the result with
    // today's UTC date (rolling window) or --anchor-date to anchor the bitmask
    // at build time rather than at the feed's earliest service start — the two
    // concerns are distinct and the library value is not dead code.
    let feed_start_date = service_attrs
        .iter()
        .flat_map(|s| std::iter::once(s.start_date).chain(s.additions.iter().copied()))
        .filter(|d| *d != 0)
        .min()
        .unwrap_or(0);

    // Max service horizon: latest `calendar.end_date` or
    // `calendar_dates` ADD date across all services. REMOVE rows
    // (`exception_type == 2`) are NOT folded in — a removal cannot extend the
    // horizon, only suppress a day inside it. A feed with no end dates AND no
    // ADD rows yields the empty-fold sentinel `0` (→ window floors to 90).
    // calendar_dates-only feeds (no calendar.txt) get their horizon purely from
    // ADD dates here.
    // GTFS reference: https://gtfs.org/documentation/schedule/reference/#calendar_datestxt
    let max_end_date = service_attrs
        .iter()
        .flat_map(|s| std::iter::once(s.end_date).chain(s.additions.iter().copied()))
        .filter(|d| *d != 0)
        .max()
        .unwrap_or(0);

    // Pass 1b: stop_times scan against the finalized interners. Counts and
    // triples are captured with POST-finalize indices, so no remap is
    // needed afterwards.
    let mut stop_times_per_trip = vec![0u32; trips_t.len()];
    let mut total_stop_times: u32 = 0;
    let mut trip_stop_triples: Vec<TripStopTriple> = Vec::new();
    let mut trip_endpoints: Vec<TripEndpoint> = vec![TripEndpoint::default(); trips_t.len()];
    for dir in feed_dirs {
        scan_trip_stop_triples(
            &dir.join("stop_times.txt"),
            &trips_t,
            &stops_t,
            &mut trip_stop_triples,
            &mut trip_endpoints,
            &mut stop_times_per_trip,
            &mut total_stop_times,
        )?;
    }

    Ok(Pass1Result {
        stops: stops_t,
        routes: routes_t,
        services: services_t,
        trips: trips_t,
        stops_attrs,
        stop_parent_map,
        routes_attrs,
        service_attrs,
        trips_attrs,
        stop_times_per_trip,
        total_stop_times,
        feed_start_date,
        max_end_date,
        trip_stop_triples,
        trip_endpoints,
        // Filled by the Pass-2 caller (see field docs); pass1 leaves it empty.
        stop_time_boarding: Vec::new(),
    })
}

fn pad_defaults<T: Default + Clone>(v: &mut Vec<T>, len: usize) {
    if v.len() < len {
        v.resize(len, T::default());
    }
}

fn scan_stops(
    path: &Path,
    interner: &mut IdentityInterner<String>,
    attrs: &mut Vec<StopAttrs>,
    seen: &mut Vec<bool>,
) -> Result<()> {
    if !path.exists() {
        return Err(Error::MissingFile(path.display().to_string()));
    }
    let file = crate::csv_open::open_csv_skip_bom(path)?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();
    let id_idx = header_pos(&headers, "stop_id", path)?;
    let name_idx = headers.iter().position(|h| h == "stop_name");
    let lat_idx = headers.iter().position(|h| h == "stop_lat");
    let lon_idx = headers.iter().position(|h| h == "stop_lon");
    let wheelchair_idx = headers.iter().position(|h| h == "wheelchair_boarding");
    let parent_station_idx = headers.iter().position(|h| h == "parent_station");

    let mut record = csv::StringRecord::new();
    while rdr.read_record(&mut record)? {
        let id = field(&record, id_idx, "stop_id", path)?.to_string();
        let name = name_idx
            .and_then(|i| record.get(i))
            .map(|s| s.to_string())
            .unwrap_or_default();
        let lat = parse_float_or_zero(lat_idx, &record);
        let lon = parse_float_or_zero(lon_idx, &record);
        let wheelchair_boarding = parse_u8_or_zero(wheelchair_idx, &record);
        let parent_station = parent_station_idx
            .and_then(|i| record.get(i))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let pre_id = interner.intern(id) as usize;
        // First-feed-wins. `pre_id` can exceed the current `attrs.len()` if a
        // prior CSV scan extended the interner without pushing here. The
        // `seen` flag distinguishes "slot still unfilled" from "real row whose
        // fields happen to match Default" — equality with `Default` would
        // alias those, letting a later feed overwrite a real all-zero row
        // (legal for stops with `location_type != 0` and empty lat/lon).
        pad_defaults(attrs, pre_id + 1);
        pad_defaults(seen, pre_id + 1);
        if !seen[pre_id] {
            attrs[pre_id] = StopAttrs {
                name,
                lat,
                lon,
                wheelchair_boarding,
                parent_station,
            };
            seen[pre_id] = true;
        }
    }
    Ok(())
}

fn scan_routes(
    path: &Path,
    interner: &mut IdentityInterner<String>,
    attrs: &mut Vec<RouteAttrs>,
    seen: &mut Vec<bool>,
) -> Result<()> {
    if !path.exists() {
        return Err(Error::MissingFile(path.display().to_string()));
    }
    let file = crate::csv_open::open_csv_skip_bom(path)?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();
    let id_idx = header_pos(&headers, "route_id", path)?;
    let agency_idx = headers.iter().position(|h| h == "agency_id");
    let short_idx = headers.iter().position(|h| h == "route_short_name");
    let long_idx = headers.iter().position(|h| h == "route_long_name");
    let type_idx = header_pos(&headers, "route_type", path)?;
    let color_idx = headers.iter().position(|h| h == "route_color");
    let text_color_idx = headers.iter().position(|h| h == "route_text_color");

    let mut record = csv::StringRecord::new();
    while rdr.read_record(&mut record)? {
        let id = field(&record, id_idx, "route_id", path)?.to_string();
        let agency_id = agency_idx
            .and_then(|i| record.get(i))
            .map(|s| s.to_string())
            .unwrap_or_default();
        let short_name = short_idx
            .and_then(|i| record.get(i))
            .map(|s| s.to_string())
            .unwrap_or_default();
        let long_name = long_idx
            .and_then(|i| record.get(i))
            .map(|s| s.to_string())
            .unwrap_or_default();
        let route_type: u16 = field(&record, type_idx, "route_type", path)?
            .parse()
            .map_err(|_| Error::MalformedGtfs(format!("{}: bad route_type", path.display())))?;
        let route_color = color_idx
            .and_then(|i| record.get(i))
            .map(|s| s.to_string())
            .unwrap_or_default();
        let route_text_color = text_color_idx
            .and_then(|i| record.get(i))
            .map(|s| s.to_string())
            .unwrap_or_default();
        let pre_id = interner.intern(id) as usize;
        // First-feed-wins. See `scan_stops` for the orphan-extension and
        // default-aliasing rationale; the same risk exists here for a row
        // with `route_type=0`, no agency, and no names.
        pad_defaults(attrs, pre_id + 1);
        pad_defaults(seen, pre_id + 1);
        if !seen[pre_id] {
            attrs[pre_id] = RouteAttrs {
                agency_id,
                short_name,
                long_name,
                route_type,
                route_color,
                route_text_color,
            };
            seen[pre_id] = true;
        }
    }
    Ok(())
}

fn scan_trips(
    path: &Path,
    trips: &mut IdentityInterner<String>,
    routes: &mut IdentityInterner<String>,
    services: &mut IdentityInterner<String>,
    attrs: &mut Vec<TripAttrs>,
    feed_rank: u32,
) -> Result<()> {
    if !path.exists() {
        return Err(Error::MissingFile(path.display().to_string()));
    }
    let file = crate::csv_open::open_csv_skip_bom(path)?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();
    let trip_idx = header_pos(&headers, "trip_id", path)?;
    let route_idx = header_pos(&headers, "route_id", path)?;
    let service_idx = header_pos(&headers, "service_id", path)?;
    let headsign_idx = headers.iter().position(|h| h == "trip_headsign");
    let wheelchair_idx = headers.iter().position(|h| h == "wheelchair_accessible");
    let bikes_idx = headers.iter().position(|h| h == "bikes_allowed");
    let direction_idx = headers.iter().position(|h| h == "direction_id");
    let shape_idx = headers.iter().position(|h| h == "shape_id");
    let block_idx = headers.iter().position(|h| h == "block_id");

    let mut record = csv::StringRecord::new();
    while rdr.read_record(&mut record)? {
        let trip_id = field(&record, trip_idx, "trip_id", path)?.to_string();
        let route_id = field(&record, route_idx, "route_id", path)?.to_string();
        let service_id = field(&record, service_idx, "service_id", path)?.to_string();
        let headsign = headsign_idx
            .and_then(|i| record.get(i))
            .map(|s| s.to_string())
            .unwrap_or_default();
        let wheelchair_accessible = parse_u8_or_zero(wheelchair_idx, &record);
        let bikes_allowed = parse_u8_or_zero(bikes_idx, &record);
        let direction_id = parse_direction_id(direction_idx, &record);
        let shape_id = shape_idx
            .and_then(|i| record.get(i))
            .map(|s| s.to_string())
            .unwrap_or_default();
        let block_id = block_idx
            .and_then(|i| record.get(i))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        // `intern` is idempotent: returns the existing pre-id if the key was
        // already seen, otherwise extends the interner. If a trips.txt row
        // references a route/service not in routes.txt/calendar.txt, the
        // interner extension is tolerated; `pad_defaults` fills the
        // corresponding pre_attrs slots with `Default` so remap stays sound.
        let pre_route = routes.intern(route_id);
        let pre_service = services.intern(service_id);
        let pre_trip = trips.intern(trip_id) as usize;
        if pre_trip == attrs.len() {
            attrs.push(TripAttrs {
                route_idx: pre_route,
                service_idx: pre_service,
                headsign,
                wheelchair_accessible,
                bikes_allowed,
                direction_id,
                shape_id,
                block_id,
                feed_rank,
            });
        }
    }
    Ok(())
}

fn header_pos(headers: &csv::StringRecord, col: &str, path: &Path) -> Result<usize> {
    headers
        .iter()
        .position(|h| h == col)
        .ok_or_else(|| Error::MalformedGtfs(format!("{} missing {col}", path.display())))
}

fn field<'a>(record: &'a csv::StringRecord, idx: usize, col: &str, path: &Path) -> Result<&'a str> {
    record
        .get(idx)
        .ok_or_else(|| Error::MalformedGtfs(format!("{} row missing {col}", path.display())))
}

fn parse_float_or_zero(idx: Option<usize>, record: &csv::StringRecord) -> f64 {
    idx.and_then(|i| record.get(i))
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0)
}

fn parse_u8_or_zero(idx: Option<usize>, record: &csv::StringRecord) -> u8 {
    idx.and_then(|i| record.get(i))
        .and_then(|s| s.trim().parse::<u8>().ok())
        .unwrap_or(0)
}

/// Parse GTFS `direction_id` into its tri-state byte encoding.
///
/// - `"0"` → `0u8` (outbound)
/// - `"1"` → `1u8` (inbound)
/// - absent column / blank / anything else → `0xFF` (no direction / unknown)
///
/// `0xFF` is the "absent/none" sentinel that round-trips through the PTB wire
/// format as-is. `loadFromPtb.ts` maps it back to `undefined` on `GtfsTrip`,
/// matching `parser.ts`'s tri-state (absent GTFS column → `undefined`). This
/// ensures that feeds omitting `direction_id` bucket `directionPatterns` by
/// headsign only — identical to the network parser path.
fn parse_direction_id(idx: Option<usize>, record: &csv::StringRecord) -> u8 {
    match idx.and_then(|i| record.get(i)).map(str::trim) {
        Some("0") => 0,
        Some("1") => 1,
        _ => 0xFF, // absent / blank / other → "no direction" (matches parser.ts undefined)
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_direction_id, run_pass1, run_pass1_union};

    fn record_with(value: &str) -> (Option<usize>, csv::StringRecord) {
        let rec = csv::StringRecord::from(vec![value]);
        (Some(0), rec)
    }

    fn record_absent() -> (Option<usize>, csv::StringRecord) {
        // idx = None simulates a missing column header.
        let rec = csv::StringRecord::from(vec!["ignored"]);
        (None, rec)
    }

    #[test]
    fn direction_id_explicit_zero() {
        let (idx, rec) = record_with("0");
        assert_eq!(parse_direction_id(idx, &rec), 0);
    }

    #[test]
    fn direction_id_explicit_one() {
        let (idx, rec) = record_with("1");
        assert_eq!(parse_direction_id(idx, &rec), 1);
    }

    #[test]
    fn direction_id_absent_column() {
        let (idx, rec) = record_absent();
        assert_eq!(parse_direction_id(idx, &rec), 0xFF);
    }

    #[test]
    fn direction_id_blank_value() {
        let (idx, rec) = record_with("");
        assert_eq!(parse_direction_id(idx, &rec), 0xFF);
    }

    #[test]
    fn direction_id_whitespace_value() {
        let (idx, rec) = record_with("  ");
        assert_eq!(parse_direction_id(idx, &rec), 0xFF);
    }

    #[test]
    fn direction_id_other_value() {
        let (idx, rec) = record_with("2");
        assert_eq!(parse_direction_id(idx, &rec), 0xFF);
    }

    #[test]
    fn run_pass1_union_builds_stop_parent_map() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        // Minimal feed: 2 stops where S2.parent_station = S1.
        std::fs::write(
            dir.join("stops.txt"),
            "stop_id,stop_name,stop_lat,stop_lon,parent_station\n\
             S1,A,0,0,\n\
             S2,B,1,1,S1\n",
        )
        .unwrap();
        // Minimal trips/routes/calendar so run_pass1_union doesn't reject:
        std::fs::write(
            dir.join("routes.txt"),
            "route_id,agency_id,route_short_name,route_long_name,route_type\nR1,A,1,One,3\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("trips.txt"),
            "route_id,service_id,trip_id\nR1,Sv1,T1\n",
        )
        .unwrap();
        std::fs::write(dir.join("calendar.txt"), "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSv1,1,1,1,1,1,1,1,20260101,20271231\n").unwrap();
        std::fs::write(dir.join("stop_times.txt"), "trip_id,stop_id,arrival_time,departure_time,stop_sequence\nT1,S1,08:00:00,08:00:00,1\nT1,S2,08:05:00,08:05:00,2\n").unwrap();

        let p1 = run_pass1_union(&[dir.to_path_buf()]).unwrap();
        // Post-finalize stops are sorted by id: S1=0, S2=1.
        assert_eq!(p1.stop_parent_map, vec![(1u32, 0u32)]);
    }

    #[test]
    fn run_pass1_union_drops_self_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(
            dir.join("stops.txt"),
            "stop_id,stop_name,stop_lat,stop_lon,parent_station\n\
             S1,A,0,0,S1\n", // S1 references itself
        )
        .unwrap();
        std::fs::write(
            dir.join("routes.txt"),
            "route_id,agency_id,route_short_name,route_long_name,route_type\nR1,A,1,One,3\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("trips.txt"),
            "route_id,service_id,trip_id\nR1,Sv1,T1\n",
        )
        .unwrap();
        std::fs::write(dir.join("calendar.txt"), "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSv1,1,1,1,1,1,1,1,20260101,20271231\n").unwrap();
        std::fs::write(dir.join("stop_times.txt"), "trip_id,stop_id,arrival_time,departure_time,stop_sequence\nT1,S1,08:00:00,08:00:00,1\n").unwrap();

        let p1 = run_pass1_union(&[dir.to_path_buf()]).unwrap();
        assert!(p1.stop_parent_map.is_empty(), "self-parent must be dropped");
    }

    #[test]
    fn run_pass1_union_drops_unknown_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(
            dir.join("stops.txt"),
            "stop_id,stop_name,stop_lat,stop_lon,parent_station\n\
             S1,A,0,0,GHOST\n", // GHOST stop doesn't exist
        )
        .unwrap();
        std::fs::write(
            dir.join("routes.txt"),
            "route_id,agency_id,route_short_name,route_long_name,route_type\nR1,A,1,One,3\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("trips.txt"),
            "route_id,service_id,trip_id\nR1,Sv1,T1\n",
        )
        .unwrap();
        std::fs::write(dir.join("calendar.txt"), "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSv1,1,1,1,1,1,1,1,20260101,20271231\n").unwrap();
        std::fs::write(dir.join("stop_times.txt"), "trip_id,stop_id,arrival_time,departure_time,stop_sequence\nT1,S1,08:00:00,08:00:00,1\n").unwrap();

        let p1 = run_pass1_union(&[dir.to_path_buf()]).unwrap();
        assert!(
            p1.stop_parent_map.is_empty(),
            "unknown-parent must be dropped"
        );
    }

    #[test]
    fn run_pass1_union_drops_two_cycle() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        // S1.parent=S2, S2.parent=S1 — a 2-cycle.
        std::fs::write(
            dir.join("stops.txt"),
            "stop_id,stop_name,stop_lat,stop_lon,parent_station\n\
             S1,A,0,0,S2\n\
             S2,B,1,1,S1\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("routes.txt"),
            "route_id,agency_id,route_short_name,route_long_name,route_type\nR1,A,1,One,3\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("trips.txt"),
            "route_id,service_id,trip_id\nR1,Sv1,T1\n",
        )
        .unwrap();
        std::fs::write(dir.join("calendar.txt"), "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSv1,1,1,1,1,1,1,1,20260101,20271231\n").unwrap();
        std::fs::write(dir.join("stop_times.txt"), "trip_id,stop_id,arrival_time,departure_time,stop_sequence\nT1,S1,08:00:00,08:00:00,1\nT1,S2,08:05:00,08:05:00,2\n").unwrap();

        let p1 = run_pass1_union(&[dir.to_path_buf()]).unwrap();
        assert!(
            p1.stop_parent_map.is_empty(),
            "2-cycle members must be dropped"
        );
    }

    #[test]
    fn run_pass1_union_handles_parent_station_whitespace() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        // S2.parent_station has leading/trailing whitespace — should still resolve.
        std::fs::write(
            dir.join("stops.txt"),
            "stop_id,stop_name,stop_lat,stop_lon,parent_station\n\
             S1,A,0,0,\n\
             S2,B,1,1, S1 \n",
        )
        .unwrap();
        std::fs::write(
            dir.join("routes.txt"),
            "route_id,agency_id,route_short_name,route_long_name,route_type\nR1,A,1,One,3\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("trips.txt"),
            "route_id,service_id,trip_id\nR1,Sv1,T1\n",
        )
        .unwrap();
        std::fs::write(dir.join("calendar.txt"), "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSv1,1,1,1,1,1,1,1,20260101,20271231\n").unwrap();
        std::fs::write(dir.join("stop_times.txt"), "trip_id,stop_id,arrival_time,departure_time,stop_sequence\nT1,S1,08:00:00,08:00:00,1\nT1,S2,08:05:00,08:05:00,2\n").unwrap();

        let p1 = run_pass1_union(&[dir.to_path_buf()]).unwrap();
        assert_eq!(
            p1.stop_parent_map,
            vec![(1u32, 0u32)],
            "whitespace must be trimmed"
        );
    }

    /// `block_id` from trips.txt is captured in `TripAttrs::block_id`.
    /// Absent/blank block_id (the common case) must become an empty string.
    /// GTFS reference: https://gtfs.org/documentation/schedule/reference/#tripstxt
    #[test]
    fn reads_block_id_column() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(
            dir.join("stops.txt"),
            "stop_id,stop_name,stop_lat,stop_lon\nSA,A,0,0\nSB,B,1,1\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("routes.txt"),
            "route_id,agency_id,route_short_name,route_long_name,route_type\nR1,AG,1,One,3\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("calendar.txt"),
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWD,1,1,1,1,1,0,0,20260101,20271231\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("trips.txt"),
            "route_id,service_id,trip_id,block_id\nR1,WD,T1,BLK9\nR1,WD,T2,\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("stop_times.txt"),
            "trip_id,stop_id,arrival_time,departure_time,stop_sequence\n\
             T1,SA,08:00:00,08:00:00,1\nT1,SB,08:05:00,08:05:00,2\n\
             T2,SA,09:00:00,09:00:00,1\nT2,SB,09:05:00,09:05:00,2\n",
        )
        .unwrap();

        let p1 = run_pass1(dir).unwrap();
        let t1 = p1.trips.lookup("T1").unwrap() as usize;
        let t2 = p1.trips.lookup("T2").unwrap() as usize;
        assert_eq!(p1.trips_attrs[t1].block_id, "BLK9");
        assert_eq!(p1.trips_attrs[t2].block_id, ""); // absent → empty (like shape_id)
    }

    /// Two `stops.txt` rows sharing a `stop_id` COLLAPSE to one interned stop,
    /// and the rule is FIRST-WINS: the interner returns the existing ordinal on
    /// the repeat (`identity.rs` intern), and the attrs scan guards with a
    /// `seen` flag (`scan_stops`), so the SECOND row's name/coords are dropped.
    /// Pins the dedup contract end-to-end (do NOT change interner behavior).
    #[test]
    fn run_pass1_union_duplicate_stop_id_collapses_first_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        // S1 appears twice with DIFFERENT name/coords; S2 is a distinct stop so
        // the post-finalize ordinal of S1 is unambiguous (sorted: S1=0, S2=1).
        std::fs::write(
            dir.join("stops.txt"),
            "stop_id,stop_name,stop_lat,stop_lon\n\
             S1,First Name,10.0,20.0\n\
             S1,Second Name,30.0,40.0\n\
             S2,Other,1.0,1.0\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("routes.txt"),
            "route_id,agency_id,route_short_name,route_long_name,route_type\nR1,A,1,One,3\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("trips.txt"),
            "route_id,service_id,trip_id\nR1,Sv1,T1\n",
        )
        .unwrap();
        std::fs::write(dir.join("calendar.txt"), "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSv1,1,1,1,1,1,1,1,20260101,20271231\n").unwrap();
        std::fs::write(dir.join("stop_times.txt"), "trip_id,stop_id,arrival_time,departure_time,stop_sequence\nT1,S1,08:00:00,08:00:00,1\nT1,S2,08:05:00,08:05:00,2\n").unwrap();

        let p1 = run_pass1_union(&[dir.to_path_buf()]).unwrap();

        // Collapse: 2 distinct stops, not 3 rows.
        assert_eq!(p1.stops.len(), 2, "duplicate stop_id must collapse");
        assert_eq!(p1.stops.keys(), &["S1".to_string(), "S2".to_string()]);

        // First-wins: S1 (post-finalize idx 0) keeps the FIRST row's attrs.
        let s1 = &p1.stops_attrs[0];
        assert_eq!(s1.name, "First Name", "first row's name wins");
        assert_eq!(s1.lat, 10.0, "first row's lat wins");
        assert_eq!(s1.lon, 20.0, "first row's lon wins");
    }
}
