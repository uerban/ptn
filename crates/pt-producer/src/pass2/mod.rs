use crate::error::{Error, Result};

pub mod shapes;

#[cfg(not(feature = "hand-rolled"))]
mod stop_times_csv;
#[cfg(not(feature = "hand-rolled"))]
pub use stop_times_csv::parse_and_write_stop_times;

#[cfg(feature = "hand-rolled")]
mod stop_times_raw;
#[cfg(feature = "hand-rolled")]
pub use stop_times_raw::parse_and_write_stop_times;

pub fn parse_hms(bytes: &[u8]) -> Result<u32> {
    // Accepts H:MM:SS or HH:MM:SS where HH may be 0..=47 (GTFS overnight rollover).
    // Allocation-free: a per-row split-collect would allocate ~1M times on Krakow
    // and visibly distort the very RSS the producer is measuring.
    fn dec(byte: u8) -> Result<u32> {
        if !byte.is_ascii_digit() {
            return Err(Error::MalformedGtfs(format!("hms non-digit byte: {byte}")));
        }
        Ok((byte - b'0') as u32)
    }
    let mut c1 = None;
    let mut c2 = None;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b':' {
            if c1.is_none() {
                c1 = Some(i);
            } else if c2.is_none() {
                c2 = Some(i);
                break;
            }
        }
    }
    let (c1, c2) = match (c1, c2) {
        (Some(a), Some(b)) => (a, b),
        _ => return Err(Error::MalformedGtfs(format!("hms colons: {}", bytes.len()))),
    };
    if c1 == 0 || c1 > 2 || c2 - c1 != 3 || bytes.len() - c2 - 1 != 2 {
        return Err(Error::MalformedGtfs(format!(
            "hms shape: len={} c1={c1} c2={c2}",
            bytes.len()
        )));
    }
    let mut h: u32 = 0;
    for &b in &bytes[..c1] {
        h = h * 10 + dec(b)?;
    }
    let m = dec(bytes[c1 + 1])? * 10 + dec(bytes[c1 + 2])?;
    let sec = dec(bytes[c2 + 1])? * 10 + dec(bytes[c2 + 2])?;
    if h > 47 || m > 59 || sec > 59 {
        return Err(Error::MalformedGtfs(format!("hms range: {h}:{m}:{sec}")));
    }
    Ok(h * 3600 + m * 60 + sec)
}
