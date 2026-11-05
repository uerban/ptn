//! Route-major structural index, built ONCE via [`Index::build`] and reused across queries (perf
//! pin: "not per query"). The reader hands P2 region accessors, not the route-major view the scan
//! consumes; this module reconstructs it: the longest-trip canonical pattern, per-trip position→row
//! alignment, and `routes_at_stop`.
//!
//! Ported from `raptorIndex.ts` (`hydrate` trip-sort + `routesAtStop`) and `loadFromPtb.ts:408-458`
//! (canonicalisation). The invariants are called out inline.

use alloc::string::String;
use alloc::vec::Vec;
use hashbrown::{HashMap, HashSet};
use rustc_hash::FxBuildHasher;

use crate::engine::consts::DEP_SECS_NOT_SERVED;
use crate::engine::mode::{route_type_to_mode, Mode};
use crate::engine::EngineError;
use crate::records::TRANSFER_ABSENT;
use crate::Reader;

/// An applied GTFS `transfers.txt` rule held in [`Index::transfer_rules`] (and
/// the scoped maps), keyed by a tab-joined string — the SAME keys the TS
/// `RaptorIndex` maps use. Keying by string id (not a dense int) sidesteps the
/// stop-index-space mismatch the S1 spec calls out; the String key lets the
/// scan look up by `&str` with no per-lookup allocation. UNSCOPED rules
/// (stop→stop) live in `transfer_rules`; SCOPED rules in `transfer_rules_trip`
/// (trip→trip, most specific) and `transfer_rules_route` (route→route, S3).
/// `transfer_type` is the GTFS value; `min_transfer_secs` carries
/// `min_transfer_time` only when `transfer_type == 2`. Applied types: 3
/// (forbid), 2 (per-pair min), 1 (timed → per-pair floor 0, S2), 4 (in-seat →
/// floor 0 + transfer-count exclusion, S3), 5 (in-seat forbidden → normal floor,
/// a documented no-op, S3).
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct TransferRuleApplied {
    pub transfer_type: u8,
    /// `min_transfer_time` (seconds) when `transfer_type == 2`; else the
    /// [`TRANSFER_ABSENT`] sentinel (the scan only reads it for type 2 — types
    /// 1/3/4/5 do not consult it).
    pub min_transfer_secs: u32,
}

/// Stop-pair key for [`Index::transfer_rules`]: `"{from}\t{to}"`. Byte-identical
/// to the TS `transferRuleKey` so both engines look up the SAME key. A scan-side
/// reusable `String` buffer avoids per-lookup allocation (see `transfer_key_into`).
pub(crate) fn transfer_key_into(buf: &mut String, from_stop_id: &str, to_stop_id: &str) {
    buf.clear();
    buf.push_str(from_stop_id);
    buf.push('\t');
    buf.push_str(to_stop_id);
}

/// Trip-scoped key for [`Index::transfer_rules_trip`]:
/// `"{from_stop}\t{to_stop}\t{from_trip}\t{to_trip}"`. Byte-identical to the TS
/// `transferTripScopedKey` (S3) so both engines look up the SAME key — the
/// MOST-SPECIFIC same-stop board rule.
pub(crate) fn transfer_trip_scoped_key_into(
    buf: &mut String,
    from_stop_id: &str,
    to_stop_id: &str,
    from_trip_id: &str,
    to_trip_id: &str,
) {
    buf.clear();
    buf.push_str(from_stop_id);
    buf.push('\t');
    buf.push_str(to_stop_id);
    buf.push('\t');
    buf.push_str(from_trip_id);
    buf.push('\t');
    buf.push_str(to_trip_id);
}

/// Route-scoped key for [`Index::transfer_rules_route`]:
/// `"{from_stop}\t{to_stop}\t{from_route}\t{to_route}"`. Byte-identical to the
/// TS `transferRouteScopedKey` (S3); less specific than trip→trip, more specific
/// than the unscoped stop→stop rule.
pub(crate) fn transfer_route_scoped_key_into(
    buf: &mut String,
    from_stop_id: &str,
    to_stop_id: &str,
    from_route_id: &str,
    to_route_id: &str,
) {
    buf.clear();
    buf.push_str(from_stop_id);
    buf.push('\t');
    buf.push_str(to_stop_id);
    buf.push('\t');
    buf.push_str(from_route_id);
    buf.push('\t');
    buf.push_str(to_route_id);
}

/// Band coordinates for a band-built trip (B1.5-T2). The scan decodes a band
/// trip's times from `0x13 TripTimes` and boarding from `0x12 PatternSemantics`
/// instead of the flat `0xF4`/`0xFA` carry, addressed by these resolved-once
/// coordinates (the O(1) hot-path hoist).
///
/// **The CoveringMerge subtlety.** Under `Unbounded` the trip's band pattern IS
/// the route's pattern and `offset == 0`, so band-position == canonical-position.
/// Under `CoveringMerge` a route (a surviving pattern `H`) holds trips folded in
/// from OTHER band patterns `G`, each riding `H`'s canonical positions
/// `[offset, offset + |G|)`. The `0x13`/`0x12` bytes for such a trip live under
/// `G`'s OWN pattern ordinal at `G`'s OWN positions — so the band coords carry the
/// trip's band pattern (`slab`/`semantics_base`) and its `offset` into the route's
/// canonical, and the scan reads band-position `canonical_pos - offset`. This is
/// the exact inverse of [`build_one_index_route`]'s `pos = offset + i` flat-row
/// placement, so band decode == flat decode position-for-position.
#[derive(Debug, Clone, Copy)]
pub(crate) struct BandCoords {
    /// Resolved `0x13` slab for this trip's BAND pattern (not the route's pattern
    /// under a fold). Decodes dep/arr/served at a band position with O(1) math.
    pub slab: crate::reader::BandSlab,
    /// Resolved `0x12` base for this trip's BAND pattern, or `None` when that
    /// pattern is all-regular (every position regular). Decodes pickup/drop-off.
    pub semantics_base: Option<usize>,
    /// LOCAL trip index within `pattern_trips(band_pattern_idx)` — the `0x13`
    /// slab's trip-major row + the `0x46` ordinal for this trip. `u32` (not the
    /// `usize` of [`crate::reader::BandSlab`]'s offsets) for compactness on this
    /// per-trip struct, mirroring `trip_idx: u32` on [`RouteTrip`].
    pub local_t: u32,
    /// This trip's composed offset into the ROUTE's canonical `stop_ids`
    /// (`band_position = canonical_position - offset`). `0` under `Unbounded`.
    /// `u32` for the same per-trip compactness reason as `local_t`.
    pub offset: u32,
}

/// One trip on a route, position-aligned to the route's canonical pattern.
pub struct RouteTrip {
    pub trip_idx: u32,
    pub service_idx: u32,
    pub wheelchair_accessible: u8,
    pub bikes_allowed: u8,
    /// Position-aligned serve markers. For a FLAT-built trip these are StopTimes global row
    /// indices; `-1` = not served at that canonical position (skipped OR a present-but-sentinel-dep
    /// row) — the TS/`.ptb` `-1` port, and the scan reads times/boarding off these rows.
    ///
    /// For a BAND-built trip (`band.is_some()`, B1.5-T2) these are SERVE MARKERS,
    /// NOT rows: `pos` when the trip serves the canonical position, `-1` otherwise.
    /// The scan's `pos_to_row[pos] != -1` "does this trip serve here" guard stays
    /// structurally identical; only the time/boarding SOURCE moves to the band
    /// (`band_dep_at`/`band_arr_at`/`band_*_forbidden_at` via [`BandCoords`]).
    /// Length == `IndexRoute::stop_ids.len()` either way.
    pub pos_to_row: Vec<i32>,
    /// Present iff this trip is BAND-built (band path, `Unbounded`/`CoveringMerge`).
    /// `None` for every flat-built trip (`Off`, no-band) — those decode off
    /// `pos_to_row` rows exactly as before.
    pub(crate) band: Option<BandCoords>,
}

/// One route's canonical pattern + its position-aligned trips.
pub struct IndexRoute {
    pub route_idx: u32,
    /// Parent GTFS-route ordinal (into `reader.route()`). Equals `route_idx` when `PatternMode` is
    /// `Off`; under pattern-splitting `route_idx` is the pattern's slot in `Index.routes` while
    /// this always carries the bare GTFS route index.
    pub reader_route_idx: u32,
    pub route_type: u16,
    /// Canonical transit mode, derived once from `route_type` (spec A5). The
    /// scan excludes by this, never by re-parsing route_type.
    pub mode: Mode,
    /// Stop INDICES, the canonical longest-trip pattern in `stop_seq` order.
    /// Repeats preserved (a circular route legitimately revisits a stop — do
    /// NOT dedup; positions are what the scan indexes by).
    pub stop_ids: Vec<u32>,
    /// Stable-sorted by departure at canonical position 0 (a trip skipping
    /// position 0 has key `-1` and sorts FIRST).
    pub trips: Vec<RouteTrip>,
    /// Whether serving departures are non-decreasing in trip array order at
    /// EVERY canonical position (mirror of the TS `computeBoardSorted`, F1).
    /// Trips are sorted by departure at position 0, so this only fails when a
    /// trip overtakes another downstream (or a position-0-skipping trip sorts
    /// first with out-of-order downstream times). `true` gates the scan's
    /// O(stops + trips) canonical-hop board search; `false` keeps the legacy
    /// array-order scan. The flag only selects between two paths proven to
    /// produce identical output — a wrong `false` costs speed, never
    /// correctness.
    pub board_sorted: bool,
}

/// The route-major view, built once. `routes` is in `route_idx` order;
/// `routes_at_stop` mirrors the `.ptb` `stop→routes` CSR.
///
/// **Encapsulation (P3 handoff).** The public surface is [`Index::build`]
/// (construct once) + handing the `&Index` to [`crate::plan`]; the internal
/// route-major tables below are `pub(crate)` so only the in-crate scan and
/// reconstruction read them. External consumers (P3/P5, the emit harness) never
/// reach into the structural tables — they only build and pass the index.
pub struct Index {
    pub(crate) routes: Vec<IndexRoute>,
    /// stop index -> route indices touching it (from the `.ptb` stop→routes CSR).
    pub(crate) routes_at_stop: HashMap<u32, Vec<u32>, FxBuildHasher>,
    /// UNSCOPED GTFS `transfers.txt` rules keyed by the `"{from}\t{to}"`
    /// tab-joined stop-id string (mirror of the TS `transferRuleKey`). The scan
    /// applies `transfer_type` 3 (skip the edge / forbid same-stop re-board),
    /// 2 (per-pair min_transfer_time floor), and 1 (timed / guaranteed
    /// connection → per-pair floor 0, S2). Empty for a feed without transfers —
    /// the scan then behaves exactly as pre-S1. See [`TransferRuleApplied`].
    /// GTFS reference:
    /// https://gtfs.org/documentation/schedule/reference/#transferstxt
    pub(crate) transfer_rules: HashMap<String, TransferRuleApplied, FxBuildHasher>,
    /// TRIP-SCOPED rules (S3) keyed by `transfer_trip_scoped_key_into`
    /// (`"{from_stop}\t{to_stop}\t{from_trip}\t{to_trip}"`, mirror of the TS
    /// `transferTripScopedKey`). A row carrying BOTH `from_trip_id` AND
    /// `to_trip_id` lands here — the MOST-SPECIFIC scope; the scan consults it
    /// FIRST at a same-stop board (resolving the arriving trip from the parent
    /// transit leg). Empty for a feed without trip-scoped transfers.
    pub(crate) transfer_rules_trip: HashMap<String, TransferRuleApplied, FxBuildHasher>,
    /// ROUTE-SCOPED rules (S3) keyed by `transfer_route_scoped_key_into`
    /// (`"{from_stop}\t{to_stop}\t{from_route}\t{to_route}"`, mirror of the TS
    /// `transferRouteScopedKey`). A row carrying BOTH `from_route_id` AND
    /// `to_route_id` (and NOT trip-scoped) lands here — consulted AFTER the
    /// trip-scoped map misses, BEFORE the unscoped map.
    pub(crate) transfer_rules_route: HashMap<String, TransferRuleApplied, FxBuildHasher>,
    /// PTB v2 query-independent indices (explicit rule resolver, linked and
    /// derived continuations, event range). `Some` iff the bundle is v2; the
    /// three v1 string-keyed maps above stay empty then, because v2 transfer
    /// rows may omit stops and are interpreted only by `engine::v2`.
    pub(crate) v2: Option<alloc::boxed::Box<crate::engine::v2::V2Index>>,
}

/// Whether serving departures are non-decreasing in trip array order at every
/// canonical position (see [`IndexRoute::board_sorted`]). Mirror of the TS
/// `computeBoardSorted` — SAME definition over the SAME post-Pin-4 trip order:
/// walk trips in array order, track the last serving departure per position,
/// fail on any strict decrease. `-1` "not served" markers are ignored.
/// Called once per route at index build; the per-(trip,pos) reads go through
/// [`dep_secs_at`] so flat and band trips decode identically.
fn compute_board_sorted<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    num_positions: usize,
    trips: &[RouteTrip],
) -> Result<bool, EngineError> {
    let mut last_dep: Vec<i64> = alloc::vec![i64::MIN; num_positions];
    for trip in trips {
        for (pos, last) in last_dep.iter_mut().enumerate() {
            let dep = crate::engine::scan::dep_secs_at(reader, trip, pos)?;
            if dep == -1 {
                continue;
            }
            if dep < *last {
                return Ok(false);
            }
            *last = dep;
        }
    }
    Ok(true)
}

/// Build one `IndexRoute` from a given `canonical` stop-idx sequence and the
/// positions of its member trips within `sorted_rows`/`trip_idxs`.
///
/// Implements the VERBATIM Pin-3 (positions_by_stop) + per-trip alignment
/// (cursor loop, DEP_SECS_NOT_SERVED slot-consume) + Pin-4 dep-sort, as
/// parameterized on `canonical` and `member_pos`. The `route_idx` is the slot
/// this pattern will occupy in `routes` (caller captures before push); the
/// `reader_route_idx` is the GTFS route ordinal (== route_idx when Off).
///
/// `trip_idxs[member_pos[i]]` → `sorted_rows[member_pos[i]]` is the i-th member.
#[allow(clippy::too_many_arguments)]
fn build_one_index_route<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    // Same rationale as `build_flat`'s: on a carry-less a bare
    // `reader.stop_time(row)` is O(k + several p) per row, and this function reads
    // every row of every member trip. Delegates to `stop_time` unchanged on a
    // carry-bearing bundle.
    st_cursor: &crate::stop_time_cursor::StopTimeCursor,
    route_idx: u32,
    reader_route_idx: u32,
    route_type: u16,
    canonical: Vec<u32>,
    member_pos: &[usize],
    offsets: &[u32],
    sorted_rows: &[Vec<usize>],
    trip_idxs: &[u32],
    num_services: u32,
) -> Result<IndexRoute, EngineError> {
    debug_assert_eq!(
        member_pos.len(),
        offsets.len(),
        "member_pos and offsets must be parallel"
    );

    // Pin 3: stop_idx -> LIST of canonical positions (ascending). Lasso /
    // loop routes revisit a stop within ONE trip (canonical keeps the
    // repeat — Pin 2), so each occurrence must keep its own row. A
    // single-position map (last-write-wins) would leave the OUTBOUND
    // occurrence of every repeated stop unserved, making the stem
    // unboardable (Vilnius 6G). Mirrors ptbToBundleWire.ts /
    // loadFromPtb.ts. GTFS best-practices — check the canonical case:
    // https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
    // https://gtfs.org/documentation/schedule/schedule-best-practices/#loop-routes
    let mut positions_by_stop: HashMap<u32, Vec<u32>, FxBuildHasher> =
        HashMap::with_capacity_and_hasher(canonical.len(), FxBuildHasher);
    for (pos, &s) in canonical.iter().enumerate() {
        positions_by_stop.entry(s).or_default().push(pos as u32);
    }

    // Per-trip alignment. A NATIVE member (offset 0 — every member under
    // Off/Unbounded, and prefix folds under CoveringMerge) walks rows in
    // stop_seq order and assigns each to the NEXT unused canonical position for
    // its stop, via a per-trip cursor (NOT a lockstep walk — that desyncs on a
    // detour stop). A row whose dep_secs is the sentinel still CONSUMES its
    // occurrence slot (so downstream repeats stay aligned) but writes no row.
    //
    // A FOLDED member (CoveringMerge, offset k>0) is a shorter trip whose signature IS
    // `canonical[k.. k+rowcount]` by the fold predicate (a contiguous subsequence), so its i-th
    // stop_seq-sorted row lands at position k+i POSITIONALLY — NOT via the from-position-0 cursor,
    // which would re-seek to the FIRST occurrence of each stop and mis-place rows when `canonical`
    // repeats a stop. Positions [0,k) and [k+rowcount, canonical.len()) stay -1. MUST mirror
    // `emitWireRoute` in ptbToBundleWire.ts byte-for-byte.
    let mut trips: Vec<RouteTrip> = Vec::with_capacity(member_pos.len());
    for (idx, &mi) in member_pos.iter().enumerate() {
        let t = trip_idxs[mi];
        let offset = offsets[idx];
        let mut pos_to_row = alloc::vec![-1i32; canonical.len()];
        if offset > 0 {
            for (i, &row) in sorted_rows[mi].iter().enumerate() {
                let st = st_cursor.stop_time(reader, row)?;
                let pos = offset as usize + i;
                // Occurrence slot consumed; a sentinel-dep row keeps the -1.
                if st.dep_secs == DEP_SECS_NOT_SERVED {
                    continue;
                }
                pos_to_row[pos] = row as i32;
            }
        } else {
            let mut cursor: HashMap<u32, usize, FxBuildHasher> =
                HashMap::with_hasher(FxBuildHasher);
            for &row in &sorted_rows[mi] {
                let st = st_cursor.stop_time(reader, row)?;
                let positions = match positions_by_stop.get(&st.stop_idx) {
                    Some(p) => p,
                    None => continue, // stop not in canonical
                };
                let k = cursor.entry(st.stop_idx).or_insert(0);
                if *k >= positions.len() {
                    continue; // trip visits this stop more often than canonical
                }
                let pos = positions[*k];
                *k += 1;
                if st.dep_secs == DEP_SECS_NOT_SERVED {
                    continue; // occurrence consumed; slot stays -1
                }
                pos_to_row[pos as usize] = row as i32;
            }
        }
        let trip_rec = reader.trip(t as usize)?;
        if trip_rec.service_idx >= num_services {
            return Err(EngineError::Corrupt("trip.service_idx >= num_services"));
        }
        trips.push(RouteTrip {
            trip_idx: t,
            service_idx: trip_rec.service_idx,
            wheelchair_accessible: trip_rec.wheelchair_accessible,
            bikes_allowed: trip_rec.bikes_allowed,
            pos_to_row,
            band: None, // flat-built: decode off pos_to_row rows
        });
    }

    // Pin 4: stable sort by departure at canonical position 0. A trip
    // skipping position 0 has `pos_to_row[0] == -1` → key `-1` → sorts
    // FIRST (loadFromPtb.ts:455-458 maps the sentinel to -1). Decode the
    // key once, surfacing reader errors; then stable-sort. Do NOT assume
    // the write order is already departure-sorted.
    let mut keyed: Vec<(i64, RouteTrip)> = Vec::with_capacity(trips.len());
    for tr in trips {
        let key = match tr.pos_to_row.first().copied() {
            Some(-1) | None => -1i64,
            Some(row) => st_cursor.stop_time(reader, row as usize)?.dep_secs as i64,
        };
        keyed.push((key, tr));
    }
    keyed.sort_by_key(|(k, _)| *k); // stable
    let trips: Vec<RouteTrip> = keyed.into_iter().map(|(_, tr)| tr).collect();

    let board_sorted = compute_board_sorted(reader, canonical.len(), &trips)?;
    Ok(IndexRoute {
        route_idx,
        reader_route_idx,
        route_type,
        mode: route_type_to_mode(route_type),
        stop_ids: canonical,
        trips,
        board_sorted,
    })
}

/// Build one `IndexRoute` for the BAND path (B1.5-T2) — the load-CPU win that
/// B1.2 deferred. Unlike [`build_one_index_route`] this does NOT walk the flat
/// `0xF4` rows, sort them by `stop_seq`, or run the per-trip cursor: those exist
/// only to derive flat-row `pos_to_row`, which the scan no longer reads off the
/// band. Instead each member trip's times/boarding are decoded straight from
/// `0x13`/`0x12` ([`BandCoords`]), `pos_to_row` is a cheap SERVED MARKER, and the
/// Pin-4 dep-sort key comes from the band — keeping trip ORDER (and the
/// `pos_to_row[0]==-1`-sorts-first tie) byte-identical to the flat path.
///
/// `member_trip_idxs[i]` rides the route's canonical `[offsets[i], offsets[i] +
/// |its band pattern|)` window (composed offset, identical to the flat path's
/// `offsets`). Each trip's BAND pattern (`trip_pattern_idx`) + LOCAL index (its
/// position in `pattern_trips(band_pattern)`) is resolved here ONCE; under
/// `Unbounded` every member shares the route's pattern at offset 0, under
/// `CoveringMerge` folded members carry their own pattern + a positive offset.
#[allow(clippy::too_many_arguments)]
fn build_one_band_route<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    route_idx: u32,
    reader_route_idx: u32,
    route_type: u16,
    canonical: Vec<u32>,
    member_trip_idxs: &[u32],
    offsets: &[u32],
    num_services: u32,
    num_patterns: usize,
    band_slabs: &[crate::reader::BandSlab],
    band_semantics_bases: &[Option<usize>],
    trip_local_in_pattern: &[u32],
) -> Result<IndexRoute, EngineError> {
    debug_assert_eq!(
        member_trip_idxs.len(),
        offsets.len(),
        "member_trip_idxs and offsets must be parallel"
    );
    let n_pos = canonical.len();

    let mut trips: Vec<RouteTrip> = Vec::with_capacity(member_trip_idxs.len());
    for (idx, &t) in member_trip_idxs.iter().enumerate() {
        let offset = offsets[idx] as usize;
        // This trip's BAND pattern (NOT the route's surviving pattern under a
        // CoveringMerge fold) + its local trip index within that pattern.
        let band_pidx = match reader.trip_pattern_idx(t as usize) {
            Some(p) if (p as usize) < num_patterns => p as usize,
            _ => return Err(EngineError::Corrupt("0x14 trip pattern_idx out of range")),
        };
        let local_t = match trip_local_in_pattern.get(t as usize).copied() {
            Some(v) if v != u32::MAX => v as usize,
            _ => {
                return Err(EngineError::Corrupt(
                    "trip absent from precomputed 0x46 local-index table",
                ))
            }
        };
        let slab = match band_slabs.get(band_pidx).copied() {
            Some(s) => s,
            None => return Err(EngineError::Corrupt("0x13 slab unresolved (non-dense?)")),
        };
        if local_t >= slab.big_t
            || reader
                .pattern_trips(band_pidx)
                .and_then(|pt| pt.get(local_t))
                .copied()
                != Some(t)
        {
            return Err(EngineError::Corrupt(
                "trip absent from its 0x46 pattern slice",
            ));
        }
        // The folded window must fit the route's canonical positions.
        if offset.checked_add(slab.s).is_none_or(|end| end > n_pos) {
            return Err(EngineError::Corrupt(
                "band fold offset+len exceeds canonical",
            ));
        }
        let semantics_base = match band_semantics_bases.get(band_pidx).copied() {
            Some(base) => base,
            None => return Err(EngineError::Corrupt("0x12 semantics base missing")),
        };

        // SERVED-MARKER pos_to_row: `pos` when the trip serves canonical position
        // `pos` (i.e. its band pattern serves `pos - offset`), `-1` otherwise. The
        // scan's `pos_to_row[pos] != -1` guard stays structurally identical; the
        // time/boarding SOURCE is the band, addressed via `offset`.
        let mut pos_to_row = alloc::vec![-1i32; n_pos];
        for band_pos in 0..slab.s {
            let pos = offset + band_pos;
            if reader.band_served_at(&slab, local_t, band_pos) {
                pos_to_row[pos] = pos as i32;
            }
        }

        let trip_rec = reader.trip(t as usize)?;
        if trip_rec.service_idx >= num_services {
            return Err(EngineError::Corrupt("trip.service_idx >= num_services"));
        }
        trips.push(RouteTrip {
            trip_idx: t,
            service_idx: trip_rec.service_idx,
            wheelchair_accessible: trip_rec.wheelchair_accessible,
            bikes_allowed: trip_rec.bikes_allowed,
            pos_to_row,
            band: Some(BandCoords {
                slab,
                semantics_base,
                local_t: local_t as u32,
                offset: offset as u32,
            }),
        });
    }

    // Pin 4: stable sort by departure at canonical position 0 — from the BAND now
    // (the flat-row read is deleted). A trip not serving position 0 (its band
    // serve-marker at pos 0 is `-1`, e.g. every folded member, offset>0) keys `-1`
    // → sorts FIRST, exactly as the flat path's `pos_to_row[0]==-1` tie.
    let mut keyed: Vec<(i64, RouteTrip)> = Vec::with_capacity(trips.len());
    for tr in trips {
        let key = match (tr.pos_to_row.first().copied(), tr.band.as_ref()) {
            (Some(-1), _) | (None, _) => -1i64,
            (Some(_), Some(bc)) => reader.band_dep_at(&bc.slab, bc.local_t as usize, 0),
            // Unreachable: a band route's trips all carry `band`. Fall back to the
            // sorts-first key rather than panic.
            (Some(_), None) => -1i64,
        };
        keyed.push((key, tr));
    }
    keyed.sort_by_key(|(k, _)| *k); // stable
    let trips: Vec<RouteTrip> = keyed.into_iter().map(|(_, tr)| tr).collect();

    let board_sorted = compute_board_sorted(reader, canonical.len(), &trips)?;
    Ok(IndexRoute {
        route_idx,
        reader_route_idx,
        route_type,
        mode: route_type_to_mode(route_type),
        stop_ids: canonical,
        trips,
        board_sorted,
    })
}

/// THE symmetric-gate firewall (B1.2 cross-check oracle). The TS≡Rust
/// differential gate feeds the SAME band bytes to both engines, so it CANNOT
/// catch a band path that round-trips its own wrong grouping. This independent
/// oracle — built over the SAME bundle via the EXISTING flat path
/// ([`Index::build_flat`], which re-derives the grouping from the flat carry via
/// [`group_by_pattern`]) — asserts per-(route,pattern) STRUCTURAL equality of the
/// band-built index against the flat-built one: same pattern count, each
/// pattern's `stop_ids` + `reader_route_idx`, each trip's order + `trip_idx`, and
/// the whole `routes_at_stop` map (value-array order included).
///
/// **B1.5-T2 — value-equality, not raw rows.** The band path no longer derives
/// flat-row `pos_to_row` (it stores SERVED MARKERS + decodes times/boarding from
/// `0x13`/`0x12`), so a raw `pos_to_row == pos_to_row` compare would be
/// apples-to-oranges. Instead this oracle now asserts, per trip, that (a) the
/// SERVED PATTERN matches (`pos_to_row[p] != -1` ⇔ flat served) — THE crux, the
/// global→local member mapping lands here — AND (b) the band-built trip's
/// DECODED dep/arr/boarding equal the flat-built trip's at every served position.
/// That is strictly STRONGER than the old row compare: it catches a band that
/// decodes a wrong VALUE even when the served set happens to match. A mismatch
/// panics with the diverging pattern/trip/position.
/// `cfg(feature = "pattern-crosscheck")` only — never compiled into a normal build.
#[cfg(feature = "pattern-crosscheck")]
fn assert_band_matches_flat<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    band: &Index,
    flat: &Index,
) {
    use crate::engine::scan::{
        alight_secs_at, dep_secs_at, drop_off_forbidden_at, pickup_forbidden_at,
    };
    assert_eq!(
        band.routes.len(),
        flat.routes.len(),
        "pattern-crosscheck: route count band={} flat={}",
        band.routes.len(),
        flat.routes.len(),
    );
    for (pidx, (b, f)) in band.routes.iter().zip(flat.routes.iter()).enumerate() {
        assert_eq!(
            b.reader_route_idx, f.reader_route_idx,
            "pattern-crosscheck: pattern {pidx} reader_route_idx band={} flat={}",
            b.reader_route_idx, f.reader_route_idx,
        );
        assert_eq!(
            b.route_idx, f.route_idx,
            "pattern-crosscheck: pattern {pidx} route_idx band={} flat={}",
            b.route_idx, f.route_idx,
        );
        assert_eq!(
            b.stop_ids, f.stop_ids,
            "pattern-crosscheck: pattern {pidx} stop_ids band={:?} flat={:?}",
            b.stop_ids, f.stop_ids,
        );
        assert_eq!(
            b.trips.len(),
            f.trips.len(),
            "pattern-crosscheck: pattern {pidx} trip count band={} flat={}",
            b.trips.len(),
            f.trips.len(),
        );
        for (ti, (bt, ft)) in b.trips.iter().zip(f.trips.iter()).enumerate() {
            assert_eq!(
                bt.trip_idx, ft.trip_idx,
                "pattern-crosscheck: pattern {pidx} trip slot {ti} trip_idx band={} flat={} (trip ORDER diverged)",
                bt.trip_idx, ft.trip_idx,
            );
            // (a) SERVED PATTERN equality — the global→local member mapping (band's
            // served-marker `pos_to_row` vs the flat path's row indices). Compare
            // served-or-not per position, NOT the raw values (band markers != rows).
            assert_eq!(
                bt.pos_to_row.len(),
                ft.pos_to_row.len(),
                "pattern-crosscheck: pattern {pidx} trip {} pos_to_row LEN band={} flat={}",
                bt.trip_idx,
                bt.pos_to_row.len(),
                ft.pos_to_row.len(),
            );
            for (pos, (br, fr)) in bt.pos_to_row.iter().zip(ft.pos_to_row.iter()).enumerate() {
                assert_eq!(
                    *br != -1, *fr != -1,
                    "pattern-crosscheck: pattern {pidx} trip {} pos {pos} served band={} flat={} (global→local MIS-MAP)",
                    bt.trip_idx, *br != -1, *fr != -1,
                );
                // (b) DECODED-VALUE equality per served position: band 0x13/0x12 vs
                // flat 0xF4/0xFA, the actual invariant the live scan depends on.
                if *fr != -1 {
                    assert_eq!(
                        dep_secs_at(reader, bt, pos).expect("band dep"),
                        dep_secs_at(reader, ft, pos).expect("flat dep"),
                        "pattern-crosscheck: pattern {pidx} trip {} pos {pos} DEP band!=flat",
                        bt.trip_idx,
                    );
                    assert_eq!(
                        alight_secs_at(reader, bt, pos).expect("band arr"),
                        alight_secs_at(reader, ft, pos).expect("flat arr"),
                        "pattern-crosscheck: pattern {pidx} trip {} pos {pos} ARR band!=flat",
                        bt.trip_idx,
                    );
                    assert_eq!(
                        pickup_forbidden_at(reader, bt, pos),
                        pickup_forbidden_at(reader, ft, pos),
                        "pattern-crosscheck: pattern {pidx} trip {} pos {pos} PICKUP band!=flat",
                        bt.trip_idx,
                    );
                    assert_eq!(
                        drop_off_forbidden_at(reader, bt, pos),
                        drop_off_forbidden_at(reader, ft, pos),
                        "pattern-crosscheck: pattern {pidx} trip {} pos {pos} DROPOFF band!=flat",
                        bt.trip_idx,
                    );
                }
            }
            assert_eq!(
                (bt.service_idx, bt.wheelchair_accessible, bt.bikes_allowed),
                (ft.service_idx, ft.wheelchair_accessible, ft.bikes_allowed),
                "pattern-crosscheck: pattern {pidx} trip {} meta diverged",
                bt.trip_idx,
            );
        }
    }
    // routes_at_stop: key set + per-stop value array (ORDER included).
    assert_eq!(
        band.routes_at_stop.len(),
        flat.routes_at_stop.len(),
        "pattern-crosscheck: routes_at_stop key count band={} flat={}",
        band.routes_at_stop.len(),
        flat.routes_at_stop.len(),
    );
    for (s, bv) in &band.routes_at_stop {
        let fv = flat.routes_at_stop.get(s).unwrap_or_else(|| {
            panic!("pattern-crosscheck: stop {s} in band routes_at_stop but not flat")
        });
        assert_eq!(
            bv, fv,
            "pattern-crosscheck: stop {s} routes_at_stop band={bv:?} flat={fv:?} (value-array order)",
        );
    }
}

impl Index {
    /// Every trip's vehicle boundary `(initial_stop, terminal_stop)`: the stops
    /// of its first and last served canonical positions (its first and last
    /// `stop_times` rows), indexed by trip ordinal. `None` for a trip outside
    /// the routing index.
    pub fn trip_boundary_stops(&self, num_trips: usize) -> Vec<Option<(u32, u32)>> {
        let mut out = alloc::vec![None; num_trips];
        for route in &self.routes {
            for rt in &route.trips {
                let served = |p: &usize| rt.pos_to_row.get(*p).copied().unwrap_or(-1) != -1;
                let (Some(first), Some(last)) = (
                    (0..route.stop_ids.len()).find(served),
                    (0..route.stop_ids.len()).rev().find(served),
                ) else {
                    continue;
                };
                if let Some(slot) = out.get_mut(rt.trip_idx as usize) {
                    if slot.is_none() {
                        *slot = Some((route.stop_ids[first], route.stop_ids[last]));
                    }
                }
            }
        }
        out
    }

    /// PTB v2 encoded event range `(min, max)` in GTFS seconds (every scheduled
    /// time plus every frequency shift); `None` for a v1 index.
    pub fn v2_event_range(&self) -> Option<(i64, i64)> {
        self.v2.as_ref().map(|v| v.event_range())
    }

    /// Build the route-major index from `reader` under `mode`.
    ///
    /// **B1.2 dispatch + B1.5-T2 scan cutover.** A bundle that carries the
    /// pattern band reads its GROUPING from the band (`0x10`/`0x11`/`0x14`/`0x45`)
    /// instead of re-running [`group_by_pattern`] over the flat carry. As of
    /// B1.5-T2 the band path ALSO reads TIMES from `0x13 TripTimes` and BOARDING
    /// from `0x12 PatternSemantics` ([`build_one_band_route`] + the band branch in
    /// [`crate::engine::scan::dep_secs_at`] / `alight_secs_at` / `*_forbidden_at`),
    /// so it NO LONGER walks the flat `0xF4`/`0xFA` rows: the per-trip `stop_seq`
    /// sort + flat-row cursor are DELETED (the load-CPU win B1.2 deferred).
    ///
    /// The band path is taken ONLY when `pattern_band_present() && mode != Off`.
    /// `Off` stays flat (a single longest-canonical route per GTFS route — it
    /// doesn't use the per-pattern split; band-`Off` is a later task). A bundle
    /// without the band OR `Off` takes the flat path.
    ///
    /// `Off` on a CARRY-LESS therefore lands in [`Self::build_flat`], which is
    /// supported: `trip_starts` and the route→trips CSR are synthesized by the
    /// reader, `stop_time` routes through the band, and the `Off` branch of Pin 5
    /// derives `routes_at_stop` rather than reading the stripped `0xF6`. Until that
    /// last piece existed the combination failed with a bare `SliceOutOfBounds`,
    /// unnoticed because every capture, gate and deploy runs `covering-merge`.
    ///
    /// Under `cfg(feature = "pattern-crosscheck")` the band path ALSO builds the
    /// flat path over the SAME bytes and asserts per-(route,pattern) structural +
    /// DECODED-VALUE equality — the symmetric-gate firewall (see
    /// [`assert_band_matches_flat`]).
    pub fn build<B: AsRef<[u8]> + Send + Sync + 'static>(
        reader: &Reader<B>,
        mode: crate::engine::patterns::PatternMode,
    ) -> Result<Index, EngineError> {
        Self::build_with(reader, mode, true)
    }

    /// [`Index::build`] with the PTB v2 `0x19` commitment check optional:
    /// `verify_v2 = false` only for the producer/fixture path that recomputes
    /// the commitment it is about to write.
    pub(crate) fn build_with<B: AsRef<[u8]> + Send + Sync + 'static>(
        reader: &Reader<B>,
        mode: crate::engine::patterns::PatternMode,
        verify_v2: bool,
    ) -> Result<Index, EngineError> {
        let take_band =
            reader.pattern_band_present() && mode != crate::engine::patterns::PatternMode::Off;
        let mut index = if take_band {
            let band_index = Self::build_from_band(reader, mode)?;
            #[cfg(feature = "pattern-crosscheck")]
            {
                let flat_index = Self::build_flat(reader, mode)?;
                assert_band_matches_flat(reader, &band_index, &flat_index);
            }
            band_index
        } else {
            Self::build_flat(reader, mode)?
        };
        if reader.is_v2() {
            index.v2 = Some(alloc::boxed::Box::new(crate::engine::v2::V2Index::build(
                reader, &index, verify_v2,
            )?));
        }
        Ok(index)
    }

    /// The flat path (pre-B1.2): one RAPTOR route per GTFS route under `Off`
    /// (longest-trip canonical), one per distinct stop-index signature under
    /// `Unbounded`/`CoveringMerge` (derived by [`group_by_pattern`] over the flat
    /// `0xF4` carry). UNCHANGED from the pre-band engine; the dispatcher in
    /// [`Index::build`] routes here for no-band or `Off`. Also called
    /// EXPLICITLY by the `pattern-crosscheck` oracle on a band bundle to
    /// cross-check the band path's output, and by the `pattern_emit` cursor-parity
    /// cross-check + the B1.5-T1 band-decode oracle (both need real flat-row
    /// `pos_to_row` for the reference, since the band path now stores served
    /// markers). `pub(crate)` for those in-crate cross-checks.
    pub(crate) fn build_flat<B: AsRef<[u8]> + Send + Sync + 'static>(
        reader: &Reader<B>,
        mode: crate::engine::patterns::PatternMode,
    ) -> Result<Index, EngineError> {
        let trip_starts = reader.trip_starts()?; // &[u32], len num_trips+1
        let num_routes = reader.num_routes();
        let num_stops = reader.num_stops();
        let num_trips = reader.num_trips();
        let num_stop_time_rows = reader.num_stop_times();

        // Read every row through the cursor rather than `reader.stop_time(row)`.
        // On a carry-BEARING bundle it delegates straight to `stop_time`, so those
        // paths are byte- and cost-identical. On a carry-less each bare
        // `stop_time` re-derives the band addressing from scratch — an O(k) scan of
        // the pattern's trip list plus several O(p) slab prefix walks, per row — and
        // this function reads every row of every trip TWICE (the Pin-1 sort pass,
        // then Pin 2's canonical pass). That is the same quadratic that made a paris
        // cold load spend 321 s of 366 s in `build_stop_membership`; measured here,
        // a real 388k-trip carry-less paris bundle did not finish `Off` in 10 min.
        let cursor = crate::stop_time_cursor::StopTimeCursor::new(reader)?;

        // Pin 6: validate the cross-region invariants P1 left to the consumer
        // (P1 mirrors loader.ts, which enforces neither). Reject malformed input
        // up front rather than indexing out of bounds mid-scan.
        let num_services = reader.num_services(); // u32; trips index into the bitmask array

        if trip_starts.len() != num_trips + 1 {
            return Err(EngineError::Corrupt("tripStarts length != num_trips + 1"));
        }
        let mut prev = 0u32;
        for &b in trip_starts {
            if b < prev {
                return Err(EngineError::Corrupt("tripStarts not monotonic"));
            }
            prev = b;
        }
        if trip_starts[num_trips] as usize > num_stop_time_rows {
            return Err(EngineError::Corrupt(
                "tripStarts last entry exceeds StopTimes rows",
            ));
        }

        let mut routes = Vec::with_capacity(num_routes);

        for r in 0..num_routes {
            let route_rec = reader.route(r)?;
            let trip_idxs = reader.route_trips(r)?;

            // Pin 1: pre-sort each trip's rows by stop_seq. The writer stores
            // rows in CSV/storage order, NOT by stop_sequence; the TS reference
            // (loadFromPtb.ts:420) explicitly `.sort((a,b)=>a.seq-b.seq)`. We
            // also run Pin 6's `stop_idx < num_stops` check here — the single
            // pass that touches every row of every trip on the route.
            //
            // When mode.enabled(), also capture each trip's stop_idx sequence (the pattern
            // signature) HERE — zero extra reader.stop_time reads beyond what Pin 1 already
            // performs (forbids a second walk).
            let mut sorted_rows: Vec<Vec<usize>> = Vec::with_capacity(trip_idxs.len());
            // sigs[i] is trip trip_idxs[i]'s stop_idx sequence in stop_seq order (full row sequence
            // INCLUDING sentinel-dep rows — corrected). Only populated when mode.enabled(); stays
            // empty under Off.
            let mut sigs: Vec<Vec<u32>> = if mode.enabled() {
                Vec::with_capacity(trip_idxs.len())
            } else {
                Vec::new()
            };
            let mut boarding_sigs = (mode.enabled()
                && (reader.has_boarding() || reader.has_pattern_semantics()))
            .then(|| Vec::with_capacity(trip_idxs.len()));

            for &t in trip_idxs {
                let lo = trip_starts[t as usize] as usize;
                let hi = trip_starts[t as usize + 1] as usize;
                let mut keyed: Vec<(u16, usize, u32)> = Vec::with_capacity(hi.saturating_sub(lo));
                for (pos, row) in (lo..hi).enumerate() {
                    let st = cursor.stop_time_in_trip(reader, t as usize, pos)?;
                    if st.stop_idx as usize >= num_stops {
                        return Err(EngineError::Corrupt("stop_time.stopIdx >= num_stops"));
                    }
                    keyed.push((st.stop_seq, row, st.stop_idx));
                }
                keyed.sort_by_key(|(seq, _, _)| *seq); // stable
                if mode.enabled() {
                    // Capture signature (sorted stop_idx sequence) during this pass.
                    sigs.push(keyed.iter().map(|(_, _, sidx)| *sidx).collect());
                    if let Some(bytes) = boarding_sigs.as_mut() {
                        bytes.push(
                            keyed
                                .iter()
                                .map(|(_, row, _)| reader.boarding_byte(*row) & 0x0F)
                                .collect(),
                        );
                    }
                }
                sorted_rows.push(keyed.into_iter().map(|(_, row, _)| row).collect());
            }

            if mode.enabled() {
                // Unbounded (and CoveringMerge): group trips by their signature.
                // Each group becomes its own IndexRoute with reader_route_idx = r.
                let groups = if let Some(boarding) = boarding_sigs.as_deref() {
                    crate::engine::patterns::group_by_pattern_with_boarding(
                        trip_idxs,
                        &sigs,
                        Some(boarding),
                        mode,
                    )
                } else {
                    crate::engine::patterns::group_by_pattern(trip_idxs, &sigs, mode)
                };
                for g in groups {
                    let route_idx = routes.len() as u32;
                    routes.push(build_one_index_route(
                        reader,
                        &cursor,
                        route_idx,
                        r as u32,
                        route_rec.route_type,
                        g.stop_idxs,
                        &g.member_pos,
                        &g.offsets,
                        &sorted_rows,
                        trip_idxs,
                        num_services,
                    )?);
                }
            } else {
                // Off: Pin 2 — canonical = the longest trip's stop-index sequence
                // (in stop_seq order). Tie-break: first in route_trips order wins
                // (strict `>`), matching loadFromPtb.ts. Repeats preserved.
                let mut canonical: Vec<u32> = Vec::new();
                for rows in &sorted_rows {
                    if rows.len() > canonical.len() {
                        let mut seq = Vec::with_capacity(rows.len());
                        for &row in rows {
                            seq.push(cursor.stop_time(reader, row)?.stop_idx);
                        }
                        canonical = seq;
                    }
                }

                let all_pos: Vec<usize> = (0..trip_idxs.len()).collect();
                // Off: every member is native → offset 0 (positional fold path
                // never triggers; alignment is byte-identical to pre-Phase-5).
                let zero_offsets: Vec<u32> = alloc::vec![0u32; trip_idxs.len()];
                let route_idx = routes.len() as u32; // == r as u32 under Off (one per GTFS route)
                routes.push(build_one_index_route(
                    reader,
                    &cursor,
                    route_idx,
                    r as u32,
                    route_rec.route_type,
                    canonical,
                    &all_pos,
                    &zero_offsets,
                    &sorted_rows,
                    trip_idxs,
                    num_services,
                )?);
            }
        }

        // Pin 5: routes_at_stop. Off, carry-BEARING: straight from the stop→routes CSR (no
        // direction-sibling fold — that is a frontend concern absent from.ptb; the adapter mirrors
        // this). Off, carry-LESS: derived from `routes`, because `0xF6` is stripped — see the note
        // below on why that is the same table. Enabled: re-derive from each pattern's own stop_ids
        // → pattern index, in routes order (enumeration). Dedup per stop: a repeated/loop stop
        // touches its pattern once.
        //
        // ## Why the derivation IS the CSR under Off
        //
        // `build_stop_routes_csr` (`crates/pt-producer/src/csr/stop_routes.rs`)
        // lists route `r` at stop `s` iff `s` is on `r`'s CANONICAL trip — the
        // longest by row count, ties to the lowest trip ordinal — with the
        // per-stop value array sorted and deduped.
        //
        // Under `Off` this loop walks the same thing from the other end. Pin 2
        // above picked each route's canonical by exactly that rule (strict `>`
        // over `sorted_rows`, which are in `route_trips` = ascending-ordinal
        // order) and stored it verbatim as `IndexRoute::stop_ids`, and `Off`
        // emits one route per GTFS route so `pidx == r`. Walking `pidx`
        // ascending therefore appends route ordinals to each stop in ascending
        // order, and the per-route `seen` set collapses a canonical's repeated
        // stops (loop/lasso) exactly as the producer's `sort_unstable` + `dedup`
        // does. Same rule, same order, same bytes as the producer's CSR.
        // `off_routes_at_stop_derivation_matches_the_band` checks it against the
        // band's own membership on committed producer output. Hand-built
        // fixtures whose CSR listed every trip's stops (not just the
        // canonical's) are not a reference for this table.
        //
        // The reader synthesizes `trip_starts` and the route→trips CSR for a
        // carry-less bundle but not stop→routes, and `Index::build` routes every
        // `Off` build here (the band is taken only when `mode != Off`). Reading
        // the stripped `0xF6` would fail with `SliceOutOfBounds`, so this
        // derivation is what makes `Off` work on carry-less bundles.
        //
        // Deriving only when the carry is absent keeps carry-bearing bundles on
        // the exact bytes they have always read.
        let mut routes_at_stop: HashMap<u32, Vec<u32>, FxBuildHasher> =
            HashMap::with_capacity_and_hasher(num_stops, FxBuildHasher);
        if mode.enabled() || reader.is_carry_less_band() {
            for (pidx, route) in routes.iter().enumerate() {
                let mut seen: HashSet<u32, FxBuildHasher> = HashSet::with_hasher(FxBuildHasher);
                for &s in &route.stop_ids {
                    if seen.insert(s) {
                        routes_at_stop.entry(s).or_default().push(pidx as u32);
                    }
                }
            }
        } else {
            for s in 0..num_stops {
                let rs = reader.stop_routes(s)?;
                if !rs.is_empty() {
                    routes_at_stop.insert(s as u32, rs.to_vec());
                }
            }
        }

        let (transfer_rules, transfer_rules_trip, transfer_rules_route) = if reader.is_v2() {
            Default::default()
        } else {
            Self::hydrate_transfers(reader, num_stops, num_trips, num_routes)?
        };

        Ok(Index {
            routes,
            routes_at_stop,
            transfer_rules,
            transfer_rules_trip,
            transfer_rules_route,
            v2: None,
        })
    }

    /// The BAND path: read the per-route pattern GROUPING from the band
    /// (`0x14 TripMeta.pattern_idx` + `0x11 PatternStops` + `0x45 PatternsAtStop`)
    /// INSTEAD of re-running [`group_by_pattern`] over the flat carry, and (B1.5-T2)
    /// build each route's trips via [`build_one_band_route`] — which decodes TIMES
    /// from `0x13` + BOARDING from `0x12` and stores a SERVED-MARKER `pos_to_row`,
    /// NOT flat-row indices. The flat `0xF4` `stop_seq` sort + per-trip cursor are
    /// GONE (the load-CPU win B1.2 deferred). Only `Unbounded`/`CoveringMerge`
    /// reach here (the dispatcher keeps `Off` flat).
    ///
    /// **Global→local member mapping (the highest-risk piece).** The band gives
    /// each trip a GLOBAL `pattern_idx` (`0x14`). Per GTFS route `r` we iterate
    /// `route_trips(r)` (the LOCAL order), read each trip's `pattern_idx`, and group
    /// BY that idx PRESERVING `route_trips` order — exactly the grouping
    /// `group_by_pattern(.., Unbounded)` would produce (first-appearance order,
    /// members in input order). [`build_one_band_route`] then re-resolves each
    /// member's BAND coordinates (its own pattern's `0x13` slab + local trip index)
    /// and re-sorts by Pin-4 (the `0x13`-decoded dep at pos 0), so the
    /// `pos_to_row[0]==-1`-sorts-first tie and the lasso repeated-stop alignment
    /// survive unchanged.
    ///
    /// `Index.routes` is built in GLOBAL `pattern_idx` order (0..num_patterns)
    /// under `Unbounded`, which equals the `0x10` enumeration order, so the `0x45`
    /// ordinals are valid `routes` indices (consumed verbatim for `routes_at_stop`).
    /// Under `CoveringMerge` the per-route Unbounded groups are folded by
    /// [`covering_merge_fold`] (identical input to the flat path), collapsing
    /// patterns, so `routes` is NO LONGER 1:1 with `0x10` — `routes_at_stop` is
    /// then re-derived from the surviving patterns' `stop_ids` (same as flat),
    /// NOT from the stale-for-fold `0x45`.
    fn build_from_band<B: AsRef<[u8]> + Send + Sync + 'static>(
        reader: &Reader<B>,
        mode: crate::engine::patterns::PatternMode,
    ) -> Result<Index, EngineError> {
        use crate::engine::patterns::{covering_merge_fold, PatternGroup, PatternMode};
        debug_assert!(
            mode != PatternMode::Off,
            "band path is Unbounded/CoveringMerge"
        );

        // The `0x13` RAGGED variant (entryFlags bit0) is unsupported. As of the
        // i32-delta fix this is UNREACHABLE in practice — `resolve_pattern_band`
        // (the load-time band gate) now rejects ANY non-bit1 flag, so a ragged
        // `0x13` fails at `Reader::from_bytes` and `pattern_band` is never `Some`
        // here. Kept as cheap defense-in-depth (a future caller that hands us a
        // band-bearing reader built some other way still fails closed). The
        // `i32`-DELTA variant (bit1, the intercity / Paris on-ramp) IS supported —
        // the band decoders (`band_dep_at`/`band_arr_at` via `band_trip_times_slab`)
        // read the wide deltas at `BandSlab::delta_bytes`, so the band route builds
        // with no further change here. See the i32-delta design spec.
        if reader.trip_times_is_ragged() == Some(true) {
            return Err(EngineError::Corrupt("0x13 ragged TripTimes unsupported"));
        }

        let trip_starts = reader.trip_starts()?; // &[u32], len num_trips+1
        let num_routes = reader.num_routes();
        let num_stops = reader.num_stops();
        let num_trips = reader.num_trips();
        let num_stop_time_rows = reader.num_stop_times();
        let num_services = reader.num_services();
        let num_patterns = match reader.patterns() {
            Some(p) => p.len(),
            None => return Err(EngineError::Corrupt("pattern band absent on band path")),
        };
        let band_slabs = reader
            .band_trip_times_slabs()
            .ok_or(EngineError::Corrupt("0x13 slab precompute failed"))?;
        if band_slabs.len() != num_patterns {
            return Err(EngineError::Corrupt("0x13 slab count != num_patterns"));
        }
        let band_semantics_bases = reader
            .band_semantics_bases()
            .ok_or(EngineError::Corrupt("0x12 semantics precompute failed"))?;
        if band_semantics_bases.len() != num_patterns {
            return Err(EngineError::Corrupt(
                "0x12 semantics base count != num_patterns",
            ));
        }

        // Trip-local ordinals within each `0x46 PatternTrips` slice. The old
        // per-trip `pat_trips.iter().position(|x| x == t)` made this
        // `Σ_p k_p²`. The reader's load gate already proves `0x14` and `0x46`
        // agree and every trip is claimed exactly once, so build the inverse once
        // and keep the same defense-in-depth checks in `build_one_band_route`.
        let mut trip_local_in_pattern = alloc::vec![u32::MAX; num_trips];
        for p in 0..num_patterns {
            let pat_trips = reader
                .pattern_trips(p)
                .ok_or(EngineError::Corrupt("0x46 pattern_trips missing"))?;
            for (local_t, &t) in pat_trips.iter().enumerate() {
                if t as usize >= num_trips || local_t > u32::MAX as usize {
                    return Err(EngineError::Corrupt("0x46 pattern_trips invalid"));
                }
                trip_local_in_pattern[t as usize] = local_t as u32;
            }
        }
        if trip_local_in_pattern.contains(&u32::MAX) {
            return Err(EngineError::Corrupt(
                "0x46 pattern_trips omitted at least one trip",
            ));
        }

        // Pin 6 cross-validation — VERBATIM from the flat path (P1 leaves these to
        // the consumer; reject malformed input up front rather than indexing OOB).
        if trip_starts.len() != num_trips + 1 {
            return Err(EngineError::Corrupt("tripStarts length != num_trips + 1"));
        }
        let mut prev = 0u32;
        for &b in trip_starts {
            if b < prev {
                return Err(EngineError::Corrupt("tripStarts not monotonic"));
            }
            prev = b;
        }
        if trip_starts[num_trips] as usize > num_stop_time_rows {
            return Err(EngineError::Corrupt(
                "tripStarts last entry exceeds StopTimes rows",
            ));
        }

        // Under Unbounded `routes[k]` must equal band pattern `k` so the `0x45`
        // ordinals index it directly. We collect each pattern's built IndexRoute
        // into a slot indexed by its GLOBAL pattern_idx, then drain in order. Under
        // CoveringMerge the fold collapses slots, so we just push survivors (their
        // `routes` indices are re-derived for routes_at_stop, not read from 0x45).
        let mut routes: Vec<IndexRoute> = Vec::with_capacity(num_patterns);
        let mut by_global: Vec<Option<IndexRoute>> = (0..num_patterns).map(|_| None).collect();

        for r in 0..num_routes {
            let route_rec = reader.route(r)?;
            let trip_idxs = reader.route_trips(r)?;

            // Group this route's trips by their band `pattern_idx`, preserving
            // `route_trips(r)` order (first-appearance), reconstructing the
            // per-route Unbounded `PatternGroup`s WITHOUT a signature derivation.
            // `group_pidx[g]` is the global band-pattern of the g-th group.
            //
            // B1.5-T2: the Pin-1 `stop_seq` sort + per-trip flat-row cursor are
            // GONE — the band route reads times/boarding straight from `0x13`/`0x12`
            // (no flat-row `pos_to_row`), so we need neither `sorted_rows` nor a
            // `member_pos` into them. The `0x11` ordinals + `0x13` slab dims were
            // already gated in range at load (`resolve_pattern_band`), so the Pin-6
            // `stop_idx < num_stops` walk is redundant here too. (`build_flat` keeps
            // both — it still consumes the flat carry.) `member_pos` is retained in
            // the reused `PatternGroup` shape but is INERT on this path.
            let mut group_pidx: Vec<u32> = Vec::new();
            let mut group_by_pidx: HashMap<u32, usize, FxBuildHasher> =
                HashMap::with_capacity_and_hasher(trip_idxs.len(), FxBuildHasher);
            let mut groups: Vec<PatternGroup> = Vec::new();
            for (i, &t) in trip_idxs.iter().enumerate() {
                let pidx = match reader.trip_pattern_idx(t as usize) {
                    Some(p) if (p as usize) < num_patterns => p,
                    _ => return Err(EngineError::Corrupt("0x14 trip pattern_idx out of range")),
                };
                match group_by_pidx.get(&pidx).copied() {
                    Some(gi) => {
                        groups[gi].member_pos.push(i);
                        groups[gi].trip_idxs.push(t);
                        groups[gi].offsets.push(0); // native member
                    }
                    None => {
                        // `0x11 PatternStops` is this pattern's canonical stop-idx
                        // sequence (repeats preserved — Pin 2 / lasso).
                        let stop_idxs = match reader.pattern_stops(pidx as usize) {
                            Some(s) => s.to_vec(),
                            None => {
                                return Err(EngineError::Corrupt(
                                    "0x11 pattern_stops missing for pattern_idx",
                                ))
                            }
                        };
                        group_pidx.push(pidx);
                        group_by_pidx.insert(pidx, groups.len());
                        groups.push(PatternGroup {
                            stop_idxs,
                            trip_idxs: alloc::vec![t],
                            member_pos: alloc::vec![i],
                            offsets: alloc::vec![0],
                        });
                    }
                }
            }

            match mode {
                PatternMode::CoveringMerge => {
                    // Fold the per-route Unbounded groups exactly as the flat path
                    // does (identical input → byte-identical fold output). The
                    // surviving groups carry composed `offsets`; the band route reads
                    // each folded member's times via its OWN band pattern at the
                    // composed offset. reader_route_idx stays `r`. CoveringMerge
                    // collapses patterns, so push directly (routes_at_stop re-derived).
                    let folded = covering_merge_fold(groups);
                    for g in folded {
                        let route_idx = routes.len() as u32;
                        routes.push(build_one_band_route(
                            reader,
                            route_idx,
                            r as u32,
                            route_rec.route_type,
                            g.stop_idxs,
                            &g.trip_idxs,
                            &g.offsets,
                            num_services,
                            num_patterns,
                            &band_slabs,
                            &band_semantics_bases,
                            &trip_local_in_pattern,
                        )?);
                    }
                }
                PatternMode::Unbounded => {
                    // One IndexRoute per band pattern, placed at its GLOBAL
                    // pattern_idx slot so `routes` ends up in 0x10 order (==
                    // 0x45-ordinal space). offsets are all 0 (native members).
                    for (gi, g) in groups.into_iter().enumerate() {
                        let pidx = group_pidx[gi] as usize;
                        if by_global[pidx].is_some() {
                            return Err(EngineError::Corrupt(
                                "0x14 pattern_idx claimed by two routes",
                            ));
                        }
                        by_global[pidx] = Some(build_one_band_route(
                            reader,
                            pidx as u32, // route_idx == global pattern slot
                            r as u32,
                            route_rec.route_type,
                            g.stop_idxs,
                            &g.trip_idxs,
                            &g.offsets,
                            num_services,
                            num_patterns,
                            &band_slabs,
                            &band_semantics_bases,
                            &trip_local_in_pattern,
                        )?);
                    }
                }
                PatternMode::Off => unreachable!("band path is Unbounded/CoveringMerge"),
            }
        }

        if mode == PatternMode::Unbounded {
            // Drain the global-pattern slots in 0x10 order. A None slot means the
            // band declared a pattern no route's trips claimed — a corrupt band.
            for slot in by_global {
                match slot {
                    Some(rt) => routes.push(rt),
                    None => {
                        return Err(EngineError::Corrupt(
                            "0x10 pattern unclaimed by any route's trips",
                        ))
                    }
                }
            }
        }

        // routes_at_stop.
        //   Unbounded: consume the band's `0x45 PatternsAtStop` (it was emitted
        //     from `Index::build(.., Unbounded).routes_at_stop`, and `routes` is in
        //     0x10/0x45-ordinal order, so the ordinals are valid `routes` indices
        //     and the value-array ORDER round-trips — the differential's
        //     `assertPatternPreconditions` checks order).
        //   CoveringMerge: the fold changed the surviving-pattern set + indices, so
        //     `0x45` (Unbounded ordinals) is stale; re-derive from each surviving
        //     pattern's `stop_ids` exactly as the flat path does (dedup per stop).
        let mut routes_at_stop: HashMap<u32, Vec<u32>, FxBuildHasher> =
            HashMap::with_capacity_and_hasher(num_stops, FxBuildHasher);
        if mode == PatternMode::Unbounded {
            for s in 0..num_stops {
                match reader.patterns_at_stop(s) {
                    Some(list) if !list.is_empty() => {
                        for &pidx in list {
                            if pidx as usize >= routes.len() {
                                return Err(EngineError::Corrupt(
                                    "0x45 pattern ordinal >= num routes",
                                ));
                            }
                        }
                        routes_at_stop.insert(s as u32, list.to_vec());
                    }
                    Some(_) => {} // empty slice — stop served by no pattern
                    None => return Err(EngineError::Corrupt("0x45 patterns_at_stop missing")),
                }
            }
        } else {
            for (pidx, route) in routes.iter().enumerate() {
                let mut seen: HashSet<u32, FxBuildHasher> = HashSet::with_hasher(FxBuildHasher);
                for &s in &route.stop_ids {
                    if seen.insert(s) {
                        routes_at_stop.entry(s).or_default().push(pidx as u32);
                    }
                }
            }
        }

        let (transfer_rules, transfer_rules_trip, transfer_rules_route) = if reader.is_v2() {
            Default::default()
        } else {
            Self::hydrate_transfers(reader, num_stops, num_trips, num_routes)?
        };

        Ok(Index {
            routes,
            routes_at_stop,
            transfer_rules,
            transfer_rules_trip,
            transfer_rules_route,
            v2: None,
        })
    }

    // GTFS transfers.txt → applied-rule lookups. Keep ONLY rows the scan
    // acts on, with WELL-DEFINED values, so the apply path never sees an
    // under-specified rule and the two engines can never diverge on one
    // (mirror of the TS `hydrate` predicate + scope routing EXACTLY).
    //
    // Three lookups by scope (mirror of TS `transferRules` /
    // `transferRulesTripScoped` / `transferRulesRouteScoped`):
    //   - UNSCOPED (no from/to route AND no from/to trip) → `transfer_rules`,
    //     keyed by `transfer_key_into`.
    //   - TRIP-SCOPED (BOTH from_trip_idx AND to_trip_idx present) →
    //     `transfer_rules_trip`, keyed by `transfer_trip_scoped_key_into`
    //     (most specific; route fields ignored for keying on a trip row).
    //   - ROUTE-SCOPED (BOTH from_route_idx AND to_route_idx present, and
    //     NOT trip-scoped) → `transfer_rules_route`, keyed by
    //     `transfer_route_scoped_key_into`.
    // Partially-scoped rows (e.g. only from_trip, or from_route + to_trip)
    // match none of the three predicates and are DROPPED on BOTH engines —
    // the spec's specificity ladder is the 3 named levels exactly.
    //
    // Actionable `transfer_type` per scope:
    //   - 3 (not possible): kept for any row.
    //   - 2 (min_transfer_time): kept ONLY when `min_transfer_secs` is
    //     present (`!= TRANSFER_ABSENT`). A spec-invalid type-2 row with NO
    //     min is SKIPPED — else the scan reads the sentinel (≈4.29e9) as an
    //     enormous floor while TS reads `minSecs` undefined → NaN; dropping
    //     on BOTH makes the pair fall through to RAPTOR_MIN_TRANSFER_SECS.
    //   - 1 (timed / guaranteed connection, S2): kept; carries no min.
    //   - 4 (in-seat / stay-seated, S3): kept; floor 0 + in-seat mark.
    //   - 5 (in-seat forbidden, S3): kept; a documented NO-OP (normal floor)
    //     that also SHADOWS a less-specific actionable rule (most-specific-
    //     wins). type 0 (recommended) is non-actionable → dropped.
    // The string keys (`reader.stop_id` / `reader.trip().trip_id` /
    // `reader.route().route_id`) are the SAME formulas the TS `hydrate`
    // uses, so both engines look up identically (S1 index-space hazard). On
    // a duplicate actionable key within a scope the LAST row wins
    // (HashMap::insert; the TS Map.set does the same). This is scan-input,
    // identical for the flat and the B1.2 band path — both call it verbatim.
    // GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
    #[allow(clippy::type_complexity)]
    fn hydrate_transfers<B: AsRef<[u8]> + Send + Sync + 'static>(
        reader: &Reader<B>,
        num_stops: usize,
        num_trips: usize,
        num_routes: usize,
    ) -> Result<
        (
            HashMap<String, TransferRuleApplied, FxBuildHasher>,
            HashMap<String, TransferRuleApplied, FxBuildHasher>,
            HashMap<String, TransferRuleApplied, FxBuildHasher>,
        ),
        EngineError,
    > {
        let num_transfers = reader.num_transfers();
        let mut transfer_rules: HashMap<String, TransferRuleApplied, FxBuildHasher> =
            HashMap::with_capacity_and_hasher(num_transfers, FxBuildHasher);
        let mut transfer_rules_trip: HashMap<String, TransferRuleApplied, FxBuildHasher> =
            HashMap::with_capacity_and_hasher(0, FxBuildHasher);
        let mut transfer_rules_route: HashMap<String, TransferRuleApplied, FxBuildHasher> =
            HashMap::with_capacity_and_hasher(0, FxBuildHasher);
        let mut key_buf = String::new();
        for i in 0..num_transfers {
            let tr = reader.transfer(i)?;
            let is_actionable = tr.transfer_type == 3
                || (tr.transfer_type == 2 && tr.min_transfer_secs != TRANSFER_ABSENT)
                || tr.transfer_type == 1
                || tr.transfer_type == 4
                || tr.transfer_type == 5;
            if !is_actionable {
                continue;
            }
            // Bounds-check the stop ordinals before stop_id() (which errors on
            // out-of-range), so a corrupt feed yields Err(Corrupt), never a panic.
            if tr.from_stop_idx as usize >= num_stops || tr.to_stop_idx as usize >= num_stops {
                return Err(EngineError::Corrupt("transfer.stopIdx >= num_stops"));
            }
            let applied = TransferRuleApplied {
                transfer_type: tr.transfer_type,
                min_transfer_secs: tr.min_transfer_secs,
            };
            let trip_scoped =
                tr.from_trip_idx != TRANSFER_ABSENT && tr.to_trip_idx != TRANSFER_ABSENT;
            let route_scoped =
                tr.from_route_idx != TRANSFER_ABSENT && tr.to_route_idx != TRANSFER_ABSENT;
            let unscoped = tr.from_route_idx == TRANSFER_ABSENT
                && tr.to_route_idx == TRANSFER_ABSENT
                && tr.from_trip_idx == TRANSFER_ABSENT
                && tr.to_trip_idx == TRANSFER_ABSENT;
            // Stop ids resolved up front (used by every scope). Trip/route ids
            // need their own bounds + are resolved lazily to keep the unscoped
            // hot path free of trip/route decodes.
            let from_stop = reader.stop_id(tr.from_stop_idx as usize)?;
            let to_stop = reader.stop_id(tr.to_stop_idx as usize)?;
            if trip_scoped {
                if tr.from_trip_idx as usize >= num_trips || tr.to_trip_idx as usize >= num_trips {
                    return Err(EngineError::Corrupt("transfer.tripIdx >= num_trips"));
                }
                let from_trip = reader.trip(tr.from_trip_idx as usize)?.trip_id;
                let to_trip = reader.trip(tr.to_trip_idx as usize)?.trip_id;
                transfer_trip_scoped_key_into(
                    &mut key_buf,
                    from_stop,
                    to_stop,
                    &from_trip,
                    &to_trip,
                );
                transfer_rules_trip.insert(key_buf.clone(), applied);
            } else if route_scoped {
                if tr.from_route_idx as usize >= num_routes
                    || tr.to_route_idx as usize >= num_routes
                {
                    return Err(EngineError::Corrupt("transfer.routeIdx >= num_routes"));
                }
                let from_route = reader.route(tr.from_route_idx as usize)?.route_id;
                let to_route = reader.route(tr.to_route_idx as usize)?.route_id;
                transfer_route_scoped_key_into(
                    &mut key_buf,
                    from_stop,
                    to_stop,
                    &from_route,
                    &to_route,
                );
                transfer_rules_route.insert(key_buf.clone(), applied);
            } else if unscoped {
                transfer_key_into(&mut key_buf, from_stop, to_stop);
                transfer_rules.insert(key_buf.clone(), applied);
            }
            // else: partially-scoped row — dropped on both engines.
        }
        Ok((transfer_rules, transfer_rules_trip, transfer_rules_route))
    }

    // ── Public accessors (Phase 3 differential gate + Phase 5 pattern-stats) ──

    /// Return the DERIVED per-pattern `routes_at_stop` table, paired with each
    /// pattern's `reader_route_idx`, in the enumeration order.
    ///
    /// Return type: ascending `stop_idx` order; the per-stop pattern list is in `routes_at_stop`
    /// order (which equals `routes` insertion order). Each entry is `(pattern_idx,
    /// reader_route_idx)`.
    ///
    /// This is the Phase-3 differential gate surface: the harness shells out to
    /// `pt-core-emit pattern-routes-at-stop <bundle.ptb>` which calls this method
    /// and prints the result as JSON, then compares against the TS `patternsAtStop`
    /// map.  (Under `Off` the pattern indices equal the GTFS route indices and
    /// `reader_route_idx == route_idx`, so the gate degrades gracefully.)
    pub fn derived_routes_at_stop(&self) -> Vec<(u32, Vec<(u32, u32)>)> {
        // Collect stop indices in ascending order for stable JSON output.
        let mut stops: Vec<u32> = self.routes_at_stop.keys().copied().collect();
        stops.sort_unstable();
        stops
            .into_iter()
            .map(|s| {
                let pattern_idxs = self.routes_at_stop.get(&s).expect("key just collected");
                let pairs: Vec<(u32, u32)> = pattern_idxs
                    .iter()
                    .map(|&pidx| {
                        let rridx = self.routes[pidx as usize].reader_route_idx;
                        (pidx, rridx)
                    })
                    .collect();
                (s, pairs)
            })
            .collect()
    }

    /// Number of RAPTOR routes (= patterns) in the index.  Under `Off` this equals
    /// the number of GTFS routes; under `Unbounded` it is the total pattern count
    /// (≥ num GTFS routes when any route has variant trips).  Phase-5 `pattern-stats`.
    pub fn num_pattern_routes(&self) -> usize {
        self.routes.len()
    }

    /// Total number of `(stop, pattern)` entries across the derived
    /// `routes_at_stop` map.  Equals the sum of `|routes_at_stop[s]|` over all `s`.
    /// Phase-5 `pattern-stats`.
    pub fn routes_at_stop_csr_sum(&self) -> usize {
        self.routes_at_stop.values().map(|v| v.len()).sum()
    }

    /// Maximum number of patterns at any single stop.  0 if the index is empty.
    /// Phase-5 `pattern-stats`.
    pub fn max_routes_at_stop(&self) -> usize {
        self.routes_at_stop
            .values()
            .map(|v| v.len())
            .max()
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::patterns::PatternMode;
    use crate::engine::testkit::{
        build_n_trip_ptb, build_two_trip_ptb, tagged_region, tiny_reader, STOP_TIMES, TRIPS_INTERN,
        TRIP_STARTS,
    };
    use alloc::vec;

    // tiny.ptb (producer output of crates/pt-producer/tests/fixtures/tiny-gtfs.zip):
    //   stops:  S1=0, S2=1, S3=2
    //   routes: R1=0 (trips T1=0,T2=1), R2=1 (trips T3=2,T4=3)
    //   R1: T1/T2 both stop_seq 1,2,3 over stop_idx 0,1,2  -> canonical [0,1,2]
    //   R2: T3 stores stop_idx 2,1,0 at seq 1,2,3 (reverse); T4 stores 0,1,2.
    //       Both length 3 -> tie -> first-in-route_trips (T3) wins -> [2,1,0].
    #[test]
    fn canonical_pattern_and_alignment() {
        let r = tiny_reader();
        let idx = Index::build(&r, PatternMode::Off).unwrap();
        let s1 = r.stop_index("S1").unwrap();
        let s2 = r.stop_index("S2").unwrap();
        let s3 = r.stop_index("S3").unwrap();
        assert_eq!((s1, s2, s3), (0, 1, 2));

        // Route 0 (R1): forward canonical pattern.
        let r1 = &idx.routes[0];
        assert_eq!(r1.route_idx, 0);
        assert_eq!(r1.stop_ids, vec![s1, s2, s3]);
        // Both trips serve every position; departure-sorted: T1 (07:00) before
        // T2 (08:00). Row 0 is T1's S1 departure, row 3 is T2's S1 departure.
        assert_eq!(r1.trips.len(), 2);
        assert_eq!(r1.trips[0].trip_idx, 0); // T1
        assert_eq!(r1.trips[0].pos_to_row, vec![0, 1, 2]);
        assert_eq!(r1.trips[1].trip_idx, 1); // T2
        assert_eq!(r1.trips[1].pos_to_row, vec![3, 4, 5]);

        // Route 1 (R2): canonical is T3's reverse pattern [s3,s2,s1]. This
        // proves (a) the stop_seq sort and (b) the MAP alignment, not a lockstep
        // walk — T4 stores rows in stop_idx 0,1,2 order but must align to the
        // reversed canonical via pos_of, landing row 9 (T4 @ S1) at position 2.
        let r2 = &idx.routes[1];
        assert_eq!(r2.route_idx, 1);
        assert_eq!(r2.stop_ids, vec![s3, s2, s1]);
        // pos_of derived from [2,1,0]: stop_idx 2->pos0, 1->pos1, 0->pos2.
        // T3 rows [6,7,8] = stop_idx 2,1,0 -> already in pos 0,1,2 -> [6,7,8].
        // T4 rows [9,10,11] = stop_idx 0,1,2 -> pos 2,1,0 -> [11,10,9].
        // Sort key = dep at position 0 (canonical S3): T3 row6=32400, T4 row11=92100.
        assert_eq!(r2.trips.len(), 2);
        assert_eq!(r2.trips[0].trip_idx, 2); // T3 first (32400 < 92100)
        assert_eq!(r2.trips[0].pos_to_row, vec![6, 7, 8]);
        assert_eq!(r2.trips[1].trip_idx, 3); // T4
        assert_eq!(r2.trips[1].pos_to_row, vec![11, 10, 9]);
    }

    #[test]
    fn routes_at_stop_from_csr() {
        let r = tiny_reader();
        let idx = Index::build(&r, PatternMode::Off).unwrap();
        // stopRoutesNeighbors [0,1, 0,1, 0,1] over offsets [0,2,4,6]:
        // every stop is served by both routes.
        assert_eq!(idx.routes_at_stop.get(&0), Some(&vec![0u32, 1]));
        assert_eq!(idx.routes_at_stop.get(&1), Some(&vec![0u32, 1]));
        assert_eq!(idx.routes_at_stop.get(&2), Some(&vec![0u32, 1]));
    }

    // The committed tiny.ptb has NO skipped-position trip and NO circular route
    // (every trip serves all 3 positions). The plan's `-1`/circular asserts are
    // therefore exercised against a purpose-built in-memory PTB below, so the
    // Pin-3 skip path and the Pin-4 "skips pos 0 -> sorts FIRST" path are
    // actually covered, not just asserted-absent.

    #[test]
    fn skipped_position_carries_minus_one() {
        // Trip 0 (canonical) serves positions 0,1,2 over stop_idx 0,1,2.
        // Trip 1 skips the MIDDLE stop (stop_idx 1): it has only stop_idx 0,2.
        let bytes = build_two_trip_ptb(
            3,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (3, 2, 29400)], // skips stop_idx 1 (position 1)
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let idx = Index::build(&r, PatternMode::Off).unwrap();
        let route = &idx.routes[0];
        assert_eq!(route.stop_ids, vec![0, 1, 2]);
        let skipping = route
            .trips
            .iter()
            .find(|t| t.pos_to_row.contains(&-1))
            .expect("expected a trip with a skipped (-1) position");
        // Trip 1 rows are global 3,4; sorted by seq stays [3,4]; aligns to
        // positions 0 and 2 -> position 1 stays -1.
        assert_eq!(skipping.pos_to_row, vec![3, -1, 4]);
    }

    #[test]
    fn skips_position_zero_sorts_first() {
        // Trip 0 (canonical, longest) serves all 3 positions, departs pos 0 at
        // 25200. Trip 1 SKIPS position 0 (no stop_idx 0): its pos_to_row[0] = -1
        // -> sort key -1 -> sorts FIRST despite trip 0 departing earlier.
        let bytes = build_two_trip_ptb(
            3,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(2, 1, 30000), (3, 2, 30300)], // no position-0 stop
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let idx = Index::build(&r, PatternMode::Off).unwrap();
        let route = &idx.routes[0];
        // Trip 1 (skips pos 0, key -1) sorts before trip 0 (key 25200).
        assert_eq!(route.trips[0].trip_idx, 1);
        assert_eq!(route.trips[0].pos_to_row, vec![-1, 3, 4]);
        assert_eq!(route.trips[1].trip_idx, 0);
        assert_eq!(route.trips[1].pos_to_row, vec![0, 1, 2]);
    }

    #[test]
    fn circular_route_preserves_repeat() {
        // Canonical (trip 0) is the loop [T,X,Y,T] = stop_idx [0,1,2,0]: the
        // terminal stop 0 repeats. The per-trip cursor (Pin 3) assigns each row
        // to the NEXT occurrence of its stop in canonical order, so BOTH
        // occurrences of the terminal are served — this is the lasso/loop fix.
        // Trip 1 (shorter) just departs the terminal at the start (stop_idx 0).
        let bytes = build_two_trip_ptb(
            3,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 0, 26100)],
            &[(1, 0, 30000)],
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let idx = Index::build(&r, PatternMode::Off).unwrap();
        let route = &idx.routes[0];
        assert_eq!(route.stop_ids, vec![0, 1, 2, 0]); // repeat preserved, not dedup'd
                                                      // Trip 0 rows are global 0,1,2,3 in stop_seq order. stop_idx 0's first
                                                      // occurrence -> position 0 (row 0), 1 -> pos 1 (row 1), 2 -> pos 2
                                                      // (row 2), then stop_idx 0's SECOND occurrence -> position 3 (row 3).
                                                      // Position 0 is now served (was -1 under last-write-wins).
        let canon = route.trips.iter().find(|t| t.trip_idx == 0).unwrap();
        assert_eq!(canon.pos_to_row, vec![0, 1, 2, 3]);
        // Trip 1 serves only the terminal's FIRST occurrence (position 0) via its
        // single global row 4; the return-leg positions stay -1. (pos_to_row
        // holds ROW indices, so position 0 = row 4, not a departure value.)
        let short = route.trips.iter().find(|t| t.trip_idx == 1).unwrap();
        assert_eq!(short.pos_to_row, vec![4, -1, -1, -1]);
    }

    // Pin 6 (P1-deferred validation): corrupt input must yield
    // EngineError::Corrupt, never a panic / out-of-bounds.
    #[test]
    fn rejects_out_of_range_stop_idx() {
        // A flat-carry bundle: the corruption targets the 0xF4 StopTimes carry.
        let mut bytes = build_two_trip_ptb(
            3,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
        );
        // Row 0's stop_idx is the u32 at 4*N in the SoA columns (N = 6 rows).
        let (st_off, _) = tagged_region(&bytes, STOP_TIMES);
        let o = st_off + 4 * 6;
        bytes[o..o + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        let r = crate::Reader::from_bytes(bytes).unwrap();
        assert_eq!(
            Index::build(&r, PatternMode::Off).err(),
            Some(EngineError::Corrupt("stop_time.stopIdx >= num_stops")),
        );
    }

    #[test]
    fn rejects_non_monotonic_trip_starts() {
        // A flat-carry bundle: the corruption targets the 0xF5 TripStarts carry.
        let mut bytes = build_n_trip_ptb(
            3,
            &[
                &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
                &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
                &[(1, 0, 32400), (2, 1, 32700), (3, 2, 33000)],
            ],
        );
        // TripStarts entries are [0,3,6,9]. Make entry[2] smaller than
        // entry[1] (write 0 at index 2) -> 0 < 3 is non-monotonic.
        let (ts_off, _) = tagged_region(&bytes, TRIP_STARTS);
        bytes[ts_off + 8..ts_off + 12].copy_from_slice(&0u32.to_le_bytes());
        let r = crate::Reader::from_bytes(bytes).unwrap();
        assert_eq!(
            Index::build(&r, PatternMode::Off).err(),
            Some(EngineError::Corrupt("tripStarts not monotonic")),
        );
    }

    // Pin 6 (service_idx bound): a trip whose service_idx >= num_services must
    // yield Err(Corrupt), not an out-of-bounds panic in run_scan's active[] index.
    // build_two_trip_ptb sets num_services=1 and service_idx=0 for both trips.
    // Overwrite trip 0's service_idx (u32 @ trips_region + 12) with 1 (== num_services).
    #[test]
    fn rejects_out_of_range_service_idx() {
        let mut bytes = build_two_trip_ptb(
            3,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
        );
        // service_idx is at +12 within the 24-byte 0xF2 TripsIntern record.
        let (tr_off, _) = tagged_region(&bytes, TRIPS_INTERN);
        bytes[tr_off + 12..tr_off + 16].copy_from_slice(&1u32.to_le_bytes()); // 1 >= num_services(1)
        let r = crate::Reader::from_bytes(bytes).unwrap();
        assert_eq!(
            Index::build(&r, PatternMode::Off).err(),
            Some(EngineError::Corrupt("trip.service_idx >= num_services")),
        );
    }



    /// Unbounded: a one-route bundle with LOCAL [s0,s1,s2,s4] + BRANCH [s0,s1,s3,s4]
    /// → 2 patterns, both from reader_route_idx 0, branch stop only in pattern 1.
    #[test]
    fn patterns_split_branch_into_its_own_route() {
        // 5 stops (s0..s4); trip 0 = LOCAL [s0,s1,s2,s4]; trip 1 = BRANCH [s0,s1,s3,s4].
        // The two signatures differ at position 2 (s2 vs s3) → two distinct patterns.
        let bytes = build_two_trip_ptb(
            5,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)], // LOCAL
            &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)], // BRANCH via s3
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let idx = Index::build(&r, PatternMode::Unbounded).unwrap();

        // Two patterns emitted for the single GTFS route.
        assert_eq!(idx.routes.len(), 2, "two patterns");
        // Both patterns come from GTFS route 0.
        assert_eq!(idx.routes[0].reader_route_idx, 0);
        assert_eq!(idx.routes[1].reader_route_idx, 0);
        // route_idx is the slot in routes (0 and 1).
        assert_eq!(idx.routes[0].route_idx, 0);
        assert_eq!(idx.routes[1].route_idx, 1);

        // Pattern 0 = LOCAL: [s0, s1, s2, s4].
        assert_eq!(idx.routes[0].stop_ids, vec![0u32, 1, 2, 4]);
        // Pattern 1 = BRANCH: [s0, s1, s3, s4].
        assert_eq!(idx.routes[1].stop_ids, vec![0u32, 1, 3, 4]);

        // routes_at_stop re-derived from pattern stop_ids:
        //   s3 (index 3) is served only by pattern 1.
        assert_eq!(
            idx.routes_at_stop.get(&3),
            Some(&vec![1u32]),
            "branch stop s3 -> pattern 1 only"
        );
        //   s2 (index 2) is served only by pattern 0.
        assert_eq!(
            idx.routes_at_stop.get(&2),
            Some(&vec![0u32]),
            "local stop s2 -> pattern 0 only"
        );
        //   s0, s1, s4 are shared (both patterns).
        assert_eq!(
            idx.routes_at_stop.get(&0),
            Some(&vec![0u32, 1]),
            "shared entry s0 -> both patterns"
        );
        assert_eq!(
            idx.routes_at_stop.get(&4),
            Some(&vec![0u32, 1]),
            "shared exit s4 -> both patterns"
        );

        // Each pattern has exactly one trip.
        assert_eq!(idx.routes[0].trips.len(), 1);
        assert_eq!(idx.routes[1].trips.len(), 1);
    }

    /// Off: same bundle → single route, longest canonical, reader_route_idx==0==route_idx.
    #[test]
    fn off_mode_is_single_canonical_unchanged() {
        let bytes = build_two_trip_ptb(
            5,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)],
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let idx = Index::build(&r, PatternMode::Off).unwrap();

        // One route, one canonical.
        assert_eq!(idx.routes.len(), 1, "Off: single route");
        assert_eq!(idx.routes[0].route_idx, 0);
        assert_eq!(idx.routes[0].reader_route_idx, 0);
        // Both trips are the same length (4 stops each); first-in-order wins →
        // canonical is the LOCAL trip's sequence [s0,s1,s2,s4].
        assert_eq!(idx.routes[0].stop_ids, vec![0u32, 1, 2, 4]);
        // Both trips in this single route.
        assert_eq!(idx.routes[0].trips.len(), 2);
        // routes_at_stop from CSR: all 5 stops → route 0 (s3 is skipped in the
        // canonical but the CSR still records it because the BRANCH trip visits it;
        // the testkit builder populates the CSR from ALL rows).
        assert_eq!(idx.routes_at_stop.get(&0), Some(&vec![0u32]));
    }

    /// reader_route_idx is set correctly under Off (== route_idx).
    #[test]
    fn reader_route_idx_equals_route_idx_under_off() {
        let r = tiny_reader();
        let idx = Index::build(&r, PatternMode::Off).unwrap();
        for route in &idx.routes {
            assert_eq!(
                route.reader_route_idx, route.route_idx,
                "Off: reader_route_idx == route_idx for every route"
            );
        }
    }



    /// `derived_routes_at_stop` under Unbounded: the branch stop (s3 / stop_idx 3)
    /// must appear with `[(pattern_idx=1, reader_route_idx=0)]`; shared stops get
    /// both patterns.  `num_pattern_routes` == 2.
    #[test]
    fn derived_routes_at_stop_unbounded_branch_fixture() {
        let bytes = build_two_trip_ptb(
            5,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)], // LOCAL
            &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)], // BRANCH via s3
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let idx = Index::build(&r, PatternMode::Unbounded).unwrap();

        let map = idx.derived_routes_at_stop();

        // ascending stop order
        let stop_idxs: Vec<u32> = map.iter().map(|(s, _)| *s).collect();
        assert_eq!(
            stop_idxs,
            vec![0u32, 1, 2, 3, 4],
            "stops in ascending order"
        );

        // branch-only stop: s3 -> [(pattern 1, reader_route 0)]
        let s3_entry = map.iter().find(|(s, _)| *s == 3).expect("s3 present");
        assert_eq!(
            s3_entry.1,
            vec![(1u32, 0u32)],
            "s3 served only by pattern 1 (GTFS route 0)"
        );

        // local-only stop: s2 -> [(pattern 0, reader_route 0)]
        let s2_entry = map.iter().find(|(s, _)| *s == 2).expect("s2 present");
        assert_eq!(
            s2_entry.1,
            vec![(0u32, 0u32)],
            "s2 served only by pattern 0 (GTFS route 0)"
        );

        // shared stops s0, s1, s4 -> [(0, 0), (1, 0)]
        for shared in [0u32, 1, 4] {
            let entry = map
                .iter()
                .find(|(s, _)| *s == shared)
                .expect("shared stop present");
            assert_eq!(
                entry.1,
                vec![(0u32, 0u32), (1u32, 0u32)],
                "shared stop {shared} -> both patterns"
            );
        }

        // stat accessors
        assert_eq!(idx.num_pattern_routes(), 2, "2 patterns from 1 GTFS route");
        // per-stop pattern counts: s0->2, s1->2, s2->1, s3->1, s4->2 = 8 entries
        assert_eq!(
            idx.routes_at_stop_csr_sum(),
            8,
            "total (stop,pattern) entries"
        );
        assert_eq!(idx.max_routes_at_stop(), 2, "max patterns at a single stop");
    }



    /// CoveringMerge: a shorter trip whose stop sequence is a contiguous window of a longer trip
    /// folds into the longer pattern. The folded trip is un-boardable at the covering pattern's
    /// non-served positions (the `-1` holes) but boardable within its window. Mirrors the TS
    /// `emitWireRoute` folded-member alignment.
    #[test]
    fn covering_merge_folds_with_minus_one_holes() {
        // Trip 0 (long canonical): [s0,s1,s2,s3,s4]. Trip 1 (short): [s1,s2,s3]
        // — the window [1..4) of trip 0's sequence → folds at offset 1.
        let bytes = build_two_trip_ptb(
            5,
            &[
                (1, 0, 25200),
                (2, 1, 25500),
                (3, 2, 25800),
                (4, 3, 26100),
                (5, 4, 26400),
            ],
            &[(1, 1, 30000), (2, 2, 30300), (3, 3, 30600)], // [s1,s2,s3] @ offset 1
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let idx = Index::build(&r, PatternMode::CoveringMerge).unwrap();

        // One surviving pattern (the long one); both trips ride it.
        assert_eq!(
            idx.routes.len(),
            1,
            "short trip folds into the long pattern"
        );
        let route = &idx.routes[0];
        assert_eq!(route.stop_ids, vec![0u32, 1, 2, 3, 4]);
        assert_eq!(route.trips.len(), 2);

        // Trip 1 sorts first: it does NOT serve position 0 (canonical s0), so its
        // sort key is -1 (pos_to_row[0] == -1) → sorts before trip 0 (dep 25200).
        let folded = route.trips.iter().find(|t| t.trip_idx == 1).unwrap();
        // Trip 1's rows are global 5,6,7 (after trip 0's 5 rows). They land at
        // positions 1,2,3; positions 0 and 4 stay -1 (the holes — un-boardable).
        assert_eq!(folded.pos_to_row, vec![-1, 5, 6, 7, -1]);

        let native = route.trips.iter().find(|t| t.trip_idx == 0).unwrap();
        assert_eq!(native.pos_to_row, vec![0, 1, 2, 3, 4]);

        // routes_at_stop: every stop served by the single surviving pattern 0.
        for s in 0u32..5 {
            assert_eq!(idx.routes_at_stop.get(&s), Some(&vec![0u32]));
        }
    }

    /// CoveringMerge with a MID-window fold over a pattern that repeats a stop:
    /// the positional (offset) alignment must place the folded rows in the
    /// window, NOT at the first cursor occurrence the Unbounded path would pick.
    #[test]
    fn covering_merge_offset_window_beats_cursor_on_repeat() {
        // Trip 0 canonical: [s1,s2,s1,s2,s3] (s1,s2 repeat). Trip 1: [s1,s2,s3]
        // — the ONLY matching window is offset 2 ([s1,s2,s3] = canonical[2..5]).
        // A from-position-0 cursor would mis-place s1->pos0, s2->pos1, s3->pos4.
        let bytes = build_two_trip_ptb(
            4, // stops s0..s3 (s0 unused in trips but keeps indices clean)
            &[
                (1, 1, 25200),
                (2, 2, 25500),
                (3, 1, 25800),
                (4, 2, 26100),
                (5, 3, 26400),
            ],
            &[(1, 1, 30000), (2, 2, 30300), (3, 3, 30600)],
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        let idx = Index::build(&r, PatternMode::CoveringMerge).unwrap();

        assert_eq!(idx.routes.len(), 1);
        let route = &idx.routes[0];
        assert_eq!(route.stop_ids, vec![1u32, 2, 1, 2, 3]);
        let folded = route.trips.iter().find(|t| t.trip_idx == 1).unwrap();
        // Folded at offset 2: rows 5,6,7 land at positions 2,3,4; 0,1 stay -1.
        assert_eq!(folded.pos_to_row, vec![-1, -1, 5, 6, 7]);
    }

    /// CoveringMerge over the committed `covering-merge.ptb` (six trips, one route,
    /// current-v1 carry-less band): the folded short trip is boardable ONLY within
    /// its covering-pattern window (the `-1` holes), the transitive fold's offset
    /// COMPOSES, and the reverse-direction trips remain TWO separate routes. Reads
    /// the committed bytes directly, so this unit test and the engine-regression
    /// gate route the same fixture. Band-built trips carry serve markers
    /// (`pos_to_row[pos] == pos` when served) and their fold offset in
    /// `BandCoords::offset`.
    #[test]
    fn covering_merge_fixture_holes_and_reverse_separate() {
        let bytes: Vec<u8> = include_bytes!(
            "../../../../packages/frontend/tests/services/__fixtures__/covering-merge.ptb"
        )
        .to_vec();
        let r = crate::Reader::from_bytes(bytes).expect("covering-merge.ptb decodes");
        assert!(
            r.is_carry_less_band(),
            "committed fixture is a carry-less band"
        );
        let idx = Index::build(&r, PatternMode::CoveringMerge).unwrap();

        // 3 surviving patterns: fold-long [s0..s4], reverse [s4..s0], transitive [s5..s9].
        assert_eq!(idx.routes.len(), 3, "fold-long + reverse + transitive-long");

        // Fold: short trip 0 [s1,s2,s3] rides covering positions 1..3 with `-1`
        // holes at 0 and 4 — boardable ONLY within its window — at offset 1.
        let fold = idx
            .routes
            .iter()
            .find(|rt| rt.stop_ids == vec![0u32, 1, 2, 3, 4])
            .expect("fold-long pattern survives");
        let folded_short = fold.trips.iter().find(|t| t.trip_idx == 0).unwrap();
        assert_eq!(
            folded_short.pos_to_row,
            vec![-1, 1, 2, 3, -1],
            "short trip un-boardable at the `-1` holes (positions 0,4)"
        );
        assert_eq!(folded_short.band.as_ref().unwrap().offset, 1);

        // Opposite-direction reverse trip is a SEPARATE pattern (no over-merge):
        // [s4,s3,s2,s1,s0] is NOT a contiguous subsequence of [s0..s4].
        assert!(
            idx.routes
                .iter()
                .any(|rt| rt.stop_ids == vec![4u32, 3, 2, 1, 0]),
            "reverse direction stays its own route"
        );

        // Transitive composition: smallest trip 3 [s7,s8] lands at offset 2 (1+1)
        // in [s5..s9] — positions 2,3 served, the rest `-1`.
        let trans = idx
            .routes
            .iter()
            .find(|rt| rt.stop_ids == vec![5u32, 6, 7, 8, 9])
            .expect("transitive-long pattern survives");
        let composed = trans.trips.iter().find(|t| t.trip_idx == 3).unwrap();
        assert_eq!(
            composed.pos_to_row,
            vec![-1, -1, 2, 3, -1],
            "transitive offset composes to 2, NOT 1"
        );
        assert_eq!(composed.band.as_ref().unwrap().offset, 2);
        let medium = trans.trips.iter().find(|t| t.trip_idx == 4).unwrap();
        assert_eq!(medium.band.as_ref().unwrap().offset, 1);
    }

    /// `derived_routes_at_stop` under Off degrades gracefully: pattern_idx == route_idx
    /// (single canonical per GTFS route) and all stat invariants hold.
    #[test]
    fn derived_routes_at_stop_off_degrades_gracefully() {
        let r = tiny_reader();
        let idx = Index::build(&r, PatternMode::Off).unwrap();
        let map = idx.derived_routes_at_stop();

        // tiny.ptb: 2 GTFS routes, 3 stops, all stops in both routes.
        assert_eq!(idx.num_pattern_routes(), 2);
        for (_, pairs) in &map {
            for (pidx, rridx) in pairs {
                assert_eq!(pidx, rridx, "Off: pattern_idx == reader_route_idx");
            }
        }
        // All stops present in ascending order.
        let stop_idxs: Vec<u32> = map.iter().map(|(s, _)| *s).collect();
        assert_eq!(stop_idxs, vec![0u32, 1, 2]);
        assert!(idx.routes_at_stop_csr_sum() > 0);
        assert!(idx.max_routes_at_stop() > 0);
    }

    // ── B1.2 Task B: Index::build reads the band GROUPING (Fix A) ─────────────
    //
    // The band path reconstructs the per-route pattern groups from `0x14
    // TripMeta.pattern_idx` + `0x11 PatternStops` + `0x45 PatternsAtStop`, then
    // feeds the UNCHANGED `build_one_index_route` cursor over the retained flat
    // `0xF4` rows — so the band-built index is structurally identical to the
    // flat-built one. These tests build band fixtures via the testkit
    // `build_pattern_band_ptb` (a single GTFS route 0, N trips, `sentinel_rows`
    // poking express-skip `-1` holes) and assert the exact `pos_to_row` arrays
    // (the primary correctness net) PLUS run the cross-check oracle. They mirror
    // the flat-path tests above (canonical, skipped-position, circular, branch,
    // covering-merge fold + transitive) over the band path.
    mod band_path {
        use super::*;
        use crate::engine::testkit::{
            build_pattern_band_ptb, build_pattern_band_ptb_with_dwell, SoaRoute, SoaStop,
        };

        /// `n` stops `s0..s{n-1}` for `build_pattern_band_ptb` (a single bus route
        /// R0). Coords are irrelevant to the index — only stop ORDINALS matter.
        fn stops(n: u32) -> Vec<SoaStop<'static>> {
            // Leak the id strings so the `&'static str` field is satisfied without
            // threading lifetimes through every test (test-only; the process exits).
            const IDS: [&str; 10] = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];
            (0..n as usize)
                .map(|i| SoaStop {
                    id: IDS[i],
                    name: IDS[i],
                    lat: 54.68 + i as f64 * 0.001,
                    lon: 25.27 + i as f64 * 0.001,
                    parent: None,
                    wheelchair: 0,
                })
                .collect()
        }

        fn route_r0() -> Vec<SoaRoute<'static>> {
            vec![SoaRoute {
                id: "R0",
                agency: "A0",
                short: "1",
                long: "Band",
                color: "",
                text_color: "",
                route_type: 3,
            }]
        }

        /// Build a v1 (current-layout) band reader from a single-route topology +
        /// express-skip sentinel rows, asserting it actually carries the band (so
        /// the dispatch takes the band path, not the flat fallback).
        fn band_reader(
            n_stops: u32,
            trips: &[&[(u16, u32, u32)]],
            sentinel_rows: &[usize],
        ) -> crate::Reader<Vec<u8>> {
            let bytes = build_pattern_band_ptb(&stops(n_stops), &route_r0(), trips, sentinel_rows);
            let r = crate::Reader::from_bytes(bytes).expect("v1-band decode");
            assert!(r.pattern_band_present(), "fixture must carry the band");
            assert_eq!(r.header().version, 1, "v1 header (current layout)");
            r
        }

        /// Like [`band_reader`] but pokes NONZERO `arr_diff` (dwell) into the
        /// SoA carry before the band derive (`(flat_row, arr_diff)` pairs,
        /// `arr_diff <= 0`). Lets the i32-delta test assert a NONZERO wide-stride
        /// dwell decode via `band_arr_secs`.
        fn band_reader_with_dwell(
            n_stops: u32,
            trips: &[&[(u16, u32, u32)]],
            sentinel_rows: &[usize],
            dwell_rows: &[(usize, i16)],
        ) -> crate::Reader<Vec<u8>> {
            let bytes = build_pattern_band_ptb_with_dwell(
                &stops(n_stops),
                &route_r0(),
                trips,
                sentinel_rows,
                dwell_rows,
            );
            let r = crate::Reader::from_bytes(bytes).expect("v1-band decode");
            assert!(r.pattern_band_present(), "fixture must carry the band");
            assert_eq!(r.header().version, 1, "v1 header (current layout)");
            r
        }

        /// The five-trip tiny topology — branch + lasso + express-skip + skip-pos-0
        /// over route R0, stops s0..s4. Identical trips + sentinel rows [15, 17] to
        /// the committed `pattern-band-tiny.ptb` (gen_fixtures `pattern_band_tiny()`).
        const TINY_TRIPS: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)], // LOCAL
            &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)], // BRANCH
            &[
                (1, 0, 32400),
                (2, 1, 32700),
                (3, 2, 33000),
                (4, 1, 33300),
                (5, 4, 33600),
            ], // LASSO
            &[(1, 0, 36000), (2, 1, 36300), (3, 2, 36600), (4, 4, 36900)], // EXPRESS-SKIP
            &[(1, 0, 39600), (2, 1, 39900), (3, 2, 40200), (4, 4, 40500)], // SKIP-POS-0
        ];

        /// A CARRY-BEARING reader of the tiny topology, built in-memory via the
        /// testkit band builder. B1.5-T5a strips the carry from the COMMITTED
        /// `pattern-band-tiny.ptb`, so the band-vs-flat equivalence / Off-stays-flat
        /// oracles below (which compare against the flat carry) build their own
        /// carry-bearing bundle of the SAME topology rather than reading the committed
        /// (now carry-less) file. The committed carry-less bytes are validated by the
        /// differential gate, `mod carry_less`, and the teardown-completeness asserts.
        fn carry_bearing_tiny() -> crate::Reader<Vec<u8>> {
            band_reader(5, TINY_TRIPS, &[15, 17])
        }

        /// The committed (CARRY-LESS, B1.5-T5a) `pattern-band-tiny.ptb` — the shipped
        /// bytes the differential gate feeds. Band-only `Index::build` works; the
        /// flat carry is absent, so `Off` / `build_flat` / the crosscheck oracle do
        /// NOT apply (those use `carry_bearing_tiny`). Only the band-only build tests
        /// consume it — all gated out of `pattern-crosscheck` — so the helper is too.
        #[cfg(not(feature = "pattern-crosscheck"))]
        fn committed_tiny() -> crate::Reader<Vec<u8>> {
            let bytes: Vec<u8> = include_bytes!(
                "../../../../packages/frontend/tests/services/__fixtures__/pattern-band-tiny.ptb"
            )
            .to_vec();
            crate::Reader::from_bytes(bytes).expect("pattern-band-tiny.ptb decodes")
        }

        // ── THE cross-check oracle (RED-first deliverable) ────────────────────
        //
        // Under `--features pattern-crosscheck` `Index::build` builds BOTH the
        // band path and the flat path over the same bytes and asserts they match
        // (panics on divergence). These tests simply build under each enabled mode
        // over the band fixtures; with the feature off they still assert the
        // band-path output directly. The committed `pattern-band-tiny.ptb` AND a
        // testkit-built equivalent both flow through, so a mis-map of the
        // global→local member position is caught for branch/lasso/express-skip/
        // skip-pos-0 topologies.

        /// Band-only build over the COMMITTED (carry-less) `pattern-band-tiny.ptb`,
        /// both ON modes. Gated OUT of `pattern-crosscheck`: that oracle builds the
        /// flat path alongside (`Index::build` → `build_flat`), which a carry-less
        /// bundle cannot satisfy. The crosscheck oracle itself runs over a
        /// carry-BEARING build in `crosscheck_testkit_tiny_topology`.
        #[cfg(not(feature = "pattern-crosscheck"))]
        #[test]
        fn build_committed_tiny_unbounded_and_covering_band_only() {
            let r = committed_tiny();
            let _u = Index::build(&r, PatternMode::Unbounded).unwrap();
            let _c = Index::build(&r, PatternMode::CoveringMerge).unwrap();
        }

        // ── `Off` on a CARRY-LESS bundle ──────────────────────────────────────
        //
        // `Index::build` sends `Off` to `build_flat` on EVERY bundle (the band is
        // taken only when `mode != Off`), so `Off` + carry-less is a supported
        // combination. Two stripped-region reads would break it with a bare
        // `SliceOutOfBounds { what: "u32 field" }`: the `0xF6` stop→routes CSR in
        // Pin 5, and `Reader::dep_secs` without the band dispatch its
        // `stop_time` twin has. These tests pin both.

        #[cfg(not(feature = "pattern-crosscheck"))]
        #[test]
        fn off_builds_on_the_committed_carry_less_tiny() {
            let r = committed_tiny();
            assert!(r.is_carry_less_band(), "fixture must be carry-less");
            let ix = Index::build(&r, PatternMode::Off).expect("Off builds on a carry-less bundle");
            assert!(!ix.routes.is_empty(), "Off must produce routes");
            assert!(
                !ix.routes_at_stop.is_empty(),
                "routes_at_stop must be derived, not left empty — an empty map is a \
                 silently unroutable index, which is worse than the crash it replaced"
            );
        }

        /// Across every committed carry-less topology: branch, lasso, multi-route
        /// converging, and covering-merge. A single-pattern fixture would pass even
        /// if the derivation collapsed patterns wrongly.
        #[cfg(not(feature = "pattern-crosscheck"))]
        #[test]
        fn off_builds_on_every_committed_carry_less_cohort_fixture() {
            for name in [
                "branch-pattern",
                "lasso-multipattern",
                "converging-multipattern",
                "covering-merge",
            ] {
                let r = committed_cohort(name);
                assert!(r.is_carry_less_band(), "{name} must be carry-less");
                let ix = Index::build(&r, PatternMode::Off).unwrap_or_else(|e| {
                    panic!("{name}: Off must build on a carry-less bundle: {e:?}")
                });
                assert!(!ix.routes.is_empty(), "{name}: Off must produce routes");
                assert!(
                    !ix.routes_at_stop.is_empty(),
                    "{name}: routes_at_stop must be derived"
                );
            }
        }

        /// The `Off` derivation matches the independent pattern-band membership
        /// on committed producer-built PTB v1 bytes.
        ///
        /// The fixture's feed is generated by
        /// `scripts/fixtures/generate-example-city-gtfs.py`, which gives every route
        /// one stop sequence shared by all its trips. It therefore has one pattern
        /// per route, making `Off` and `Unbounded` route ordinals directly comparable.
        /// Two stops are served by two routes, so value ordering is constrained too.
        #[test]
        fn off_routes_at_stop_derivation_matches_the_band() {
            let bytes: Vec<u8> = include_bytes!(
                "../../../../packages/frontend/tests/services/__fixtures__/example-city.ptb"
            )
            .to_vec();
            let r = crate::Reader::from_bytes(bytes).expect("example-city.ptb decodes");
            assert!(
                r.is_carry_less_band(),
                "example-city.ptb must use the current carry-less PTB v1 layout"
            );
            let off = Index::build(&r, PatternMode::Off).expect("Off builds");
            let band = Index::build(&r, PatternMode::Unbounded).expect("Unbounded builds");

            assert!(
                off.routes_at_stop.len() > 1 && off.routes.len() > 1,
                "oracle needs a non-trivial feed: {} stops with routes, {} routes",
                off.routes_at_stop.len(),
                off.routes.len()
            );
            assert!(
                off.routes_at_stop.values().any(|v| v.len() > 1),
                "oracle needs a stop served by more than one route to constrain value order"
            );
            assert_eq!(
                off.routes.len(),
                band.routes.len(),
                "fixture must retain one pattern per route"
            );
            assert_eq!(
                off.routes_at_stop, band.routes_at_stop,
                "Off-derived and pattern-band stop membership must match, order included"
            );
        }

        // ── Cross-check over the current PTB v1 pattern-band cohort ───────────
        //
        // The branch, lasso, converging, and covering-merge band fixtures carry
        // the current PTB v1 layout. Building each under
        // Unbounded + CoveringMerge runs the symmetric-gate firewall
        // (`assert_band_matches_flat`) inside `Index::build` under
        // `--features pattern-crosscheck`, so a global→local pos_to_row mis-map or a
        // routes_at_stop value-order divergence on these topologies (branch, lasso,
        // multi-route converging, covering-merge fold + transitive) fails HERE.
        //
        // The committed current PTB v1 band fixtures are CARRY-LESS (no flat
        // 0xF4/0xF5 for `assert_band_matches_flat`
        // to compare against), so this oracle rebuilds a CARRY-BEARING bundle of the
        // SAME topology in-memory (the exact trips + route assignment
        // `gen_fixtures.rs` uses for each fixture). The committed carry-less bytes
        // are validated by the differential gate (both engines) + `mod carry_less` +
        // the gen_fixtures teardown-completeness asserts.

        /// The committed carry-less current PTB v1 cohort bytes — the shipped
        /// artifacts the differential gate feeds.
        /// Band-only `Index::build` works; the flat carry is absent. Used by the
        /// band-only build test (gated out of `pattern-crosscheck`, so the helper is
        /// too); the band-vs-flat equivalence oracles use `carry_bearing_cohort`
        /// (testkit, single-route).
        #[cfg(not(feature = "pattern-crosscheck"))]
        fn committed_cohort(name: &str) -> crate::Reader<Vec<u8>> {
            let bytes: Vec<u8> = match name {
                "branch-pattern" => include_bytes!(
                    "../../../../packages/frontend/tests/services/__fixtures__/branch-pattern.ptb"
                )
                .to_vec(),
                "lasso-multipattern" => include_bytes!(
                    "../../../../packages/frontend/tests/services/__fixtures__/lasso-multipattern.ptb"
                )
                .to_vec(),
                "converging-multipattern" => include_bytes!(
                    "../../../../packages/frontend/tests/services/__fixtures__/converging-multipattern.ptb"
                )
                .to_vec(),
                "covering-merge" => include_bytes!(
                    "../../../../packages/frontend/tests/services/__fixtures__/covering-merge.ptb"
                )
                .to_vec(),
                other => panic!("unknown cohort fixture {other}"),
            };
            let r = crate::Reader::from_bytes(bytes).unwrap_or_else(|e| {
                panic!("{name}.ptb decodes: {e:?}");
            });
            assert_eq!(r.header().version, 1, "{name} is current PTB v1");
            assert!(r.pattern_band_present(), "{name} carries the band");
            r
        }

        /// CARRY-BEARING single-route cohort siblings, built in-memory via the
        /// testkit band builder, for the band-vs-flat equivalence oracles (which
        /// compare the band against the flat carry the committed bytes no longer
        /// hold). The converging cohort is multi-route (the testkit builder is
        /// single-route only), so it is EXCLUDED here and its band-vs-flat
        /// equivalence is covered by the differential gate instead.
        fn carry_bearing_cohort(name: &str) -> crate::Reader<Vec<u8>> {
            match name {
                "branch-pattern" => {
                    let trips: &[&[(u16, u32, u32)]] = &[
                        &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)],
                        &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)],
                    ];
                    band_reader(5, trips, &[])
                }
                "lasso-multipattern" => {
                    let trips: &[&[(u16, u32, u32)]] = &[
                        &[
                            (1, 0, 25200),
                            (2, 1, 25500),
                            (3, 2, 25800),
                            (4, 1, 26100),
                            (5, 3, 26400),
                        ],
                        &[
                            (1, 0, 28800),
                            (2, 1, 29100),
                            (3, 4, 29400),
                            (4, 1, 29700),
                            (5, 3, 30000),
                        ],
                    ];
                    band_reader(5, trips, &[])
                }
                "covering-merge" => {
                    let trips: &[&[(u16, u32, u32)]] = &[
                        &[(1, 1, 1000), (2, 2, 1300), (3, 3, 1600)],
                        &[
                            (1, 0, 2000),
                            (2, 1, 2300),
                            (3, 2, 2600),
                            (4, 3, 2900),
                            (5, 4, 3200),
                        ],
                        &[
                            (1, 4, 5000),
                            (2, 3, 5300),
                            (3, 2, 5600),
                            (4, 1, 5900),
                            (5, 0, 6200),
                        ],
                        &[(1, 7, 1000), (2, 8, 1300)],
                        &[(1, 6, 1500), (2, 7, 1800), (3, 8, 2100)],
                        &[
                            (1, 5, 2500),
                            (2, 6, 2800),
                            (3, 7, 3100),
                            (4, 8, 3400),
                            (5, 9, 3700),
                        ],
                    ];
                    band_reader(10, trips, &[])
                }
                other => panic!("no single-route carry-bearing sibling for {other}"),
            }
        }

        /// Band-only build over the COMMITTED (carry-less) current PTB v1 cohort
        /// in both ON modes. Gated OUT of `pattern-crosscheck`
        /// (that oracle builds the flat path, which a carry-less bundle cannot
        /// satisfy). This proves the SHIPPED carry-less bytes the differential gate
        /// feeds build cleanly under both ON modes (branch / lasso / multi-route
        /// converging / covering-merge fold), WITHOUT the flat carry. The crosscheck
        /// ORACLE runs over the carry-bearing siblings in
        /// `crosscheck_carry_bearing_cohort` below.
        #[cfg(not(feature = "pattern-crosscheck"))]
        #[test]
        fn build_committed_cohort_band_only() {
            for name in [
                "branch-pattern",
                "lasso-multipattern",
                "converging-multipattern",
                "covering-merge",
            ] {
                let r = committed_cohort(name);
                let _u = Index::build(&r, PatternMode::Unbounded).unwrap();
                let _c = Index::build(&r, PatternMode::CoveringMerge).unwrap();
            }
        }

        /// The cross-check ORACLE over the CARRY-BEARING single-route cohort siblings
        /// (`assert_band_matches_flat` fires inside `Index::build` under the feature).
        /// The committed cohort is carry-less (B1.5-T5a), so the band-vs-flat oracle
        /// runs over these in-memory carry-bearing rebuilds instead. (Converging is
        /// multi-route — not expressible via the single-route testkit builder — so
        /// its band-vs-flat equivalence is covered by the differential gate.)
        #[test]
        fn crosscheck_carry_bearing_cohort() {
            for name in ["branch-pattern", "lasso-multipattern", "covering-merge"] {
                let r = carry_bearing_cohort(name);
                let _u = Index::build(&r, PatternMode::Unbounded).unwrap();
                let _c = Index::build(&r, PatternMode::CoveringMerge).unwrap();
            }
        }

        /// Cross-check over a TESTKIT-built band with the same 5-trip topology
        /// (branch/lasso/express-skip/skip-pos-0) — exercises `build_pattern_band_ptb`.
        #[test]
        fn crosscheck_testkit_tiny_topology() {
            // trip 0 LOCAL [0,1,2,4]; 1 BRANCH [0,1,3,4]; 2 LASSO [0,1,2,1,4];
            // 3 EXPRESS-SKIP (sig [0,1,2,4], s2 row poked); 4 SKIP-POS-0 (s0 poked).
            // Row offsets: trips 0/1/2 = 4+4+5 = 13 rows; trip 3 rows 13..17 (s2 @ 15);
            // trip 4 rows 17..21 (s0 @ 17). Sentinel rows = [15, 17].
            let trips: &[&[(u16, u32, u32)]] = &[
                &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)],
                &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)],
                &[
                    (1, 0, 32400),
                    (2, 1, 32700),
                    (3, 2, 33000),
                    (4, 1, 33300),
                    (5, 4, 33600),
                ],
                &[(1, 0, 36000), (2, 1, 36300), (3, 2, 36600), (4, 4, 36900)],
                &[(1, 0, 39600), (2, 1, 39900), (3, 2, 40200), (4, 4, 40500)],
            ];
            let r = band_reader(5, trips, &[15, 17]);
            let _u = Index::build(&r, PatternMode::Unbounded).unwrap();
            let _c = Index::build(&r, PatternMode::CoveringMerge).unwrap();
        }

        // ── Ported correctness nets: exact pos_to_row over the band path ──────

        /// Branch (ported from `patterns_split_branch_into_its_own_route`): the
        /// LOCAL [s0,s1,s2,s4] + BRANCH [s0,s1,s3,s4] split into two patterns,
        /// both reader_route_idx 0, `routes_at_stop` from the band's `0x45`.
        #[test]
        fn band_branch_split_two_patterns() {
            let trips: &[&[(u16, u32, u32)]] = &[
                &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)],
                &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)],
            ];
            let r = band_reader(5, trips, &[]);
            let idx = Index::build(&r, PatternMode::Unbounded).unwrap();

            assert_eq!(idx.routes.len(), 2, "two patterns");
            assert_eq!(idx.routes[0].reader_route_idx, 0);
            assert_eq!(idx.routes[1].reader_route_idx, 0);
            assert_eq!(idx.routes[0].route_idx, 0);
            assert_eq!(idx.routes[1].route_idx, 1);
            assert_eq!(idx.routes[0].stop_ids, vec![0u32, 1, 2, 4]);
            assert_eq!(idx.routes[1].stop_ids, vec![0u32, 1, 3, 4]);

            // pos_to_row is a SERVED MARKER on the band path (B1.5-T2): `pos` when
            // served, `-1` otherwise. Both native trips serve every position → the
            // identity marker. (Pre-T2 these were flat rows: [0,1,2,3] / [4,5,6,7].)
            assert_eq!(idx.routes[0].trips.len(), 1);
            assert_eq!(idx.routes[0].trips[0].trip_idx, 0);
            assert_eq!(idx.routes[0].trips[0].pos_to_row, vec![0, 1, 2, 3]);
            assert_eq!(idx.routes[1].trips.len(), 1);
            assert_eq!(idx.routes[1].trips[0].trip_idx, 1);
            assert_eq!(idx.routes[1].trips[0].pos_to_row, vec![0, 1, 2, 3]);

            // routes_at_stop from 0x45: s3 → pattern 1, s2 → pattern 0, shared → both.
            assert_eq!(idx.routes_at_stop.get(&3), Some(&vec![1u32]));
            assert_eq!(idx.routes_at_stop.get(&2), Some(&vec![0u32]));
            assert_eq!(idx.routes_at_stop.get(&0), Some(&vec![0u32, 1]));
            assert_eq!(idx.routes_at_stop.get(&4), Some(&vec![0u32, 1]));
        }

        /// Skipped middle position carries `-1` (ported from
        /// `skipped_position_carries_minus_one`). The two trips share sig
        /// [s0,s1,s2] (ONE pattern); trip 1's middle row is sentinel-poked so its
        /// served-marker pos 1 == -1. B1.5-T2: pos_to_row is a SERVED MARKER (`pos`
        /// served / `-1` skipped), not a flat row — the band's served_bits drive it.
        #[test]
        fn band_skipped_position_minus_one() {
            let trips: &[&[(u16, u32, u32)]] = &[
                &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
                &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
            ];
            let r = band_reader(3, trips, &[4]); // poke trip 1's middle (global row 4)
            let idx = Index::build(&r, PatternMode::Unbounded).unwrap();
            assert_eq!(idx.routes.len(), 1, "shared sig → one pattern");
            let route = &idx.routes[0];
            assert_eq!(route.stop_ids, vec![0u32, 1, 2]);
            let skipping = route
                .trips
                .iter()
                .find(|t| t.pos_to_row.contains(&-1))
                .expect("a trip with a -1 hole");
            assert_eq!(skipping.trip_idx, 1);
            // Served marker: pos 0 + 2 served, pos 1 skipped. (Pre-T2 rows: [3,-1,5].)
            assert_eq!(skipping.pos_to_row, vec![0, -1, 2], "middle -1 hole");
        }

        /// Skip-position-0 sorts FIRST (ported from `skips_position_zero_sorts_first`).
        /// Two trips share sig [s0,s1,s2]; trip 1's pos-0 row is sentinel-poked, so
        /// its `pos_to_row[0] == -1` → sort key -1 → sorts before trip 0 despite a
        /// later dep. Sentinel row = trip 1's first row = 3.
        #[test]
        fn band_skip_pos_zero_sorts_first() {
            let trips: &[&[(u16, u32, u32)]] = &[
                &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
                &[(1, 0, 30000), (2, 1, 30300), (3, 2, 30600)],
            ];
            let r = band_reader(3, trips, &[3]); // poke trip 1's s0 row (global 3)
            let idx = Index::build(&r, PatternMode::Unbounded).unwrap();
            assert_eq!(idx.routes.len(), 1);
            let route = &idx.routes[0];
            // Trip 1 (pos-0 hole → band-decoded dep@0 == -1, key -1) sorts before
            // trip 0 (key 25200). pos_to_row is a SERVED MARKER (B1.5-T2): trip 1
            // [-1,1,2] (pos 0 skipped), trip 0 [0,1,2]. (Pre-T2 rows: [-1,4,5].)
            assert_eq!(route.trips[0].trip_idx, 1);
            assert_eq!(route.trips[0].pos_to_row, vec![-1, 1, 2]);
            assert_eq!(route.trips[1].trip_idx, 0);
            assert_eq!(route.trips[1].pos_to_row, vec![0, 1, 2]);
        }

        /// Circular / lasso repeated-stop (ported from
        /// `circular_route_preserves_repeat`). Trip 0 loops [s0,s1,s2,s0] (terminal
        /// repeats); trip 1 short [s0]. Distinct sigs → TWO patterns. The cursor
        /// serves BOTH terminal occurrences of the loop.
        #[test]
        fn band_circular_preserves_repeat() {
            let trips: &[&[(u16, u32, u32)]] = &[
                &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 0, 26100)],
                &[(1, 0, 30000)],
            ];
            let r = band_reader(3, trips, &[]);
            let idx = Index::build(&r, PatternMode::Unbounded).unwrap();
            assert_eq!(idx.routes.len(), 2, "loop + short are distinct sigs");
            let loop_pat = idx
                .routes
                .iter()
                .find(|rt| rt.stop_ids == vec![0u32, 1, 2, 0])
                .expect("loop pattern with repeated terminal");
            let canon = loop_pat.trips.iter().find(|t| t.trip_idx == 0).unwrap();
            // Both terminal occurrences served (served marker = identity here).
            assert_eq!(canon.pos_to_row, vec![0, 1, 2, 3]);
            let short_pat = idx
                .routes
                .iter()
                .find(|rt| rt.stop_ids == vec![0u32])
                .expect("short pattern [s0]");
            let short = short_pat.trips.iter().find(|t| t.trip_idx == 1).unwrap();
            // Served marker `0` at pos 0 (pre-T2 this was flat row 4).
            assert_eq!(short.pos_to_row, vec![0]);
        }

        /// CoveringMerge fold over the band's Unbounded base (ported from
        /// `covering_merge_folds_with_minus_one_holes`). Trip 0 long [s0..s4],
        /// trip 1 short [s1,s2,s3] = window [1..4) → folds at offset 1 with `-1`
        /// holes at 0 and 4. The fold runs over the band-derived Unbounded groups,
        /// so the surviving pattern is identical to the flat path's.
        #[test]
        fn band_covering_merge_folds_with_holes() {
            let trips: &[&[(u16, u32, u32)]] = &[
                &[
                    (1, 0, 25200),
                    (2, 1, 25500),
                    (3, 2, 25800),
                    (4, 3, 26100),
                    (5, 4, 26400),
                ],
                &[(1, 1, 30000), (2, 2, 30300), (3, 3, 30600)],
            ];
            let r = band_reader(5, trips, &[]);
            let idx = Index::build(&r, PatternMode::CoveringMerge).unwrap();
            assert_eq!(idx.routes.len(), 1, "short folds into long pattern");
            let route = &idx.routes[0];
            assert_eq!(route.stop_ids, vec![0u32, 1, 2, 3, 4]);
            assert_eq!(route.trips.len(), 2);
            // Trip 1 (the folded short): served marker (B1.5-T2) — pos 0 and 4 are
            // -1 holes, positions 1,2,3 served. The band decodes its times via its
            // OWN band pattern at the composed offset 1. (Pre-T2 rows: [-1,5,6,7,-1].)
            let folded = route.trips.iter().find(|t| t.trip_idx == 1).unwrap();
            assert_eq!(folded.pos_to_row, vec![-1, 1, 2, 3, -1]);
            let native = route.trips.iter().find(|t| t.trip_idx == 0).unwrap();
            assert_eq!(native.pos_to_row, vec![0, 1, 2, 3, 4]);
            // routes_at_stop re-derived (NOT 0x45) for CoveringMerge: every stop → pattern 0.
            for s in 0u32..5 {
                assert_eq!(idx.routes_at_stop.get(&s), Some(&vec![0u32]));
            }
        }

        /// CoveringMerge transitive fold composes offsets over the band base
        /// (ported from the transitive limb of
        /// `covering_merge_fixture_holes_and_reverse_separate`). [s7,s8] ⊂
        /// [s6,s7,s8] ⊂ [s5..s9]: the smallest folds at composed offset 2 (1+1).
        #[test]
        fn band_covering_merge_transitive_composes() {
            // Single route 0, three nested trips; ascending stop ordinals s5..s9.
            let trips: &[&[(u16, u32, u32)]] = &[
                &[(1, 7, 1000), (2, 8, 1300)],               // [s7,s8]
                &[(1, 6, 1500), (2, 7, 1800), (3, 8, 2100)], // [s6,s7,s8]
                &[
                    (1, 5, 2500),
                    (2, 6, 2800),
                    (3, 7, 3100),
                    (4, 8, 3400),
                    (5, 9, 3700),
                ], // [s5..s9]
            ];
            let r = band_reader(10, trips, &[]);
            let idx = Index::build(&r, PatternMode::CoveringMerge).unwrap();
            assert_eq!(idx.routes.len(), 1, "transitive chain folds to one pattern");
            let route = &idx.routes[0];
            assert_eq!(route.stop_ids, vec![5u32, 6, 7, 8, 9]);
            // The smallest trip 0 [s7,s8] lands at composed offset 2: served marker
            // (B1.5-T2) at positions 2,3. (Pre-T2 flat rows: [-1,-1,0,1,-1].)
            let composed = route.trips.iter().find(|t| t.trip_idx == 0).unwrap();
            assert_eq!(composed.pos_to_row, vec![-1, -1, 2, 3, -1]);
        }

        /// Off STAYS FLAT on a band bundle (the dispatcher keeps `Off` on the
        /// flat single-longest-canonical path; band-`Off` is B1.4/B1.5). The
        /// committed branch+lasso fixture under `Off` collapses to ONE route with
        /// the longest trip's canonical pattern (the lasso, 5 positions).
        #[test]
        fn off_stays_flat_on_band_bundle() {
            // Off routes to `build_flat`, which reads the flat carry — so this uses
            // the CARRY-BEARING build (the committed bytes are carry-less; `Off` over
            // them errors, covered by `mod carry_less::off_over_carry_less_*`).
            let r = carry_bearing_tiny();
            let idx = Index::build(&r, PatternMode::Off).unwrap();
            assert_eq!(idx.routes.len(), 1, "Off: single GTFS route → single route");
            assert_eq!(idx.routes[0].reader_route_idx, 0);
            assert_eq!(idx.routes[0].route_idx, 0);
            // Longest trip is the lasso [s0,s1,s2,s1,s4] (5 positions) → canonical.
            assert_eq!(idx.routes[0].stop_ids.len(), 5);
            assert_eq!(idx.routes[0].stop_ids, vec![0u32, 1, 2, 1, 4]);
            // routes_at_stop from the stop→routes CSR (Off path), single route 0.
            for s in 0u32..5 {
                if let Some(v) = idx.routes_at_stop.get(&s) {
                    assert_eq!(v, &vec![0u32], "Off CSR: stop {s} → route 0");
                }
            }
        }

        /// The committed (CARRY-LESS) `pattern-band-tiny.ptb` under Unbounded: 3
        /// patterns ([0,1,2,4] owns trips {0,3,4}, [0,1,3,4] owns {1}, [0,1,2,1,4]
        /// owns {2}), with the exact `-1`-hole pos_to_row for the express-skip +
        /// skip-pos-0 trips. This is the SHIPPED bytes — band-only build (no flat
        /// carry). Gated OUT of `pattern-crosscheck` (that oracle forces a flat build
        /// the carry-less bytes cannot satisfy).
        #[cfg(not(feature = "pattern-crosscheck"))]
        #[test]
        fn committed_tiny_unbounded_patterns_and_holes() {
            let r = committed_tiny();
            let idx = Index::build(&r, PatternMode::Unbounded).unwrap();
            assert_eq!(idx.routes.len(), 3, "branch + lasso + local collapse");

            let local = idx
                .routes
                .iter()
                .find(|rt| rt.stop_ids == vec![0u32, 1, 2, 4])
                .expect("LOCAL pattern [0,1,2,4]");
            // LOCAL owns trips {0 (native), 3 (express-skip s2 hole), 4 (skip-pos-0)}.
            let mut owned: Vec<u32> = local.trips.iter().map(|t| t.trip_idx).collect();
            owned.sort_unstable();
            assert_eq!(owned, vec![0u32, 3, 4]);
            // Trip 3 express-skip: s2 (pos 2) is a -1 hole. Trip 4 skip-pos-0: pos 0 hole.
            let t3 = local.trips.iter().find(|t| t.trip_idx == 3).unwrap();
            assert_eq!(t3.pos_to_row[2], -1, "express-skip s2 hole");
            assert!(t3.pos_to_row[0] != -1 && t3.pos_to_row[1] != -1 && t3.pos_to_row[3] != -1);
            let t4 = local.trips.iter().find(|t| t.trip_idx == 4).unwrap();
            assert_eq!(t4.pos_to_row[0], -1, "skip-pos-0 hole");
            assert!(t4.pos_to_row[1] != -1 && t4.pos_to_row[2] != -1 && t4.pos_to_row[3] != -1);
            // Trip 4 skips pos 0 → sort key -1 → sorts FIRST in the LOCAL pattern.
            assert_eq!(local.trips[0].trip_idx, 4, "skip-pos-0 sorts first (Pin-4)");

            // Lasso pattern preserves the repeated stop s1.
            let lasso = idx
                .routes
                .iter()
                .find(|rt| rt.stop_ids == vec![0u32, 1, 2, 1, 4])
                .expect("LASSO pattern with repeated s1");
            assert_eq!(lasso.trips.len(), 1);
            assert_eq!(lasso.trips[0].trip_idx, 2);

            // routes_at_stop from 0x45: s3 only in the branch pattern.
            let branch_idx = idx
                .routes
                .iter()
                .position(|rt| rt.stop_ids == vec![0u32, 1, 3, 4])
                .unwrap() as u32;
            assert_eq!(idx.routes_at_stop.get(&3), Some(&vec![branch_idx]));
        }

        /// `Reader::from_bytes` REJECTS the RAGGED `0x13` variant (`entry_flags`
        /// bit0) at LOAD — the band gate (`resolve_pattern_band`) now fails closed
        /// on any non-bit1 flag, mirroring TS `decodePatternBand`. (Ragged used to
        /// reach `Reader::from_bytes` OK and only error later at `Index::build`; it
        /// now fails earlier, at load.) We poke the `0x13` region-table entry's
        /// `entryFlags` u16 to set bit0. (The i32-delta variant, bit1, IS supported
        /// — see `band_i32_deltas_*`.)
        #[test]
        fn band_rejects_ragged_trip_times() {
            let trips: &[&[(u16, u32, u32)]] = &[
                &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
                &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
            ];
            let mut bytes = build_pattern_band_ptb(&stops(3), &route_r0(), trips, &[]);
            // Walk the tagged region table (24 B entries from byte 32) to find
            // 0x13 TripTimes and set its entryFlags (u16 @ entry+2) bit0 (ragged).
            let mut e = 32;
            loop {
                let id = u16::from_le_bytes(bytes[e..e + 2].try_into().unwrap());
                assert_ne!(id, 0, "0x13 TripTimes entry not found");
                if id == crate::region_ids::TRIP_TIMES {
                    bytes[e + 2..e + 4].copy_from_slice(&1u16.to_le_bytes()); // bit0 ragged
                    break;
                }
                e += 24;
            }
            // The unsupported-flag band gate rejects ragged at LOAD now.
            let err = crate::Reader::from_bytes(bytes)
                .err()
                .expect("ragged 0x13 rejected at load");
            assert_eq!(
                err,
                crate::PtbError::PatternBandInvalid {
                    reason: "0x13 TripTimes unsupported entryFlags",
                },
            );
        }

        /// Patch the `0x13 TripTimes` region-table entry's `entryFlags` u16 (at
        /// `entry+2`) to `flags`, walking the tagged region table (24 B entries
        /// from byte 32). Mirrors the walk in `band_rejects_ragged_trip_times`.
        fn patch_trip_times_entry_flags(bytes: &mut [u8], flags: u16) {
            let mut e = 32;
            loop {
                let id = u16::from_le_bytes(bytes[e..e + 2].try_into().unwrap());
                assert_ne!(id, 0, "0x13 TripTimes entry not found");
                if id == crate::region_ids::TRIP_TIMES {
                    bytes[e + 2..e + 4].copy_from_slice(&flags.to_le_bytes());
                    return;
                }
                e += 24;
            }
        }

        /// The load-time band gate (`resolve_pattern_band`) fails closed on ANY
        /// `0x13 TripTimes` `entryFlags` other than `0x0000` (i16) or `0x0002`
        /// (`TRIP_TIMES_FLAG_I32_DELTAS`, i32) — the symmetric twin of TS
        /// `decodePatternBand`, which throws on the same bytes. Pins the
        /// cross-runtime symmetry: bit1 PLUS an unknown bit (`0x0006` = bit1|bit2)
        /// must be REJECTED at load (Rust was previously too lenient and would have
        /// decoded it as pure i32 — a silent divergence vs TS). The clean i16
        /// (`0x0000`) and i32 (`0x0002`) flag words must still load.
        #[test]
        fn band_rejects_unsupported_trip_times_entry_flags() {
            // A long-span overnight trip forces the REGION-LEVEL i32 variant, so the
            // clean bundle's 0x13 entryFlags == 0x0002 (TRIP_TIMES_FLAG_I32_DELTAS).
            const FIRST_DEP: u32 = 36_000; // 10:00:00
            const LONG_DEP: u32 = 91_800; // 25:30:00 — delta 55800 > i16::MAX
            let trips: &[&[(u16, u32, u32)]] =
                &[&[(1, 0, FIRST_DEP), (2, 1, 64_800), (3, 2, LONG_DEP)]];

            // (a) clean i32 case: build it, confirm entryFlags == 0x0002, and that
            //     it loads. (band_reader_with_dwell already `from_bytes`-decodes.)
            let r_i32 = band_reader_with_dwell(3, trips, &[], &[(1, -180), (2, -300)]);
            assert_eq!(
                r_i32.trip_times_entry_flags(),
                Some(crate::reader::TRIP_TIMES_FLAG_I32_DELTAS), // 0x0002
                "overnight feed declares the i32 variant",
            );

            // (b) clean i16 case: a short-span feed stays i16 (entryFlags 0x0000)
            //     and loads.
            let i16_trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 25_200), (2, 1, 25_500)]];
            let r_i16_bytes = build_pattern_band_ptb(&stops(2), &route_r0(), i16_trips, &[]);
            let r_i16 = crate::Reader::from_bytes(r_i16_bytes).expect("i16 band loads");
            assert_eq!(
                r_i16.trip_times_entry_flags(),
                Some(0x0000),
                "short-span feed stays the i16 layout",
            );

            // (c) the divergence case: bit1 | an UNKNOWN bit2 (0x0006). Take the
            //     clean i32 bytes, poke entryFlags to 0x0006, and assert the band
            //     gate rejects at LOAD (Rust was too lenient before — TS already
            //     throws). Even though bit1 is set (which `delta_bytes_for_flags`
            //     would honor), the unknown bit makes the band unresolvable.
            let mut bad = build_pattern_band_ptb_with_dwell(
                &stops(3),
                &route_r0(),
                trips,
                &[],
                &[(1, -180), (2, -300)],
            );
            patch_trip_times_entry_flags(&mut bad, 0x0006);
            let err = crate::Reader::from_bytes(bad)
                .err()
                .expect("0x0006 (bit1|unknown bit2) rejected at load");
            assert_eq!(
                err,
                crate::PtbError::PatternBandInvalid {
                    reason: "0x13 TripTimes unsupported entryFlags",
                },
            );
        }

        /// A trip whose span (first SERVED dep → a later position) exceeds the
        /// `i16` ±32767 s (~9.1h) cap forces the REGION-LEVEL `i32`-delta `0x13`
        /// variant. The encoder must NOT error (no `Corrupt`), the `0x13`
        /// region-table entry's `entryFlags` MUST carry bit1
        /// (`TRIP_TIMES_FLAG_I32_DELTAS`), and the band must decode the long span's
        /// departure as the EXACT original second — round-tripping a span no `i16`
        /// layout can hold. A wrong-stride decode (reading i16 where the region is
        /// i32) reconstructs a different second, so the exact-value assertion is
        /// mutation-resistant. Under `--features pattern-crosscheck` the band==flat
        /// firewall ALSO runs inside `Index::build`.
        ///
        /// First dep 36000s (10:00); the third served position at 91800s (25:30, a
        /// >24h overnight time) ⇒ dep_delta 55800 > i16::MAX (32767).
        #[test]
        fn band_overnight_forces_i32_deltas_and_roundtrips() {
            const FIRST_DEP: u32 = 36_000; // 10:00:00
            const MID_DEP: u32 = 64_800; // 18:00:00
            const LONG_DEP: u32 = 91_800; // 25:30:00 — delta 55800 > i16::MAX
                                          // NONZERO dwells (arr_diff <= 0; arr = dep + arr_diff) so the i32 dwell
                                          // sub-array carries non-zero wide-stride values — an i16 mis-stride of the
                                          // dwell column would mis-read these (the dep-only asserts can't catch a
                                          // dwell-stride bug since the dwell sub-array would be all-zero).
            const MID_DWELL: i16 = -180; // arr at pos 1 = 64800 - 180 = 64620
            const LONG_DWELL: i16 = -300; // arr at the >9.1h pos 2 = 91800 - 300 = 91500
            let trips: &[&[(u16, u32, u32)]] = &[&[
                (1, 0, FIRST_DEP),
                (2, 1, MID_DEP),  // 18:00 — delta 28800 (still i16-OK on its own)
                (3, 2, LONG_DEP), // overnight — delta 55800 overflows i16
            ]];
            // build_pattern_band_ptb_with_dwell encodes the band; with the i32 variant
            // it must NOT panic. Flat rows: 0=(pos0), 1=(pos1), 2=(pos2); dwell on the
            // mid + the >9.1h long-span position (the latter forces the wide layout).
            let r = band_reader_with_dwell(3, trips, &[], &[(1, MID_DWELL), (2, LONG_DWELL)]);

            // (b) the 0x13 region declares the i32-delta variant (entryFlags bit1).
            assert_eq!(
                r.trip_times_is_i32_deltas(),
                Some(true),
                "0x13 entryFlags bit1 (i32 deltas) set for the overnight feed"
            );
            assert_eq!(
                r.trip_times_is_ragged(),
                Some(false),
                "ragged bit0 stays clear"
            );

            // (c) the band decodes the long span: pattern [s0,s1,s2], one trip, the
            // band-decoded dep at pos 2 == 91800 EXACTLY (an i16 stride would
            // mis-read the wide delta). Reads via the band slab, not the flat carry.
            assert_eq!(
                r.band_dep_secs(0, 0, 2),
                Some(LONG_DEP as i64),
                "pos 2 dep round-trips to 91800 via the i32 delta"
            );
            assert_eq!(r.band_dep_secs(0, 0, 0), Some(FIRST_DEP as i64), "pos 0");
            assert_eq!(r.band_dep_secs(0, 0, 1), Some(MID_DEP as i64), "pos 1");

            // (c2) the wide-stride DWELL sub-array decodes to the EXACT arr second.
            // arr = dep + arr_diff; an i16 mis-stride of the dwell column (reading at
            // *2 while dep reads at *4) lands on different bytes and mis-reads these.
            assert_eq!(
                r.band_arr_secs(0, 0, 2),
                Some((LONG_DEP as i64) + LONG_DWELL as i64), // 91800 - 300 = 91500
                "pos 2 arr round-trips to 91500 via the i32 dwell delta"
            );
            assert_eq!(
                r.band_arr_secs(0, 0, 1),
                Some((MID_DEP as i64) + MID_DWELL as i64), // 64800 - 180 = 64620
                "pos 1 arr round-trips to 64620 via the i32 dwell delta"
            );
            assert_eq!(
                r.band_arr_secs(0, 0, 0),
                Some(FIRST_DEP as i64), // zero dwell at pos 0 ⇒ arr == dep
                "pos 0 arr == dep (zero dwell)"
            );

            // (a) the band path builds (no Corrupt) end-to-end. Under
            // pattern-crosscheck this also asserts band==flat for the wide deltas.
            let idx =
                Index::build(&r, PatternMode::Unbounded).expect("band builds with i32 deltas");
            assert_eq!(idx.routes.len(), 1, "single pattern [s0,s1,s2]");
            assert_eq!(idx.routes[0].stop_ids, vec![0u32, 1, 2]);
        }

        //
        // The pattern band (`0x13 TripTimes` / `0x12 PatternSemantics`) is emitted
        // additively from the SAME cursor that built the flat carry (`0xF4
        // StopTimes` / `0xFA StopTimeBoarding`), so the new band decoders MUST
        // return bit-identical times/boarding for every (pattern, trip, position).
        // This is the equivalence cross-check that proves the band carries
        // everything the scan reads BEFORE a later task cuts the scan over. It runs
        // in the normal `cargo test -p pt-core` (NOT gated behind
        // `pattern-crosscheck`). A mismatch is a REAL band mis-encode — the exact
        // (pattern, trip, position) + both values are in the panic message.

        /// Prove the band reference decoders (`reader.band_*`, O(p)) match the FLAT
        /// `0xF4`/`0xFA` carry, under `PatternMode::Unbounded` — the band's NATIVE
        /// grouping where `Index.routes[p]` is 1:1 with the `0x10` pattern ordinal
        /// `p` (the locked-layout enumeration == Unbounded), so the `0x13`/`0x12`
        /// decoders keyed by that ordinal line up. (`CoveringMerge` FOLDS the
        /// per-route groups so `routes` is no longer 1:1 with `0x10` — that's an
        /// index-build concern the `pattern-crosscheck` cfg covers, not a
        /// band-decode concern.)
        ///
        /// **B1.5-T2.** The band-built index now stores a SERVED-MARKER `pos_to_row`
        /// (not flat rows), so the flat reference comes from an INDEPENDENT
        /// FLAT-built index (`Index::build_flat`, which keeps real rows). Both are
        /// built under `Unbounded`, so route `p` / trip `t` align 1:1 (the firewall
        /// asserts this; `pattern_trips(p)[t] == trip.trip_idx` in both). For each
        /// `(p, t, pos)` this asserts:
        ///  - band `band_served` ⇔ flat `pos_to_row[pos] != -1`;
        ///  - band `band_dep_secs`/`band_arr_secs` == flat `dep_secs_at`/`alight_secs_at`;
        ///  - band `band_pickup_forbidden`/`band_drop_off_forbidden` ==
        ///    flat `pickup_forbidden`/`drop_off_forbidden` on the flat `0xFA` row.
        fn assert_band_decode_matches_flat<B>(reader: &crate::Reader<B>)
        where
            B: AsRef<[u8]> + Send + Sync + 'static,
        {
            use crate::engine::scan::{alight_secs_at, dep_secs_at};

            let band_idx = Index::build(reader, PatternMode::Unbounded).expect("band index build");
            let flat_idx =
                Index::build_flat(reader, PatternMode::Unbounded).expect("flat index build");
            assert_eq!(
                band_idx.routes.len(),
                flat_idx.routes.len(),
                "band/flat route count diverge",
            );
            let mut compared = 0usize;
            for (p, (route, flat_route)) in band_idx
                .routes
                .iter()
                .zip(flat_idx.routes.iter())
                .enumerate()
            {
                let pat_trips = reader
                    .pattern_trips(p)
                    .expect("pattern_trips present on band");
                assert_eq!(
                    pat_trips.len(),
                    route.trips.len(),
                    "pattern {p}: 0x46 trip count != index trip count",
                );
                assert_eq!(
                    route.trips.len(),
                    flat_route.trips.len(),
                    "pattern {p}: band vs flat trip count diverge",
                );
                for (t, (trip, flat_trip)) in
                    route.trips.iter().zip(flat_route.trips.iter()).enumerate()
                {
                    assert_eq!(
                        pat_trips[t], trip.trip_idx,
                        "pattern {p} trip {t}: 0x46 trip_idx {} != index trip_idx {}",
                        pat_trips[t], trip.trip_idx,
                    );
                    assert_eq!(
                        trip.trip_idx, flat_trip.trip_idx,
                        "pattern {p} trip {t}: band/flat trip_idx diverge",
                    );
                    for pos in 0..route.stop_ids.len() {
                        // Flat reference rows come from the FLAT index (real rows).
                        let flat_row = flat_trip.pos_to_row[pos]; // -1 ⇒ not served
                        let flat_served = flat_row != -1;

                        // served bit (also cross-check the band served-marker).
                        assert_eq!(
                            trip.pos_to_row[pos] != -1,
                            flat_served,
                            "pattern {p} trip {t} pos {pos}: band served-marker vs flat served",
                        );
                        assert_eq!(
                            reader.band_served(p, t, pos),
                            Some(flat_served),
                            "pattern {p} trip {t} (trip_idx {}) pos {pos}: served band={:?} flat={flat_served}",
                            trip.trip_idx,
                            reader.band_served(p, t, pos),
                        );

                        // dep_secs (band reference vs flat `dep_secs_at` on the flat
                        // trip, both -1 when unserved)
                        let flat_dep =
                            dep_secs_at(reader, flat_trip, pos).expect("flat dep_secs_at");
                        assert_eq!(
                            reader.band_dep_secs(p, t, pos),
                            Some(flat_dep),
                            "pattern {p} trip {t} (trip_idx {}) pos {pos}: dep band={:?} flat={flat_dep}",
                            trip.trip_idx,
                            reader.band_dep_secs(p, t, pos),
                        );

                        // arr_secs (band reference vs flat `alight_secs_at`; flat
                        // helper is only valid for served positions)
                        let flat_arr = if flat_served {
                            alight_secs_at(reader, flat_trip, pos).expect("flat alight_secs_at")
                        } else {
                            crate::reader::BAND_NOT_SERVED
                        };
                        assert_eq!(
                            reader.band_arr_secs(p, t, pos),
                            Some(flat_arr),
                            "pattern {p} trip {t} (trip_idx {}) pos {pos}: arr band={:?} flat={flat_arr}",
                            trip.trip_idx,
                            reader.band_arr_secs(p, t, pos),
                        );

                        // boarding — band 0x12 vs flat 0xFA on the flat trip's row.
                        // Compare only when the flat trip serves (has a row).
                        if flat_served {
                            let row = flat_row as usize;
                            assert_eq!(
                                reader.band_pickup_forbidden(p, pos),
                                Some(reader.pickup_forbidden(row)),
                                "pattern {p} trip {t} pos {pos} row {row}: pickup_forbidden band={:?} flat={}",
                                reader.band_pickup_forbidden(p, pos),
                                reader.pickup_forbidden(row),
                            );
                            assert_eq!(
                                reader.band_drop_off_forbidden(p, pos),
                                Some(reader.drop_off_forbidden(row)),
                                "pattern {p} trip {t} pos {pos} row {row}: drop_off_forbidden band={:?} flat={}",
                                reader.band_drop_off_forbidden(p, pos),
                                reader.drop_off_forbidden(row),
                            );
                        }
                        compared += 1;
                    }
                }
            }
            assert!(compared > 0, "no (pattern,trip,pos) tuples compared");
        }

        /// HOT-PATH `_at` decoder equivalence (B1.5-T2 review Finding 1). The
        /// always-on `assert_band_decode_matches_flat` oracle exercises only the
        /// REFERENCE decoders (`band_dep_secs`/`band_arr_secs`/`band_served`/
        /// `band_pickup_forbidden`/`band_drop_off_forbidden`), never the hoisted
        /// O(1) `_at` decoders the live scan actually ships
        /// (`band_dep_at`/`band_arr_at`/`band_served_at`/`band_pickup_forbidden_at`/
        /// `band_drop_off_forbidden_at`). The scan unit tests all run
        /// `PatternMode::Off` → flat path, so under bare `cargo test` the band
        /// branch (and thus the `_at` decoders) is never taken; only
        /// `--features pattern-crosscheck` + the CI-only frontend differential
        /// touch them. This closes that gap with an ALWAYS-ON assertion.
        ///
        /// For each band route/trip and EVERY canonical position (served AND
        /// not-served, position 0 AND non-zero), this asserts the hot-path `_at`
        /// decoder equals its reference twin, addressed by the trip's resolved
        /// [`BandCoords`] (`local_t`/`offset`/`slab`/`semantics_base`) — the exact
        /// coordinates the scan threads through `dep_secs_at`/`alight_secs_at`/
        /// `pickup_forbidden_at`/`drop_off_forbidden_at`. `pattern_idx` (needed only
        /// by the reference decoders) is the trip's BAND pattern ordinal, resolved
        /// via `0x14` (`trip_pattern_idx`) so a `CoveringMerge` fold — `offset > 0`,
        /// band pattern != route slot — is covered too.
        fn assert_band_at_decoders_match_reference<B>(reader: &crate::Reader<B>, mode: PatternMode)
        where
            B: AsRef<[u8]> + Send + Sync + 'static,
        {
            let idx = Index::build(reader, mode).expect("band index build");
            let mut compared = 0usize;
            for route in &idx.routes {
                let n_pos = route.stop_ids.len();
                for trip in &route.trips {
                    // Every band route's trips carry BandCoords (band path).
                    let bc = trip
                        .band
                        .as_ref()
                        .expect("band-built trip must carry BandCoords");
                    // The trip's BAND pattern ordinal (NOT the route slot under a
                    // CoveringMerge fold) — the reference decoders index by it.
                    let band_pidx = reader
                        .trip_pattern_idx(trip.trip_idx as usize)
                        .expect("0x14 trip pattern_idx")
                        as usize;
                    let local_t = bc.local_t as usize;
                    let offset = bc.offset as usize;
                    for canonical_pos in 0..n_pos {
                        // band_position = canonical_position - offset (0 under
                        // Unbounded). Only positions inside this trip's band-pattern
                        // window `[offset, offset + slab.s)` are this trip's — a
                        // CoveringMerge route's canonical can be LONGER than a folded
                        // member's pattern, and positions outside the window belong to
                        // a sibling member (the reference decoder's `pos < s` guard
                        // returns `None` there, while the hot path's own bound returns
                        // `false`; that's a not-this-trip position, not a divergence).
                        if canonical_pos < offset {
                            continue;
                        }
                        let bandpos = canonical_pos - offset;
                        if bandpos >= bc.slab.s {
                            continue;
                        }

                        // served (incl not-served → both false)
                        let ref_served = reader
                            .band_served(band_pidx, local_t, bandpos)
                            .expect("band_served reference");
                        assert_eq!(
                            reader.band_served_at(&bc.slab, local_t, bandpos),
                            ref_served,
                            "served_at != reference: pattern {band_pidx} local_t {local_t} bandpos {bandpos} (canonical {canonical_pos})",
                        );

                        // dep (incl not-served → both -1, AND non-zero bandpos)
                        assert_eq!(
                            reader.band_dep_at(&bc.slab, local_t, bandpos),
                            reader
                                .band_dep_secs(band_pidx, local_t, bandpos)
                                .expect("band_dep_secs reference"),
                            "dep_at != reference: pattern {band_pidx} local_t {local_t} bandpos {bandpos} (canonical {canonical_pos})",
                        );

                        // arr (incl not-served → both -1)
                        assert_eq!(
                            reader.band_arr_at(&bc.slab, local_t, bandpos),
                            reader
                                .band_arr_secs(band_pidx, local_t, bandpos)
                                .expect("band_arr_secs reference"),
                            "arr_at != reference: pattern {band_pidx} local_t {local_t} bandpos {bandpos} (canonical {canonical_pos})",
                        );

                        // pickup/drop-off forbidden (semantics_base path)
                        assert_eq!(
                            reader.band_pickup_forbidden_at(bc.semantics_base, bandpos),
                            reader
                                .band_pickup_forbidden(band_pidx, bandpos)
                                .expect("band_pickup_forbidden reference"),
                            "pickup_forbidden_at != reference: pattern {band_pidx} bandpos {bandpos} (canonical {canonical_pos})",
                        );
                        assert_eq!(
                            reader.band_drop_off_forbidden_at(bc.semantics_base, bandpos),
                            reader
                                .band_drop_off_forbidden(band_pidx, bandpos)
                                .expect("band_drop_off_forbidden reference"),
                            "drop_off_forbidden_at != reference: pattern {band_pidx} bandpos {bandpos} (canonical {canonical_pos})",
                        );
                        compared += 1;
                    }
                }
            }
            assert!(compared > 0, "no (route,trip,pos) tuples compared");
        }

        /// Always-on hot-path `_at` decoder coverage (B1.5-T2 review Finding 1) over
        /// the COMMITTED cohort + tiny, under BOTH `Unbounded` (offset 0) and
        /// `CoveringMerge`. Every position — served, not-served, position 0 and
        /// non-zero — runs through both the hot-path `_at` decoder and its reference
        /// twin and asserts they agree, so a regression in `band_arr_at`, either
        /// `_forbidden_at`, or `band_dep_at`'s not-served / non-zero-pos branches now
        /// fails under bare `cargo test` (previously only CI-only paths caught it).
        ///
        /// The fixtures jointly exercise every branch the `_at` decoders own:
        ///  - `pattern-band-tiny` carries express-skip + skip-pos-0 holes → the
        ///    NOT-SERVED branch of `band_served_at`/`band_dep_at`/`band_arr_at`
        ///    (both decode to `-1`);
        ///  - `covering-merge` under `CoveringMerge` folds members at `offset 2`
        ///    → the `bandpos = canonical_pos - offset` non-zero-position arithmetic
        ///    over a band pattern that is NOT the route slot.
        #[test]
        fn band_at_decoders_match_reference_committed_cohort() {
            // CARRY-BEARING rebuilds (the `_at` reference twin reads the flat carry);
            // converging is multi-route → covered by the differential gate.
            for name in ["branch-pattern", "lasso-multipattern", "covering-merge"] {
                let r = carry_bearing_cohort(name);
                assert_band_at_decoders_match_reference(&r, PatternMode::Unbounded);
                assert_band_at_decoders_match_reference(&r, PatternMode::CoveringMerge);
            }
            let tiny = carry_bearing_tiny();
            assert_band_at_decoders_match_reference(&tiny, PatternMode::Unbounded);
            assert_band_at_decoders_match_reference(&tiny, PatternMode::CoveringMerge);
        }

        /// Equivalence over the COMMITTED cohort + tiny, both modes. The lasso
        /// (repeated-stop) fixture is the load-bearing case — a repeated stop
        /// produces two distinct canonical positions that the band's served_bits +
        /// per-position deltas must align with the cursor's `pos_to_row`.
        #[test]
        fn band_decode_matches_flat_committed_cohort() {
            // CARRY-BEARING rebuilds (`assert_band_decode_matches_flat` builds the
            // flat index, which needs the carry the committed bytes no longer hold);
            // converging is multi-route → covered by the differential gate.
            for name in ["branch-pattern", "lasso-multipattern", "covering-merge"] {
                let r = carry_bearing_cohort(name);
                assert_band_decode_matches_flat(&r);
            }
            let tiny = carry_bearing_tiny();
            assert_band_decode_matches_flat(&tiny);
        }

        /// Equivalence over a TESTKIT lasso (repeated-stop) topology — trip 2
        /// `s0→s1→s2→s1→s4` revisits s1, so the pattern has TWO positions mapping
        /// to stop s1 with distinct rows. Exercises `build_pattern_band_ptb` + the
        /// repeated-stop served/dep/arr decode end-to-end.
        #[test]
        fn band_decode_matches_flat_testkit_lasso() {
            let trips: &[&[(u16, u32, u32)]] = &[
                &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)],
                &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)],
                &[
                    (1, 0, 32400),
                    (2, 1, 32700),
                    (3, 2, 33000),
                    (4, 1, 33300),
                    (5, 4, 33600),
                ],
            ];
            let r = band_reader(5, trips, &[]);
            assert_band_decode_matches_flat(&r);
        }

        /// Equivalence over an express-skip topology (a sentinel-dep row → an
        /// unserved middle position). Verifies the band reports NOT-served (`-1`)
        /// exactly where the flat cursor leaves `pos_to_row == -1`.
        #[test]
        fn band_decode_matches_flat_express_skip() {
            // Two trips share sig [s0,s1,s2]; trip 1's middle row (global row 4) is
            // sentinel-poked so the cursor leaves its pos 1 == -1.
            let trips: &[&[(u16, u32, u32)]] = &[
                &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
                &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
            ];
            let r = band_reader(3, trips, &[4]);
            assert_band_decode_matches_flat(&r);
            // Confirm the unserved hole actually decodes to NOT-served on the band.
            let idx = Index::build(&r, PatternMode::Unbounded).unwrap();
            let (p, t) = idx
                .routes
                .iter()
                .enumerate()
                .find_map(|(p, rt)| {
                    rt.trips
                        .iter()
                        .position(|tr| tr.pos_to_row.contains(&-1))
                        .map(|t| (p, t))
                })
                .expect("a trip with a -1 hole");
            assert_eq!(r.band_served(p, t, 1), Some(false), "middle pos unserved");
            assert_eq!(r.band_dep_secs(p, t, 1), Some(-1), "unserved dep == -1");
            assert_eq!(r.band_arr_secs(p, t, 1), Some(-1), "unserved arr == -1");
        }

        /// Equivalence over a band carrying a NON-default `0xFA` boarding column —
        /// drives the `0x12 PatternSemantics` non-regular decode path
        /// (`band_pickup_forbidden` / `band_drop_off_forbidden`). One trip
        /// `s0→s1→s2`; s1 forbids pickup (`pickup_type 1`, packed `0b01 = 0x01`),
        /// s2 forbids drop-off (`drop_off_type 1`, packed `0b01 << 2 = 0x04`).
        #[test]
        fn band_decode_matches_flat_with_boarding() {
            use crate::engine::testkit::build_pattern_band_ptb_with_boarding;
            let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)]];
            // Flat 0xFA bytes, one per stop_time row (rows 0,1,2):
            //   row 0 (s0): regular (0x50, the default-ish; low nibble 0x0 regular)
            //   row 1 (s1): pickup forbidden → pickup_type=1 → low bits 0b01 = 0x01
            //   row 2 (s2): drop-off forbidden → drop_off_type=1 → bits 0b01<<2 = 0x04
            let boarding: &[u8] = &[0x50, 0x01, 0x04];
            let bytes = build_pattern_band_ptb_with_boarding(
                &stops(3),
                &route_r0(),
                trips,
                &[],
                boarding,
                &[],
            );
            let r = crate::Reader::from_bytes(bytes).expect("band+boarding decode");
            assert!(r.pattern_band_present(), "fixture carries the band");
            assert!(
                r.has_pattern_semantics(),
                "non-regular boarding ⇒ 0x12 present",
            );
            assert_band_decode_matches_flat(&r);
            // Non-regular `0x12` ⇒ the hot-path `_forbidden_at` decoders see a
            // forbidden pickup (s1) and drop-off (s2), so this drives Finding 1's
            // `band_pickup_forbidden_at`/`band_drop_off_forbidden_at` coverage (the
            // committed cohort is all-regular). A shift/mask regression bites here.
            assert_band_at_decoders_match_reference(&r, PatternMode::Unbounded);
            assert_band_at_decoders_match_reference(&r, PatternMode::CoveringMerge);

            // Direct spot-check of the predicates against the known boarding bytes.
            let idx = Index::build(&r, PatternMode::Unbounded).unwrap();
            assert_eq!(idx.routes.len(), 1);
            assert_eq!(idx.routes[0].stop_ids, vec![0u32, 1, 2]);
            assert_eq!(r.band_pickup_forbidden(0, 0), Some(false), "s0 pickup ok");
            assert_eq!(
                r.band_pickup_forbidden(0, 1),
                Some(true),
                "s1 pickup forbidden"
            );
            assert_eq!(
                r.band_drop_off_forbidden(0, 1),
                Some(false),
                "s1 drop-off ok"
            );
            assert_eq!(
                r.band_drop_off_forbidden(0, 2),
                Some(true),
                "s2 drop-off forbidden"
            );
        }

        /// A truncated `0x12 PatternSemantics` region is REJECTED at load with a
        /// typed `PatternBandInvalid`, matching the TS loader's exact-size gate.
        /// Without the load-time gate, the Rust hot path (`band_pickup_forbidden_at`)
        /// would read an adjacent region's bytes as boarding flags while the TS
        /// materializer defaults a missing byte to regular — a same-bytes Rust↔TS
        /// boarding divergence. This pins fail-closed parity.
        #[test]
        fn gate_rejects_truncated_pattern_semantics_length() {
            use crate::engine::testkit::build_pattern_band_ptb_with_boarding;
            let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)]];
            // s1 forbids pickup, s2 forbids drop-off ⇒ a non-omitted 0x12 region.
            let boarding: &[u8] = &[0x50, 0x01, 0x04];
            // Positive control: the well-formed fixture loads and carries 0x12.
            let good = build_pattern_band_ptb_with_boarding(
                &stops(3),
                &route_r0(),
                trips,
                &[],
                boarding,
                &[],
            );
            {
                let r = crate::Reader::from_bytes(good.clone()).expect("well-formed 0x12 loads");
                assert!(r.has_pattern_semantics(), "fixture carries 0x12");
                assert_eq!(
                    r.pattern_semantics().map(<[u8]>::len),
                    Some(3),
                    "0x12 = Σ stop_count over non-all-regular patterns (one 3-stop pattern)",
                );
            }
            // Shrink the 0x12 table-entry length by 1 B (declared 3 → 2): the
            // per-pattern Σ stop_count (3) no longer matches ⇒ hard reject.
            let mut bytes = good;
            // Walk the tagged table (24 B entries from offset 32) to the 0x12 entry;
            // `length u64 @ entry+16`.
            let mut e = 32usize;
            let semantics_id = crate::region_ids::PATTERN_SEMANTICS;
            loop {
                let id = u16::from_le_bytes(bytes[e..e + 2].try_into().unwrap());
                assert_ne!(id, 0, "0x12 PatternSemantics entry not found");
                if id == semantics_id {
                    let cur = u32::from_le_bytes(bytes[e + 16..e + 20].try_into().unwrap());
                    assert_eq!(cur, 3, "fixture 0x12 length is 3 before truncation");
                    bytes[e + 16..e + 20].copy_from_slice(&(cur - 1).to_le_bytes());
                    break;
                }
                e += 24;
            }
            match crate::Reader::from_bytes(bytes) {
                Err(crate::PtbError::PatternBandInvalid {
                    reason: "patternSemantics length",
                }) => {}
                Err(other) => {
                    panic!("expected PatternBandInvalid(patternSemantics length), got {other:?}")
                }
                Ok(_) => panic!("expected from_bytes to reject the truncated 0x12 length"),
            }
        }

        /// THE all-regular-skip offset coverage (B1.5-T1 mutation-resistance).
        ///
        /// `band_semantics_byte`'s per-pattern `0x12` offset sums `stop_count`
        /// only over EARLIER patterns that are NOT all-regular — an all-regular
        /// pattern (`Patterns.flags.bit0`) emits ZERO `0x12` bytes despite having
        /// stops (`pattern_emit.rs:170-178`). Every other band test is either
        /// single-pattern (`band_decode_matches_flat_with_boarding`, `pattern_idx`
        /// always 0 so the offset loop never iterates) or all-regular (the `0x12`
        /// region is omitted and the decode short-circuits before the loop), so
        /// none of them exercises the skip. This one does: an all-regular pattern
        /// (ordinal 0) PRECEDES a non-regular pattern (ordinal 1) that carries the
        /// only `0x12` bytes, so the later pattern's offset MUST be 0, not
        /// pattern-0's `stop_count`.
        ///
        /// Mutation guard: with the naive offset `Σ all earlier stop_count`
        /// (dropping the all-regular skip), pattern 1's base becomes pattern-0's
        /// `stop_count` (3). `sem[3+0]` reads the WRONG (valid, regular) byte for
        /// position 0 — flipping `band_pickup_forbidden(1, 0)` from `true` to
        /// `false` — and `sem[3+pos]` runs OFF the 5-byte `0x12` region for the
        /// later positions → `None`. Either way this test fails under the
        /// mutation, so a latent multi-pattern boarding-offset bug cannot ship.
        #[test]
        fn band_all_regular_pattern_contributes_zero_0x12_bytes() {
            use crate::engine::testkit::build_pattern_band_ptb_with_boarding;
            // Two trips on route R0 with DISTINCT signatures → two patterns
            // (first-appearance order: trip 0 → pattern 0, trip 1 → pattern 1,
            // matching `band_branch_split_two_patterns`):
            //   trip 0  [s0,s1,s5]        → pattern 0, all-regular  (rows 0,1,2)
            //   trip 1  [s0,s1,s2,s3,s4]  → pattern 1, non-regular  (rows 3..8)
            // Pattern 0 has FEWER stops (3) than pattern 1 (5), so the naive
            // base=3 still lands in-range for pos 0 (a valid WRONG byte, the
            // strongest bite) and runs off the end for pos>=2 (a None bite).
            let trips: &[&[(u16, u32, u32)]] = &[
                &[(1, 0, 25200), (2, 1, 25500), (6, 5, 25800)],
                &[
                    (1, 0, 28800),
                    (2, 1, 29100),
                    (3, 2, 29400),
                    (4, 3, 29700),
                    (5, 4, 30000),
                ],
            ];
            // Flat 0xFA, one byte per stop_time row (8 rows, flat order):
            //   rows 0,1,2 (pattern 0 = all-regular): default 0x50 (low nibble 0x0)
            //   row 3 (pattern 1, pos 0 = s0): pickup forbidden  → 0x01
            //   row 6 (pattern 1, pos 3 = s3): drop-off forbidden → 0x04
            //   the remaining pattern-1 rows: default 0x50
            // → pattern 1's 0x12 bytes (low nibble) = [0x01, 0x00, 0x00, 0x04, 0x00].
            let boarding: &[u8] = &[
                0x50, 0x50, 0x50, // pattern 0 rows (all-regular)
                0x01, 0x50, 0x50, 0x04, 0x50, // pattern 1 rows
            ];
            let bytes = build_pattern_band_ptb_with_boarding(
                &stops(6),
                &route_r0(),
                trips,
                &[],
                boarding,
                &[],
            );
            let r = crate::Reader::from_bytes(bytes).expect("band+boarding decode");
            assert!(r.pattern_band_present(), "fixture carries the band");
            assert!(
                r.has_pattern_semantics(),
                "non-regular boarding ⇒ 0x12 present",
            );

            // Confirm the pattern layout: ordinal 0 all-regular, ordinal 1 not.
            let pats = r.patterns().expect("patterns present");
            assert_eq!(pats.len(), 2, "two distinct signatures → two patterns");
            assert_eq!(
                pats[0].flags & crate::reader::PATTERN_FLAG_ALL_REGULAR,
                crate::reader::PATTERN_FLAG_ALL_REGULAR,
                "pattern 0 is all-regular (emits zero 0x12 bytes)",
            );
            assert_eq!(pats[0].stop_count, 3, "pattern 0 has 3 stops");
            assert_eq!(
                pats[1].flags & crate::reader::PATTERN_FLAG_ALL_REGULAR,
                0,
                "pattern 1 is NOT all-regular (carries the 0x12 bytes)",
            );
            assert_eq!(pats[1].stop_count, 5, "pattern 1 has 5 stops");
            // The 0x12 region holds ONLY pattern 1's 5 bytes (pattern 0 omitted).
            assert_eq!(
                r.pattern_semantics().map(<[u8]>::len),
                Some(5),
                "0x12 carries only the non-regular pattern's bytes",
            );

            // Index layout sanity (Unbounded == the band's native ordinals).
            let idx = Index::build(&r, PatternMode::Unbounded).unwrap();
            assert_eq!(idx.routes.len(), 2);
            assert_eq!(idx.routes[0].stop_ids, vec![0u32, 1, 5]);
            assert_eq!(idx.routes[1].stop_ids, vec![0u32, 1, 2, 3, 4]);

            // ── THE assertions that bite the naive offset. ───────────────────
            // Pattern 0 (all-regular) → every position regular.
            for pos in 0..3 {
                assert_eq!(
                    r.band_pickup_forbidden(0, pos),
                    Some(false),
                    "pattern 0 pos {pos}: regular pickup",
                );
                assert_eq!(
                    r.band_drop_off_forbidden(0, pos),
                    Some(false),
                    "pattern 0 pos {pos}: regular drop-off",
                );
            }
            // Pattern 1 (non-regular): offset MUST be 0 (pattern 0 skipped).
            //   pos 0 forbids pickup; pos 3 forbids drop-off; rest regular.
            // The valid-WRONG-byte bite: naive base=3 reads sem[3] (0x04 →
            // drop-off, NOT pickup) for pos 0, so the correct `true` here flips.
            assert_eq!(
                r.band_pickup_forbidden(1, 0),
                Some(true),
                "pattern 1 pos 0: pickup forbidden (offset must be 0, not 3)",
            );
            assert_eq!(
                r.band_drop_off_forbidden(1, 0),
                Some(false),
                "pattern 1 pos 0: drop-off ok",
            );
            assert_eq!(
                r.band_pickup_forbidden(1, 1),
                Some(false),
                "pattern 1 pos 1: pickup ok",
            );
            assert_eq!(
                r.band_drop_off_forbidden(1, 3),
                Some(true),
                "pattern 1 pos 3: drop-off forbidden",
            );
            assert_eq!(
                r.band_pickup_forbidden(1, 3),
                Some(false),
                "pattern 1 pos 3: pickup ok",
            );
            // The None bite: naive base=3 runs sem[3+4]=sem[7] off the 5-byte
            // region for pos 4, so the correct regular `false` becomes `None`.
            assert_eq!(
                r.band_drop_off_forbidden(1, 4),
                Some(false),
                "pattern 1 pos 4: regular (naive base=3 reads off-region → None)",
            );
            assert_eq!(
                r.band_semantics_byte(1, 0),
                Some(0x01),
                "pattern 1 pos 0 byte (offset 0)",
            );
            assert_eq!(
                r.band_semantics_byte(1, 3),
                Some(0x04),
                "pattern 1 pos 3 byte (offset 0)",
            );

            // The fixture is a REAL band (band == flat over every pos/trip),
            // so the boarding bytes above are decoded the same way the scan
            // would read the flat 0xFA carry.
            assert_band_decode_matches_flat(&r);
            // Drive Finding 1's hot-path `_forbidden_at` coverage through the
            // all-regular-skip `semantics_base` (pattern 1 carries the only `0x12`
            // bytes at base 0): the `_at` decoders must agree with the reference at
            // pattern 1's forbidden pickup (pos 0) and drop-off (pos 3).
            assert_band_at_decoders_match_reference(&r, PatternMode::Unbounded);
            assert_band_at_decoders_match_reference(&r, PatternMode::CoveringMerge);
        }

        // ── B1.5-T4a: carry-LESS reader + band-sourced structural arrays ──────
        //
        // A band bundle with the flat carry (`0xF4`/`0xF5`/`0xF6`/`0xFA`)
        // STRIPPED must (a) LOAD, and (b) build an Index — under Unbounded AND
        // CoveringMerge — IDENTICAL to the one built over the carry-BEARING bundle
        // (same routes/patterns/membership/`pos_to_row`/`BandCoords`), and `plan()`
        // must return identical itineraries. `Off` over a stripped bundle legitimately
        // needs the carry and must fail CLEANLY (a typed Err, never a panic).
        mod carry_less {
            use super::*;
            use crate::engine::scan::ScanState;
            use crate::engine::types::{Mobility, Query, StopWalk};

            const CARRY_IDS: &[u16] = &[0xF4, 0xF5, 0xF6, 0xFA];

            /// `(carry_bearing_bytes, carry_less_bytes)` for the same band topology.
            fn pair(
                n_stops: u32,
                trips: &[&[(u16, u32, u32)]],
                sentinel_rows: &[usize],
            ) -> (Vec<u8>, Vec<u8>) {
                let full =
                    build_pattern_band_ptb(&stops(n_stops), &route_r0(), trips, sentinel_rows);
                let stripped =
                    crate::strip_regions::strip_regions(full.clone(), CARRY_IDS).expect("strip");
                (full, stripped)
            }

            /// Structural + decoded-value equality of two band-built indexes, over the
            /// carry-bearing reader `ra` and the carry-less reader `rb`.
            ///
            /// It compares the route fields (`stop_ids`, `reader_route_idx`,
            /// `route_idx`, `route_type`, `mode`), the per-trip fields (`trip_idx`,
            /// `service_idx`, wheelchair, bikes, and the `pos_to_row` markers), the
            /// `BandCoords` LOGICAL fields (`local_t`, `offset`, the slab dimensions
            /// `big_t`,`s`,`dep_off`,`dwell_off`,`served_off`, and the band-present
            /// flag), and the whole `routes_at_stop` value-array map (order included).
            ///
            /// `BandCoords.slab.slab_off` and `semantics_base` are ABSOLUTE byte offsets
            /// into their OWN bundle — they legitimately differ after `strip_regions`
            /// re-packs bodies — so they are NOT compared raw. Instead the DECODED
            /// departure, arrival, served, pickup-forbidden and drop-off-forbidden at
            /// every canonical position are compared through each index's own reader
            /// (the load-bearing equivalence: the band reads identical times and
            /// boarding carry-less).
            fn assert_index_eq(
                ra: &crate::Reader<Vec<u8>>,
                a: &Index,
                rb: &crate::Reader<Vec<u8>>,
                b: &Index,
            ) {
                assert_eq!(a.routes.len(), b.routes.len(), "route count");
                for (rt_a, rt_b) in a.routes.iter().zip(b.routes.iter()) {
                    assert_eq!(rt_a.route_idx, rt_b.route_idx, "route_idx");
                    assert_eq!(
                        rt_a.reader_route_idx, rt_b.reader_route_idx,
                        "reader_route_idx"
                    );
                    assert_eq!(rt_a.route_type, rt_b.route_type, "route_type");
                    assert_eq!(rt_a.mode, rt_b.mode, "mode");
                    assert_eq!(rt_a.stop_ids, rt_b.stop_ids, "stop_ids");
                    assert_eq!(rt_a.trips.len(), rt_b.trips.len(), "trip count");
                    let n_pos = rt_a.stop_ids.len();
                    for (ta, tb) in rt_a.trips.iter().zip(rt_b.trips.iter()) {
                        assert_eq!(ta.trip_idx, tb.trip_idx, "trip_idx");
                        assert_eq!(ta.service_idx, tb.service_idx, "service_idx");
                        assert_eq!(
                            ta.wheelchair_accessible, tb.wheelchair_accessible,
                            "wheelchair"
                        );
                        assert_eq!(ta.bikes_allowed, tb.bikes_allowed, "bikes_allowed");
                        assert_eq!(ta.pos_to_row, tb.pos_to_row, "pos_to_row markers");
                        match (ta.band.as_ref(), tb.band.as_ref()) {
                            (Some(ba), Some(bb)) => {
                                // LOGICAL band coords (offset-independent).
                                assert_eq!(ba.local_t, bb.local_t, "BandCoords.local_t");
                                assert_eq!(ba.offset, bb.offset, "BandCoords.offset");
                                assert_eq!(ba.slab.big_t, bb.slab.big_t, "slab.big_t");
                                assert_eq!(ba.slab.s, bb.slab.s, "slab.s");
                                assert_eq!(ba.slab.dep_off, bb.slab.dep_off, "slab.dep_off");
                                assert_eq!(ba.slab.dwell_off, bb.slab.dwell_off, "slab.dwell_off");
                                assert_eq!(
                                    ba.slab.served_off, bb.slab.served_off,
                                    "slab.served_off"
                                );
                                assert_eq!(
                                    ba.semantics_base.is_some(),
                                    bb.semantics_base.is_some(),
                                    "BandCoords.semantics_base presence"
                                );
                                // DECODED equivalence at every served position: the
                                // band reads identical times/boarding carry-less (the
                                // absolute `slab_off`/`semantics_base` differ because the
                                // re-packed bundle places the band at a new offset).
                                let lt = ba.local_t as usize;
                                for pos in 0..n_pos {
                                    if ta.pos_to_row[pos] == -1 {
                                        continue; // not served at this canonical pos
                                    }
                                    let bp = pos - ba.offset as usize;
                                    assert_eq!(
                                        ra.band_dep_at(&ba.slab, lt, bp),
                                        rb.band_dep_at(&bb.slab, lt, bp),
                                        "band dep at trip {} pos {pos}",
                                        ta.trip_idx
                                    );
                                    assert_eq!(
                                        ra.band_arr_at(&ba.slab, lt, bp),
                                        rb.band_arr_at(&bb.slab, lt, bp),
                                        "band arr at trip {} pos {pos}",
                                        ta.trip_idx
                                    );
                                    assert_eq!(
                                        ra.band_served_at(&ba.slab, lt, bp),
                                        rb.band_served_at(&bb.slab, lt, bp),
                                        "band served at trip {} pos {pos}",
                                        ta.trip_idx
                                    );
                                    assert_eq!(
                                        ra.band_pickup_forbidden_at(ba.semantics_base, bp),
                                        rb.band_pickup_forbidden_at(bb.semantics_base, bp),
                                        "band pickup_forbidden at trip {} pos {pos}",
                                        ta.trip_idx
                                    );
                                    assert_eq!(
                                        ra.band_drop_off_forbidden_at(ba.semantics_base, bp),
                                        rb.band_drop_off_forbidden_at(bb.semantics_base, bp),
                                        "band drop_off_forbidden at trip {} pos {pos}",
                                        ta.trip_idx
                                    );
                                }
                            }
                            (None, None) => {}
                            _ => panic!("one trip is band-built, the other is not"),
                        }
                    }
                }
                // routes_at_stop: same key set + same value-array order per key.
                assert_eq!(
                    a.routes_at_stop.len(),
                    b.routes_at_stop.len(),
                    "routes_at_stop key count"
                );
                for (s, av) in &a.routes_at_stop {
                    let bv = b
                        .routes_at_stop
                        .get(s)
                        .unwrap_or_else(|| panic!("routes_at_stop missing stop {s}"));
                    assert_eq!(av, bv, "routes_at_stop[{s}] value array (order incl.)");
                }
            }

            /// `plan()` over both readers (built from the SAME query) must agree.
            fn assert_plan_eq(
                rf: &crate::Reader<Vec<u8>>,
                idx_f: &Index,
                rs: &crate::Reader<Vec<u8>>,
                idx_s: &Index,
                from: &str,
                to: &str,
                dep: i64,
            ) {
                let mk = |r: &crate::Reader<Vec<u8>>| -> Query {
                    Query {
                        excluded_routes: Default::default(),
                        entry_stops: vec![StopWalk {
                            stop: r.stop_index(from).expect("from stop"),
                            walk_secs: 0,
                        }],
                        exit_stops: vec![StopWalk {
                            stop: r.stop_index(to).expect("to stop"),
                            walk_secs: 0,
                        }],
                        departure_secs: dep,
                        date: 20260601,
                        max_rounds: None,
                        mobility: Mobility::Default,
                        excluded_modes: vec![],
                        walk_speed_mm_s: None,
                        min_transfer_secs: None,
                    }
                };
                let mut sf = ScanState::default();
                let mut ss = ScanState::default();
                let itin_f = crate::plan(rf, idx_f, None, &mut sf, &mk(rf)).expect("plan full");
                let itin_s = crate::plan(rs, idx_s, None, &mut ss, &mk(rs)).expect("plan stripped");
                assert_eq!(
                    itin_f, itin_s,
                    "plan itineraries identical (band == carry-less)"
                );
                assert!(
                    !itin_f.is_empty(),
                    "the representative query routes (non-vacuous)"
                );
            }

            /// The canonical proof for a topology under one mode: load the stripped
            /// bundle, assert the index equals the carry-bearing one, and `plan()`
            /// the representative query identically.
            fn prove(
                n_stops: u32,
                trips: &[&[(u16, u32, u32)]],
                sentinel_rows: &[usize],
                mode: PatternMode,
                from: &str,
                to: &str,
                dep: i64,
            ) {
                let (full, stripped) = pair(n_stops, trips, sentinel_rows);
                let rf = crate::Reader::from_bytes(full).expect("carry-bearing decodes");
                let rs = crate::Reader::from_bytes(stripped).expect("carry-LESS decodes");
                assert!(rs.pattern_band_present(), "stripped keeps the band");
                assert!(!rs.has_boarding(), "0xFA stripped");

                // ── Synthesized `trip_starts` is EXACTLY the per-trip band-position
                //    prefix-sum (independently recomputed from the band here, so a
                //    wrong accumulation in `synthesize_carry_from_band` fails). It is
                //    monotonic and `last == num_stop_times()`. ──
                let ts = rs.trip_starts().expect("synth trip_starts");
                assert_eq!(ts.len(), trips.len() + 1, "trip_starts length");
                let mut expected = alloc::vec![0u32];
                let mut acc = 0u32;
                for t in 0..rs.num_trips() {
                    let pidx = rs.trip_pattern_idx(t).expect("0x14 pattern_idx") as usize;
                    acc += rs.pattern_stops(pidx).expect("0x11 pattern stops").len() as u32;
                    expected.push(acc);
                }
                assert_eq!(
                    ts,
                    expected.as_slice(),
                    "synth trip_starts == band-position prefix-sum"
                );
                assert!(ts.windows(2).all(|w| w[0] <= w[1]), "trip_starts monotonic");
                assert_eq!(
                    *ts.last().unwrap() as usize,
                    rs.num_stop_times(),
                    "synth tripStarts last == num_stop_times"
                );

                // ── Synthesized route→trips CSR EQUALS the carry CSR (same membership
                //    AND value-array order), so the route iteration is identical. ──
                for r in 0..rf.num_routes() {
                    assert_eq!(
                        rs.route_trips(r).expect("synth route_trips"),
                        rf.route_trips(r).expect("carry route_trips"),
                        "synth route_trips({r}) == carry route_trips"
                    );
                }

                // Build the BAND path directly on both sides. We bypass the `build`
                // dispatcher because under `--features pattern-crosscheck` it ALSO
                // builds the flat oracle (`assert_band_matches_flat`), which reads the
                // flat carry — impossible on the carry-LESS bundle (there is no flat to
                // cross-check against). `build_from_band` is exactly the path the
                // dispatcher would take here (`band && mode != Off`).
                let idx_f = Index::build_from_band(&rf, mode).expect("band index over carry");
                let idx_s = Index::build_from_band(&rs, mode).expect("band index over carry-less");
                assert_index_eq(&rf, &idx_f, &rs, &idx_s);
                assert_plan_eq(&rf, &idx_f, &rs, &idx_s, from, to, dep);
            }

            /// Branch topology (LOCAL [s0,s1,s2,s4] + BRANCH [s0,s1,s3,s4]) → two
            /// patterns. Unbounded + CoveringMerge.
            #[test]
            fn branch_unbounded_and_covering() {
                let trips: &[&[(u16, u32, u32)]] = &[
                    &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)],
                    &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)],
                ];
                prove(5, trips, &[], PatternMode::Unbounded, "s0", "s4", 25000);
                prove(5, trips, &[], PatternMode::CoveringMerge, "s0", "s4", 25000);
            }

            /// LASSO / repeated-stop topology (Vilnius 6G: a trip revisits s1).
            /// Stem-board → apex alignment must survive carry-less. The 5-trip
            /// branch/lasso/express-skip/skip-pos-0 cohort exercises sentinel rows.
            #[test]
            fn lasso_cohort_unbounded_and_covering() {
                // trip 0 LOCAL [0,1,2,4]; 1 BRANCH [0,1,3,4]; 2 LASSO [0,1,2,1,4];
                // 3 EXPRESS-SKIP (sig [0,1,2,4], s2 row 15 poked); 4 SKIP-POS-0
                // (s0 row 17 poked). Rows: trips 0/1/2 = 4+4+5 = 13; trip 3 13..17;
                // trip 4 17..21. Sentinel rows = [15, 17].
                let trips: &[&[(u16, u32, u32)]] = &[
                    &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)],
                    &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)],
                    &[
                        (1, 0, 32400),
                        (2, 1, 32700),
                        (3, 2, 33000),
                        (4, 1, 33300),
                        (5, 4, 33600),
                    ],
                    &[(1, 0, 36000), (2, 1, 36300), (3, 2, 36600), (4, 4, 36900)],
                    &[(1, 0, 39600), (2, 1, 39900), (3, 2, 40200), (4, 4, 40500)],
                ];
                prove(
                    5,
                    trips,
                    &[15, 17],
                    PatternMode::Unbounded,
                    "s0",
                    "s4",
                    25000,
                );
                prove(
                    5,
                    trips,
                    &[15, 17],
                    PatternMode::CoveringMerge,
                    "s0",
                    "s4",
                    25000,
                );
            }

            /// `Off` over a carry-less bundle BUILDS.
            ///
            /// This test previously asserted the opposite — that `Off` "legitimately
            /// needs the flat carry" and must fail — which is what kept the defect
            /// invisible: `Index::build` dispatches `Off` to the flat path on every
            /// bundle, so `Off` + carry-less is a reachable production configuration
            /// (a rollback of `--pattern-mode` on a generation), not an
            /// unsupported one. Codifying the failure as intended behaviour turned a
            /// bug into a spec.
            ///
            /// Two stripped-region reads had to go: the `0xF6` stop→routes CSR in
            /// Pin 5 (now derived from each route's canonical `stop_ids`) and
            /// `Reader::dep_secs`, which lacked the band dispatch its `stop_time`
            /// twin has.
            #[test]
            fn off_mode_builds_over_a_carry_less_bundle() {
                let trips: &[&[(u16, u32, u32)]] = &[
                    &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
                    &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
                ];
                let (full, stripped) = pair(3, trips, &[]);
                let rf = crate::Reader::from_bytes(full).expect("carry-BEARING decodes");
                let rs = crate::Reader::from_bytes(stripped).expect("carry-LESS decodes");
                assert!(!rf.is_carry_less_band());
                assert!(rs.is_carry_less_band());

                let carry_less = match Index::build(&rs, PatternMode::Off) {
                    Ok(ix) => ix,
                    Err(e) => panic!("Off must build over a carry-less bundle: {e:?}"),
                };
                let carry_bearing = Index::build(&rf, PatternMode::Off)
                    .expect("Off builds over the carry-bearing pair");

                // Same feed, both formats: the routes must come out identical.
                assert_eq!(
                    carry_less.routes.len(),
                    carry_bearing.routes.len(),
                    "route count diverges between the carry-less and carry-bearing pair"
                );
                for (i, (a, b)) in carry_less
                    .routes
                    .iter()
                    .zip(carry_bearing.routes.iter())
                    .enumerate()
                {
                    assert_eq!(a.stop_ids, b.stop_ids, "route {i} canonical stop_ids");
                    assert_eq!(a.trips.len(), b.trips.len(), "route {i} trip count");
                }
                assert!(
                    !carry_less.routes_at_stop.is_empty(),
                    "routes_at_stop must be derived, not left empty — an empty map is a \
                     silently unroutable index"
                );
                // NOTE: `routes_at_stop` itself is NOT compared against the pair here.
                // `pair()`'s carry-bearing half is testkit-built, and the testkit writes
                // a PLACEHOLDER stop→routes CSR (`sr_values = (0..num_stops).map(|_| 0)`
                // — every stop lists route 0), so the carry-bearing side reads a table
                // that was never real. The derivation is checked against a genuine
                // producer-emitted CSR in `off_routes_at_stop_derivation_matches_the_csr`.
            }

            // ── Cross-route synth-CSR coverage (review I-2) ──────────────────────
            //
            // Every OTHER carry-less fixture builds over `route_r0()` (a SINGLE GTFS
            // route), so every trip's `0xF2 TripsIntern` `route_idx` is 0 — the
            // counting-sort in `synthesize_carry_from_band` only ever fills route
            // 0's one bucket, leaving its CROSS-ROUTE math (the `rt_offsets`
            // prefix-sum that places route ≥1's trips at the correct NON-ZERO base,
            // and the per-route `cursor`) wholly unexercised. This builds a band
            // bundle over THREE routes, pokes ≥2 distinct `route_idx` values into the
            // surviving `0xF2` region (route_idx is `u32 @ t*24+8`; `0xF2` is NOT in
            // CARRY_IDS so it survives `strip_regions` byte-identical — see the
            // strip_regions round-trip test), loads carry-less so the synth runs, and
            // asserts each route's `route_trips(r)` is EXACTLY its matching trips in
            // ascending trip-ordinal order. The bundle is intentionally artificial:
            // the band grouping (`0x14`/`0x46`) is unchanged and `route_trips` is the
            // ONLY consumer of the poked `0xF2 route_idx`, so this isolates the
            // counting-sort's cross-route partition/offset math, not band/0xF2
            // consistency. Mutating the `rt_offsets` prefix-sum or the `cursor` base
            // in `synthesize_carry_from_band` makes this FAIL where the single-route
            // tests stay green.
            #[test]
            fn synth_csr_partitions_across_multiple_routes() {
                // THREE GTFS routes so num_routes==3 admits poked route_idx 0/1/2.
                let routes = alloc::vec![
                    crate::engine::testkit::SoaRoute {
                        id: "R0",
                        agency: "A0",
                        short: "0",
                        long: "Zero",
                        color: "",
                        text_color: "",
                        route_type: 3,
                    },
                    crate::engine::testkit::SoaRoute {
                        id: "R1",
                        agency: "A0",
                        short: "1",
                        long: "One",
                        color: "",
                        text_color: "",
                        route_type: 3,
                    },
                    crate::engine::testkit::SoaRoute {
                        id: "R2",
                        agency: "A0",
                        short: "2",
                        long: "Two",
                        color: "",
                        text_color: "",
                        route_type: 3,
                    },
                ];
                // 5 trips over s0..s2 (the band path & grouping are irrelevant to the
                // CSR poke; the builder hard-codes every trip to route 0 in 0xF2).
                let trips: &[&[(u16, u32, u32)]] = &[
                    &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
                    &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
                    &[(1, 0, 32400), (2, 1, 32700), (3, 2, 33000)],
                    &[(1, 0, 36000), (2, 1, 36300), (3, 2, 36600)],
                    &[(1, 0, 39600), (2, 1, 39900), (3, 2, 40200)],
                ];
                // Interleave the poked route ownership so every route's base is a
                // distinct non-zero prefix-sum and order is verified within a bucket:
                //   route 0 -> trips {0, 3}   (base 0)
                //   route 1 -> trips {1, 4}   (base 2 — cross-route offset)
                //   route 2 -> trip  {2}      (base 4 — cross-route offset)
                // The middle route landing at the WRONG base (off-by-one in the
                // prefix-sum) is exactly the gap the single-route tests miss.
                let route_of: [u32; 5] = [0, 1, 2, 0, 1];
                let mut expected: [alloc::vec::Vec<u32>; 3] =
                    [alloc::vec![], alloc::vec![], alloc::vec![]];
                for (t, &r) in route_of.iter().enumerate() {
                    expected[r as usize].push(t as u32); // ascending trip ordinal
                }

                let mut full = build_pattern_band_ptb(&stops(3), &routes, trips, &[]);

                // Poke route_idx (u32 @ t*24+8) into the surviving 0xF2 TripsIntern
                // region — located by id via the parsed header (region offsets are a
                // public surface; the literal 0xF2 mirrors the strip_regions test).
                {
                    let h = crate::header::Header::parse(&full).expect("full header");
                    let f2 = h.region_by_id(0xF2).expect("0xF2 TripsIntern present");
                    for (t, &r) in route_of.iter().enumerate() {
                        let o = f2.offset + t * crate::records::TRIP_RECORD_BYTES + 8;
                        full[o..o + 4].copy_from_slice(&r.to_le_bytes());
                    }
                }

                // Strip the flat carry (0xF2 is NOT dropped → the poke survives) and
                // load carry-less, which runs `synthesize_carry_from_band`.
                let stripped = crate::strip_regions::strip_regions(full, CARRY_IDS).expect("strip");
                let rs = crate::Reader::from_bytes(stripped).expect("carry-LESS decodes");
                assert_eq!(rs.num_routes(), 3, "three routes");
                assert_eq!(rs.num_trips(), 5, "five trips");

                // Each route's synthesized CSR slice == exactly its poked trips, in
                // ascending trip-ordinal order. Route 1/2's correctness is the
                // cross-route offset proof (non-zero `rt_offsets` base + cursor).
                for (r, want) in expected.iter().enumerate() {
                    assert_eq!(
                        rs.route_trips(r).expect("synth route_trips"),
                        want.as_slice(),
                        "synth route_trips({r}) partition (cross-route offset)"
                    );
                }
                // Belt-and-braces: the whole CSR is a permutation of 0..num_trips
                // with no trip dropped or duplicated across buckets.
                let mut all: alloc::vec::Vec<u32> =
                    expected.iter().flat_map(|v| v.iter().copied()).collect();
                all.sort_unstable();
                assert_eq!(
                    all,
                    (0..rs.num_trips() as u32).collect::<alloc::vec::Vec<_>>(),
                    "every trip placed exactly once"
                );
            }
        }
    }
}
