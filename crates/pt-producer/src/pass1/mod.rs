pub mod attrs;
pub mod calendar;
pub mod counts;
pub mod feed_info;
pub mod frequencies;
pub mod identity;
pub mod inseat;
pub mod stop_sequences;
pub mod transfers;

pub use attrs::{remap_attrs, RouteAttrs, StopAttrs, TripAttrs};
pub use calendar::ServiceAttrs;
pub use counts::{run_pass1, run_pass1_union, Pass1Result};
pub use feed_info::{parse_feed_info, FeedInfo};
pub use frequencies::{parse_frequencies, FrequenciesResult, FrequencyRow};
pub use inseat::{derive_for_build, derive_inseat_rules, TripForDerivation, MAX_LAYOVER_SECS};
pub use stop_sequences::{TripEndpoint, TripStopTriple};
pub use transfers::{parse_transfers, TransferRow, TransfersResult};

/// Prefix-sum of per-trip stop_times row counts, in post-finalize (sorted)
/// trip order. The returned vector has length `num_trips + 1` such that
/// `trip_starts[i]..trip_starts[i+1]` is the row range for sorted trip `i`:
///
/// - `trip_starts[0] == 0`
/// - `trip_starts[i+1] == trip_starts[i] + (rows for sorted trip i)`
/// - `trip_starts[num_trips] == total_stop_times`
///
/// `Pass1Result::stop_times_per_trip` is *already* indexed by post-finalize
/// (sorted) trip id — the Pass-1b stop_times scan runs against the finalized
/// trips interner (see `run_pass1_union`), so the counts need no remap. We
/// simply prefix-sum them. This array sizes/fills the PTB `TripStarts`
/// region; a later task makes Pass 2 write rows into these exact ranges.
pub fn compute_trip_starts(p1: &Pass1Result) -> Vec<u32> {
    let n = p1.trips.len();
    let mut trip_starts = vec![0u32; n + 1];
    let mut acc: u32 = 0;
    for (i, &count) in p1.stop_times_per_trip.iter().enumerate() {
        acc += count;
        trip_starts[i + 1] = acc;
    }
    trip_starts
}
