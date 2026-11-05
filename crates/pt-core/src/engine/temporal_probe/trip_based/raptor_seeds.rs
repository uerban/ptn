//! Inert diagnostic schema for historical rejected seed experiments.
//! No production-forward discovery implementation remains.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RaptorSeedDiagnostics {
    pub enabled: bool,
    pub generation_stop_scans: usize,
    pub generation_lookup_work: usize,
    pub generation_states: usize,
    /// Logical vehicle-directory + departure rows, excluding maps/capacity/allocator.
    pub generation_cache_bytes: usize,
    /// Completed query-local occurrence tables and charged reuse requests.
    pub catalogue_cache_builds: usize,
    pub catalogue_cache_hits: usize,
    /// Charged event checks during concrete-directory construction, including retries.
    pub catalogue_event_checks: usize,
    /// Immediate target detections; reconstruction may still exhaust its budget.
    pub target_first_stops: usize,
    pub ordering_attempted: bool,
    pub ordering_ready: bool,
    pub ordering_stop_scans: usize,
    pub ordering_lookup_work: usize,
    pub ordering_rows: usize,
    pub ordering_edges: usize,
    pub ordering_bytes: usize,
    pub candidates: usize,
    pub replayed: usize,
    pub rejected: usize,
    pub replay_truncations: usize,
    pub replay_stop_scans: usize,
    pub replay_lookup_work: usize,
    pub replay_states: usize,
}
