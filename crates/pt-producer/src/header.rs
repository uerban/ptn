use crate::error::{Error, Result};

pub const PTB_MAGIC: &[u8; 4] = b"PTB\0";
pub const HEADER_PREFIX_BYTES: usize = 32;

/// Write the fixed PTB v1 header prefix. The tagged region table starts at byte
/// 32 and is emitted separately by the current bundle writer.
///
/// Layout:
/// - `[0..4]` magic `PTB\\0`
/// - `[4..6]` version `1`
/// - `[6..8]` feature flags (currently zero)
/// - `[8..12]` stop count
/// - `[12..16]` route count
/// - `[16..20]` trip count
/// - `[20..24]` feed start date as YYYYMMDD
/// - `[24..28]` service count
/// - `[28..32]` city UTC offset in seconds
#[allow(clippy::too_many_arguments)]
pub fn write_header_fields(
    header: &mut [u8],
    num_stops: u32,
    num_routes: u32,
    num_trips: u32,
    feed_start_date: u32,
    num_services: u32,
    city_tz_offset_seconds: i32,
) -> Result<()> {
    if header.len() < HEADER_PREFIX_BYTES {
        return Err(Error::Config(format!(
            "header region too small need={HEADER_PREFIX_BYTES} have={}",
            header.len()
        )));
    }

    header[0..4].copy_from_slice(PTB_MAGIC);
    header[4..6].copy_from_slice(&pt_core::PTB_VERSION_V1.to_le_bytes());
    header[8..12].copy_from_slice(&num_stops.to_le_bytes());
    header[12..16].copy_from_slice(&num_routes.to_le_bytes());
    header[16..20].copy_from_slice(&num_trips.to_le_bytes());
    header[20..24].copy_from_slice(&feed_start_date.to_le_bytes());
    header[24..28].copy_from_slice(&num_services.to_le_bytes());
    header[28..32].copy_from_slice(&city_tz_offset_seconds.to_le_bytes());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_header_round_trips_counts_and_timezone() {
        let mut header = vec![0u8; HEADER_PREFIX_BYTES];
        write_header_fields(&mut header, 1535, 116, 23147, 20260501, 42, -28800).unwrap();

        assert_eq!(&header[0..4], PTB_MAGIC);
        assert_eq!(
            u16::from_le_bytes(header[4..6].try_into().unwrap()),
            pt_core::PTB_VERSION_V1
        );
        assert_eq!(u32::from_le_bytes(header[8..12].try_into().unwrap()), 1535);
        assert_eq!(u32::from_le_bytes(header[12..16].try_into().unwrap()), 116);
        assert_eq!(
            u32::from_le_bytes(header[16..20].try_into().unwrap()),
            23147
        );
        assert_eq!(
            u32::from_le_bytes(header[20..24].try_into().unwrap()),
            20260501
        );
        assert_eq!(u32::from_le_bytes(header[24..28].try_into().unwrap()), 42);
        assert_eq!(
            i32::from_le_bytes(header[28..32].try_into().unwrap()),
            -28800
        );
    }

    #[test]
    fn rejects_short_header() {
        assert!(
            write_header_fields(&mut [0u8; HEADER_PREFIX_BYTES - 1], 0, 0, 0, 0, 0, 0).is_err()
        );
    }
}
