//! Reusable PTB-build pipeline.
//!
//! Factored out of `main.rs` so the P4 publish protocol (`refresh.rs`) can
//! call into the same Pass-1 + Pass-2 + region-write + header-write logic
//! without duplicating the orchestration. The `--out <path>` flow in `main.rs`
//! calls this directly; `refresh.rs` calls it with a
//! staging-dir destination.
//!
//! The function deliberately does NOT handle:
//! - download (caller hands us a `Vec<PathBuf>` of local zip paths)
//! - `current.json` / pointer manifests (caller owns the publish protocol)
//! - sidecars (write_meta / write_shapes) — caller drives those independently
//!
//! The returned [`BuildOutcome`] carries everything the caller needs to
//! emit a P4 `GenerationManifest` (size + feed-start-date + computed SHA).

use crate::date_utils::{today_yyyymmdd, validate_yyyymmdd};
use crate::error::{Error, Result};
use crate::interns::write_trips_intern;
use crate::layout::{self, Region};
use crate::regions::{flush_mid_pass_regions, write_transfers_region, write_u32_slice};
use crate::writer::WriteRegion;
use crate::{pass1, pass2, pass3, source, strpool, writer};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Minimum service count below which the weak-dedup warning is suppressed — on
/// a tiny feed a near-`numServices` distinct count is unremarkable (dedup has
/// little to recover), so the warning would be noise.
const WEAK_DEDUP_MIN_SERVICES: u32 = 16;

/// Emit a weak-dedup warning when the `0x15 ServiceBitfieldPool`
/// recovered little: `count > 0.9 * num_services` with `num_services >= 16`. A
/// pool whose distinct count stays near `num_services` deduped almost nothing —
/// at scale that usually signals a stride/anchor bug upstream (a real feed with
/// many genuinely-distinct calendars is legitimate). `service_pool_count` is
/// Shared by both emit paths — `build_ptb` (periodic refresh) and
/// `main.rs::run` (one-shot sidecar) — so the diagnostic is symmetric.
pub fn warn_weak_service_bitfield_dedup(service_pool_count: Option<u32>, num_services: u32) {
    if let Some(count) = service_pool_count {
        if num_services >= WEAK_DEDUP_MIN_SERVICES
            && u64::from(count) * 10 > u64::from(num_services) * 9
        {
            eprintln!(
                "[producer] WARN service_bitfield_pool_weak_dedup: {count} distinct bitfields for \
                 {num_services} services (ratio {:.2}) — the 0x15 ServiceBitfieldPool \
                 recovered little; verify the bitmask stride/anchor.",
                f64::from(count) / f64::from(num_services.max(1)),
            );
        }
    }
}

/// Result of one PTB build. The caller persists `bundle_bytes` (or copies
/// from `bundle_tmp_path`) and emits a `GenerationManifest` referencing the
/// returned SHA / size / anchor.
pub struct BuildOutcome {
    /// On-disk path of the built PTB file (in a caller-provided scratch dir).
    pub bundle_tmp_path: PathBuf,
    /// Size in bytes of the PTB at `bundle_tmp_path`.
    pub bundle_size_bytes: u64,
    /// Lowercase-hex SHA-256 of the PTB bytes. Used as `generationId`.
    pub bundle_sha256: String,
    /// 90-day service-window anchor (YYYYMMDD u32). Mirrored into the PTB
    /// header AND the GenerationManifest so the metadata validator's pairing
    /// check passes.
    pub feed_start_date: u32,
    /// Per-feed PTB-shape sidecar data used by the existing P3 path. The
    /// P4 path may ignore this; the field is plumbed through so the caller
    /// can choose.
    pub shape_groups: Vec<crate::sidecars::ShapeGroup>,
    /// Feed records (URL, sha, etag) for sidecar emission.
    pub feed_records: Vec<crate::download::FeedRecord>,
    /// Per-feed `feed_info.txt` metadata, parallel to `feed_records`.
    pub feed_infos: Vec<crate::pass1::feed_info::FeedInfo>,
    /// Complete `departures-idx.bin` bytes (header + CSR). The caller stages this file and records
    /// its SHA in the generation manifest. Empty-feed case is still a valid >=84-byte buffer (never
    /// 0-length).
    pub departures_idx_bytes: Vec<u8>,
    /// Complete `shapes.bin` bytes (SHPB header + index + varint-delta
    /// polylines). The caller stages this file and records its SHA in the
    /// generation manifest (`shapesBinSha256`). Empty-feed case is still a
    /// valid >=88-byte buffer (never 0-length).
    pub shapes_bin_bytes: Vec<u8>,

    /// Window provenance. `window_days` is the derived window
    /// length emitted into `0x01` (when `> 90`) AND used as the bitmask stride;
    /// the booleans are the counted fidelity warnings the caller mirrors into
    /// `generation.json` (`windowClampedHigh`/`windowFlooredLow`).
    pub window_days: u16,
    /// `clamp_event == ClampedHigh`: the feed horizon exceeded the 400-day
    /// ceiling and the window was capped.
    pub window_clamped_high: bool,
    /// `clamp_event == FlooredLow`: the feed horizon (incl. the empty-fold /
    /// stale-feed cases) fell below the 90-day floor and the window was raised.
    pub window_floored_low: bool,
    /// Number of distinct service bitfields written to the current PTB v1
    /// `0x15 ServiceBitfieldPool`.
    /// Recorded into `generation.json` (`serviceBitfieldPoolCount`) for operator
    /// triage of dedup effectiveness (I22).
    pub service_bitfield_pool_count: Option<u32>,
    /// Number of GTFS services (calendars) in this generation — the denominator
    /// for the dedup ratio `count / numServices`. Mirrored into
    /// `generation.json` (`numServices`) alongside `serviceBitfieldPoolCount`.
    pub num_services: u32,
    /// Number of type-4 in-seat transfer rules derived from block_id
    /// continuations. Always `Some` from `build_ptb` (0 when derivation ran
    /// but found none, or when auto-disabled). Surfaced in `*.meta.json` via
    /// `sidecars::write_meta` so operators can observe the derived count
    /// without parsing logs.
    pub derived_inseat_rules: u32,
    /// `[minLon, minLat, maxLon, maxLat]` over stops.txt coordinates.
    pub stop_bbox: pt_shared::pack_manifest::BBox,
    /// v1 pack coverage bbox: stops plus parsed shapes geometry when present.
    pub coverage_bbox: pt_shared::pack_manifest::BBox,
    /// Machine-readable caveats when declared geometry exists but cannot extend coverage.
    pub coverage_incomplete_reasons: Vec<String>,
}

/// Build a current PTB v1 bundle from a set of local GTFS zip paths.
///
/// - `feed_zip_paths` — local paths to GTFS zips. The caller is responsible
///   for downloading from URL if needed (preserved as-is for the existing
///   `--gtfs-url` path).
/// - `extract_root` — a scratch directory used for unzipping. Caller owns
///   the lifetime (typically a `tempfile::TempDir`).
/// - `bundle_dest` — the path the built PTB is written to. Caller picks
///   (e.g. staging-dir/bundle.ptb for P4; tmpfile for the P3 path).
/// - `anchor_date` — `Some(yyyymmdd)` for deterministic CI/test, `None` to
///   use today's UTC date. The default is the production case.
/// - `feed_records` — per-feed provenance, supplied by the caller to keep
///   the URL/local-path bifurcation out of this fn.
/// - `city_tz_offset_seconds` — `Some(secs)` to stamp into the PTB
///   header's `city_tz_offset_seconds` field; `None` falls through to
///   a value computed from `city_tz_iana`, or 0 (UTC) when both are absent.
/// - `city_tz_iana` — IANA timezone name (e.g. `"Europe/Vilnius"`). When
///   `city_tz_offset_seconds` is `None`, the offset is computed from this
///   name at the anchor date's midnight UTC, using the same bundled Jiff
///   computation pt-serve's T13 cross-check uses.
#[allow(clippy::too_many_arguments)]
pub fn build_ptb(
    feed_records: Vec<crate::download::FeedRecord>,
    extract_root: &Path,
    bundle_dest: &Path,
    anchor_date: Option<u32>,
    city_tz_offset_seconds: Option<i32>,
    city_tz_iana: Option<&str>,
    derive_inseat: crate::cli::DeriveInseat,
) -> Result<BuildOutcome> {
    let zip_paths: Vec<PathBuf> = feed_records.iter().map(|f| f.zip_path.clone()).collect();
    std::fs::create_dir_all(extract_root)?;
    source::extract_all(&zip_paths, extract_root)?;
    let feed_dirs: Vec<PathBuf> = (0..zip_paths.len())
        .map(|i| extract_root.join(format!("feed-{i}")))
        .collect();

    // Per-feed `feed_info.txt` provenance (publisher/lang/version), parallel
    // to `feed_dirs`/`feed_records`. Optional GTFS file → all-None per feed
    // when absent. GTFS reference:
    // https://gtfs.org/documentation/schedule/reference/#feed_infotxt
    let feed_infos: Vec<pass1::feed_info::FeedInfo> = feed_dirs
        .iter()
        .map(|d| pass1::feed_info::parse_feed_info(d))
        .collect::<Result<_>>()?;

    let mut p1 = pass1::run_pass1_union(&feed_dirs)?;

    // Anchor-date override matches main.rs behaviour: default is today
    // (rolling); --anchor-date is set ONLY by CI/tests for determinism.
    let anchor = anchor_date.unwrap_or_else(today_yyyymmdd);
    if let Err(msg) = validate_yyyymmdd(anchor) {
        return Err(Error::Config(format!("anchor-date: {msg}")));
    }
    p1.feed_start_date = anchor;

    // Derive windowDays at the final anchor.
    // The horizon is `maxEnd - anchor` (both via the bitmask's `ymd_to_julian`),
    // so it MUST be derived here — after the `--anchor-date`/today override —
    // not in pass1.
    let window = resolve_window(p1.feed_start_date, p1.max_end_date);
    let window_days = window.window_days;

    validate_no_empty_ids([
        ("stop_id", p1.stops.keys()),
        ("route_id", p1.routes.keys()),
        ("trip_id", p1.trips.keys()),
    ])?;

    // Parse transfers.txt across all feeds AFTER finalize so ids resolve to
    // post-finalize ordinals (the indices the PTB Transfers record stores).
    // Optional GTFS file → empty when absent. Carried only (no scan reads it).
    // GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
    let (transfers, derived_inseat_count) = {
        let mut rows: Vec<pass1::TransferRow> = Vec::new();
        let mut dropped = 0usize;
        for feed_dir in &feed_dirs {
            let res = pass1::parse_transfers(feed_dir, &p1)?;
            rows.extend(res.rows);
            dropped += res.dropped_unknown_stop;
        }
        if dropped > 0 {
            eprintln!(
                "[producer] transfers: dropped {dropped} row(s) referencing unknown stop ids"
            );
        }
        // Derive type-4 in-seat rules from block_id continuations, honoring the
        // activation gate (auto-disabled when the union already declares type-4).
        // Merged INSIDE this block so `transfers.len()` (which sizes the
        // Transfers region in Layout::compute below) reflects the merged total.
        let derived = pass1::derive_for_build(&p1, &rows, derive_inseat);
        eprintln!("[producer] in-seat rules derived={}", derived.len());
        let count = derived.len() as u32;
        rows.extend(derived);
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
            eprintln!("[producer] frequencies: dropped {dropped} row(s) (unknown trip / bad headway / inverted window)");
        }
        rows
    };

    let pool = {
        let mut pool = strpool::StringPool::new();
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

    let natural_bytes = layout.total_bytes();
    let mut w = writer::open_writer(bundle_dest, natural_bytes)?;

    {
        let trips_region = w.region_slice(&layout, Region::TripsIntern);
        write_trips_intern(trips_region, p1.trips.keys(), &p1.trips_attrs, &pool)?;
    }

    flush_mid_pass_regions(&mut w, &layout, &p1, window_days)?;

    let trip_starts = pass1::compute_trip_starts(&p1);
    let mut write_cursor = trip_starts.clone();

    // Parallel per-stop_time boarding bytes for PatternSemantics construction,
    // one byte per StopTimes row in global-row order. Pre-fill the default
    // `0x50` (pickup/drop_off 0, continuous_* 1) and thread the SAME `&mut [u8]`
    // across all feeds — each row's packed byte lands at `off / stride`, so any
    // slot a feed never reaches keeps the default. Sized to `total_stop_times`
    // (== the StopTimes region row count) which is known up front from Pass 1.
    let mut boarding = vec![0x50u8; p1.total_stop_times as usize];

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
    // Hand the filled boarding bytes to the current emitter via `p1`; the
    // `&p1` borrow held by the loop above is released here.
    p1.stop_time_boarding = boarding;
    if total_rows as u32 != p1.total_stop_times {
        return Err(Error::Config(format!(
            "row-count invariant violated: pass1={} pass2={}",
            p1.total_stop_times, total_rows,
        )));
    }
    for i in 0..p1.trips.len() {
        if write_cursor[i] != trip_starts[i + 1] {
            return Err(Error::Config(format!(
                "trip-fill invariant violated for sorted trip {i}: \
                 write_cursor={} expected trip_starts[{}]={}",
                write_cursor[i],
                i + 1,
                trip_starts[i + 1],
            )));
        }
    }

    {
        let ts_region = w.region_slice(&layout, Region::TripStarts);
        write_u32_slice(ts_region, &trip_starts)?;
    }
    {
        let sp_region = w.region_slice(&layout, Region::StringPool);
        pool.write(sp_region)?;
    }
    // NOTE: `pool` (which borrows `p1`) is kept alive past here — the current emit
    // branch below re-reads it for the SoA `*_idx` column lookups. All other
    // post-write `p1` accesses are immutable too, so the borrows coexist.

    // Write resolved GTFS transfers.txt rules into the staging region.
    write_transfers_region(&mut w, &layout, &transfers)?;

    // ---- departures-idx sidecar (Stage C C1b) -----------------------------
    // Transpose post-finalize triples into a per-stop CSR, header-stamped with
    // the canonical trip/stop interner SHAs so a sidecar built against a
    // different interning is rejected at load.
    let trips_intern_sha = pt_shared::sidecar::intern_namespace_sha256(p1.trips.keys());
    let stops_intern_sha = pt_shared::sidecar::intern_namespace_sha256(p1.stops.keys());
    // `trip_starts` is the same prefix-sum build_ptb already computed for the
    // StopTimes write (pass1::compute_trip_starts(&p1)); pass it so the sidecar
    // entries carry the exact absolute StopTimes row index.
    let (dep_offsets, dep_entries) = pass3::departures_idx::build_departures_idx_csr(
        &p1.trip_stop_triples,
        p1.stops.len(),
        &trip_starts,
    )?;
    let departures_idx_bytes = pt_shared::sidecar::encode_departures_idx(
        &dep_offsets,
        &dep_entries,
        &trips_intern_sha,
        &stops_intern_sha,
    )
    .map_err(|e| Error::Config(format!("departures-idx encode: {e}")))?;

    let resolved_tz_offset =
        resolve_city_tz_offset(city_tz_offset_seconds, city_tz_iana, p1.feed_start_date)?;
    w.finish()?;
    let feed_start_date = p1.feed_start_date;

    // Reframe the temporary positional regions into the sole published PTB v1
    // layout before any downstream hash, sidecar, or manifest sees the bundle.
    let temporary_bytes = std::fs::read(bundle_dest)?;
    let (current_bytes, service_pool_count) = reencode_staging_bundle_as_current(
        &temporary_bytes,
        &layout,
        &p1,
        &pool,
        resolved_tz_offset,
        window_days,
        &frequencies,
    )?;
    std::fs::write(bundle_dest, &current_bytes)?;
    drop(pool);

    // Compute SHA-256 + size from the just-written file. The producer must
    // hash the exact bytes that landed on disk so a torn write surfaces as a
    // checksum mismatch later — re-hashing an in-memory buffer would miss
    // any I/O corruption.
    let bundle_bytes = std::fs::read(bundle_dest)?;
    let bundle_size_bytes = bundle_bytes.len() as u64;
    let bundle_sha256 = sha256_hex(&bundle_bytes);

    let stop_bbox = bbox_from_stops(&p1.stops_attrs);
    let shape_groups = pass2::shapes::parse_shapes_all(&feed_dirs)?;
    let mut coverage_bbox = stop_bbox;
    let mut coverage_incomplete_reasons = Vec::new();
    if shape_groups.iter().any(|g| !g.points.is_empty()) {
        coverage_bbox = bbox_union(coverage_bbox, bbox_from_shapes(&shape_groups));
    } else if !shape_groups.is_empty() {
        coverage_incomplete_reasons.push("shape-groups-without-valid-points".to_string());
    }

    // ---- shapes-bin sidecar (Stage C C1c) ---------------------------------
    // Encode from the SAME shape_groups vec the JSON sidecar uses (dual-write
    // content parity is structural — one parse, two serialisers), header-
    // stamped with the same canonical namespace SHAs the departures-idx
    // sidecar carries (trips_intern_sha / stops_intern_sha, still in scope
    // from the C1b block above).
    let shapes_bin_bytes =
        pass3::shapes_bin::build_shapes_bin(&shape_groups, &trips_intern_sha, &stops_intern_sha)?;

    // Counted fidelity warnings (I9) — one line each, mirroring the
    // transfers/calendar skip-count style. The caller writes the same facts
    // into `generation.json`.
    if window.clamp_event == crate::service::bitmask::WindowClampEvent::ClampedHigh {
        eprintln!(
            "[producer] WARN window_clamped_high: feed horizon exceeds the {}-day ceiling; \
             window_days capped at {window_days}.",
            pt_core::WINDOW_HARD_CEILING,
        );
    } else if window.clamp_event == crate::service::bitmask::WindowClampEvent::FlooredLow {
        eprintln!(
            "[producer] WARN window_floored_low: feed horizon below the {}-day floor; \
             window_days raised to {window_days}.",
            pt_core::WINDOW_MIN_FLOOR,
        );
    }

    // Counted weak-dedup warning. The 0x15 pool is effective when many
    // services share a calendar (`count << numServices`). A pool whose distinct
    // count stays near `numServices` recovered almost nothing — surface it for
    // operator triage. Shared with `main.rs::run` so both emit paths warn alike.
    warn_weak_service_bitfield_dedup(service_pool_count, p1.services.len() as u32);

    Ok(BuildOutcome {
        bundle_tmp_path: bundle_dest.to_path_buf(),
        bundle_size_bytes,
        bundle_sha256,
        feed_start_date,
        shape_groups,
        feed_records,
        feed_infos,
        departures_idx_bytes,
        shapes_bin_bytes,
        window_days,
        window_clamped_high: window.clamp_event
            == crate::service::bitmask::WindowClampEvent::ClampedHigh,
        window_floored_low: window.clamp_event
            == crate::service::bitmask::WindowClampEvent::FlooredLow,
        service_bitfield_pool_count: service_pool_count,
        num_services: p1.services.len() as u32,
        derived_inseat_rules: derived_inseat_count,
        stop_bbox,
        coverage_bbox,
        coverage_incomplete_reasons,
    })
}

fn bbox_from_stops(stops: &[pass1::StopAttrs]) -> pt_shared::pack_manifest::BBox {
    let mut acc = BBoxAccumulator::default();
    for stop in stops {
        acc.add(stop.lon, stop.lat);
    }
    acc.finish()
}

fn bbox_from_shapes(shapes: &[crate::sidecars::ShapeGroup]) -> pt_shared::pack_manifest::BBox {
    let mut acc = BBoxAccumulator::default();
    for shape in shapes {
        for point in &shape.points {
            acc.add(f64::from(point.lon), f64::from(point.lat));
        }
    }
    acc.finish()
}

fn bbox_union(
    a: pt_shared::pack_manifest::BBox,
    b: pt_shared::pack_manifest::BBox,
) -> pt_shared::pack_manifest::BBox {
    let [a_min_lon, a_min_lat, a_max_lon, a_max_lat] = a.0;
    let [b_min_lon, b_min_lat, b_max_lon, b_max_lat] = b.0;
    pt_shared::pack_manifest::BBox([
        a_min_lon.min(b_min_lon),
        a_min_lat.min(b_min_lat),
        a_max_lon.max(b_max_lon),
        a_max_lat.max(b_max_lat),
    ])
}

#[derive(Default)]
struct BBoxAccumulator {
    min_lon: f64,
    min_lat: f64,
    max_lon: f64,
    max_lat: f64,
    seen: bool,
}

impl BBoxAccumulator {
    fn add(&mut self, lon: f64, lat: f64) {
        if !lon.is_finite() || !lat.is_finite() {
            return;
        }
        if self.seen {
            self.min_lon = self.min_lon.min(lon);
            self.min_lat = self.min_lat.min(lat);
            self.max_lon = self.max_lon.max(lon);
            self.max_lat = self.max_lat.max(lat);
        } else {
            self.min_lon = lon;
            self.min_lat = lat;
            self.max_lon = lon;
            self.max_lat = lat;
            self.seen = true;
        }
    }

    fn finish(self) -> pt_shared::pack_manifest::BBox {
        if self.seen {
            // The f64->f32 cast matches SHPB's precision: shapes.bin quantizes
            // from f32 points, and both paths must agree on the E5 integers.
            pt_shared::pack_manifest::BBox([
                pt_shared::sidecar::quantize_deg(self.min_lon as f32),
                pt_shared::sidecar::quantize_deg(self.min_lat as f32),
                pt_shared::sidecar::quantize_deg(self.max_lon as f32),
                pt_shared::sidecar::quantize_deg(self.max_lat as f32),
            ])
        } else {
            // Empty feed => degenerate Null-Island bbox [0,0,0,0]. It validates;
            // consumers must not read it as coverage (documented in the pack spec).
            pt_shared::pack_manifest::BBox([0, 0, 0, 0])
        }
    }
}

/// Reframe the producer's temporary positional regions as current PTB v1.
///
/// The current emitter needs tightly sized source regions plus the two SoA
/// columns it encodes from `pool` and `p1`. Rather than rerun a writer, this
/// function reads those source bytes from the temporary staging buffer. Each
/// region body lives at
/// `layout.offset(region)` and the TIGHT content length is either the region's
/// exact `layout.length(...)` (StopTimes/TripStarts/StringPool/Transfers) or
/// the content-stride product (Trips/ServiceBitmasks) / packed CSR length
/// (Csr) — the page-aligned region length over-reports those three, so we
/// recompute their tight extents here.
///
/// This is the single current-format boundary used by both producer modes.
/// Returns the bundle bytes and the distinct service-bitfield count.
#[allow(clippy::too_many_arguments)]
pub fn reencode_staging_bundle_as_current(
    temporary_bytes: &[u8],
    layout: &layout::Layout,
    p1: &pass1::Pass1Result,
    pool: &strpool::StringPool,
    city_tz_offset_seconds: i32,
    window_days: u16,
    frequencies: &[pass1::FrequencyRow],
) -> Result<(Vec<u8>, Option<u32>)> {
    use crate::csr::route_trips::build_route_trips_csr;
    use crate::csr::stop_routes::build_stop_routes_csr;
    use crate::interns::TRIP_RECORD_BYTES;

    let staging_region = |region: Region, len: u64| -> Result<&[u8]> {
        let off = layout.offset(region) as usize;
        let end = off + len as usize;
        if end > temporary_bytes.len() {
            return Err(Error::Config(format!(
                "current PTB staging region {region:?} [{off}..{end}] overruns temporary buffer ({})",
                temporary_bytes.len()
            )));
        }
        Ok(&temporary_bytes[off..end])
    };

    let num_stops = p1.stops.len();
    let num_routes = p1.routes.len();
    let num_trips = p1.trips.len();
    let num_services = p1.services.len();

    // Trips and service-bitmask staging regions are page-aligned; current PTB
    // consumes only their populated heads.
    let trips_len = num_trips as u64 * TRIP_RECORD_BYTES as u64;
    // `ceil(window_days/8)` B per service (matches `compute_service_bitmasks` +
    // `Layout::compute`, all via `pt_core::bytes_per_service`) — the buffer
    // we are re-slicing was written at the SAME derived `window_days`, so this
    // tight carry length is exact (the I6 invariant).
    let bitmasks_len = num_services as u64 * pt_core::bytes_per_service(window_days) as u64;
    // StopTimes / TripStarts / StringPool / Transfers region lengths are ALREADY
    // tight (exact, page-aligned ADVANCE only) — reuse them verbatim.
    let stop_times_len = layout.length(Region::StopTimes);
    let trip_starts_len = layout.length(Region::TripStarts);
    let string_pool_len = layout.length(Region::StringPool);
    let transfers_len = layout.length(Region::Transfers);

    // Recompute the packed length current PTB needs by re-deriving the four
    // arrays `flush_mid_pass_regions` packs back-to-back
    // (route_trips_offsets, route_trips_neighbors, stop_routes_offsets,
    // stop_routes_neighbors).
    let (rt_off, rt_neighbors) = build_route_trips_csr(&p1.trips_attrs, num_routes)?;
    let (sr_off, sr_neighbors) =
        build_stop_routes_csr(&p1.trip_stop_triples, &p1.trips_attrs, num_stops)?;
    let csr_len =
        (rt_off.len() + rt_neighbors.len() + sr_off.len() + sr_neighbors.len()) as u64 * 4;

    let trips = staging_region(Region::TripsIntern, trips_len)?;
    let service_bitmasks = staging_region(Region::ServiceBitmasks, bitmasks_len)?;
    let stop_times = staging_region(Region::StopTimes, stop_times_len)?;
    let trip_starts = staging_region(Region::TripStarts, trip_starts_len)?;
    let csr = staging_region(Region::Csr, csr_len)?;
    let string_pool = staging_region(Region::StringPool, string_pool_len)?;
    let transfers = staging_region(Region::Transfers, transfers_len)?;

    // Split the staging bitmask rows by the current window stride and deduplicate
    // them into the normative 0x15/0x16 pool representation.
    let bytes_per_service = pt_core::bytes_per_service(window_days);
    debug_assert!(
        layout.length(Region::ServiceBitmasks) as usize >= num_services * bytes_per_service,
        "staging ServiceBitmasks region length ({}) must cover the tight prefix \
         (numServices {num_services} * S {bytes_per_service})",
        layout.length(Region::ServiceBitmasks)
    );
    let masks: Vec<Vec<u8>> = if bytes_per_service == 0 {
        Vec::new()
    } else {
        service_bitmasks
            .chunks_exact(bytes_per_service)
            .map(<[u8]>::to_vec)
            .collect()
    };
    let (service_pool, service_to_bitfield_idx, service_pool_count) =
        crate::service::bitmask::dedup_service_bitfields(&masks);
    let service_to_bitfield: Vec<u8> = service_to_bitfield_idx
        .iter()
        .flat_map(|i| i.to_le_bytes())
        .collect();

    let bundle = crate::current_emit::build_current_bundle(
        p1.stops.keys(),
        &p1.stops_attrs,
        p1.routes.keys(),
        &p1.routes_attrs,
        &p1.stop_parent_map,
        pool,
        trips,
        stop_times,
        trip_starts,
        csr,
        string_pool,
        transfers,
        &p1.stop_time_boarding,
        &service_pool,
        &service_to_bitfield,
        service_pool_count,
        num_stops as u32,
        num_routes as u32,
        num_trips as u32,
        num_services as u32,
        p1.feed_start_date,
        city_tz_offset_seconds,
        window_days,
        frequencies,
    )?;
    Ok((bundle, Some(service_pool_count)))
}

/// Resolve the emitted `window_days` from the build anchor and the
/// feed's `max_end_date` horizon for the current PTB contract.
pub fn resolve_window(
    feed_start_date: u32,
    max_end_date: u32,
) -> crate::service::bitmask::WindowDerive {
    crate::service::bitmask::derive_window(feed_start_date, max_end_date)
}

/// Lowercase-hex SHA-256 — matches the validator + `gen-fixtures`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest.iter() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Resolve the city's UTC offset (seconds) to stamp into the PTB v1 header.
///
/// Priority:
/// 1. An explicit `--city-tz-offset-seconds` override (operator pins it).
/// 2. Computed via `pt_shared::tz::offset_at_anchor` — the shared helper that
///    pt-serve's T13 cross-check also calls, so both sides are structurally
///    coupled and must agree (otherwise every publish fails at load).
/// 3. 0 (UTC) when neither is supplied.
pub fn resolve_city_tz_offset(
    explicit: Option<i32>,
    iana: Option<&str>,
    feed_start_date: u32,
) -> Result<i32> {
    if let Some(secs) = explicit {
        return Ok(secs);
    }
    let Some(iana) = iana else {
        return Ok(0);
    };
    pt_shared::tz::offset_at_anchor(iana, feed_start_date).map_err(|e| match e {
        pt_shared::tz::TzOffsetError::UnknownIana => {
            Error::Config(format!("unknown IANA tz name: {iana:?}"))
        }
        pt_shared::tz::TzOffsetError::BadDate => {
            Error::Config(format!("bad feed_start_date: {feed_start_date}"))
        }
    })
}

/// Rejects any empty mandatory id. Mirrored from main.rs (the helper is
/// private there; duplicate here to keep main.rs intact while still
/// guarding the build pipeline).
fn validate_no_empty_ids<'a, I>(labeled_keys: I) -> Result<()>
where
    I: IntoIterator<Item = (&'a str, &'a [String])>,
{
    for (label, keys) in labeled_keys {
        if keys.iter().any(|k| k.is_empty()) {
            return Err(Error::Config(format!(
                "empty {label} in feed — PTB requires non-empty mandatory ids"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::resolve_city_tz_offset;

    #[test]
    fn resolve_tz_offset_explicit_wins() {
        assert_eq!(
            resolve_city_tz_offset(Some(7200), Some("Europe/Paris"), 20260501).unwrap(),
            7200
        );
    }

    #[test]
    fn resolve_tz_offset_computes_from_iana() {
        // Asia/Tbilisi is UTC+4 year-round (no DST) → 14400s.
        assert_eq!(
            resolve_city_tz_offset(None, Some("Asia/Tbilisi"), 20260501).unwrap(),
            14400
        );
    }

    #[test]
    fn resolve_tz_offset_defaults_to_zero() {
        assert_eq!(resolve_city_tz_offset(None, None, 20260501).unwrap(), 0);
    }

    #[test]
    fn resolve_tz_offset_rejects_bad_iana() {
        assert!(resolve_city_tz_offset(None, Some("Europe/Nowhere"), 20260501).is_err());
    }
}

#[cfg(test)]
mod build_outcome_tests {
    use super::*;
    use crate::download::FeedRecord;

    #[test]
    fn build_ptb_returns_parseable_departures_idx() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join("bundle.ptb");
        let extract = tmp.path().join("extract");
        let zip = std::path::PathBuf::from("tests/fixtures/tiny-gtfs.zip");
        let outcome = build_ptb(
            vec![FeedRecord {
                url: "test".into(),
                zip_path: zip,
                sha_hex: String::new(),
                etag: None,
            }],
            &extract,
            &bundle,
            Some(20260501),
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
        )
        .unwrap();
        assert!(!outcome.departures_idx_bytes.is_empty());
        // Recompute the namespace SHAs the same way build_ptb did and parse.
        // The sidecar header SHAs are validated by the round-trip test; here we
        // just assert the bytes carry the DPIX magic + a sane num_stops.
        let header =
            pt_shared::sidecar::parse_sidecar_header(&outcome.departures_idx_bytes, *b"DPIX")
                .unwrap();
        assert_eq!(header.version, 1);
    }

    #[test]
    fn build_ptb_returns_parseable_shapes_bin() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join("bundle.ptb");
        let extract = tmp.path().join("extract");
        let outcome = build_ptb(
            vec![FeedRecord {
                url: "test".into(),
                zip_path: std::path::PathBuf::from("tests/fixtures/tiny-gtfs.zip"),
                sha_hex: String::new(),
                etag: None,
            }],
            &extract,
            &bundle,
            Some(20260501),
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
        )
        .unwrap();
        // tiny-gtfs.zip carries no shapes.txt → empty (88-byte) but valid SHPB.
        let header =
            pt_shared::sidecar::parse_sidecar_header(&outcome.shapes_bin_bytes, *b"SHPB").unwrap();
        assert_eq!(header.version, 1);
        assert!(
            outcome.shapes_bin_bytes.len() >= 88,
            "never below SHPB minimum"
        );
    }

    /// End-to-end NON-empty path: build from a GTFS zip that DOES carry shapes.txt,
    /// then parse + decode the emitted shapes.bin and assert the coordinates match
    /// the feed. Without this, the whole build_ptb→encode pipeline was only ever
    /// exercised on the 0-shape (88-byte) case, so a non-empty encode regression
    /// would pass every integration test.
    #[test]
    fn build_ptb_shapes_bin_decodes_real_shapes() {
        use pt_shared::sidecar::ShapesBin;
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join("bundle.ptb");
        let extract = tmp.path().join("extract");
        let outcome = build_ptb(
            vec![FeedRecord {
                url: "test".into(),
                zip_path: std::path::PathBuf::from("tests/fixtures/tiny-gtfs-with-shapes.zip"),
                sha_hex: String::new(),
                etag: None,
            }],
            &extract,
            &bundle,
            Some(20260501),
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
        )
        .unwrap();
        // We don't have `p1` here to recompute the namespace SHAs build_ptb hashed,
        // so parse with the SHAs read from the file's own header — this still
        // exercises the full length/offset validation + varint decode (namespace-SHA
        // correctness is covered by the pt-shared unit tests).
        let header =
            pt_shared::sidecar::parse_sidecar_header(&outcome.shapes_bin_bytes, *b"SHPB").unwrap();
        let sb = ShapesBin::parse(
            &outcome.shapes_bin_bytes,
            &header.trips_intern_sha256,
            &header.stops_intern_sha256,
        )
        .expect("emitted shapes.bin must parse + decode");
        // Fixture shapes.txt has SH_A (3 pts) + SH_B (2 pts), sorted.
        assert_eq!(sb.num_shapes(), 2);
        assert_eq!(sb.lookup("SH_A"), Some(0));
        let a = sb.points(0);
        assert_eq!(a.len(), 3);
        // First point of SH_A is (54.6900, 25.2800) per the fixture.
        assert!((a[0].0 - 54.69).abs() < 1e-4 && (a[0].1 - 25.28).abs() < 1e-4);
    }

    // Boarding-semantics producer round trips. These exercise the full current
    // path from `stop_times.txt` through PatternSemantics. Parse the tagged
    // region table directly out of the emitted bytes (mirroring `pt_core`'s reader: 24 B
    // entries at header byte 32, regionId u16@+0, offset u64@+8, length u64@+16,
    // regionId 0 terminates) and apply the SAME `pickup_forbidden` predicate the
    // reader uses (`byte & 0b11 == 1`).

    /// Write a complete minimal single-trip GTFS feed (`s0→s1→s2`, one weekday
    /// service) to `dir` and zip it. `stop_times_body` is the full
    /// `stop_times.txt` contents (header + rows) so each test can vary the
    /// optional boarding columns.
    fn write_boarding_feed_zip(
        dir: &std::path::Path,
        name: &str,
        stop_times_body: &str,
    ) -> std::path::PathBuf {
        write_boarding_feed_zip_with_trips(
            dir,
            name,
            stop_times_body,
            "route_id,service_id,trip_id\nR1,WD,T1\n",
        )
    }

    fn write_boarding_feed_zip_with_trips(
        dir: &std::path::Path,
        name: &str,
        stop_times_body: &str,
        trips_body: &str,
    ) -> std::path::PathBuf {
        use std::io::Write;
        use zip::write::FileOptions;
        let path = dir.join(name);
        let f = std::fs::File::create(&path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts: FileOptions<'_, '_, ()> = FileOptions::default();
        let mut add = |fname: &str, body: &str| {
            zw.start_file(fname, opts).unwrap();
            zw.write_all(body.as_bytes()).unwrap();
        };
        add(
            "agency.txt",
            "agency_id,agency_name,agency_url,agency_timezone\nA,A,http://a,Europe/Vilnius\n",
        );
        add(
            "stops.txt",
            "stop_id,stop_name,stop_lat,stop_lon\n\
             s0,Zero,54.69,25.28\ns1,One,54.70,25.29\ns2,Two,54.71,25.30\n",
        );
        add(
            "routes.txt",
            "route_id,agency_id,route_short_name,route_type\nR1,A,1,3\n",
        );
        add("trips.txt", trips_body);
        add(
            "calendar.txt",
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
             WD,1,1,1,1,1,0,0,20260101,20271231\n",
        );
        add("stop_times.txt", stop_times_body);
        zw.finish().unwrap();
        path
    }

    /// Parse the tagged region table out of an emitted bundle, returning
    /// `(region_id, offset, length)` triples up to the `regionId == 0`
    /// terminator. Mirrors `pt_core`'s `header.rs` parse loop + the in-crate
    /// the emitter's unit-test parser.
    fn parse_region_table(buf: &[u8]) -> Vec<(u16, u64, u64)> {
        let mut out = Vec::new();
        let mut i = 0usize;
        loop {
            let e = 32 + i * 24;
            let region_id = u16::from_le_bytes(buf[e..e + 2].try_into().unwrap());
            if region_id == 0 {
                break;
            }
            let off = u64::from_le_bytes(buf[e + 8..e + 16].try_into().unwrap());
            let len = u64::from_le_bytes(buf[e + 16..e + 24].try_into().unwrap());
            out.push((region_id, off, len));
            i += 1;
        }
        out
    }

    /// A `pickup_type=1` row is preserved in the current pattern semantics and
    /// decodes to `pickup_forbidden` through `pt_core::Reader`.
    #[test]
    fn build_ptb_preserves_non_default_boarding_semantics() {
        let tmp = tempfile::tempdir().unwrap();
        // Single trip, 3 rows. s1 (row 1) is pickup_type=1 (alight-only).
        let zip = write_boarding_feed_zip(
            tmp.path(),
            "boarding.zip",
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type\n\
             T1,07:00:00,07:00:00,s0,1,0\n\
             T1,07:05:00,07:05:00,s1,2,1\n\
             T1,07:10:00,07:10:00,s2,3,0\n",
        );
        let bundle = tmp.path().join("bundle.ptb");
        let extract = tmp.path().join("extract");
        build_ptb(
            vec![FeedRecord {
                url: "test".into(),
                zip_path: zip,
                sha_hex: String::new(),
                etag: None,
            }],
            &extract,
            &bundle,
            Some(20260501),
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
        )
        .unwrap();

        let buf = std::fs::read(&bundle).unwrap();
        assert_eq!(&buf[0..4], b"PTB\0");
        assert_eq!(
            u16::from_le_bytes(buf[4..6].try_into().unwrap()),
            pt_core::PTB_VERSION_V1
        );
        let table = parse_region_table(&buf);
        assert!(table.iter().any(|(id, _, _)| *id == 0x12));
        assert!(!table.iter().any(|(id, _, _)| *id == 0xFA));

        let reader = pt_core::Reader::from_bytes(buf).expect("current PTB decodes");
        assert_eq!(reader.band_pickup_forbidden(0, 0), Some(false));
        assert_eq!(reader.band_pickup_forbidden(0, 1), Some(true));
        assert_eq!(reader.band_pickup_forbidden(0, 2), Some(false));
    }

    #[test]
    fn build_ptb_preserves_mixed_restrictions_on_identical_stop_sequences() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = write_boarding_feed_zip_with_trips(
            tmp.path(),
            "mixed.zip",
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n\
             T1,07:00:00,07:00:00,s0,1,0,0\n\
             T1,07:05:00,07:05:00,s1,2,0,0\n\
             T1,07:10:00,07:10:00,s2,3,0,0\n\
             T2,08:00:00,08:00:00,s0,1,0,0\n\
             T2,08:05:00,08:05:00,s1,2,1,1\n\
             T2,08:10:00,08:10:00,s2,3,0,0\n",
            "route_id,service_id,trip_id\nR1,WD,T1\nR1,WD,T2\n",
        );
        let bundle = tmp.path().join("bundle.ptb");
        build_ptb(
            vec![FeedRecord {
                url: "test".into(),
                zip_path: zip,
                sha_hex: String::new(),
                etag: None,
            }],
            &tmp.path().join("extract"),
            &bundle,
            Some(20260501),
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
        )
        .unwrap();
        let reader = pt_core::Reader::from_bytes(std::fs::read(bundle).unwrap()).unwrap();
        assert_eq!(reader.patterns().unwrap().len(), 2);
        assert_eq!(reader.band_pickup_forbidden(0, 1), Some(false));
        assert_eq!(reader.band_drop_off_forbidden(0, 1), Some(false));
        assert_eq!(reader.band_pickup_forbidden(1, 1), Some(true));
        assert_eq!(reader.band_drop_off_forbidden(1, 1), Some(true));
        assert_ne!(reader.trip_pattern_idx(0), reader.trip_pattern_idx(1));
        for mode in [
            pt_core::PatternMode::Off,
            pt_core::PatternMode::Unbounded,
            pt_core::PatternMode::CoveringMerge,
        ] {
            pt_core::Index::build(&reader, mode).unwrap();
        }
    }

    /// An all-default feed omits both temporary boarding carry and current
    /// PatternSemantics while remaining readable with default permissions.
    #[test]
    fn build_ptb_omits_boarding_semantics_when_all_default() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = write_boarding_feed_zip(
            tmp.path(),
            "default.zip",
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
             T1,07:00:00,07:00:00,s0,1\n\
             T1,07:05:00,07:05:00,s1,2\n\
             T1,07:10:00,07:10:00,s2,3\n",
        );
        let bundle = tmp.path().join("bundle.ptb");
        let extract = tmp.path().join("extract");
        build_ptb(
            vec![FeedRecord {
                url: "test".into(),
                zip_path: zip,
                sha_hex: String::new(),
                etag: None,
            }],
            &extract,
            &bundle,
            Some(20260501),
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
        )
        .unwrap();

        let buf = std::fs::read(&bundle).unwrap();
        let table = parse_region_table(&buf);
        assert!(
            !table.iter().any(|(id, _, _)| *id == 0xFA),
            "current PTB must not retain temporary boarding carry"
        );
        assert!(!table.iter().any(|(id, _, _)| *id == 0x12));
        let reader = pt_core::Reader::from_bytes(buf).expect("current PTB decodes");
        assert_eq!(reader.band_pickup_forbidden(0, 0), Some(false));
        assert_eq!(reader.band_pickup_forbidden(0, 1), Some(false));
        assert_eq!(reader.band_pickup_forbidden(0, 2), Some(false));
    }

    // Window-length emit round trips.
    // Full producer path: a feed with the given calendar/calendar_dates is built
    // with --anchor-date 20260501, the window derives, and we parse the emitted
    // table to assert on the `0x01 WindowMeta` region and the `0x15` service-pool
    // stride. The 0x01 anchor 20260501 yields the day-offsets in
    // the doc comments (computed via the shared JDN formula).

    /// Write a minimal single-trip feed (s0→s1→s2, service WD) with a
    /// caller-supplied `calendar.txt` body. `calendar_dates_body` is `Some(..)`
    /// to also write `calendar_dates.txt`, or `None` to omit it. `calendar_body`
    /// is `Some(..)` for a calendar.txt feed, `None` for a calendar_dates-only
    /// feed (no calendar.txt at all).
    fn write_window_feed_zip(
        dir: &std::path::Path,
        name: &str,
        calendar_body: Option<&str>,
        calendar_dates_body: Option<&str>,
    ) -> std::path::PathBuf {
        use std::io::Write;
        use zip::write::FileOptions;
        let path = dir.join(name);
        let f = std::fs::File::create(&path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts: FileOptions<'_, '_, ()> = FileOptions::default();
        let mut add = |fname: &str, body: &str| {
            zw.start_file(fname, opts).unwrap();
            zw.write_all(body.as_bytes()).unwrap();
        };
        add(
            "agency.txt",
            "agency_id,agency_name,agency_url,agency_timezone\nA,A,http://a,Europe/Vilnius\n",
        );
        add(
            "stops.txt",
            "stop_id,stop_name,stop_lat,stop_lon\n\
             s0,Zero,54.69,25.28\ns1,One,54.70,25.29\ns2,Two,54.71,25.30\n",
        );
        add(
            "routes.txt",
            "route_id,agency_id,route_short_name,route_type\nR1,A,1,3\n",
        );
        add("trips.txt", "route_id,service_id,trip_id\nR1,WD,T1\n");
        if let Some(cal) = calendar_body {
            add("calendar.txt", cal);
        }
        if let Some(cd) = calendar_dates_body {
            add("calendar_dates.txt", cd);
        }
        add(
            "stop_times.txt",
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
             T1,07:00:00,07:00:00,s0,1\n\
             T1,07:05:00,07:05:00,s1,2\n\
             T1,07:10:00,07:10:00,s2,3\n",
        );
        zw.finish().unwrap();
        path
    }

    /// Build the feed at `--anchor-date 20260501` and return current PTB bytes
    /// plus the outcome.
    fn build_window_bundle(
        zip: std::path::PathBuf,
        tmp: &std::path::Path,
    ) -> (Vec<u8>, BuildOutcome) {
        let bundle = tmp.join("bundle.ptb");
        let extract = tmp.join("extract");
        let outcome = build_ptb(
            vec![FeedRecord {
                url: "test".into(),
                zip_path: zip,
                sha_hex: String::new(),
                etag: None,
            }],
            &extract,
            &bundle,
            Some(20260501),
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
        )
        .unwrap();
        (std::fs::read(&bundle).unwrap(), outcome)
    }

    /// Find the tight service-bitfield stride from `0x15`: the region is a
    /// four-byte distinct-count prefix followed by `count × stride` bytes.
    fn service_pool_stride(table: &[(u16, u64, u64)], count: u64) -> u64 {
        let pool = table.iter().find(|(id, _, _)| *id == 0x15).unwrap();
        (pool.2 - 4) / count
    }

    /// A feed deriving EXACTLY 90 emits NO `0x01` region (omit-at-default) and
    /// the service-pool stride stays 12. end_date = anchor+76 (20260716): 76+14=90.
    #[test]
    fn build_ptb_omits_window_meta_at_default_90() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = write_window_feed_zip(
            tmp.path(),
            "w90.zip",
            Some(
                "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
                 WD,1,1,1,1,1,0,0,20260501,20260716\n",
            ),
            None,
        );
        let (buf, outcome) = build_window_bundle(zip, tmp.path());
        assert_eq!(outcome.window_days, 90);
        assert!(!outcome.window_clamped_high && !outcome.window_floored_low);
        let table = parse_region_table(&buf);
        assert!(
            !table.iter().any(|(id, _, _)| *id == 0x01),
            "window 90 must OMIT the 0x01 region (reader defaults to 90)"
        );
        assert_eq!(
            service_pool_stride(&table, 1),
            12,
            "stride stays ceil(90/8)=12"
        );
    }

    /// end_date = anchor+386 (20270522) ⇒ 386+14 = 400 EXACTLY ⇒ window 400,
    /// `0x01` present == 400, stride 50, NOT clamped (strict `>`). Also proves
    /// the agreement between the emitted 0x01 value and the 0x15 service-pool
    /// stride (8 * stride covers the window).
    #[test]
    fn build_ptb_emits_window_meta_400_no_clamp_and_strides_agree() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = write_window_feed_zip(
            tmp.path(),
            "w400.zip",
            Some(
                "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
                 WD,1,1,1,1,1,0,0,20260501,20270522\n",
            ),
            None,
        );
        let (buf, outcome) = build_window_bundle(zip, tmp.path());
        assert_eq!(outcome.window_days, 400);
        assert!(
            !outcome.window_clamped_high,
            "386+14=400 exactly → strict > → NOT clamped_high"
        );
        let table = parse_region_table(&buf);
        let wm = table
            .iter()
            .find(|(id, _, _)| *id == 0x01)
            .expect("window 400 must emit 0x01");
        let (off, len) = (wm.1 as usize, wm.2 as usize);
        assert_eq!(len, 4, "WindowMeta body is 4 bytes (u16 + reserved u16)");
        assert_eq!(off % 2, 0, "WindowMeta is 2-byte aligned (M10)");
        let emitted = u16::from_le_bytes(buf[off..off + 2].try_into().unwrap());
        assert_eq!(emitted, 400, "0x01 windowDays == 400");
        assert_eq!(
            u16::from_le_bytes(buf[off + 2..off + 4].try_into().unwrap()),
            0,
            "reserved u16 is zero"
        );
        // Agreement: emitted 0x01 value vs the actual service-pool stride.
        let stride = service_pool_stride(&table, 1);
        assert_eq!(stride, 50, "ceil(400/8) == 50");
        assert_eq!(
            (emitted as u64).div_ceil(8),
            stride,
            "emitted 0x01 windowDays must imply the same service-pool stride"
        );
    }

    /// end_date = anchor+500 (20270913) ⇒ 514 > 400 ⇒ window clamps to 400 and
    /// `window_clamped_high` is set.
    #[test]
    fn build_ptb_clamps_high_over_ceiling() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = write_window_feed_zip(
            tmp.path(),
            "wover.zip",
            Some(
                "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
                 WD,1,1,1,1,1,0,0,20260501,20270913\n",
            ),
            None,
        );
        let (buf, outcome) = build_window_bundle(zip, tmp.path());
        assert_eq!(outcome.window_days, 400);
        assert!(outcome.window_clamped_high, "514 > 400 → clamped_high");
        let table = parse_region_table(&buf);
        let wm = table.iter().find(|(id, _, _)| *id == 0x01).unwrap();
        assert_eq!(
            u16::from_le_bytes(buf[wm.1 as usize..wm.1 as usize + 2].try_into().unwrap()),
            400
        );
    }

    /// A STALE feed (end_date before the anchor) derives 90 and sets
    /// `window_floored_low`; NO 0x01 region.
    #[test]
    fn build_ptb_stale_feed_floors_low() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = write_window_feed_zip(
            tmp.path(),
            "wstale.zip",
            Some(
                "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
                 WD,1,1,1,1,1,0,0,20251101,20260101\n",
            ),
            None,
        );
        let (buf, outcome) = build_window_bundle(zip, tmp.path());
        assert_eq!(outcome.window_days, 90);
        assert!(
            outcome.window_floored_low,
            "end before anchor → floored_low"
        );
        let table = parse_region_table(&buf);
        assert!(!table.iter().any(|(id, _, _)| *id == 0x01));
    }

    /// DISCRIMINATING REMOVE: end_date = anchor+100 (20260809) plus a REMOVE at
    /// anchor+300 (20270225). maxEnd MUST be 20260809 (the REMOVE does NOT
    /// extend it) ⇒ horizon 100 ⇒ window 114, NOT 314. Proves exception_type==2
    /// is excluded from the horizon fold.
    #[test]
    fn build_ptb_remove_does_not_extend_horizon() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = write_window_feed_zip(
            tmp.path(),
            "wremove.zip",
            Some(
                "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
                 WD,1,1,1,1,1,0,0,20260501,20260809\n",
            ),
            // REMOVE far in the future — must NOT widen the window.
            Some("service_id,date,exception_type\nWD,20270225,2\n"),
        );
        let (buf, outcome) = build_window_bundle(zip, tmp.path());
        assert_eq!(
            outcome.window_days, 114,
            "maxEnd = end_date (REMOVE excluded) ⇒ 100+14 = 114, NOT 314"
        );
        let table = parse_region_table(&buf);
        let wm = table.iter().find(|(id, _, _)| *id == 0x01).unwrap();
        assert_eq!(
            u16::from_le_bytes(buf[wm.1 as usize..wm.1 as usize + 2].try_into().unwrap()),
            114
        );
        assert_eq!(service_pool_stride(&table, 1), 15, "ceil(114/8) == 15");
    }

    /// calendar_dates-ONLY feed (no calendar.txt): maxEnd comes purely from the
    /// ADD rows. ADD at anchor+386 (20270522) ⇒ window 400.
    #[test]
    fn build_ptb_calendar_dates_only_horizon_from_adds() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = write_window_feed_zip(
            tmp.path(),
            "wcdonly.zip",
            None, // NO calendar.txt
            // Two ADD rows; the later one (20270522) sets maxEnd. The anchor is
            // forced to 20260501 so the horizon is exactly 386.
            Some(
                "service_id,date,exception_type\n\
                 WD,20260601,1\n\
                 WD,20270522,1\n",
            ),
        );
        let (buf, outcome) = build_window_bundle(zip, tmp.path());
        assert_eq!(outcome.window_days, 400, "maxEnd from the latest ADD row");
        let table = parse_region_table(&buf);
        let wm = table.iter().find(|(id, _, _)| *id == 0x01).unwrap();
        assert_eq!(
            u16::from_le_bytes(buf[wm.1 as usize..wm.1 as usize + 2].try_into().unwrap()),
            400
        );
    }
}
