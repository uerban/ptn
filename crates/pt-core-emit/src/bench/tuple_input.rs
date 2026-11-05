//! Strict reader for the shared `pt-serve-query-tuples.json` shape.
//!
//! This module belongs to the `std` CLI crate. `pt-core` remains `no_std` and
//! continues to receive already-resolved `Query` values only.

use std::fs;

use pt_core::{Mobility, Query, Reader, StopWalk};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub(crate) struct TupleProvenance {
    pub(crate) entry_stops: Vec<StopWalkProvenance>,
    pub(crate) exit_stops: Vec<StopWalkProvenance>,
    pub(crate) date: String,
    pub(crate) departure_secs: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct StopWalkProvenance {
    pub(crate) stop_id: String,
    pub(crate) walk_secs: u32,
}

pub(crate) struct ResolvedTuple {
    pub(crate) query: Query,
    pub(crate) provenance: TupleProvenance,
}

#[derive(Debug, Deserialize)]
struct TupleFile {
    tuples: Vec<TupleInput>,
    #[serde(rename = "ptbSha256")]
    ptb_sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TupleInput {
    #[serde(rename = "entryStops")]
    entry_stops: Vec<StopWalkInput>,
    #[serde(rename = "exitStops")]
    exit_stops: Vec<StopWalkInput>,
    date: String,
    #[serde(rename = "departureSecs")]
    departure_secs: i64,
}

#[derive(Debug, Deserialize)]
struct StopWalkInput {
    #[serde(rename = "stopId")]
    stop_id: String,
    #[serde(rename = "walkSecs")]
    walk_secs: u32,
}

pub(crate) fn load(path: &str, reader: &Reader<Vec<u8>>) -> Result<Vec<ResolvedTuple>, String> {
    let contents =
        fs::read_to_string(path).map_err(|err| format!("query-tuples: read {path}: {err}"))?;
    let file: TupleFile = serde_json::from_str(&contents)
        .map_err(|err| format!("query-tuples: invalid JSON in {path}: {err}"))?;
    if let Some(expected) = &file.ptb_sha256 {
        if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("query-tuples: ptbSha256 must be 64 hex characters".into());
        }
        let bytes = reader
            .bytes_view()
            .ok_or("query-tuples: PTB bytes unavailable")?;
        let actual = format!("{:x}", Sha256::digest(bytes));
        if expected.to_ascii_lowercase() != actual {
            return Err(format!(
                "query-tuples: ptbSha256 does not match the PTB bytes (expected {expected}, actual {actual})"
            ));
        }
    }
    if file.tuples.is_empty() {
        return Err("query-tuples: `tuples` must be a non-empty array".to_string());
    }

    file.tuples
        .into_iter()
        .enumerate()
        .map(|(tuple_idx, tuple)| resolve_tuple(tuple_idx, tuple, reader))
        .collect()
}

fn resolve_tuple(
    tuple_idx: usize,
    tuple: TupleInput,
    reader: &Reader<Vec<u8>>,
) -> Result<ResolvedTuple, String> {
    if tuple.entry_stops.is_empty() {
        return Err(format!(
            "query-tuples: tuples[{tuple_idx}].entryStops must be non-empty"
        ));
    }
    if tuple.exit_stops.is_empty() {
        return Err(format!(
            "query-tuples: tuples[{tuple_idx}].exitStops must be non-empty"
        ));
    }

    let entry_stops = resolve_stops(tuple_idx, "entryStops", &tuple.entry_stops, reader)?;
    let exit_stops = resolve_stops(tuple_idx, "exitStops", &tuple.exit_stops, reader)?;
    let date = parse_date(tuple_idx, &tuple.date, reader)?;

    let query = Query {
        excluded_routes: Default::default(),
        entry_stops: entry_stops
            .iter()
            .map(|stop| StopWalk {
                stop: stop.stop,
                walk_secs: stop.walk_secs,
            })
            .collect(),
        exit_stops: exit_stops
            .iter()
            .map(|stop| StopWalk {
                stop: stop.stop,
                walk_secs: stop.walk_secs,
            })
            .collect(),
        departure_secs: tuple.departure_secs,
        date,
        max_rounds: None,
        mobility: Mobility::Default,
        excluded_modes: Vec::new(),
        walk_speed_mm_s: None,
        min_transfer_secs: None,
    };

    Ok(ResolvedTuple {
        query,
        provenance: TupleProvenance {
            entry_stops: entry_stops
                .iter()
                .map(|stop| StopWalkProvenance {
                    stop_id: stop.stop_id.clone(),
                    walk_secs: stop.walk_secs,
                })
                .collect(),
            exit_stops: exit_stops
                .iter()
                .map(|stop| StopWalkProvenance {
                    stop_id: stop.stop_id.clone(),
                    walk_secs: stop.walk_secs,
                })
                .collect(),
            date: tuple.date,
            departure_secs: tuple.departure_secs,
        },
    })
}

struct ResolvedStop {
    stop_id: String,
    stop: u32,
    walk_secs: u32,
}

fn resolve_stops(
    tuple_idx: usize,
    field: &str,
    stops: &[StopWalkInput],
    reader: &Reader<Vec<u8>>,
) -> Result<Vec<ResolvedStop>, String> {
    stops
        .iter()
        .enumerate()
        .map(|(stop_idx, stop)| {
            if stop.stop_id.is_empty() {
                return Err(format!(
                    "query-tuples: tuples[{tuple_idx}].{field}[{stop_idx}].stopId must be non-empty"
                ));
            }
            let resolved = reader.stop_index(&stop.stop_id).ok_or_else(|| {
                format!(
                    "query-tuples: tuples[{tuple_idx}].{field}[{stop_idx}].stopId unknown stop id '{}'",
                    stop.stop_id
                )
            })?;
            Ok(ResolvedStop {
                stop_id: stop.stop_id.clone(),
                stop: resolved,
                walk_secs: stop.walk_secs,
            })
        })
        .collect()
}

fn parse_date(tuple_idx: usize, raw: &str, reader: &Reader<Vec<u8>>) -> Result<u32, String> {
    if raw.len() != 8 || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!(
            "query-tuples: tuples[{tuple_idx}].date must be an eight-digit YYYYMMDD string"
        ));
    }
    let date = raw.parse::<u32>().map_err(|_| {
        format!("query-tuples: tuples[{tuple_idx}].date must be an eight-digit YYYYMMDD string")
    })?;
    if !valid_date(date) {
        return Err(format!(
            "query-tuples: tuples[{tuple_idx}].date invalid calendar date '{raw}'"
        ));
    }

    let day_offset = days_from_civil(date) - days_from_civil(reader.feed_start_date());
    if day_offset < 0 || day_offset >= i64::from(reader.window_days()) {
        return Err(format!(
            "query-tuples: tuples[{tuple_idx}].date '{raw}' is outside the PTB service window"
        ));
    }
    Ok(date)
}

fn valid_date(date: u32) -> bool {
    let year = date / 10000;
    let month = (date / 100) % 100;
    let day = date % 100;
    if year == 0 || !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days_in_month = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    day <= days_in_month
}

// Howard Hinnant's civil-date conversion, matching pt-core's YYYYMMDD day math.
fn days_from_civil(date: u32) -> i64 {
    let y = (date / 10000) as i64;
    let month = ((date / 100) % 100) as i64;
    let day = (date % 100) as i64;
    let y = if month <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let month = (month + 9) % 12;
    let doy = (153 * month + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}
