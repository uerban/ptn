use clap::Parser;
use pt_producer::cli::{Args, Command};
use pt_producer::date_utils::{today_yyyymmdd, validate_yyyymmdd};
use pt_producer::interns::write_trips_intern;
use pt_producer::layout::Region;
use pt_producer::liveness::{self, HealthState, LivenessConfig};
use pt_producer::regions::{flush_mid_pass_regions, write_transfers_region, write_u32_slice};
use pt_producer::writer::WriteRegion;
use pt_producer::{
    download, idle, layout, pass1, pass2, persist, refresh, republish, sidecars, source, writer,
    Error, Result,
};
use pt_shared::clock::SystemClock;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// The library re-exports `pt_core::coord_quant`, keeping producer and reader on
// one implementation. Re-alias it here for the binary's three-way oracle test;
// the production emit caller reaches the same module through the library.
#[cfg(test)]
use pt_producer::coord_quant;

/// Reject invalid `--city-tz-iana` / `--city-tz-offset-seconds` combinations
/// at producer startup so operator mistakes fail fast here rather than silently
/// baking a bad IANA name into the manifest and only erroring at pt-serve load.
///
/// Checks (in order):
/// 1. A non-UTC `--city-tz-iana` with `--city-tz-offset-seconds=0` is almost
///    certainly a misconfiguration (offset forgotten); reject it loudly.
/// 2. When `--city-tz-iana` is set to any value other than "UTC" or the empty
///    string, verify it is a real IANA tz name (resolve via the bundled tzdb). A typo
///    (e.g. `Europe/Warsav`) would otherwise be baked into the manifest and
///    only fail at pt-serve's T13 load-time cross-check.
fn validate_tz(iana: Option<&str>, offset: Option<i32>) -> Result<()> {
    if matches!(iana, Some(s) if s != "UTC") && offset == Some(0) {
        return Err(Error::Config(
            "--city-tz-offset-seconds=0 with non-UTC --city-tz-iana — \
             set the real offset (e.g. 7200 for Europe/Vilnius standard time)."
                .into(),
        ));
    }
    if let Some(name) = iana {
        if !name.is_empty() && name != "UTC" {
            // Use a fixed sentinel date — we only need parse success, not a
            // meaningful offset value. 20260101 is a valid date in every tz.
            if let Err(pt_shared::tz::TzOffsetError::UnknownIana) =
                pt_shared::tz::offset_at_anchor(name, 20260101)
            {
                return Err(Error::Config(format!(
                    "unknown IANA tz name: {name:?} — check --city-tz-iana"
                )));
            }
        }
    }
    Ok(())
}

fn run() -> Result<()> {
    let args = Args::parse();
    if let Some(Command::BindDataRoot {
        data_root,
        identity,
        expected_generation,
    }) = &args.command
    {
        let _lock = pt_producer::producer_lock::acquire(data_root)
            .map_err(|e| Error::Config(e.to_string()))?;
        pt_shared::data_root_identity::bind(data_root, identity, expected_generation.as_deref())?;
        return Ok(());
    }

    // P4 modes: hand off to the publish protocol.
    // - PeriodicRefresh: long-running loop (one tick per `refresh-interval-
    //   secs`), exits only on SIGTERM/SIGINT or fatal misconfig (e.g.
    //   producer.lock conflict). The liveness server stays bound across ticks.
    // - Republish: single tick + exit (DR escape hatch).
    if let Some(Command::PeriodicRefresh {
        data_root,
        city,
        gtfs,
        anchor_date,
        transfers,
        address_search,
        walking_graph,
        city_osm_dir,
        osm_artifact_root,
        osm_lease_root,
        max_retained_generations,
        liveness_listen_addr,
        refresh_interval_secs,
        city_tz_iana,
        city_tz_offset_seconds,
        derive_inseat,
    }) = args.command.clone()
    {
        validate_tz(city_tz_iana.as_deref(), city_tz_offset_seconds)?;
        let sidecars = Sidecars {
            prebuilt_transfers: transfers,
            walking_graph,
            address_search,
            _lease: None,
        };
        return run_periodic_refresh(
            &data_root,
            &city,
            &gtfs,
            anchor_date,
            sidecars.transfers(),
            sidecars.address_search.as_deref(),
            city_osm_dir.as_deref(),
            osm_artifact_root.as_deref(),
            osm_lease_root.as_deref(),
            max_retained_generations,
            liveness_listen_addr,
            refresh_interval_secs,
            city_tz_offset_seconds,
            city_tz_iana.as_deref(),
            derive_inseat,
        );
    }
    if let Some(Command::Republish {
        data_root,
        city,
        from_cache,
        archive_to,
        anchor_date,
        transfers,
        address_search,
        walking_graph,
        city_osm_dir,
        osm_artifact_root,
        osm_lease_root,
        max_retained_generations,
        city_tz_iana,
        city_tz_offset_seconds,
        derive_inseat,
    }) = args.command.clone()
    {
        validate_tz(city_tz_iana.as_deref(), city_tz_offset_seconds)?;
        let sidecars = resolve_tick_sidecars(
            transfers
                .as_deref()
                .map(refresh::TransfersSource::Prebuilt)
                .or_else(|| {
                    walking_graph
                        .as_deref()
                        .map(refresh::TransfersSource::WalkingGraph)
                }),
            address_search.as_deref(),
            city_osm_dir.as_deref(),
            osm_artifact_root.as_deref(),
            osm_lease_root.as_deref(),
            &city,
        )?;
        return run_republish(
            &data_root,
            &city,
            &from_cache,
            archive_to.as_deref(),
            anchor_date,
            sidecars.transfers(),
            sidecars.address_search.as_deref(),
            max_retained_generations,
            city_tz_offset_seconds,
            city_tz_iana.as_deref(),
            derive_inseat,
        );
    }
    if let Some(Command::PackAddressSearch { input, out, city }) = args.command.clone() {
        let (in_bytes, out_bytes) =
            pt_producer::address_pack::pack_address_search(&input, &out, city.as_deref())?;
        eprintln!(
            "[producer] packed {} -> {} ({} -> {} bytes, {:.1}x smaller)",
            input.display(),
            out.display(),
            in_bytes,
            out_bytes,
            in_bytes as f64 / out_bytes.max(1) as f64,
        );
        return Ok(());
    }
    if let Some(Command::BuildScheduleTiles {
        gen_dir,
        city,
        gen_id,
    }) = args.command.clone()
    {
        return run_build_schedule_tiles(&gen_dir, &city, gen_id.as_deref());
    }
    validate_tz(args.city_tz_iana.as_deref(), args.city_tz_offset_seconds)?;
    eprintln!(
        "[producer] start variant={} listen={} idle_after={}s",
        pt_producer::VARIANT_LABEL,
        args.listen_addr,
        args.idle_after_ingestion_secs,
    );

    let http = pt_producer::http::ReadinessServer::spawn(args.listen_addr)?;
    let ready = http.ready_flag().clone();

    let stop = idle::install_signal_handler();

    let work_tmp = tempfile::tempdir()?;

    let download_dir = work_tmp.path().join("dl");
    std::fs::create_dir_all(&download_dir)?;
    let feed_records: Vec<download::FeedRecord> = if let Some(url) = args.gtfs_url.as_deref() {
        download::fetch(url, &download_dir)?
    } else if !args.gtfs_path.is_empty() {
        // One record per `--gtfs-path`, in the order given. Multiple paths union
        // through the same `run_pass1_union` below that a comma-separated
        // `--gtfs-url` uses, so a three-feed city builds identically from local
        // zips as from URLs.
        args.gtfs_path
            .iter()
            .map(|path| download::record_for_local(path))
            .collect::<Result<Vec<_>>>()?
    } else {
        return Err(pt_producer::Error::Config(
            "neither --gtfs-url nor --gtfs-path provided".into(),
        ));
    };
    let zip_paths: Vec<PathBuf> = feed_records.iter().map(|f| f.zip_path.clone()).collect();

    let extract_dir = work_tmp.path().join("extracted");
    std::fs::create_dir_all(&extract_dir)?;
    source::extract_all(&zip_paths, &extract_dir)?;
    // Krakow's 3-zip GTFS MUST be unioned: a single-feed run sees ~1/3 of stop_times and passes the
    // 350 MB threshold by construction, not by merit, invalidating the decision. Iterate
    // feeds in extraction order (0..n). With trip-grouped Pass 2 the feed order no longer affects
    // row placement (each row routes to its trip's reserved range via `write_cursor`), but a
    // numeric 0..n walk keeps the traversal deterministic and avoids the `feed-10`-before-`feed-2`
    // surprise a lexical sort would introduce once a deployment uses ≥10 feeds.
    let feed_dirs: Vec<std::path::PathBuf> = (0..zip_paths.len())
        .map(|i| extract_dir.join(format!("feed-{i}")))
        .collect();

    let t_pass1 = Instant::now();
    let mut p1 = pass1::run_pass1_union(&feed_dirs)?;
    eprintln!(
        "[producer] pass1 done in {} ms — feeds={} stops={} routes={} trips={} stop_times={}",
        t_pass1.elapsed().as_millis(),
        feed_dirs.len(),
        p1.stops.len(),
        p1.routes.len(),
        p1.trips.len(),
        p1.total_stop_times,
    );

    // Override the bitmask-window anchor: use today (rolling) or the value
    // supplied via --anchor-date. Pass1's feed_start_date is min(start_date)
    // across all services — for feeds whose service started months ago that
    // value pushes "today" outside the 90-day window → zero departures.
    // This single override flows into BOTH flush_mid_pass_regions (bitmask)
    // and the final header (feedStartDate), so the header and bitmask are always
    // co-anchored at the same date.
    let anchor = args.anchor_date.unwrap_or_else(today_yyyymmdd);
    if let Err(msg) = validate_yyyymmdd(anchor) {
        eprintln!("[producer] FATAL: {msg}");
        std::process::exit(1);
    }
    p1.feed_start_date = anchor;
    let anchor_src = if args.anchor_date.is_some() {
        "--anchor-date"
    } else {
        "today"
    };
    eprintln!("[producer] bitmask anchor={anchor} (from {anchor_src})");

    // Derive windowDays from the feed horizon at the final anchor.
    // One value flows into Layout::compute (stride), flush_mid_pass_regions,
    // and the PTB WindowMeta region.
    let window = pt_producer::build::resolve_window(p1.feed_start_date, p1.max_end_date);
    let window_days = window.window_days;
    if window.clamp_event == pt_producer::service::bitmask::WindowClampEvent::ClampedHigh {
        eprintln!("[producer] WARN window_clamped_high: feed horizon exceeds ceiling; window_days={window_days}.");
    } else if window.clamp_event == pt_producer::service::bitmask::WindowClampEvent::FlooredLow {
        eprintln!(
            "[producer] WARN window_floored_low: feed horizon below floor; window_days={window_days}."
        );
    }
    eprintln!(
        "[producer] derived window_days={window_days} (max_end_date={})",
        p1.max_end_date
    );

    // GTFS-fidelity guard: a record with no id is meaningless and would alias
    // pool index 0 (""). Reject empty mandatory ids loudly.
    validate_no_empty_ids([
        ("stop_id", p1.stops.keys()),
        ("route_id", p1.routes.keys()),
        ("trip_id", p1.trips.keys()),
    ])?;

    // Parse transfers.txt across all feeds AFTER finalize so ids resolve to
    // post-finalize ordinals. Optional GTFS file → empty when absent. Carried
    // only — no scan reads the Transfers region.
    // GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
    let (transfers, derived_inseat_count) = {
        let mut rows: Vec<pass1::TransferRow> = Vec::new();
        let mut dropped = 0usize;
        for feed_dir in &feed_dirs {
            let res = pass1::parse_transfers(feed_dir, &p1)?;
            rows.extend(res.rows);
            dropped += res.dropped_unknown_stop;
        }
        // Derive type-4 in-seat rules from block_id continuations, honoring the
        // activation gate (auto-disabled when the union already declares type-4).
        // Merged INSIDE this block so `transfers.len()` (which sizes the
        // Transfers region in Layout::compute) reflects the merged total.
        let derived = pass1::derive_for_build(&p1, &rows, args.derive_inseat);
        eprintln!("[producer] in-seat rules derived={}", derived.len());
        let count = derived.len() as u32;
        rows.extend(derived);
        eprintln!(
            "[producer] transfers parsed rows={} dropped_unknown_stop={dropped}",
            rows.len()
        );
        (rows, count)
    };

    // Parse frequencies.txt across all feeds AFTER finalize so trip_ids resolve
    // to post-finalize ordinals. Optional GTFS file → empty when absent.
    // Rows are not yet emitted to the PTB (A3 writes the 0x17 region).
    // GTFS reference: https://gtfs.org/documentation/schedule/reference/#frequenciestxt
    let frequencies = {
        let mut rows: Vec<pass1::FrequencyRow> = Vec::new();
        let mut dropped = 0usize;
        for feed_dir in &feed_dirs {
            let res = pass1::parse_frequencies(feed_dir, &p1)?;
            rows.extend(res.rows);
            dropped += res.dropped;
        }
        if dropped > 0 {
            eprintln!(
                "[producer] frequencies: dropped {dropped} row(s) (unknown trip / bad headway / inverted window)"
            );
        }
        rows
    };

    // Build the StringPool by an explicit record-by-record column walk in
    // finalized sorted-id order. The order here IS the byte-equality contract;
    // the TS mirror writer (buildTinyPtnb.ts) must replicate it exactly.
    let pool = {
        let mut pool = pt_producer::strpool::StringPool::new();
        for (key, a) in p1.stops.keys().iter().zip(&p1.stops_attrs) {
            pool.intern(key);
            pool.intern(&a.name);
        }
        for (key, a) in p1.routes.keys().iter().zip(&p1.routes_attrs) {
            pool.intern(key);
            pool.intern(&a.agency_id);
            pool.intern(&a.short_name);
            pool.intern(&a.long_name);
            pool.intern(&a.route_color);
            pool.intern(&a.route_text_color);
        }
        for (key, a) in p1.trips.keys().iter().zip(&p1.trips_attrs) {
            pool.intern(key);
            pool.intern(&a.headsign);
            pool.intern(&a.shape_id);
        }
        pool
    };

    let layout = layout::Layout::compute(
        p1.stops.len() as u64,
        p1.routes.len() as u64,
        p1.trips.len() as u64,
        p1.total_stop_times as u64,
        window_days as u64,
        p1.services.len() as u64,
        pool.byte_len(),
        transfers.len() as u64,
    );
    eprintln!("[producer] layout total_bytes={}", layout.total_bytes());

    let tmp_bin = work_tmp.path().join("p1.bin");
    let natural_bytes = layout.total_bytes();
    eprintln!(
        "[producer] writer open natural={} total={}",
        natural_bytes, natural_bytes
    );
    let mut w = writer::open_writer(&tmp_bin, natural_bytes)?;

    let t_interns = Instant::now();
    {
        let trips_region = w.region_slice(&layout, Region::TripsIntern);
        write_trips_intern(trips_region, p1.trips.keys(), &p1.trips_attrs, &pool)?;
    }
    eprintln!(
        "[producer] interns written in {} ms — trips={}",
        t_interns.elapsed().as_millis(),
        p1.trips.len(),
    );

    let t_mid = Instant::now();
    flush_mid_pass_regions(&mut w, &layout, &p1, window_days)?;
    eprintln!(
        "[producer] mid-pass done in {} ms — services={} bitmask_window_days={window_days}",
        t_mid.elapsed().as_millis(),
        p1.services.len(),
    );

    // Trip-grouped Pass 2: rows land in their sorted-trip ranges, not feed
    // order. `trip_starts[i]..trip_starts[i+1]` is sorted trip i's reserved
    // range; `write_cursor` is a running clone that advances per row and MUST
    // persist across feeds (Krakow unions 3 feeds whose rows for a single trip
    // may be split across files). Kept past Pass 2 for the row-fill invariant
    // (and reused by the TripStarts-region writer in a later task).
    let trip_starts = pass1::compute_trip_starts(&p1);
    let mut write_cursor = trip_starts.clone();

    // Parallel per-stop_time boarding bytes for PatternSemantics construction.
    // Default-fill `0x50` and thread the SAME `&mut [u8]` across all feeds; each
    // packed byte lands at the row's global index (`off / stride`). See the
    // matching block in `build::build_ptb` for the full rationale.
    let mut boarding = vec![0x50u8; p1.total_stop_times as usize];

    let t_pass2 = Instant::now();
    let mut total_rows: usize = 0;
    for feed_dir in &feed_dirs {
        let n = pass2::parse_and_write_stop_times(
            &feed_dir.join("stop_times.txt"),
            &layout,
            &p1,
            &mut w,
            &mut write_cursor,
            &mut boarding,
        )?;
        total_rows += n;
    }
    // Release the `&p1` loop borrow, then hand the filled bytes to the current
    // emit boundary through `p1`.
    p1.stop_time_boarding = boarding;
    eprintln!(
        "[producer] pass2 done in {} ms — rows={total_rows}",
        t_pass2.elapsed().as_millis()
    );

    // Pass-1's row count drives layout.total_bytes() and therefore the mmap size. Divergence means
    // Pass 2 wrote into a wrong-sized region — rssPeakBytes is then a lie. Fail loud.
    if total_rows as u32 != p1.total_stop_times {
        return Err(pt_producer::Error::Config(format!(
            "row-count invariant violated: pass1={} pass2={} — output layout is wrong-sized; \
             rssPeakBytes is unreliable. Investigate before trusting this run.",
            p1.total_stop_times, total_rows,
        )));
    }

    // Stronger trip-grouped invariant: every trip's reserved range is filled
    // EXACTLY. After all feeds, each `write_cursor[i]` must have advanced to
    // the next trip's start (`trip_starts[i+1]`). A mismatch means a trip got
    // too few/many rows — the silent schedule-misattribution bug this fix
    // targets (served routes collapsed 116→1 on Vilnius).
    for i in 0..p1.trips.len() {
        if write_cursor[i] != trip_starts[i + 1] {
            return Err(pt_producer::Error::Config(format!(
                "trip-fill invariant violated for sorted trip {i}: \
                 write_cursor={} expected trip_starts[{}]={} — StopTimes rows are \
                 misgrouped; schedule attribution is unreliable.",
                write_cursor[i],
                i + 1,
                trip_starts[i + 1],
            )));
        }
    }

    // Emit the TripStarts region: the PRISTINE prefix-sum (offsets where each
    // sorted trip STARTS), length num_trips+1. Use `trip_starts`, NOT
    // `write_cursor` — Pass 2 advanced `write_cursor` to each trip's END
    // (trip_starts[i+1]), which is the wrong content for a starts table.
    {
        let ts_region = w.region_slice(&layout, Region::TripStarts);
        write_u32_slice(ts_region, &trip_starts)?;
    }
    eprintln!(
        "[producer] trip_starts region written entries={}",
        trip_starts.len()
    );

    {
        let sp_region = w.region_slice(&layout, Region::StringPool);
        pool.write(sp_region)?;
    }
    eprintln!("[producer] string_pool written count={}", pool.count());

    // NOTE: `pool` (which borrows `p1`) is kept alive past here — the current emit
    // branch below re-reads it for the SoA `*_idx` column lookups. The rest of
    // this path only borrows `p1` immutably, so the borrows coexist.

    // Write resolved GTFS transfers.txt rules into the staging region.
    write_transfers_region(&mut w, &layout, &transfers)?;
    eprintln!(
        "[producer] transfers region written rows={}",
        transfers.len()
    );

    let resolved_tz_offset = pt_producer::build::resolve_city_tz_offset(
        args.city_tz_offset_seconds,
        args.city_tz_iana.as_deref(),
        p1.feed_start_date,
    )?;
    w.finish()?;

    // Re-encode the temporary positional build into the sole published PTB v1
    // layout before persistence or sidecar generation sees it.
    let temporary_bytes = std::fs::read(&tmp_bin)?;
    let (current_bytes, service_pool_count) =
        pt_producer::build::reencode_staging_bundle_as_current(
            &temporary_bytes,
            &layout,
            &p1,
            &pool,
            resolved_tz_offset,
            window_days,
            &frequencies,
        )?;
    std::fs::write(&tmp_bin, &current_bytes)?;
    eprintln!(
        "[producer] PTB v{} re-encode done bytes={}{}",
        pt_core::PTB_VERSION_V1,
        current_bytes.len(),
        service_pool_count
            .map(|c| format!(" serviceBitfieldPoolCount={c}"))
            .unwrap_or_default(),
    );
    pt_producer::build::warn_weak_service_bitfield_dedup(
        service_pool_count,
        p1.services.len() as u32,
    );
    drop(pool);

    // Capture the bitmask anchor before dropping p1 — the sidecar writer
    // below needs it so loaders interpret the 90-day bitmap relative to
    // the producer's anchor (not their own process-start day).
    let p1_feed_start_date = p1.feed_start_date;

    // Drop the Pass 1 state before the idle window so steady RSS reflects
    // the production end-state (PTB bytes only, no in-memory interner /
    // attribute vectors / triples). Without this, the steady measurement
    // double-counts the parser-side data structures against the PTB.
    drop(p1);
    eprintln!("[producer] pass1 state dropped before idle");

    if let Some(dest) = args.out.as_ref() {
        persist::persist_artifact(&tmp_bin, dest)?;
        eprintln!("[producer] persisted ptnb to {}", dest.display());

        // Q1.E sidecars: meta (per-feed SHA + ETag) + shapes (parsed polylines).
        // Both written next to <dest> via the `<dest>.<suffix>` helper so any
        // extension on `dest` is preserved (Path::with_extension would replace
        // .ptnb, which is the opposite of what we want).
        let meta_path = sidecar_path(dest, "meta.json");
        let shapes_path = sidecar_path(dest, "shapes.json");
        let feed_metas: Vec<sidecars::FeedMeta> = feed_records
            .iter()
            .map(|f| sidecars::FeedMeta {
                url: f.url.clone(),
                blob_sha256: f.sha_hex.clone(),
                etag: f.etag.clone(),
            })
            .collect();
        let producer_sha: &str = option_env!("PT_PRODUCER_GIT_SHA").unwrap_or("unknown");
        let feed_start_date_iso = sidecars::format_ymd(p1_feed_start_date);
        sidecars::write_meta(
            &meta_path,
            &feed_metas,
            producer_sha,
            &feed_start_date_iso,
            args.city_tz_iana.as_deref(),
            Some(derived_inseat_count),
        )?;
        let shape_groups = pass2::shapes::parse_shapes_all(&feed_dirs)?;
        sidecars::write_shapes(&shapes_path, &shape_groups)?;
        eprintln!(
            "[producer] sidecars written: {} {}",
            meta_path.display(),
            shapes_path.display()
        );
    }

    ready.store(true, Ordering::SeqCst);
    eprintln!(
        "[producer] ready=true; idling for up to {} s",
        args.idle_after_ingestion_secs
    );

    idle::sleep_until_term(&stop, args.idle_after_ingestion_secs);
    eprintln!("[producer] stop signal received or idle elapsed; exiting");

    drop(http);
    Ok(())
}

/// Returns `<out>.<suffix>` — always appends, regardless of existing extension.
/// `Path::with_extension` would REPLACE the last extension, so for
/// `bundle.ptnb` it would yield `bundle.meta.json` (dropping `.ptnb`); we want
/// `bundle.ptnb.meta.json` so the binary + sidecars share a common stem.
fn sidecar_path(out: &Path, suffix: &str) -> PathBuf {
    let s = format!("{}.{}", out.display(), suffix);
    PathBuf::from(s)
}

/// Rejects any empty mandatory id in the given (label, keys) pairs.
/// GTFS-fidelity guard: an empty id would alias pool index 0 ("") and produce
/// silent wrong-record lookups at decode time.
fn validate_no_empty_ids<'a, I>(labeled_keys: I) -> Result<()>
where
    I: IntoIterator<Item = (&'a str, &'a [String])>,
{
    for (label, keys) in labeled_keys {
        if keys.iter().any(|k| k.is_empty()) {
            return Err(pt_producer::Error::Config(format!(
                "empty {label} in feed — PTB requires non-empty mandatory ids"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_no_empty_ids_accepts_non_empty() {
        let ids = vec!["S1".to_string(), "S2".to_string()];
        assert!(validate_no_empty_ids([("stop_id", ids.as_slice())]).is_ok());
    }

    #[test]
    fn validate_no_empty_ids_rejects_empty_stop_id() {
        let ids = vec!["S1".to_string(), "".to_string()];
        let err = validate_no_empty_ids([("stop_id", ids.as_slice())]).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("empty stop_id"), "unexpected error: {msg}");
        assert!(
            msg.contains("non-empty mandatory ids"),
            "unexpected error: {msg}"
        );
    }

    #[test]
    fn validate_no_empty_ids_rejects_empty_route_id() {
        let ids = vec!["".to_string()];
        let err = validate_no_empty_ids([("route_id", ids.as_slice())]).unwrap_err();
        assert!(err.to_string().contains("empty route_id"));
    }

    #[test]
    fn validate_no_empty_ids_rejects_empty_trip_id() {
        let ids = vec!["T1".to_string(), "".to_string(), "T3".to_string()];
        let err = validate_no_empty_ids([("trip_id", ids.as_slice())]).unwrap_err();
        assert!(err.to_string().contains("empty trip_id"));
    }
}

// Third leg of the 3-way quantizer oracle (Rust pt-core + TS + this producer).
// The producer uses pt-core's public quantizer module, so this leg proves the
// shared implementation produces identical i32s against the hand-authored
// `coord-oracle.json`.
#[cfg(test)]
mod coord_oracle_producer {
    use crate::coord_quant::{decode_e7, encode_lat_e7, encode_lon_e7};

    #[derive(serde::Deserialize)]
    struct Row {
        r#in: String,
        axis: String,
        i32: Option<i32>,
        prod_hex: Option<String>,
        reject: Option<bool>,
    }

    fn parse(s: &str) -> f64 {
        match s {
            "nan" => f64::NAN,
            "inf" => f64::INFINITY,
            _ => s.parse().unwrap(),
        }
    }

    #[test]
    fn coord_quant_f64_exact_witness() {
        // The f64-exact 7-decimal survivor — no hand-copied constant beyond
        // the witness itself (cross-checked against the oracle row below).
        assert_eq!(encode_lat_e7(54.6912345), Some(546912345));
    }

    #[test]
    fn coord_oracle_table_via_path_include() {
        let rows: Vec<Row> = serde_json::from_str(include_str!(
            "../../../crates/pt-core/tests/fixtures/coord-oracle.json"
        ))
        .unwrap();
        assert!(rows.len() >= 20);
        for r in &rows {
            let x = parse(&r.r#in);
            let enc = if r.axis == "lat" {
                encode_lat_e7(x)
            } else {
                encode_lon_e7(x)
            };
            if r.reject == Some(true) {
                assert_eq!(enc, None, "{} must reject", r.r#in);
                continue;
            }
            if let Some(h) = &r.prod_hex {
                assert_eq!(
                    format!("{:016x}", (x * 1e7).to_bits()),
                    *h,
                    "prod {}",
                    r.r#in
                );
            }
            assert_eq!(enc, Some(r.i32.unwrap()), "encode {}", r.r#in);
            assert!(
                (decode_e7(r.i32.unwrap()) - x).abs() <= 0.5e-7,
                "decode tol {}",
                r.r#in
            );
        }
    }
}

/// P4 periodic-refresh entrypoint — long-running tick loop.
///
/// The publish protocol is in `refresh::publish_one_tick`. This wrapper
/// adapts the CLI args into a `Vec<FeedRecord>` and a `SystemClock`, then
/// runs the tick on a loop at `refresh_interval_secs` cadence.
///
/// Returns `Result<()>` for type compatibility with the call site, but
/// the function diverges (the inner `loop { ... }` never breaks). The
/// process exits only via SIGTERM/SIGKILL from compose / k8s / an
/// uncaught panic. Compose `restart: unless-stopped` is a panic/OOM
/// safety net; it is no longer the primary scheduling mechanism.
///
/// Pre-loop history (kept here so the rationale doesn't get lost in
/// `git blame`): this used to run a single tick per process invocation,
/// matching k8s sidecar semantics — but in compose-deployed staging
/// stacks, restart-policy-driven re-runs raced with the `/readyz`
/// healthcheck contract (port 9100 unbound during exit→restart window).
/// Tricity's small-feed ~5s tick + exponential-backoff restart made the
/// dead-window dominant, marking the container unhealthy and blocking
/// `depends_on: service_healthy` consumers downstream.
///
/// Args:
/// - `gtfs_zips`: one or more local GTFS zips. Each is mapped through
///   `download::record_for_local` PER TICK (so a refresher updating the
///   cache mid-loop produces a fresh sha that publish_one_tick detects).
///   `publish_one_tick` already takes a `Vec` and feeds the same
///   `pass1::run_pass1_union` path the URL flow uses. Krakow's 3-feed
///   input is the driving multi-feed consumer.
/// - `transfers_path`: optional pre-built `transfers.bin` to publish
///   alongside the bundle. Pre-built by the Node-side `scripts/build-
///   transfers.mjs` (the producer doesn't build transfers itself).
/// - `max_retained_generations`: janitor cap (default 10).
/// - `liveness_listen_addr`: optional `/healthz` + `/readyz` + `/metrics`
///   HTTP server. Spawned ONCE before the loop and stays bound for the
///   process lifetime.
#[allow(clippy::too_many_arguments)]
fn run_periodic_refresh(
    data_root: &Path,
    city: &str,
    gtfs_zips: &[PathBuf],
    anchor_date: Option<u32>,
    transfers_path: Option<refresh::TransfersSource<'_>>,
    address_search_path: Option<&Path>,
    city_osm_dir: Option<&Path>,
    osm_artifact_root: Option<&Path>,
    osm_lease_root: Option<&Path>,
    max_retained_generations: usize,
    liveness_listen_addr: Option<SocketAddr>,
    refresh_interval_secs: u64,
    city_tz_offset_seconds: Option<i32>,
    city_tz_iana: Option<&str>,
    derive_inseat: pt_producer::cli::DeriveInseat,
) -> Result<()> {
    eprintln!(
        "[producer] periodic-refresh start data_root={} city={} gtfs=[{}] transfers={} address_search={} max_retained={}",
        data_root.display(),
        city,
        gtfs_zips
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
        match transfers_path {
            Some(refresh::TransfersSource::Prebuilt(p)) => p.display().to_string(),
            Some(refresh::TransfersSource::WalkingGraph(p)) => format!("build:{}", p.display()),
            None => "<none>".into(),
        },
        address_search_path
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "<none>".into()),
        max_retained_generations,
    );

    // Build a `Vec<FeedRecord>` from the supplied local zips. The download
    // path (multi-feed URL) is wired by the top-level flow via
    // `download::fetch`; here we just record each local path. Order is
    // preserved so the eventual `pass1::run_pass1_union` walk matches the
    // operator's CLI order (matters for Krakow's three feeds).
    if !data_root.exists() {
        return Err(Error::Config(format!(
            "data root does not exist: {} — operator must create the directory first",
            data_root.display()
        )));
    }

    // SIGTERM/SIGINT handler. Reuses the existing `idle` module pattern
    // already used by the `--gtfs-path` ingestion subcommand (main.rs:84).
    // Without this, `std::thread::sleep` would block SIGTERM delivery for
    // up to `refresh_interval_secs` (3600 s default), making `docker
    // compose down` appear to hang for an hour before SIGKILL fires.
    let stop = idle::install_signal_handler();

    // Optional liveness server. Spawned BEFORE the first tick begins so
    // /healthz + /readyz are available immediately for compose / k8s
    // producers. Shares an `Arc<Mutex<HealthState>>` with the tick loop so
    // each tick's success/failure is reflected in the counters.
    // A restart over an already-published data root keeps serving that
    // generation while the first tick builds; /readyz reports it as ready
    // until the first tick ends (liveness::render_readyz).
    let liveness_state = Arc::new(Mutex::new(HealthState {
        generation_on_disk: refresh::current_generation_on_disk(data_root),
        ..HealthState::default()
    }));
    if let Some(addr) = liveness_listen_addr {
        let cfg = LivenessConfig {
            listen_addr: addr,
            refresh_interval: Duration::from_secs(refresh_interval_secs),
        };
        match liveness::spawn(cfg, Arc::clone(&liveness_state)) {
            Ok(bound) => eprintln!("[producer] liveness server bound to {bound}"),
            Err(e) => eprintln!("[producer] liveness server spawn failed (non-fatal): {e}"),
        }
    }

    let clock = SystemClock;
    let refresh_interval = Duration::from_secs(refresh_interval_secs);

    // Long-running tick loop. Previously this function ran a SINGLE tick
    // and exited, relying on compose `restart: unless-stopped` to re-run
    // it every `refresh_interval_secs`. That interacted badly with the
    // `/readyz` healthcheck contract introduced in PR #224 (and with
    // `/healthz` under exponential-backoff restart): each restart freed
    // port 9100 for several seconds, and a compose healthcheck that
    // landed in the dead window got connection-refused. After 3 strikes
    // the container was marked unhealthy and downstream `depends_on:
    // service_healthy` blocked the deploy. Moving the loop into the
    // process keeps the liveness listener bound across ticks.
    //
    // Compose `restart: unless-stopped` remains as an OOM/SIGKILL safety
    // net only — uncaught panics inside publish_one_tick are converted to
    // failed-tick counters by the `catch_unwind` below so the loop stays
    // alive across all soft failure classes.
    loop {
        if stop.load(Ordering::SeqCst) {
            eprintln!("[producer] periodic-refresh: SIGTERM/SIGINT received, exiting cleanly");
            return Ok(());
        }

        let tick_started_at = Instant::now();
        // Bump the loop iteration marker BEFORE record_for_local so a
        // stuck zip read still shows progress on /healthz.
        liveness::with_state(&liveness_state, |s| {
            s.last_loop_at = Some(tick_started_at);
        });

        // Rebuild feed_records every tick: `record_for_local` re-reads
        // the zip and re-hashes it, so an upstream refresher updating
        // the cache between ticks produces a fresh sha that publish_one_tick
        // will detect as new content.
        let feed_records: Vec<download::FeedRecord> = match gtfs_zips
            .iter()
            .map(|p| download::record_for_local(p))
            .collect::<Result<Vec<_>>>()
        {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[producer] periodic-refresh: failed to read feed records: {e}");
                liveness::with_state(&liveness_state, |s| {
                    s.publish_failed = s.publish_failed.saturating_add(1);
                });
                let elapsed = tick_started_at.elapsed();
                let sleep_for = refresh_interval.saturating_sub(elapsed);
                idle::sleep_until_term(&stop, sleep_for.as_secs());
                continue;
            }
        };

        // Wrap publish_one_tick in catch_unwind so a panic deep in pass1/pass2
        // doesn't kill the loop — preserves the always-alive contract that
        // the new healthcheck semantics depend on. AssertUnwindSafe is the
        // standard escape for closures holding references (publish_one_tick
        // takes &Path / &str / &SystemClock); a panic mid-publish is no
        // worse than a kill -9 since the publish protocol is atomic-rename
        // crash-safe and producer.lock is auto-released on drop/exit.
        let mut awaiting_osm = false;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let pinned = resolve_tick_sidecars(
                transfers_path,
                address_search_path,
                city_osm_dir,
                osm_artifact_root,
                osm_lease_root,
                city,
            )
            .inspect_err(|_| {
                awaiting_osm = osm_artifact_root.is_some();
            })?;
            refresh::publish_one_tick(
                data_root,
                city,
                feed_records,
                anchor_date,
                pinned.transfers(),
                pinned.address_search.as_deref(),
                max_retained_generations,
                city_tz_offset_seconds,
                city_tz_iana,
                derive_inseat,
                Some(&stop),
                &clock,
            )
        }));
        match result {
            Ok(Ok(refresh::PublishOutcome::Published {
                generation_id,
                janitor,
            })) => {
                eprintln!(
                    "[producer] periodic-refresh published generation_id={generation_id} \
                     generations_deleted={} publishing_dirs_deleted={}",
                    janitor.generations_deleted.len(),
                    janitor.publishing_dirs_deleted.len(),
                );
                liveness::with_state(&liveness_state, |s| {
                    s.publish_ok = s.publish_ok.saturating_add(1);
                    s.last_success_at = Some(std::time::SystemTime::now());
                });
            }
            Ok(Ok(refresh::PublishOutcome::Paused { reason })) => {
                use refresh::PausedReason;
                match reason {
                    PausedReason::OperatorPaused => {
                        eprintln!("[producer] periodic-refresh: producer.paused — no-op");
                        liveness::with_state(&liveness_state, |s| {
                            s.publish_paused = s.publish_paused.saturating_add(1);
                        });
                    }
                    PausedReason::PtServeVersionMismatch
                    | PausedReason::PtServeVersionMalformed => {
                        eprintln!(
                            "[producer] periodic-refresh: version-gate skip (reason={reason:?})"
                        );
                        liveness::with_state(&liveness_state, |s| {
                            s.pt_serve_version_skips = s.pt_serve_version_skips.saturating_add(1);
                        });
                    }
                }
            }
            Ok(Ok(refresh::PublishOutcome::Noop { generation_id })) => {
                // Noop bumps last_success_at too: the gauge is named
                // `producer_last_success_timestamp_seconds` and Noop is the
                // producer successfully observing-and-confirming-current.
                // Without this, an upstream that's stable for 23h/day pins
                // the gauge at the first publish forever, and any alert keyed
                // on `time() - producer_last_success_timestamp_seconds > N`
                // fires spuriously for the entire stable period.
                eprintln!(
                    "[producer] periodic-refresh: no change (generation {generation_id} already current)"
                );
                liveness::with_state(&liveness_state, |s| {
                    s.publish_ok = s.publish_ok.saturating_add(1);
                    s.last_success_at = Some(std::time::SystemTime::now());
                });
            }
            Ok(Err(e)) => {
                eprintln!("[producer] periodic-refresh: error: {e}");
                let msg = e.to_string();
                // Lock conflict is a permanent misconfiguration (another
                // producer owns this data root). Exit so compose's restart-
                // policy + docker backoff handle the retry cadence; soft-
                // looping forever just wastes CPU on a condition that needs
                // operator intervention. String-match is fragile — matches
                // the message refresh.rs:94-99 constructs from
                // ProducerLockError::AlreadyLocked. Typed discriminator is
                // followups item under #20.
                if msg.contains("producer.lock already held") {
                    return Err(e);
                }
                // Step-7 validation failures are a distinct counter so the
                // alert pack rate-key doesn't miss validation aborts.
                if msg.contains("offline validation failed") {
                    liveness::with_state(&liveness_state, |s| {
                        s.validation_failures = s.validation_failures.saturating_add(1);
                    });
                }
                liveness::with_state(&liveness_state, |s| {
                    s.publish_failed = s.publish_failed.saturating_add(1);
                });
                // Soft-fail: log, increment, sleep, retry on next tick.
            }
            Err(panic_payload) => {
                // Recover the panic message for the log line; downcast covers
                // the two common payload shapes (`&'static str` for
                // `panic!("literal")`, `String` for `panic!("{}", fmt)`).
                let payload_str = panic_payload
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| panic_payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "<non-string panic payload>".into());
                eprintln!(
                    "[producer] periodic-refresh: PANIC inside publish_one_tick (caught, loop continues): {payload_str}"
                );
                liveness::with_state(&liveness_state, |s| {
                    s.publish_failed = s.publish_failed.saturating_add(1);
                });
            }
        }
        // Sleep `refresh_interval - elapsed` so cadence is wall-clock-
        // anchored (operator's `--refresh-interval-secs=3600` means "publish
        // attempts at 0/60/120/... minutes" not "0/60+T/120+2T/..."). Uses
        // `sleep_until_term` so SIGTERM during the sleep aborts within 1 s
        // instead of waiting up to `refresh_interval` for SIGKILL.
        let elapsed = tick_started_at.elapsed();
        // The shared manager may still be installing required inputs on a
        // fresh deployment. Retry discovery promptly; the normal GTFS cadence
        // resumes after inputs resolve. Existing generations remain untouched.
        let interval = if awaiting_osm {
            refresh_interval.min(Duration::from_secs(30))
        } else {
            refresh_interval
        };
        let sleep_for = interval.saturating_sub(elapsed);
        idle::sleep_until_term(&stop, sleep_for.as_secs());
    }
}

/// Sidecar inputs after folding `--city-osm-dir` into the explicit flags.
struct Sidecars {
    prebuilt_transfers: Option<PathBuf>,
    walking_graph: Option<PathBuf>,
    address_search: Option<PathBuf>,
    /// Held until the tick's build finishes; dropping releases the OS lock.
    _lease: Option<pt_shared::artifact_lease::ConsumerLease>,
}

impl Sidecars {
    fn transfers(&self) -> Option<refresh::TransfersSource<'_>> {
        match (&self.prebuilt_transfers, &self.walking_graph) {
            (Some(p), _) => Some(refresh::TransfersSource::Prebuilt(p)),
            (None, Some(g)) => Some(refresh::TransfersSource::WalkingGraph(g)),
            (None, None) => None,
        }
    }
}

fn resolve_tick_sidecars(
    transfers: Option<refresh::TransfersSource<'_>>,
    addresses: Option<&Path>,
    city_osm_dir: Option<&Path>,
    artifacts: Option<&Path>,
    lease_root: Option<&Path>,
    city: &str,
) -> Result<Sidecars> {
    if let Some(root) = artifacts {
        let unavailable =
            |e| Error::Config(format!("required OSM inputs unavailable for {city}: {e}"));
        let (pinned, lease) = match lease_root {
            Some(leases) => {
                let (inputs, lease) =
                    pt_shared::osm_install::producer_inputs_leased(root, leases, city)
                        .map_err(unavailable)?;
                (inputs, Some(lease))
            }
            None => (
                pt_shared::osm_install::producer_inputs(root, city).map_err(unavailable)?,
                None,
            ),
        };
        eprintln!(
            "[producer] pinned OSM release={} city={city}",
            pinned.release
        );
        return Ok(Sidecars {
            prebuilt_transfers: None,
            walking_graph: Some(pinned.walking),
            address_search: Some(pinned.addresses),
            _lease: lease,
        });
    }
    let (prebuilt, walking) = match transfers {
        Some(refresh::TransfersSource::Prebuilt(path)) => (Some(path.to_owned()), None),
        Some(refresh::TransfersSource::WalkingGraph(path)) => (None, Some(path.to_owned())),
        None => (None, None),
    };
    Ok(resolve_sidecars(
        prebuilt,
        walking,
        addresses.map(Path::to_owned),
        city_osm_dir,
    ))
}

/// `--city-osm-dir` supplies `walking.geojsonseq.gz` and `address-search.fst`
/// only where the matching explicit flag is unset and the file exists; a
/// missing file is logged so an image built without OSM artifacts still
/// publishes (just without that sidecar).
fn resolve_sidecars(
    transfers: Option<PathBuf>,
    walking_graph: Option<PathBuf>,
    address_search: Option<PathBuf>,
    city_osm_dir: Option<&Path>,
) -> Sidecars {
    let mut out = Sidecars {
        prebuilt_transfers: transfers,
        walking_graph,
        address_search,
        _lease: None,
    };
    if let Some(dir) = city_osm_dir {
        let pick = |name: &str| {
            let p = dir.join(name);
            if p.is_file() {
                Some(p)
            } else {
                eprintln!(
                    "[producer] WARN --city-osm-dir: {} missing; publishing without it",
                    p.display()
                );
                None
            }
        };
        if out.prebuilt_transfers.is_none() && out.walking_graph.is_none() {
            out.walking_graph = pick(CITY_OSM_WALKING_GRAPH);
        }
        if out.address_search.is_none() {
            out.address_search = pick(CITY_OSM_ADDRESS_SEARCH);
        }
    }
    out
}

/// File names inside a `--city-osm-dir` (written by
/// `scripts/build-city-osm-artifacts.mjs`).
const CITY_OSM_WALKING_GRAPH: &str = "walking.geojsonseq.gz";
const CITY_OSM_ADDRESS_SEARCH: &str = "address-search.fst";

/// P4 republish entrypoint. Mirrors `run_periodic_refresh` but reads from a
/// cached zip and may archive the current generation first.
#[allow(clippy::too_many_arguments)]
fn run_republish(
    data_root: &Path,
    city: &str,
    from_cache: &[PathBuf],
    archive_to: Option<&Path>,
    anchor_date: Option<u32>,
    transfers_path: Option<refresh::TransfersSource<'_>>,
    address_search_path: Option<&Path>,
    max_retained_generations: usize,
    city_tz_offset_seconds: Option<i32>,
    city_tz_iana: Option<&str>,
    derive_inseat: pt_producer::cli::DeriveInseat,
) -> Result<()> {
    let clock = SystemClock;
    match republish::run_republish_many(
        data_root,
        city,
        from_cache,
        archive_to,
        anchor_date,
        transfers_path,
        address_search_path,
        max_retained_generations,
        city_tz_offset_seconds,
        city_tz_iana,
        derive_inseat,
        &clock,
    )? {
        refresh::PublishOutcome::Published {
            generation_id,
            janitor,
        } => {
            eprintln!(
                "[producer] republish published generation_id={generation_id} \
                 generations_deleted={} publishing_dirs_deleted={}",
                janitor.generations_deleted.len(),
                janitor.publishing_dirs_deleted.len(),
            );
        }
        refresh::PublishOutcome::Paused { reason } => {
            eprintln!("[producer] republish: tick skipped (reason={reason:?})");
        }
        refresh::PublishOutcome::Noop { generation_id } => {
            eprintln!(
                "[producer] republish: no change (generation {generation_id} already current)"
            );
        }
    }
    Ok(())
}

/// Tile-step-only entrypoint (`build-schedule-tiles`). Runs the SAME
/// `schedule_tiles::build_schedule_tiles` the publish modes invoke as their
/// Step 3g, against a generation directory that already holds `bundle.ptb` and
/// `route-styles.json`.
///
/// The `--gen-id` cross-check is the load-bearing part. pt-serve resolves tile
/// bodies from `<gen_dir>/schedule-tiles/<generationId>/`. Existing generation
/// manifests determine that ID; it is distinct from the PTB's content hash.
/// Standalone fixture builds can use an explicit token without a manifest.
fn run_build_schedule_tiles(gen_dir: &Path, city: &str, gen_id: Option<&str>) -> Result<()> {
    let ptb_path = gen_dir.join("bundle.ptb");
    let ptb_bytes = std::fs::read(&ptb_path).map_err(|e| {
        Error::Config(format!(
            "failed to read {} — build-schedule-tiles operates on an already-staged \
             generation directory: {e}",
            ptb_path.display()
        ))
    })?;
    let bundle_sha256 = pt_producer::build::sha256_hex(&ptb_bytes);
    let manifest_path = gen_dir.join("generation.json");
    let generation_id = if manifest_path.is_file() {
        let manifest: pt_shared::manifest::GenerationManifest =
            serde_json::from_slice(&std::fs::read(manifest_path)?)
                .map_err(|e| Error::Config(e.to_string()))?;
        let expected = pt_shared::manifest::publication_id(
            &bundle_sha256,
            &manifest.publication_inputs_sha256,
        );
        if manifest.bundle_sha256 != bundle_sha256 || manifest.generation_id != expected {
            return Err(Error::Config(
                "generation manifest does not match staged PTB/publication inputs".into(),
            ));
        }
        if gen_id.is_some_and(|id| id != expected) {
            return Err(Error::Config(
                "--gen-id disagrees with generation manifest".into(),
            ));
        }
        expected
    } else {
        let supplied = gen_id.unwrap_or(&bundle_sha256);
        if !pt_shared::osm_manifest::valid_digest(supplied) {
            return Err(Error::Config(
                "--gen-id must be lowercase SHA-256 hex".into(),
            ));
        }
        supplied.to_owned()
    };
    let config = pt_producer::schedule_tiles::TileBuildConfig::from_env()?;
    eprintln!(
        "[producer] schedule-tiles threads={} quality={}",
        config.threads, config.quality
    );
    let outputs =
        pt_producer::schedule_tiles::build_schedule_tiles(gen_dir, city, &generation_id, &config)?;
    // Same stdout protocol as schedule-tile-gen.mjs (:69,:135) so the two tile
    // builders stay drop-in comparable and a caller can parse either.
    println!(
        "schedule-tile-bundle {} {} {}",
        outputs.manifest_sha256, outputs.manifest_size_bytes, outputs.bundle_hash
    );
    println!(
        "trip-route.json {} {}",
        outputs.trip_route_sha256, outputs.trip_route_size_bytes
    );
    println!(
        "stop-cell.json {} {}",
        outputs.stop_cell_sha256, outputs.stop_cell_size_bytes
    );
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("[producer] FATAL: {e}");
        std::process::exit(1);
    }
}
