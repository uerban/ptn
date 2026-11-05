use crate::interns::TRIP_RECORD_BYTES;

const PAGE: u64 = 4096;

// Production-shaped stop_times row: 12 B = dep_secs (u32 LE) + arr_diff (i16 LE)
// + stop_idx (u32 LE) + stop_seq (u16 LE). Pass 2 writes all four columns; see
// pass2/stop_times_csv.rs and pass2/stop_times_raw.rs for the encoding.
pub const STOP_TIME_ROW_BYTES: u64 = 12;

/// One GTFS `transfers.txt` rule is a fixed 32-byte staging record. GTFS reference:
/// https://gtfs.org/documentation/schedule/reference/#transferstxt
pub const TRANSFER_RECORD_BYTES: u64 = 32;

fn align_up(n: u64, align: u64) -> u64 {
    (n + align - 1) & !(align - 1)
}

/// Temporary producer region order. This layout is an internal staging buffer;
/// the current emitter selects and reframes its data into PTB v1.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Region {
    TripsIntern,
    ServiceBitmasks,
    StopTimes,
    TripStarts,
    Csr,
    StringPool,
    Transfers,
}

pub struct Layout {
    offsets: [u64; 7],
    lengths: [u64; 7],
    total: u64,
}

impl Layout {
    #[allow(clippy::too_many_arguments)]
    pub fn compute(
        num_stops: u64,
        num_routes: u64,
        num_trips: u64,
        total_stop_times: u64,
        service_window_days: u64,
        num_services: u64,
        string_pool_bytes: u64,
        num_transfers: u64,
    ) -> Self {
        // The emitter reads TripsIntern to derive the pattern band. Stop and
        // route columns are emitted directly from Pass1Result into their v1
        // SoA regions and need no scratch copies.
        let trips_bytes = align_up(num_trips * TRIP_RECORD_BYTES as u64, PAGE);
        let bitmask_bytes_per_service = service_window_days.div_ceil(8);
        let bitmasks_bytes = align_up(num_services * bitmask_bytes_per_service, PAGE);
        // The CSR region packs four u32 arrays back-to-back. The two neighbor
        // arrays have exact upper bounds: route→trips is num_trips, and
        // stop→routes is bounded by total_stop_times because it is built from
        // stop-time triples and then deduplicated. Both offsets arrays have one
        // entry per slot plus a terminator.
        let rt_offsets_bytes = (num_routes + 1) * 4;
        let rt_neighbors_bytes = num_trips * 4;
        let sr_offsets_bytes = (num_stops + 1) * 4;
        let sr_neighbors_bytes = total_stop_times * 4;
        let csr_bytes = align_up(
            rt_offsets_bytes + rt_neighbors_bytes + sr_offsets_bytes + sr_neighbors_bytes,
            PAGE,
        );

        // TripStarts holds num_trips+1 u32 prefix-sum offsets (one per trip
        // plus a terminator).
        let trip_starts_bytes = align_up((num_trips + 1) * 4, PAGE);

        // Transfers: num_transfers × 32 B. Exact-length region; the cursor
        // advances page-aligned like StopTimes / TripStarts / StringPool.
        let transfers_bytes = num_transfers * TRANSFER_RECORD_BYTES;

        let mut offsets = [0u64; 7];
        let mut lengths = [0u64; 7];

        let mut cursor: u64 = 0;

        offsets[Region::TripsIntern as usize] = cursor;
        lengths[Region::TripsIntern as usize] = trips_bytes;
        cursor += trips_bytes;

        offsets[Region::ServiceBitmasks as usize] = cursor;
        lengths[Region::ServiceBitmasks as usize] = bitmasks_bytes;
        cursor += bitmasks_bytes;

        offsets[Region::StopTimes as usize] = cursor;
        lengths[Region::StopTimes as usize] = total_stop_times * STOP_TIME_ROW_BYTES;
        cursor = align_up(cursor + total_stop_times * STOP_TIME_ROW_BYTES, PAGE);

        offsets[Region::TripStarts as usize] = cursor;
        lengths[Region::TripStarts as usize] = (num_trips + 1) * 4;
        cursor += trip_starts_bytes;

        offsets[Region::Csr as usize] = cursor;
        lengths[Region::Csr as usize] = csr_bytes;
        cursor += csr_bytes;

        // StringPool: exact populated length (4 + (count+1)*4 + blob_len), but
        // the cursor advances page-aligned so the next region stays aligned —
        // same exact-length / aligned-advance pattern as StopTimes/TripStarts.
        offsets[Region::StringPool as usize] = cursor;
        lengths[Region::StringPool as usize] = string_pool_bytes;
        cursor = align_up(cursor + string_pool_bytes, PAGE);

        // Transfers: exact-length, page-aligned advance (see above).
        offsets[Region::Transfers as usize] = cursor;
        lengths[Region::Transfers as usize] = transfers_bytes;
        cursor = align_up(cursor + transfers_bytes, PAGE);

        let total = align_up(cursor, PAGE);
        Self {
            offsets,
            lengths,
            total,
        }
    }

    pub fn offset(&self, r: Region) -> u64 {
        self.offsets[r as usize]
    }
    pub fn length(&self, r: Region) -> u64 {
        self.lengths[r as usize]
    }
    pub fn total_bytes(&self) -> u64 {
        self.total
    }
}

#[cfg(test)]
mod layout_tests {
    use super::*;

    #[test]
    fn string_pool_region_present_before_transfers() {
        // string_pool_bytes = 100 (arbitrary exact length), 0 transfers.
        let l = Layout::compute(3, 2, 4, 12, 90, 2, 100, 0);
        let sp_off = l.offset(Region::StringPool);
        let transfers_off = l.offset(Region::Transfers);
        assert!(sp_off > 0);
        assert!(transfers_off > sp_off, "Transfers must follow StringPool");
        assert_eq!(l.length(Region::StringPool), 100); // exact, not page-aligned
        assert_eq!(transfers_off % 4096, 0); // next region offset is page-aligned
    }

    #[test]
    fn transfers_region_follows_string_pool() {
        // 2 transfers → 64 B exact staging region.
        let l = Layout::compute(3, 2, 4, 12, 90, 2, 100, 2);
        let sp_off = l.offset(Region::StringPool);
        let tr_off = l.offset(Region::Transfers);
        assert!(tr_off >= sp_off, "Transfers must follow StringPool");
        assert_eq!(l.length(Region::Transfers), 2 * 32); // exact, not page-aligned
        assert_eq!(tr_off % 4096, 0); // page-aligned start
    }

    #[test]
    fn empty_transfers_region_has_zero_length() {
        let l = Layout::compute(3, 2, 4, 12, 90, 2, 100, 0);
        assert_eq!(l.length(Region::Transfers), 0);
        // Length-0 region still has a valid (page-aligned) offset.
        assert_eq!(l.offset(Region::Transfers) % 4096, 0);
    }
}
