use crate::error::{Error, Result};
use crate::pass1::identity::IdentityInterner;
use std::path::Path;

/// Service attributes derived from `calendar.txt` and `calendar_dates.txt`.
///
/// `weekdays` is a 7-bit mask: bit 0 = Monday,..., bit 6 = Sunday. Date fields are GTFS YYYYMMDD
/// integers (e.g. 20260501). `additions` and `removals` are unsorted in capture order; the bitmask
/// builder will iterate them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ServiceAttrs {
    pub weekdays: u8,
    pub start_date: u32,
    pub end_date: u32,
    pub additions: Vec<u32>,
    pub removals: Vec<u32>,
}

pub fn parse_calendar(
    path: &Path,
    services: &mut IdentityInterner<String>,
    attrs: &mut Vec<ServiceAttrs>,
) -> Result<()> {
    if !path.exists() {
        // calendar.txt is optional per the GTFS spec when calendar_dates.txt
        // covers everything; downstream code tolerates a service with only
        // exceptions and no weekday mask.
        return Ok(());
    }
    let file = crate::csv_open::open_csv_skip_bom(path)?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();

    let svc_idx = header_pos(&headers, "service_id", path)?;
    let mon_idx = header_pos(&headers, "monday", path)?;
    let tue_idx = header_pos(&headers, "tuesday", path)?;
    let wed_idx = header_pos(&headers, "wednesday", path)?;
    let thu_idx = header_pos(&headers, "thursday", path)?;
    let fri_idx = header_pos(&headers, "friday", path)?;
    let sat_idx = header_pos(&headers, "saturday", path)?;
    let sun_idx = header_pos(&headers, "sunday", path)?;
    let start_idx = header_pos(&headers, "start_date", path)?;
    let end_idx = header_pos(&headers, "end_date", path)?;

    let mut record = csv::StringRecord::new();
    while rdr.read_record(&mut record)? {
        let id = field(&record, svc_idx)?.trim().to_string();
        let mut weekdays: u8 = 0;
        for (bit, col_idx) in [
            mon_idx, tue_idx, wed_idx, thu_idx, fri_idx, sat_idx, sun_idx,
        ]
        .iter()
        .enumerate()
        {
            if parse_zero_one(field(&record, *col_idx)?.trim())? {
                weekdays |= 1 << bit;
            }
        }
        let start_date = parse_yyyymmdd(field(&record, start_idx)?.trim())?;
        let end_date = parse_yyyymmdd(field(&record, end_idx)?.trim())?;
        let pre_id = services.intern(id) as usize;
        ensure_len(attrs, pre_id + 1);
        // Update weekdays/dates only — preserve any additions/removals already
        // captured for this service_id by an earlier feed's calendar_dates.txt
        // (the per-feed loop in counts.rs runs calendar before calendar_dates,
        // but across feeds the second feed's calendar would otherwise wipe the
        // first feed's exceptions). First-feed-wins for the weekday/date facts
        // matches the first-feed-wins behaviour in `scan_stops` / `scan_routes`.
        let slot = &mut attrs[pre_id];
        if slot.start_date == 0 && slot.end_date == 0 && slot.weekdays == 0 {
            slot.weekdays = weekdays;
            slot.start_date = start_date;
            slot.end_date = end_date;
        }
    }
    Ok(())
}

pub fn parse_calendar_dates(
    path: &Path,
    services: &mut IdentityInterner<String>,
    attrs: &mut Vec<ServiceAttrs>,
) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let file = crate::csv_open::open_csv_skip_bom(path)?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();

    let svc_idx = header_pos(&headers, "service_id", path)?;
    let date_idx = header_pos(&headers, "date", path)?;
    let etype_idx = header_pos(&headers, "exception_type", path)?;

    let mut record = csv::StringRecord::new();
    while rdr.read_record(&mut record)? {
        let id = field(&record, svc_idx)?.trim().to_string();
        let date = parse_yyyymmdd(field(&record, date_idx)?.trim())?;
        let etype: u8 = field(&record, etype_idx)?
            .trim()
            .parse()
            .map_err(|_| Error::MalformedGtfs(format!("{}: bad exception_type", path.display())))?;
        let pre_id = services.intern(id) as usize;
        ensure_len(attrs, pre_id + 1);
        match etype {
            1 => attrs[pre_id].additions.push(date),
            2 => attrs[pre_id].removals.push(date),
            _ => {
                return Err(Error::MalformedGtfs(format!(
                    "{}: exception_type must be 1 or 2, got {etype}",
                    path.display()
                )))
            }
        }
    }
    Ok(())
}

fn header_pos(headers: &csv::StringRecord, col: &str, path: &Path) -> Result<usize> {
    headers
        .iter()
        .position(|h| h == col)
        .ok_or_else(|| Error::MalformedGtfs(format!("{}: missing {col}", path.display())))
}

fn field(record: &csv::StringRecord, idx: usize) -> Result<&str> {
    record
        .get(idx)
        .ok_or_else(|| Error::MalformedGtfs(format!("row missing field at index {idx}")))
}

fn parse_zero_one(s: &str) -> Result<bool> {
    match s {
        "0" => Ok(false),
        "1" => Ok(true),
        _ => Err(Error::MalformedGtfs(format!(
            "calendar.txt: expected 0/1, got {s}"
        ))),
    }
}

fn parse_yyyymmdd(s: &str) -> Result<u32> {
    if s.len() != 8 {
        return Err(Error::MalformedGtfs(format!("expected YYYYMMDD, got {s}")));
    }
    s.parse::<u32>()
        .map_err(|_| Error::MalformedGtfs(format!("YYYYMMDD parse: {s}")))
}

fn ensure_len(attrs: &mut Vec<ServiceAttrs>, len: usize) {
    if attrs.len() < len {
        attrs.resize(len, ServiceAttrs::default());
    }
}
