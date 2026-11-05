//! PTB v2 staging emission (not published).
//!
//! Builds the authoritative PTB v2 bundle plus its two v1 compatibility
//! artifacts (identity `bundle-v1.ptb` and deterministic `bundle-v1.ptb.gz`)
//! into a local staging directory. Publication stays disabled: nothing here
//! writes a manifest, pointer or generation directory, and the default build
//! path never calls it.
//!
//! ("PTB Version And Storage Contract", "Transfer Ingestion And Validation").
//!
//! The v2 bundle is assembled from the v1-layout bytes the existing producer
//! emits, so both lanes share one feed, schedule, service window and ordinal
//! space by construction:
//!
//! - the build anchor moves back [`GUARD_DAYS`] service dates so a query at the
//!   operational anchor already satisfies `Q >= origin[0] + max_event`;
//! - `0x18 ServiceDayOrigins` holds local noon minus 43,200 s per date in the
//!   feed's IANA zone (an ambiguous or nonexistent noon is an error);
//! - `0xF8` carries the explicit `transfers.txt` rows under the v2 contract
//!   (stopless type 4/5 kept, unknown scope ids dropped instead of broadened,
//!   exact duplicates removed, divergent primary keys tombstoned as type 3);
//! - `0x17 Frequencies` carries the v2 quarantine plan: a malformed or
//!   overlapping row quarantines its trip behind one marker row instead of
//!   letting it route as its scheduled template;
//! - `TripMeta.block_idx` names the source-scoped key
//!   `ptn:block:<feed_rank>:<base64url(block_id)>`;
//! - `0x19` is recomputed through `pt-core`'s own index builder and `0x1A`
//!   commits to the exact v1 identity and gzip bytes.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use jiff::ToSpan;
use pt_shared::tz::{date_from_ymd, resolve_time_zone};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::pass1::Pass1Result;

/// Service dates prepended before the operational anchor. Two days cover
/// every event below 47 elapsed hours; [`build_v2_bundle`] proves the guard
/// against the bundle's real event range and fails otherwise.
pub const GUARD_DAYS: u32 = 2;

const ABSENT: u32 = u32::MAX;

/// Counts reported for one v2 transfer ingestion.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TransferDiagnostics {
    pub rows_read: usize,
    pub rows_emitted: usize,
    pub by_type: [usize; 6],
    pub dropped_unknown_id: usize,
    pub dropped_malformed: usize,
    pub dropped_station_on_linked: usize,
    pub dropped_trip_route_mismatch: usize,
    pub exact_duplicates: usize,
    pub tombstones: usize,
    pub linked_stopless: usize,
    pub linked_boundary_mismatch: usize,
    pub station_rules: usize,
}

/// One validated v2 transfer row (absent = [`ABSENT`]), plus its source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V2TransferRow {
    pub from_stop: u32,
    pub to_stop: u32,
    pub from_route: u32,
    pub to_route: u32,
    pub from_trip: u32,
    pub to_trip: u32,
    pub min_secs: u32,
    pub transfer_type: u8,
}

impl V2TransferRow {
    fn key(&self) -> (u32, u32, u32, u32, u32, u32) {
        (
            self.from_stop,
            self.to_stop,
            self.from_trip,
            self.to_trip,
            self.from_route,
            self.to_route,
        )
    }

    fn to_bytes(self) -> [u8; 32] {
        let mut b = [0u8; 32];
        for (i, v) in [
            self.from_stop,
            self.to_stop,
            self.from_route,
            self.to_route,
            self.from_trip,
            self.to_trip,
            self.min_secs,
        ]
        .into_iter()
        .enumerate()
        {
            b[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
        b[28] = self.transfer_type;
        b
    }
}

/// Why a `frequencies.txt` row quarantined its trip (or was dropped).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FrequencyRule {
    /// `trip_id` blank or unknown: the row's scope cannot be resolved, so it
    /// is dropped (never broadened) and quarantines nothing.
    UnknownTrip,
    MalformedTime,
    InvalidHeadway,
    /// `headway_secs` above the PTB `u16` field.
    HeadwayOverflow,
    EmptyWindow,
    InvalidExactTimes,
    OverlappingWindows,
}

/// One typed frequency diagnostic. `line` is the 1-based CSV line (header =
/// line 1); `feed_rank` the component feed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FrequencyDiagnostic {
    pub feed_rank: u32,
    pub line: u64,
    pub trip_id: String,
    pub rule: FrequencyRule,
}

/// Counts and typed entries for one v2 frequency ingestion.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FrequencyDiagnostics {
    pub rows_read: usize,
    pub rows_emitted: usize,
    pub dropped_unknown_trip: usize,
    pub quarantined_trips: usize,
    pub diagnostics: Vec<FrequencyDiagnostic>,
}

/// The v2 `0x17 Frequencies` body: valid rows of healthy trips plus one
/// quarantine marker per quarantined trip, sorted by `(trip, start)`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct V2Frequencies {
    rows: Vec<(u32, u32, u32, u16, u8, u8)>,
}

impl V2Frequencies {
    fn region_body(&self) -> Option<Vec<u8>> {
        if self.rows.is_empty() {
            return None;
        }
        let mut b = Vec::with_capacity(4 + self.rows.len() * 16);
        b.extend_from_slice(&(self.rows.len() as u32).to_le_bytes());
        for &(t, st, en, h, x, f) in &self.rows {
            b.extend_from_slice(&t.to_le_bytes());
            b.extend_from_slice(&st.to_le_bytes());
            b.extend_from_slice(&en.to_le_bytes());
            b.extend_from_slice(&h.to_le_bytes());
            b.extend_from_slice(&[x, f]);
        }
        Some(b)
    }
}

/// Parse every feed's `frequencies.txt` under the v2 contract
/// (<https://gtfs.org/documentation/schedule/reference/#frequenciestxt>).
/// A malformed or overlapping row quarantines its whole trip with a typed
/// diagnostic: the trip is then never routed, rather than degrading into its
/// scheduled template. A row whose `trip_id` cannot be resolved is dropped.
pub fn parse_frequencies_v2(
    feed_dirs: &[PathBuf],
    p1: &Pass1Result,
) -> Result<(V2Frequencies, FrequencyDiagnostics)> {
    use std::collections::{BTreeMap, BTreeSet};
    let mut diag = FrequencyDiagnostics::default();
    // Valid rows per trip: (start, end, headway, exact, feed_rank, line, trip_id).
    type Row = (u32, u32, u16, u8, u32, u64, String);
    let mut by_trip: BTreeMap<u32, Vec<Row>> = BTreeMap::new();
    let mut quarantined: BTreeSet<u32> = BTreeSet::new();
    for (rank, dir) in feed_dirs.iter().enumerate() {
        let path = dir.join("frequencies.txt");
        if !path.exists() {
            continue;
        }
        let file = crate::csv_open::open_csv_skip_bom(&path)?;
        let mut rdr = csv::Reader::from_reader(file);
        let headers = rdr.headers()?.clone();
        let col = |n: &str| headers.iter().position(|h| h == n);
        let (ct, cs, ce, ch, cx) = (
            col("trip_id"),
            col("start_time"),
            col("end_time"),
            col("headway_secs"),
            col("exact_times"),
        );
        let mut record = csv::StringRecord::new();
        let mut line = 1u64;
        while rdr.read_record(&mut record)? {
            line += 1;
            diag.rows_read += 1;
            let field =
                |c: Option<usize>| c.and_then(|i| record.get(i)).map(str::trim).unwrap_or("");
            let trip_id = field(ct).to_string();
            let flag = |rule, trip_id: &str, d: &mut FrequencyDiagnostics| {
                d.diagnostics.push(FrequencyDiagnostic {
                    feed_rank: rank as u32,
                    line,
                    trip_id: trip_id.to_string(),
                    rule,
                });
            };
            let Some(trip) = (!trip_id.is_empty())
                .then(|| p1.trips.lookup(&trip_id))
                .flatten()
            else {
                diag.dropped_unknown_trip += 1;
                flag(FrequencyRule::UnknownTrip, &trip_id, &mut diag);
                continue;
            };
            let time = |c| {
                let v = field(c);
                (!v.is_empty())
                    .then(|| crate::pass2::parse_hms(v.as_bytes()).ok())
                    .flatten()
            };
            let rule = (|| {
                let (Some(st), Some(en)) = (time(cs), time(ce)) else {
                    return Err(FrequencyRule::MalformedTime);
                };
                let h = match field(ch).parse::<u32>() {
                    Ok(0) | Err(_) => return Err(FrequencyRule::InvalidHeadway),
                    Ok(h) if h > u16::MAX as u32 => return Err(FrequencyRule::HeadwayOverflow),
                    Ok(h) => h,
                };
                if st >= en {
                    return Err(FrequencyRule::EmptyWindow);
                }
                let x = match field(cx) {
                    "" | "0" => 0u8,
                    "1" => 1,
                    _ => return Err(FrequencyRule::InvalidExactTimes),
                };
                Ok((st, en, h as u16, x))
            })();
            match rule {
                Ok((st, en, h, x)) => by_trip.entry(trip).or_default().push((
                    st,
                    en,
                    h,
                    x,
                    rank as u32,
                    line,
                    trip_id,
                )),
                Err(rule) => {
                    flag(rule, &trip_id, &mut diag);
                    quarantined.insert(trip);
                }
            }
        }
    }
    for (trip, rows) in by_trip.iter_mut() {
        rows.sort_by_key(|r| (r.0, r.1));
        for w in rows.windows(2) {
            if w[1].0 < w[0].1 {
                for r in w {
                    diag.diagnostics.push(FrequencyDiagnostic {
                        feed_rank: r.4,
                        line: r.5,
                        trip_id: r.6.clone(),
                        rule: FrequencyRule::OverlappingWindows,
                    });
                }
                quarantined.insert(*trip);
            }
        }
    }
    let mut out = V2Frequencies::default();
    for (&trip, rows) in &by_trip {
        if quarantined.contains(&trip) {
            continue;
        }
        for r in rows {
            out.rows.push((trip, r.0, r.1, r.2, r.3, 0));
        }
    }
    for &trip in &quarantined {
        out.rows
            .push((trip, 0, 1, 1, 0, pt_core::v2::FREQUENCY_FLAG_QUARANTINED));
    }
    out.rows.sort_by_key(|r| (r.0, r.1));
    diag.rows_emitted = out.rows.len();
    diag.quarantined_trips = quarantined.len();
    diag.diagnostics.sort_by_key(|d| (d.feed_rank, d.line));
    // A row overlapping both neighbours is reported once.
    diag.diagnostics.dedup();
    Ok((out, diag))
}

/// Parse every feed's `transfers.txt` under the v2 contract, in canonical
/// order (feed order, then file row order). `boundaries[t]` is the trip's
/// `(initial_stop, terminal_stop)` from the v1 index.
///
/// GTFS reference: <https://gtfs.org/documentation/schedule/reference/#transferstxt>
pub fn parse_transfers_v2(
    feed_dirs: &[PathBuf],
    p1: &Pass1Result,
    boundaries: &[Option<(u32, u32)>],
) -> Result<(Vec<V2TransferRow>, TransferDiagnostics)> {
    let mut diag = TransferDiagnostics::default();
    let is_station: std::collections::HashSet<u32> =
        p1.stop_parent_map.iter().map(|&(_, p)| p).collect();
    let mut rows: Vec<V2TransferRow> = Vec::new();
    for dir in feed_dirs {
        let path = dir.join("transfers.txt");
        if !path.exists() {
            continue;
        }
        let file = crate::csv_open::open_csv_skip_bom(&path)?;
        let mut rdr = csv::Reader::from_reader(file);
        let headers = rdr.headers()?.clone();
        let col = |n: &str| headers.iter().position(|h| h == n);
        let (fs, ts, fr, tr, ft, tt, ty, mt) = (
            col("from_stop_id"),
            col("to_stop_id"),
            col("from_route_id"),
            col("to_route_id"),
            col("from_trip_id"),
            col("to_trip_id"),
            col("transfer_type"),
            col("min_transfer_time"),
        );
        let mut rec = csv::StringRecord::new();
        while rdr.read_record(&mut rec)? {
            diag.rows_read += 1;
            let raw = |i: Option<usize>| i.and_then(|i| rec.get(i)).map(str::trim).unwrap_or("");
            // Blank = absent; present but unknown = the scope cannot be
            // resolved, so the row is dropped rather than broadened.
            let resolve = |v: &str, t: &crate::pass1::identity::InternTable<String>| {
                if v.is_empty() {
                    Ok(ABSENT)
                } else {
                    t.lookup(v).ok_or(())
                }
            };
            let ids = (
                resolve(raw(fs), &p1.stops),
                resolve(raw(ts), &p1.stops),
                resolve(raw(fr), &p1.routes),
                resolve(raw(tr), &p1.routes),
                resolve(raw(ft), &p1.trips),
                resolve(raw(tt), &p1.trips),
            );
            let (
                Ok(from_stop),
                Ok(to_stop),
                Ok(from_route),
                Ok(to_route),
                Ok(from_trip),
                Ok(to_trip),
            ) = ids
            else {
                diag.dropped_unknown_id += 1;
                continue;
            };
            let transfer_type = match raw(ty) {
                "" => 0u8,
                v => match v.parse::<u8>() {
                    Ok(t) if t <= 5 => t,
                    _ => {
                        diag.dropped_malformed += 1;
                        continue;
                    }
                },
            };
            let min_secs = match raw(mt) {
                "" => ABSENT,
                v => match v.parse::<u32>() {
                    Ok(m) if m != ABSENT => m,
                    _ => {
                        diag.dropped_malformed += 1;
                        continue;
                    }
                },
            };
            let row = V2TransferRow {
                from_stop,
                to_stop,
                from_route,
                to_route,
                from_trip,
                to_trip,
                min_secs,
                transfer_type,
            };
            let linked = transfer_type >= 4;
            if linked {
                if from_trip == ABSENT || to_trip == ABSENT {
                    diag.dropped_malformed += 1;
                    continue;
                }
                if is_station.contains(&from_stop) || is_station.contains(&to_stop) {
                    diag.dropped_station_on_linked += 1;
                    continue;
                }
                if from_stop == ABSENT || to_stop == ABSENT {
                    diag.linked_stopless += 1;
                }
                let fb = boundaries.get(from_trip as usize).copied().flatten();
                let tb = boundaries.get(to_trip as usize).copied().flatten();
                if (from_stop != ABSENT && fb.is_some_and(|b| b.1 != from_stop))
                    || (to_stop != ABSENT && tb.is_some_and(|b| b.0 != to_stop))
                {
                    // Kept: the runtime yields no candidate for it.
                    diag.linked_boundary_mismatch += 1;
                }
            } else if from_stop == ABSENT || to_stop == ABSENT {
                diag.dropped_malformed += 1;
                continue;
            }
            if transfer_type == 2 && min_secs == ABSENT {
                diag.dropped_malformed += 1;
                continue;
            }
            let route_of = |t: u32| p1.trips_attrs[t as usize].route_idx;
            if (from_trip != ABSENT && from_route != ABSENT && route_of(from_trip) != from_route)
                || (to_trip != ABSENT && to_route != ABSENT && route_of(to_trip) != to_route)
            {
                diag.dropped_trip_route_mismatch += 1;
                continue;
            }
            rows.push(row);
        }
    }
    // Exact duplicates collapse; divergent rows sharing the six-field primary
    // key become one type-3 tombstone at that exact scope, in the position of
    // the key's first row.
    let mut first: HashMap<(u32, u32, u32, u32, u32, u32), usize> = HashMap::new();
    let mut out: Vec<V2TransferRow> = Vec::with_capacity(rows.len());
    let mut tomb: Vec<bool> = Vec::new();
    for r in rows {
        match first.get(&r.key()) {
            None => {
                first.insert(r.key(), out.len());
                out.push(r);
                tomb.push(false);
            }
            Some(&i) if out[i] == r => diag.exact_duplicates += 1,
            Some(&i) => {
                if !tomb[i] {
                    tomb[i] = true;
                    diag.tombstones += 1;
                }
            }
        }
    }
    for (i, r) in out.iter_mut().enumerate() {
        if !tomb[i] {
            continue;
        }
        if r.transfer_type >= 4 {
            // Materialize omitted linked stops from the validated boundaries.
            let fb = boundaries.get(r.from_trip as usize).copied().flatten();
            let tb = boundaries.get(r.to_trip as usize).copied().flatten();
            match (fb, tb) {
                (Some(f), Some(t)) => {
                    if r.from_stop == ABSENT {
                        r.from_stop = f.1;
                    }
                    if r.to_stop == ABSENT {
                        r.to_stop = t.0;
                    }
                }
                _ => {
                    return Err(Error::Config(
                        "ptb v2: cannot tombstone a linked conflict on an unroutable trip".into(),
                    ))
                }
            }
        }
        r.transfer_type = 3;
        r.min_secs = ABSENT;
    }
    for r in &out {
        diag.by_type[r.transfer_type as usize] += 1;
        if r.transfer_type < 4
            && (is_station.contains(&r.from_stop) || is_station.contains(&r.to_stop))
        {
            diag.station_rules += 1;
        }
    }
    diag.rows_emitted = out.len();
    Ok((out, diag))
}

/// `origin[i]` for `feed_start_date + i`, `i in 0..=days`: local noon minus
/// 43,200 s in `iana`. GTFS `Time` is measured from "noon minus 12h"
/// (<https://gtfs.org/documentation/schedule/reference/#field-types>).
pub fn service_day_origins(iana: &str, feed_start_date: u32, days: u32) -> Result<Vec<i64>> {
    let tz = resolve_time_zone(iana)
        .map_err(|_| Error::Config(format!("ptb v2: unknown IANA zone {iana:?}")))?;
    let start = date_from_ymd(feed_start_date)
        .ok_or_else(|| Error::Config(format!("ptb v2: bad feed start {feed_start_date}")))?;
    let mut out = Vec::with_capacity(days as usize + 1);
    for i in 0..=days {
        let date = start
            .checked_add(i64::from(i).days())
            .map_err(|_| Error::Config("ptb v2: date overflow".into()))?;
        let instant = tz
            .to_ambiguous_timestamp(date.at(12, 0, 0, 0))
            .unambiguous()
            .map_err(|_| {
                Error::Config(format!(
                    "ptb v2: local noon on {date} in {iana} is ambiguous or nonexistent"
                ))
            })?
            .as_second();
        out.push(
            instant
                .checked_sub(43_200)
                .ok_or_else(|| Error::Config("ptb v2: origin overflow".into()))?,
        );
    }
    Ok(out)
}

/// Deterministic gzip of the v1 compatibility bytes: level 6, mtime 0, no
/// file name, OS byte 255.
pub fn deterministic_gzip(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut enc = flate2::GzBuilder::new()
        .mtime(0)
        .operating_system(255)
        .write(Vec::new(), flate2::Compression::new(6));
    enc.write_all(bytes)?;
    Ok(enc.finish()?)
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Per-trip `(initial_stop, terminal_stop)` from a v1 bundle's routing index.
pub fn trip_boundaries(v1_bytes: &[u8]) -> Result<Vec<Option<(u32, u32)>>> {
    let reader = pt_core::Reader::from_bytes(v1_bytes.to_vec())
        .map_err(|e| Error::Config(format!("ptb v2: v1 decode: {e}")))?;
    let index = pt_core::engine::Index::build(&reader, pt_core::engine::PatternMode::CoveringMerge)
        .map_err(|e| Error::Config(format!("ptb v2: v1 index: {e:?}")))?;
    Ok(index.trip_boundary_stops(reader.num_trips()))
}

/// What one v2 staging build produced.
#[derive(Debug, serde::Serialize)]
pub struct V2Outcome {
    pub feed_start_date: u32,
    pub window_days: u16,
    pub guard_days: u32,
    pub derive_block_inseat: bool,
    pub derived_block_pair_date_count: u64,
    pub derived_block_index_sha256: String,
    pub bundle_sha256: String,
    pub bundle_size_bytes: u64,
    pub bundle_v1_sha256: String,
    pub bundle_v1_size_bytes: u64,
    pub bundle_v1_gzip_sha256: String,
    pub bundle_v1_gzip_size_bytes: u64,
    pub min_event_secs: i64,
    pub max_event_secs: i64,
    pub transfers: TransferDiagnostics,
    pub frequencies: FrequencyDiagnostics,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Assemble the v2 bundle from the v1 compatibility bytes (already built at
/// the guard-shifted anchor). Returns the v2 bytes and the v1 gzip bytes.
#[allow(clippy::too_many_arguments)]
pub fn build_v2_bundle(
    v1_bytes: &[u8],
    p1: &Pass1Result,
    rows: &[V2TransferRow],
    transfers_diag: TransferDiagnostics,
    frequencies: &V2Frequencies,
    frequencies_diag: FrequencyDiagnostics,
    iana: &str,
    derive_block_inseat: bool,
) -> Result<(Vec<u8>, Vec<u8>, V2Outcome)> {
    use pt_core::region_ids::{
        BLOCK_DERIVATION_COMMITMENT, COMPATIBILITY_ARTIFACT_COMMITMENT, FREQUENCIES,
        SERVICE_DAY_ORIGINS, TRIP_META,
    };
    use pt_core::RegionEdit;
    let reader = pt_core::Reader::from_bytes(v1_bytes.to_vec())
        .map_err(|e| Error::Config(format!("ptb v2: v1 decode: {e}")))?;
    if reader.version() != pt_core::PTB_VERSION_V1 {
        return Err(Error::Config(
            "ptb v2: compatibility input is not PTB v1".into(),
        ));
    }
    let header = reader.header();
    let feed_start = header.feed_start_date;
    let window_days = header.window_days;

    // Block keys -> StringPool; TripMeta.block_idx.
    let region = |id: u16| -> Result<&[u8]> {
        let e = header
            .region_by_id(id)
            .ok_or_else(|| Error::Config(format!("ptb v2: v1 bundle lacks region {id:#x}")))?;
        Ok(&v1_bytes[e.offset..e.offset + e.length])
    };
    let pool_body = region(0xF7)?;
    let count = u32::from_le_bytes(pool_body[0..4].try_into().unwrap()) as usize;
    let off_at =
        |i: usize| u32::from_le_bytes(pool_body[4 + 4 * i..8 + 4 * i].try_into().unwrap()) as usize;
    let blob = 4 + 4 * (count + 1);
    let mut strings: Vec<&str> = Vec::with_capacity(count);
    let mut index: HashMap<String, u32> = HashMap::with_capacity(count);
    for i in 0..count {
        let s = std::str::from_utf8(&pool_body[blob + off_at(i)..blob + off_at(i + 1)])
            .map_err(|_| Error::Config("ptb v2: StringPool UTF-8".into()))?;
        strings.push(s);
        index.entry(s.to_string()).or_insert(i as u32);
    }
    let mut extra: Vec<String> = Vec::new();
    let mut trip_meta = region(TRIP_META)?.to_vec();
    if trip_meta.len() != p1.trips_attrs.len() * 24 {
        return Err(Error::Config("ptb v2: TripMeta row count".into()));
    }
    for (t, a) in p1.trips_attrs.iter().enumerate() {
        if a.block_id.is_empty() {
            continue;
        }
        let key = pt_core::v2::block_key(a.feed_rank, &a.block_id);
        let idx = match index.get(&key) {
            Some(&i) => i,
            None => {
                let i = (count + extra.len()) as u32;
                index.insert(key.clone(), i);
                extra.push(key);
                i
            }
        };
        trip_meta[t * 24 + 16..t * 24 + 20].copy_from_slice(&idx.to_le_bytes());
    }
    let mut new_pool =
        Vec::with_capacity(pool_body.len() + extra.iter().map(|s| s.len() + 4).sum::<usize>());
    new_pool.extend_from_slice(&((count + extra.len()) as u32).to_le_bytes());
    let mut cur = 0u32;
    for s in strings
        .iter()
        .copied()
        .chain(extra.iter().map(String::as_str))
    {
        new_pool.extend_from_slice(&cur.to_le_bytes());
        cur = cur
            .checked_add(s.len() as u32)
            .ok_or_else(|| Error::Config("ptb v2: StringPool overflow".into()))?;
    }
    new_pool.extend_from_slice(&cur.to_le_bytes());
    for s in strings
        .iter()
        .copied()
        .chain(extra.iter().map(String::as_str))
    {
        new_pool.extend_from_slice(s.as_bytes());
    }

    let transfers: Vec<u8> = rows.iter().flat_map(|r| r.to_bytes()).collect();
    let origins = service_day_origins(iana, feed_start, window_days as u32)?;
    let origins_body: Vec<u8> = origins.iter().flat_map(|o| o.to_le_bytes()).collect();
    let gz = deterministic_gzip(v1_bytes)?;
    let compat = pt_core::v2::CompatibilityArtifactCommitment {
        algorithm_version: pt_core::v2::COMMITMENT_ALGORITHM_V1,
        v1_identity_size: v1_bytes.len() as u64,
        v1_gzip_size: gz.len() as u64,
        v1_identity_sha256: sha256(v1_bytes),
        v1_gzip_sha256: sha256(&gz),
    }
    .to_bytes();
    let flags = if derive_block_inseat {
        pt_core::FEATURE_DERIVE_BLOCK_INSEAT
    } else {
        0
    };
    let empty = pt_core::v2::BlockDerivationCommitment::EMPTY.to_bytes();
    // The v1 0x17 keeps its legacy row drops; v2 carries the quarantine plan.
    let freq_body = frequencies.region_body();
    let freq_edit = match &freq_body {
        Some(b) => RegionEdit::Set(FREQUENCIES, b),
        None => RegionEdit::Remove(FREQUENCIES),
    };
    let edits = [
        freq_edit,
        RegionEdit::Set(TRIP_META, &trip_meta),
        RegionEdit::Set(0xF7, &new_pool),
        RegionEdit::Set(0xF8, &transfers),
        RegionEdit::Set(SERVICE_DAY_ORIGINS, &origins_body),
        RegionEdit::Set(BLOCK_DERIVATION_COMMITMENT, &empty),
        RegionEdit::Set(COMPATIBILITY_ARTIFACT_COMMITMENT, &compat),
    ];
    let staged = pt_core::rewrite_regions(v1_bytes, pt_core::PTB_VERSION_V2, flags, &edits)
        .map_err(|e| Error::Config(format!("ptb v2: assemble: {e}")))?;
    let staged_reader = pt_core::Reader::from_bytes(staged.clone())
        .map_err(|e| Error::Config(format!("ptb v2: staged decode: {e}")))?;
    let commitment = pt_core::engine::v2::recompute_block_commitment(
        &staged_reader,
        pt_core::engine::PatternMode::CoveringMerge,
    )
    .map_err(|e| Error::Config(format!("ptb v2: block commitment: {e:?}")))?;
    let bundle = pt_core::rewrite_regions(
        &staged,
        pt_core::PTB_VERSION_V2,
        flags,
        &[RegionEdit::Set(
            BLOCK_DERIVATION_COMMITMENT,
            &commitment.to_bytes(),
        )],
    )
    .map_err(|e| Error::Config(format!("ptb v2: commit: {e}")))?;

    // Post-write validation in a separate builder execution: the reader and
    // index must accept the bytes, and the guard must make the operational
    // anchor (feedStartDate + GUARD_DAYS) a complete query instant.
    let final_reader = pt_core::Reader::from_bytes(bundle.clone())
        .map_err(|e| Error::Config(format!("ptb v2: final decode: {e}")))?;
    let final_index =
        pt_core::engine::Index::build(&final_reader, pt_core::engine::PatternMode::CoveringMerge)
            .map_err(|e| Error::Config(format!("ptb v2: final index: {e:?}")))?;
    let (min_event, max_event) = final_index
        .v2_event_range()
        .ok_or_else(|| Error::Config("ptb v2: index has no v2 state".into()))?;
    let anchor_origin = origins[GUARD_DAYS as usize];
    if anchor_origin < origins[0] + max_event {
        return Err(Error::Config(format!(
            "ptb v2: {GUARD_DAYS} guard days do not cover the {max_event} s event range"
        )));
    }
    let outcome = V2Outcome {
        feed_start_date: feed_start,
        window_days,
        guard_days: GUARD_DAYS,
        derive_block_inseat,
        derived_block_pair_date_count: commitment.pair_date_count,
        derived_block_index_sha256: hex(&commitment.tuples_sha256),
        bundle_sha256: hex(&sha256(&bundle)),
        bundle_size_bytes: bundle.len() as u64,
        bundle_v1_sha256: hex(&sha256(v1_bytes)),
        bundle_v1_size_bytes: v1_bytes.len() as u64,
        bundle_v1_gzip_sha256: hex(&sha256(&gz)),
        bundle_v1_gzip_size_bytes: gz.len() as u64,
        min_event_secs: min_event,
        max_event_secs: max_event,
        transfers: transfers_diag,
        frequencies: frequencies_diag,
    };
    Ok((bundle, gz, outcome))
}

/// Shift a `YYYYMMDD` date by `-days`.
pub fn date_minus(yyyymmdd: u32, days: u32) -> Result<u32> {
    let date = date_from_ymd(yyyymmdd)
        .and_then(|x| x.checked_sub(i64::from(days).days()).ok())
        .ok_or_else(|| Error::Config(format!("ptb v2: bad date {yyyymmdd}")))?;
    let year = u32::try_from(date.year())
        .map_err(|_| Error::Config("ptb v2: date shift precedes year zero".into()))?;
    Ok(year * 10000 + date.month() as u32 * 100 + date.day() as u32)
}

/// Build the three staging artifacts into `out_dir`: `bundle.ptb` (v2),
/// `bundle-v1.ptb`, `bundle-v1.ptb.gz`, plus `ptb-v2-staging.json`. The v1
/// lane is the ordinary producer output at `anchor - GUARD_DAYS`.
pub fn stage(
    feed_records: Vec<crate::download::FeedRecord>,
    extract_root: &Path,
    out_dir: &Path,
    anchor: u32,
    iana: &str,
    derive_inseat: crate::cli::DeriveInseat,
) -> Result<V2Outcome> {
    std::fs::create_dir_all(out_dir)?;
    let v1_path = out_dir.join("bundle-v1.ptb");
    let shifted = date_minus(anchor, GUARD_DAYS)?;
    let n = feed_records.len();
    crate::build::build_ptb(
        feed_records,
        extract_root,
        &v1_path,
        Some(shifted),
        None,
        Some(iana),
        derive_inseat,
    )?;
    let v1 = std::fs::read(&v1_path)?;
    let feed_dirs: Vec<PathBuf> = (0..n)
        .map(|i| extract_root.join(format!("feed-{i}")))
        .collect();
    let mut p1 = crate::pass1::run_pass1_union(&feed_dirs)?;
    p1.feed_start_date = shifted;
    let boundaries = trip_boundaries(&v1)?;
    let (rows, diag) = parse_transfers_v2(&feed_dirs, &p1, &boundaries)?;
    let (freqs, freq_diag) = parse_frequencies_v2(&feed_dirs, &p1)?;
    let derive = matches!(derive_inseat, crate::cli::DeriveInseat::Auto);
    let (bundle, gz, outcome) =
        build_v2_bundle(&v1, &p1, &rows, diag, &freqs, freq_diag, iana, derive)?;
    std::fs::write(out_dir.join("bundle.ptb"), &bundle)?;
    std::fs::write(out_dir.join("bundle-v1.ptb.gz"), &gz)?;
    std::fs::write(
        out_dir.join("ptb-v2-staging.json"),
        serde_json::to_vec_pretty(&outcome).map_err(|e| Error::Config(e.to_string()))?,
    )?;
    Ok(outcome)
}

/// Build the bundle the producer publishes: a PTB v2 bundle, the only published
/// PTB version. The guard-shifted v1 build supplies every sidecar and the
/// generation metadata; its bundle bytes are then replaced by the v2 assembly
/// written to `bundle_dest`, so `outcome.bundle_sha256` and the size describe
/// the v2 file. The window starts [`GUARD_DAYS`] before `anchor` (design §
/// "guard dates"): without them a query near the window start is incomplete.
///
/// Requires an IANA zone, since the v2 origins are local noon minus 12 h.
#[allow(clippy::too_many_arguments)]
pub fn build_published(
    feed_records: Vec<crate::download::FeedRecord>,
    extract_root: &Path,
    bundle_dest: &Path,
    anchor: u32,
    city_tz_offset_seconds: Option<i32>,
    iana: &str,
    derive_inseat: crate::cli::DeriveInseat,
) -> Result<crate::build::BuildOutcome> {
    let shifted = date_minus(anchor, GUARD_DAYS)?;
    let n = feed_records.len();
    let mut outcome = crate::build::build_ptb(
        feed_records,
        extract_root,
        bundle_dest,
        Some(shifted),
        city_tz_offset_seconds,
        Some(iana),
        derive_inseat,
    )?;
    let v1 = std::fs::read(bundle_dest)?;
    let feed_dirs: Vec<PathBuf> = (0..n)
        .map(|i| extract_root.join(format!("feed-{i}")))
        .collect();
    let mut p1 = crate::pass1::run_pass1_union(&feed_dirs)?;
    p1.feed_start_date = shifted;
    let boundaries = trip_boundaries(&v1)?;
    let (rows, diag) = parse_transfers_v2(&feed_dirs, &p1, &boundaries)?;
    let (freqs, freq_diag) = parse_frequencies_v2(&feed_dirs, &p1)?;
    let derive = matches!(derive_inseat, crate::cli::DeriveInseat::Auto);
    let (bundle, _gz, _v2) =
        build_v2_bundle(&v1, &p1, &rows, diag, &freqs, freq_diag, iana, derive)?;
    std::fs::write(bundle_dest, &bundle)?;
    outcome.bundle_sha256 = crate::build::sha256_hex(&bundle);
    outcome.bundle_size_bytes = bundle.len() as u64;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_follow_noon_minus_twelve_hours_across_dst() {
        // Europe/Paris falls back at 03:00 on 2026-10-25, inside the interval
        // from 2026-10-24's origin (noon CEST - 12 h) to 2026-10-25's (noon
        // CET - 12 h): 25 elapsed hours.
        let o = service_day_origins("Europe/Paris", 20261024, 2).unwrap();
        assert_eq!(o[1] - o[0], 90_000);
        assert_eq!(o[2] - o[1], 86_400);
        // 2026-10-24 noon CEST = 10:00 UTC; minus 12 h = 2026-10-23T22:00Z.
        assert_eq!(o[0], 1_792_792_800);
        let spring = service_day_origins("Europe/Paris", 20260328, 2).unwrap();
        assert_eq!(spring[1] - spring[0], 82_800);
        assert_eq!(spring[2] - spring[1], 86_400);
    }

    #[test]
    fn origins_reject_skipped_noon_and_out_of_range_dates() {
        // Apia skipped 2011-12-30 entirely. Do not silently normalize a
        // nonexistent GTFS service date while building the origin table.
        assert!(service_day_origins("Pacific/Apia", 20111230, 0).is_err());
        assert!(service_day_origins("Europe/Paris", 99991231, 1).is_err());
        assert!(service_day_origins("Europe/Paris", 100000101, 0).is_err());
    }

    #[test]
    fn every_malformed_frequency_row_quarantines_its_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        std::fs::write(
            d.join("stops.txt"),
            "stop_id,stop_name,stop_lat,stop_lon\nA,A,54.6,25.2\nB,B,54.7,25.3\n",
        )
        .unwrap();
        std::fs::write(d.join("routes.txt"), "route_id,route_type\nR,3\n").unwrap();
        std::fs::write(
            d.join("calendar.txt"),
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
             S,1,1,1,1,1,1,1,20260501,20260601\n",
        )
        .unwrap();
        let trips = ["OK", "TIME", "HW0", "HWBIG", "EMPTY", "EXACT", "ONDEP"];
        let mut t = String::from("route_id,service_id,trip_id\n");
        let mut st = String::from("trip_id,arrival_time,departure_time,stop_id,stop_sequence\n");
        for id in trips {
            t += &format!("R,S,{id}\n");
            st += &format!("{id},08:00:00,08:00:00,A,1\n{id},08:10:00,08:10:00,B,2\n");
        }
        std::fs::write(d.join("trips.txt"), t).unwrap();
        std::fs::write(d.join("stop_times.txt"), st).unwrap();
        std::fs::write(
            d.join("frequencies.txt"),
            "trip_id,start_time,end_time,headway_secs,exact_times\n\
             OK,08:00:00,09:00:00,600,\n\
             OK,09:00:00,10:00:00,600,0\n\
             TIME,8h,09:00:00,600,0\n\
             HW0,08:00:00,09:00:00,0,0\n\
             HWBIG,08:00:00,09:00:00,70000,0\n\
             EMPTY,09:00:00,09:00:00,600,0\n\
             EXACT,08:00:00,09:00:00,600,2\n\
             ONDEP,08:00:00,09:00:00,600,1\n",
        )
        .unwrap();
        let p1 = crate::pass1::run_pass1(d).unwrap();
        let (f, diag) = parse_frequencies_v2(&[d.to_path_buf()], &p1).unwrap();
        use FrequencyRule::*;
        let rules: Vec<(&str, FrequencyRule)> = diag
            .diagnostics
            .iter()
            .map(|x| (x.trip_id.as_str(), x.rule))
            .collect();
        assert_eq!(
            rules,
            vec![
                ("TIME", MalformedTime),
                ("HW0", InvalidHeadway),
                ("HWBIG", HeadwayOverflow),
                ("EMPTY", EmptyWindow),
                ("EXACT", InvalidExactTimes),
            ]
        );
        assert_eq!(diag.quarantined_trips, 5);
        let ok = p1.trips.lookup("OK").unwrap();
        let ondep = p1.trips.lookup("ONDEP").unwrap();
        let healthy: Vec<_> = f.rows.iter().filter(|r| r.5 == 0).collect();
        assert_eq!(
            healthy.len(),
            3,
            "back-to-back OK windows are not an overlap; an exact window ending on a departure is accepted"
        );
        assert!(healthy.iter().all(|r| r.0 == ok || r.0 == ondep));
        assert_eq!(f.rows.iter().filter(|r| r.5 != 0).count(), 5);
    }

    #[test]
    fn gzip_is_deterministic() {
        let a = deterministic_gzip(b"PTB\0abc").unwrap();
        let b = deterministic_gzip(b"PTB\0abc").unwrap();
        assert_eq!(a, b);
        assert_eq!(&a[4..8], &[0, 0, 0, 0], "mtime 0");
        assert_eq!(a[9], 255, "OS unknown");
    }

    #[test]
    fn date_minus_crosses_months() {
        assert_eq!(date_minus(20261001, 2).unwrap(), 20260929);
        assert!(date_minus(101, 1).is_err()); // no unsigned key for year -1
    }
}
