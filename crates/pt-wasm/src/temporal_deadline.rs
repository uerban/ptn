//! Isolated, feature-gated deadline benchmark. Production PtRouter is unchanged.
//! Reuses pt-core's exact engine and the existing JS query parser; no GTFS
//! transfer rule or pedestrian routing is implemented at this boundary.
//! GTFS: https://gtfs.org/documentation/schedule/reference/#transferstxt

use pt_core::engine::temporal_probe::r3::{ProfileObjectives, R3Point, R3TransitWitness};
use pt_core::engine::temporal_probe::trip_based::*;
use pt_core::{PatternMode, Reader, Transfers};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

mod failure;
mod journey;
#[cfg(feature = "temporal-setup-profile")]
mod setup_profile;
#[cfg(feature = "temporal-setup-profile")]
pub use setup_profile::take_setup_profile;

/// Records a setup marker in profile builds; expands to nothing otherwise.
macro_rules! setup_mark {
    ($mark:expr) => {
        #[cfg(feature = "temporal-setup-profile")]
        setup_profile::mark($mark);
    };
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn now() -> f64;
}

#[derive(Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum Objective {
    R3,
    #[default]
    M4,
}
#[derive(Clone, Copy, Deserialize, Default)]
enum Lookup {
    #[serde(rename = "lazy-all")]
    All,
    #[serde(rename = "lazy-indexed")]
    Indexed,
    #[default]
    #[serde(rename = "lazy-fast")]
    Fast,
    #[serde(rename = "lazy-cached")]
    Cached,
}
impl Lookup {
    fn name(self) -> &'static str {
        match self {
            Self::All => "lazy-all",
            Self::Indexed => "lazy-indexed",
            Self::Fast => "lazy-fast",
            Self::Cached => "lazy-cached",
        }
    }
}
#[derive(Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum Validation {
    #[default]
    Checked,
    Session,
}
#[derive(Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum WitnessComparison {
    #[default]
    Materialized,
    #[serde(rename = "materialized-date-memo")]
    MaterializedDateMemo,
    Streaming,
}
impl WitnessComparison {
    fn core(self) -> DeadlineWitnessComparison {
        match self {
            Self::Materialized => DeadlineWitnessComparison::Materialized,
            Self::MaterializedDateMemo => DeadlineWitnessComparison::MaterializedDateMemo,
            Self::Streaming => DeadlineWitnessComparison::Streaming,
        }
    }
    fn name(self) -> &'static str {
        self.core().name()
    }
}
#[derive(Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
enum FrontierStorage {
    #[default]
    Tree,
    EventIndexed,
}
impl FrontierStorage {
    fn core(self) -> DeadlineFrontierStorage {
        match self {
            Self::Tree => DeadlineFrontierStorage::Tree,
            Self::EventIndexed => DeadlineFrontierStorage::EventIndexed,
        }
    }
    fn name(self) -> &'static str {
        self.core().name()
    }
}
impl Validation {
    fn name(self) -> &'static str {
        match self {
            Self::Checked => "checked",
            Self::Session => "session",
        }
    }
}
#[derive(Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum CatalogueMode {
    #[default]
    Fresh,
    Reuse,
    /// H83: cut from the held catalogue by copy when it covers the request.
    #[serde(rename = "held-slice")]
    HeldSlice,
}
#[derive(Clone, Copy, Deserialize, Default)]
enum Traversal {
    #[default]
    #[serde(rename = "fifo")]
    Fifo,
    #[serde(rename = "arrival-first")]
    ArrivalFirst,
    #[serde(rename = "guided")]
    Guided,
}
impl Traversal {
    fn name(self) -> &'static str {
        match self {
            Self::Fifo => "fifo",
            Self::ArrivalFirst => "arrival-first",
            Self::Guided => "guided",
        }
    }
}
impl CatalogueMode {
    fn name(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Reuse => "reuse",
            Self::HeldSlice => "held-slice",
        }
    }
    fn source(self) -> CatalogueSource {
        match self {
            Self::Fresh => CatalogueSource::Fresh,
            Self::Reuse => CatalogueSource::Reuse,
            Self::HeldSlice => CatalogueSource::HeldSlice,
        }
    }
}
fn origin_name(origin: CatalogueOrigin) -> &'static str {
    match origin {
        CatalogueOrigin::Built => "built",
        CatalogueOrigin::Reused => "reused",
        CatalogueOrigin::WindowSlice => "window-slice",
        CatalogueOrigin::HeldSlice => "held-slice",
    }
}
#[derive(Clone, Copy, Deserialize, Default, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum PrefixCertificate {
    #[default]
    Duration,
    Timetable,
}
#[derive(Clone, Copy, Deserialize, Default, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum PrefixSetup {
    #[default]
    Rebuild,
    Prepared,
}
#[derive(Clone, Copy, Serialize)]
struct PrefixModeWire {
    certificate: &'static str,
    setup: &'static str,
}
fn yes() -> bool {
    true
}
fn segments() -> usize {
    250_000
}
fn width() -> usize {
    64
}
fn work() -> usize {
    10_000_000
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    window_start: i64,
    window_end: i64,
    arrival_deadline: i64,
    #[serde(default)]
    objective: Objective,
    #[serde(default)]
    lookup: Lookup,
    #[serde(default)]
    validation: Validation,
    #[serde(default)]
    catalogue: CatalogueMode,
    #[serde(default)]
    traversal: Traversal,
    #[serde(default)]
    witness_comparison: WitnessComparison,
    #[serde(default)]
    frontier_storage: FrontierStorage,
    #[serde(default)]
    prefix_certificate: PrefixCertificate,
    #[serde(default)]
    prefix_setup: PrefixSetup,
    #[serde(default)]
    static_bound: bool,
    #[serde(default)]
    walking_bound: bool,
    /// H79 opt-in passenger-transfer prefix row; default false.
    #[serde(default)]
    transfer_bound: bool,
    #[serde(default)]
    forward_seeds: bool,
    #[serde(default = "yes")]
    prefix_bound: bool,
    #[serde(default = "yes")]
    point_bound: bool,
    #[serde(default = "segments")]
    max_segments: usize,
    #[serde(default = "width")]
    max_frontier_width: usize,
    #[serde(default = "work")]
    max_stop_scans: usize,
    #[serde(default = "work")]
    max_lookup_work: usize,
}
impl Options {
    fn known_key(key: &str) -> bool {
        matches!(
            key,
            "windowStart"
                | "windowEnd"
                | "arrivalDeadline"
                | "objective"
                | "lookup"
                | "validation"
                | "catalogue"
                | "traversal"
                | "witnessComparison"
                | "frontierStorage"
                | "prefixCertificate"
                | "prefixSetup"
                | "staticBound"
                | "walkingBound"
                | "transferBound"
                | "forwardSeeds"
                | "prefixBound"
                | "pointBound"
                | "maxSegments"
                | "maxFrontierWidth"
                | "maxStopScans"
                | "maxLookupWork"
        )
    }

    fn validate(&self) -> Result<(), String> {
        if self.prefix_mode().is_some()
            && (!matches!(self.objective, Objective::M4)
                || !self.prefix_bound
                || !self.point_bound
                || self.static_bound
                || self.forward_seeds
                || self.prefix_setup == PrefixSetup::Prepared
                    && (!matches!(self.validation, Validation::Session)
                        || matches!(self.catalogue, CatalogueMode::Reuse)))
        {
            return Err("prefix experiment requires M4 point bounds, static/sampling off; prepared setup requires session validation and a fresh or held-slice catalogue".into());
        }
        if [self.window_start, self.window_end, self.arrival_deadline]
            .iter()
            .any(|v| v.unsigned_abs() > 9_007_199_254_740_991)
        {
            return Err("deadline times must be JS safe integers".into());
        }
        if self.window_start >= self.window_end
            || self.window_end > self.arrival_deadline + 1
            || [
                self.max_segments,
                self.max_frontier_width,
                self.max_stop_scans,
                self.max_lookup_work,
            ]
            .contains(&0)
            || self.point_bound && !self.prefix_bound
            || matches!(self.traversal, Traversal::Guided) && !self.static_bound
            || self.walking_bound && (!self.prefix_bound || !self.point_bound)
            || self.transfer_bound
                && (!self.prefix_bound
                    || !self.point_bound
                    || !matches!(self.objective, Objective::M4))
            || self.forward_seeds && (!self.prefix_bound || !self.point_bound)
        {
            return Err("invalid deadline window, bounds or zero limit".into());
        }
        Ok(())
    }
    fn prefix_mode(&self) -> Option<PrefixModeWire> {
        (self.prefix_certificate != PrefixCertificate::Duration
            || self.prefix_setup != PrefixSetup::Rebuild)
            .then_some(PrefixModeWire {
                certificate: match self.prefix_certificate {
                    PrefixCertificate::Duration => "duration",
                    PrefixCertificate::Timetable => "timetable",
                },
                setup: match self.prefix_setup {
                    PrefixSetup::Rebuild => "rebuild",
                    PrefixSetup::Prepared => "prepared",
                },
            })
    }
    fn config(&self) -> DeadlineSessionConfig {
        let mut r =
            DeadlineSessionConfig::new(self.window_start..self.window_end, self.arrival_deadline);
        r.objectives = match self.objective {
            Objective::R3 => ProfileObjectives::R3,
            Objective::M4 => ProfileObjectives::M4,
        };
        r.lookup = match self.lookup {
            Lookup::All => LazyLookupMode::ScanAll,
            Lookup::Indexed => LazyLookupMode::StopIndexed,
            Lookup::Fast => LazyLookupMode::PlainFast,
            Lookup::Cached => LazyLookupMode::PlainCached,
        };
        r.pruning = match (self.prefix_bound, self.point_bound) {
            (false, _) => DeadlinePruning::None,
            (true, false) => DeadlinePruning::EarliestPrefix,
            (true, true) => match self.prefix_certificate {
                PrefixCertificate::Duration => DeadlinePruning::EarliestPrefixAndPoints,
                PrefixCertificate::Timetable => DeadlinePruning::EarliestPrefixAndTimetablePoints,
            },
        };
        r.traversal = match self.traversal {
            Traversal::Fifo => DeadlineTraversal::Fifo,
            Traversal::ArrivalFirst => DeadlineTraversal::ArrivalFirst,
            Traversal::Guided => DeadlineTraversal::Guided,
        };
        r.static_bound = self.static_bound;
        r.witness_comparison = self.witness_comparison.core();
        r.frontier_storage = self.frontier_storage.core();
        r.walking_bound = self.walking_bound;
        r.transfer_bound = self.transfer_bound;
        r.forward_seeds = self.forward_seeds;
        r.max_segments = self.max_segments;
        r.max_frontier_width = self.max_frontier_width;
        r.max_stop_scans = self.max_stop_scans;
        r.max_lookup_work = self.max_lookup_work;
        r
    }
}

/// Separate experimental handle, with wasm-bindgen's actual deallocating free.
/// No production methods, bundle formats or mobile ABI are changed.
#[wasm_bindgen]
pub struct TemporalDeadlineProbe {
    session: DeadlineSession,
    validation: Option<Validation>,
    lookup: Lookup,
    traversal: Traversal,
    witness_comparison: WitnessComparison,
    frontier_storage: FrontierStorage,
    prefix_mode: Option<PrefixModeWire>,
    static_bound: bool,
    walking_bound: bool,
    transfer_bound: bool,
    forward_seeds: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedWire {
    event_count: usize,
    event_index_bytes: usize,
    peak_build_bytes: usize,
    catalogue_mode: &'static str,
    catalogue_reused: bool,
    catalogue_key: Option<[u8; 32]>,
    /// H83 diagnostics: how this prepare obtained its catalogue, and the
    /// bytes of the catalogue held for later requests.
    catalogue_origin: Option<&'static str>,
    held_catalogue_bytes: usize,
    lookup_mode: &'static str,
    traversal_mode: &'static str,
    witness_comparison: &'static str,
    frontier_storage: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    prefix_experiment: Option<PrefixModeWire>,
    static_bound: bool,
    walking_bound: bool,
    transfer_bound: bool,
    forward_seeds: bool,
}

/// H58 phase A output: a departure time, never a journey.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LatestScanWire {
    schema: &'static str,
    window: [i64; 2],
    arrival_deadline: i64,
    departure: Option<i64>,
    out_of_scope: Option<&'static str>,
    index_built: bool,
    dates: usize,
    instances: usize,
    template_positions: usize,
    position_scans: usize,
    label_relaxations: usize,
    scan_index_bytes: usize,
    core_ms: f64,
}

/// H81 phase A output: the selector's optimum and its latest departure,
/// never a journey.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectorScanWire {
    schema: &'static str,
    goal: &'static str,
    window: [i64; 2],
    arrival_deadline: i64,
    /// Passenger transfers or total walk seconds.
    optimum: Option<u64>,
    departure: Option<i64>,
    out_of_scope: Option<&'static str>,
    index_built: bool,
    dates: usize,
    instances: usize,
    template_positions: usize,
    position_scans: usize,
    label_relaxations: usize,
    scan_index_bytes: usize,
    core_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowWire {
    service_date: u32,
    covered: [i64; 2],
    event_count: usize,
    event_index_bytes: usize,
    peak_build_bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WitnessWire {
    service_date: u32,
    route_idx: u32,
    reader_route_idx: u32,
    trip_idx: u32,
    board_position: u32,
    alight_position: u32,
    board_secs: i64,
    alight_secs: i64,
    frequency_offset_secs: i64,
    frequency_instance: bool,
    in_seat: bool,
}
impl From<&R3TransitWitness> for WitnessWire {
    fn from(w: &R3TransitWitness) -> Self {
        Self {
            service_date: w.service_date,
            route_idx: w.route_idx,
            reader_route_idx: w.reader_route_idx,
            trip_idx: w.trip_idx,
            board_position: w.board_position,
            alight_position: w.alight_position,
            board_secs: w.board_secs,
            alight_secs: w.alight_secs,
            frequency_offset_secs: w.frequency_offset_secs,
            frequency_instance: w.frequency_instance,
            in_seat: w.in_seat,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PointWire {
    departure_secs: i64,
    arrival_secs: i64,
    actual_transfers: u32,
    total_walk_secs: u64,
    transit_rounds: u32,
    service_date: u32,
    witness_legs: usize,
    witness: Vec<WitnessWire>,
}
impl From<&R3Point> for PointWire {
    fn from(p: &R3Point) -> Self {
        Self {
            departure_secs: p.origin_departure_secs,
            arrival_secs: p.destination_arrival_secs,
            actual_transfers: p.actual_transfers,
            total_walk_secs: p.total_walk_secs,
            transit_rounds: p.transit_rounds,
            service_date: p.service_date,
            witness_legs: p.witness.len(),
            witness: p.witness.iter().map(Into::into).collect(),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultWire {
    scope: &'static str,
    complete: bool,
    points: Vec<PointWire>,
    prepare_ms: f64,
    search_ms: f64,
    core_ms: f64,
    lookup_work: usize,
    pair_checks: usize,
    segments_enqueued: usize,
    stop_events_scanned: usize,
    prefix_enabled: bool,
    stop_indexed: bool,
    validation_mode: &'static str,
    lookup_mode: &'static str,
    traversal_mode: &'static str,
    witness_comparison: &'static str,
    frontier_storage: &'static str,
    pointer_bytes: usize,
    frontiers: FrontierWire,
    static_bound: bool,
    walking_bound: bool,
    transfer_bound: bool,
    forward_seeds: bool,
    forward: ForwardWire,
    prefix_walking: PrefixWalkingWire,
    prefix_transfer: PrefixTransferWire,
    optimistic: OptimisticWire,
    lazy: LazyWire,
}

fn winner_goal(name: &str) -> Result<Option<DeadlinePreference>, String> {
    if name == "portfolio" {
        return Ok(None);
    }
    DeadlinePreference::ALL
        .into_iter()
        .find(|p| p.name() == name)
        .map(Some)
        .ok_or_else(|| "invalid winner goal".into())
}
fn winner_suffix(name: &str) -> Result<DeadlineSuffixPruning, String> {
    match name {
        "off" => Ok(DeadlineSuffixPruning::Off),
        "row-prefix" => Ok(DeadlineSuffixPruning::RowPrefix),
        _ => Err("invalid winner suffix mode".into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WinnerCountersWire {
    lookup_work: usize,
    stop_work: usize,
    segments: usize,
    segments_scanned: usize,
    max_frontier_width: usize,
    seed_event_checks: usize,
    stop_events_scanned: usize,
    prefix_event_scans: usize,
    prefix_walking_relaxations: usize,
    prefix_enabled: bool,
    point_pruned_boardings: usize,
    event_probes: usize,
    pair_checks: usize,
    instance_probes: usize,
    incoming_index_bytes: usize,
    arena_bytes: usize,
}
impl From<&DeadlineDiagnostics> for WinnerCountersWire {
    fn from(d: &DeadlineDiagnostics) -> Self {
        Self {
            lookup_work: d.lazy.work,
            stop_work: d.seed_event_checks
                + d.stop_events_scanned
                + d.prefix.event_scans
                + d.prefix.walking_relaxations
                + d.prefix.timetable.work()
                + d.optimistic.work()
                + d.forward.stop_work(),
            segments: d.segments_enqueued,
            segments_scanned: d.segments_scanned,
            max_frontier_width: d.max_frontier_width,
            seed_event_checks: d.seed_event_checks,
            stop_events_scanned: d.stop_events_scanned,
            prefix_event_scans: d.prefix.event_scans,
            prefix_walking_relaxations: d.prefix.walking_relaxations,
            prefix_enabled: d.prefix.enabled,
            point_pruned_boardings: d.prefix.point_pruned_boardings,
            event_probes: d.lazy.event_probes,
            pair_checks: d.lazy.pair_checks,
            instance_probes: d.lazy.instance_probes,
            incoming_index_bytes: d.incoming_index_bytes,
            arena_bytes: d.arena_bytes,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WinnerSelectionWire {
    bound_checks: usize,
    pruned_boardings: usize,
    suffix_bound_checks: usize,
    pruned_suffixes: usize,
    predecessor_bound_checks: usize,
    pruned_predecessor_pairs: usize,
    row_bound_checks: usize,
    skipped_rows: usize,
    row_ceiling_builds: usize,
    row_ceiling_selectors: usize,
    row_ceiling_disabled: usize,
}
impl WinnerSelectionWire {
    fn new(s: DeadlinePortfolioDiagnostics, d: LazyLookupDiagnostics) -> Self {
        Self {
            bound_checks: s.bound_checks,
            pruned_boardings: s.pruned_boardings,
            suffix_bound_checks: s.suffix_bound_checks,
            pruned_suffixes: s.pruned_suffixes,
            predecessor_bound_checks: s.predecessor_bound_checks,
            pruned_predecessor_pairs: s.pruned_predecessor_pairs,
            row_bound_checks: d.row_bound_checks,
            skipped_rows: d.certified_source_rows_skipped,
            row_ceiling_builds: s.row_ceiling_builds,
            row_ceiling_selectors: s.row_ceiling_selectors,
            row_ceiling_disabled: s.row_ceiling_disabled,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WinnerResultWire<'a> {
    scope: &'static str,
    contract: &'static str,
    complete: bool,
    completion_scope: &'static str,
    query_kind: &'a str,
    suffix_bound: &'a str,
    requested_window: [i64; 2],
    arrival_deadline: i64,
    winners: BTreeMap<&'static str, Option<PointWire>>,
    validation_mode: &'static str,
    lookup_mode: &'static str,
    traversal_mode: &'static str,
    witness_comparison: &'static str,
    witness_date_memo_stack_bytes: usize,
    frontier_storage: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    prefix_experiment: Option<PrefixResultWire>,
    pointer_bytes: usize,
    frontiers: FrontierWire,
    counters: WinnerCountersWire,
    selection: WinnerSelectionWire,
    lazy: LazyWire,
    prepare_ms: f64,
    search_ms: f64,
    core_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TimetablePrefixWire {
    enabled: bool,
    event_scans: usize,
    walking_proposals: usize,
    profile_checks: usize,
    retained_labels: usize,
    index_bytes: usize,
    work: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrefixResultWire {
    #[serde(flatten)]
    mode: PrefixModeWire,
    enabled: bool,
    /// Retained tracked payload, not allocator overhead, build peak or RSS.
    index_bytes: usize,
    /// Replayed on every search even when physical prefix setup is retained.
    nominal_stop_work: usize,
    timetable: TimetablePrefixWire,
}
impl PrefixResultWire {
    fn new(mode: Option<PrefixModeWire>, p: PrefixDiagnostics) -> Option<Self> {
        let t = p.timetable;
        mode.map(|mode| Self {
            mode,
            enabled: p.enabled,
            index_bytes: p.index_bytes,
            nominal_stop_work: p.event_scans + p.walking_relaxations + t.work(),
            timetable: TimetablePrefixWire {
                enabled: t.enabled,
                event_scans: t.event_scans,
                walking_proposals: t.walking_proposals,
                profile_checks: t.profile_checks,
                retained_labels: t.retained_labels,
                index_bytes: t.index_bytes,
                work: t.work(),
            },
        })
    }
}

fn project_winners(
    winners: &DeadlinePortfolioWinners,
    preference: Option<DeadlinePreference>,
) -> BTreeMap<&'static str, Option<PointWire>> {
    DeadlinePreference::ALL
        .into_iter()
        .zip(&winners.by_preference)
        .filter(|(p, _)| preference.is_none_or(|s| s == *p))
        .map(|(p, w)| (p.name(), w.as_ref().map(Into::into)))
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FrontierWire {
    directory_entries: usize,
    directory_capacity_bytes: usize,
    records: usize,
    record_capacity_bytes: Option<usize>,
    retained_ids: usize,
    id_capacity_bytes: usize,
}
impl From<DeadlineFrontierStats> for FrontierWire {
    fn from(f: DeadlineFrontierStats) -> Self {
        Self {
            directory_entries: f.directory_entries,
            directory_capacity_bytes: f.directory_capacity_bytes,
            records: f.records,
            record_capacity_bytes: f.record_capacity_bytes,
            retained_ids: f.retained_ids,
            id_capacity_bytes: f.id_capacity_bytes,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LazyWire {
    work: usize,
    event_probes: usize,
    pair_checks: usize,
    instance_probes: usize,
    plain_pair_checks: usize,
    fallback_pair_checks: usize,
    walking_index_edges: usize,
    rule_candidate_edges: usize,
    stop_indexed: bool,
    early_source_rows_skipped: usize,
    source_bound_cache_rows: usize,
    source_bound_cache_probes: usize,
    source_bound_cache_hits: usize,
    source_bound_cache_misses: usize,
    source_bound_cache_bytes: usize,
}
impl From<LazyLookupDiagnostics> for LazyWire {
    fn from(d: LazyLookupDiagnostics) -> Self {
        Self {
            work: d.work,
            event_probes: d.event_probes,
            pair_checks: d.pair_checks,
            instance_probes: d.instance_probes,
            plain_pair_checks: d.plain_pair_checks,
            fallback_pair_checks: d.fallback_pair_checks,
            walking_index_edges: d.walking_index_edges,
            rule_candidate_edges: d.rule_candidate_edges,
            stop_indexed: d.stop_indexed,
            early_source_rows_skipped: d.early_source_rows_skipped,
            source_bound_cache_rows: d.source_bound_cache_rows,
            source_bound_cache_probes: d.source_bound_cache_probes,
            source_bound_cache_hits: d.source_bound_cache_hits,
            source_bound_cache_misses: d.source_bound_cache_misses,
            source_bound_cache_bytes: d.source_bound_cache_bytes,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrefixWalkingWire {
    enabled: bool,
    bytes: usize,
    pruned_boardings: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrefixTransferWire {
    /// False when requested but the feed has no derived continuations.
    enabled: bool,
    bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ForwardWire {
    enabled: bool,
    selection_checks: usize,
    root_candidates: usize,
    shots: usize,
    truncated_shots: usize,
    stop_scans: usize,
    stop_work: usize,
    lookup_work: usize,
    accepted_states: usize,
    incumbents: usize,
    certified_prunes: usize,
    arena_bytes: usize,
}
impl From<ForwardSeedDiagnostics> for ForwardWire {
    fn from(d: ForwardSeedDiagnostics) -> Self {
        Self {
            enabled: d.enabled,
            selection_checks: d.selection_checks,
            root_candidates: d.root_candidates,
            shots: d.shots,
            truncated_shots: d.truncated_shots,
            stop_scans: d.stop_scans,
            stop_work: d.stop_work(),
            lookup_work: d.lookup_work,
            accepted_states: d.accepted_states,
            incumbents: d.incumbents,
            certified_prunes: d.certified_prunes,
            arena_bytes: d.arena_bytes,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OptimisticWire {
    enabled: bool,
    work: usize,
    template_rows: usize,
    movement_checks: usize,
    distance_work: usize,
    edges: usize,
    graph_bytes: usize,
    potential_bytes: usize,
    origin_duration_secs: Option<i64>,
    origin_pruned_segments: usize,
    destination_pruned_segments: usize,
    walking_pruned_boardings: usize,
}
impl From<OptimisticDiagnostics> for OptimisticWire {
    fn from(d: OptimisticDiagnostics) -> Self {
        Self {
            enabled: d.enabled,
            work: d.work(),
            template_rows: d.template_rows,
            movement_checks: d.movement_checks,
            distance_work: d.distance_work,
            edges: d.edges,
            graph_bytes: d.graph_bytes,
            potential_bytes: d.potential_bytes,
            origin_duration_secs: d.origin_duration_secs,
            origin_pruned_segments: d.origin_pruned_segments,
            destination_pruned_segments: d.destination_pruned_segments,
            walking_pruned_boardings: d.walking_pruned_boardings,
        }
    }
}

impl TemporalDeadlineProbe {
    fn new_inner(ptb: &[u8], ptft: &[u8], mode: &str, retained: bool) -> Result<Self, JsError> {
        let mode = match mode {
            "off" => PatternMode::Off,
            "unbounded" => PatternMode::Unbounded,
            "covering-merge" => PatternMode::CoveringMerge,
            _ => return Err(JsError::new("invalid pattern mode")),
        };
        setup_mark!(setup_profile::Mark::Wasm("OwnerStarted"));
        let bytes = ptb.to_vec();
        setup_mark!(setup_profile::Mark::Wasm("InputCopied"));
        let reader = Reader::from_bytes(bytes).map_err(crate::error::ptb_error_to_js)?;
        setup_mark!(setup_profile::Mark::Wasm("ReaderBuilt"));
        let transfers = if ptft.is_empty() {
            None
        } else {
            Some(
                Transfers::from_bytes(ptft)
                    .map_err(|e| JsError::new(&format!("deadline PTFT: {e:?}")))?,
            )
        };
        setup_mark!(setup_profile::Mark::Wasm("TransfersBuilt"));
        let session = if retained {
            DeadlineSession::new_with_immutable_binding_and_phases(reader, mode, transfers, |_p| {
                setup_mark!(setup_profile::Mark::Core(_p));
            })
        } else {
            DeadlineSession::new(reader, mode, transfers)
        }
        .map_err(|e| JsError::new(&format!("deadline index: {e:?}")))?;
        Ok(Self {
            session,
            validation: None,
            lookup: Lookup::Fast,
            traversal: Traversal::Fifo,
            witness_comparison: WitnessComparison::Materialized,
            frontier_storage: FrontierStorage::Tree,
            prefix_mode: None,
            static_bound: false,
            walking_bound: false,
            transfer_bound: false,
            forward_seeds: false,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OwnerBindingWire {
    schema: &'static str,
    policy: &'static str,
    pointer_bytes: usize,
    owner_inline_bytes: usize,
    probe_inline_bytes: usize,
    binding_slot_bytes: usize,
    populated_binding_bytes: usize,
    separate_binding_allocation_bytes: usize,
}

impl TemporalDeadlineProbe {
    fn binding_wire(&self) -> OwnerBindingWire {
        let populated = self.session.retained_binding_bytes();
        OwnerBindingWire {
            schema: "immutable-owner-v1",
            policy: if populated == 0 {
                "recompute"
            } else {
                "retained"
            },
            pointer_bytes: core::mem::size_of::<usize>(),
            owner_inline_bytes: DeadlineSession::owner_storage_bytes(),
            probe_inline_bytes: core::mem::size_of::<Self>(),
            binding_slot_bytes: DeadlineSession::immutable_binding_slot_bytes(),
            populated_binding_bytes: populated,
            separate_binding_allocation_bytes: 0,
        }
    }
}

#[wasm_bindgen]
impl TemporalDeadlineProbe {
    #[wasm_bindgen(constructor)]
    pub fn new(ptb: &[u8], ptft: &[u8], mode: &str) -> Result<TemporalDeadlineProbe, JsError> {
        Self::new_inner(ptb, ptft, mode, false)
    }

    /// Additive experimental factory. Hash work is charged to construction;
    /// query options cannot substitute or forge a retained validation token.
    #[wasm_bindgen(js_name = withImmutableBinding)]
    pub fn with_immutable_binding(ptb: &[u8], ptft: &[u8], mode: &str) -> Result<Self, JsError> {
        Self::new_inner(ptb, ptft, mode, true)
    }

    /// Read-only footprint/retention diagnostics outside routing result schemas.
    /// Inline bytes are included in the owning allocation, not free heap memory.
    /// No separate digest allocation exists; this is not a live-RSS measure.
    pub fn owner_binding_info(&self) -> Result<JsValue, JsError> {
        serde_wasm_bindgen::to_value(&self.binding_wire())
            .map_err(|e| JsError::new(&format!("owner binding output: {e}")))
    }

    /// Build one catalogue separately from query latency. Failed preparation
    /// invalidates the old request; retained cache data can never be run without
    /// another successful preparation with a matching canonical key.
    pub fn prepare(&mut self, query: JsValue, options: JsValue) -> Result<JsValue, JsValue> {
        setup_mark!(setup_profile::Mark::Wasm("PrepareStarted"));
        self.validation = None;
        self.prefix_mode = None;
        self.session.invalidate_request();
        let query = crate::query::build_engine_query(
            self.session.reader(),
            crate::query::deserialize_query(query)?,
        )?;
        setup_mark!(setup_profile::Mark::Wasm("QueryBuilt"));
        // serde-wasm-bindgen's struct ObjectAccess visits declared fields only;
        // deny_unknown_fields alone cannot reject extra JS object properties.
        if !options.is_object() || options.is_null() || js_sys::Array::is_array(&options) {
            return Err(JsError::new("deadline options must be an object").into());
        }
        for key in
            js_sys::Object::get_own_property_names(options.unchecked_ref::<js_sys::Object>()).iter()
        {
            let key = key.as_string().unwrap_or_default();
            if !Options::known_key(&key) {
                return Err(JsError::new(&format!("unknown deadline options field: {key}")).into());
            }
        }
        let options: Options = serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsError::new(&format!("deadline options: {e}")))?;
        options.validate().map_err(|e| JsError::new(&e))?;
        setup_mark!(setup_profile::Mark::Wasm("OptionsParsed"));
        let observe = |_p| {
            setup_mark!(setup_profile::Mark::Core(_p));
        };
        let source = options.catalogue.source();
        let d = match (options.prefix_setup, options.catalogue) {
            (PrefixSetup::Prepared, _) => self.session.prepare_with_prefix_cache_from_and_phases(
                query,
                options.config(),
                source,
                observe,
            ),
            (_, CatalogueMode::Reuse) => self.session.prepare_reusing(query, options.config()),
            (_, CatalogueMode::Fresh | CatalogueMode::HeldSlice) => self
                .session
                .prepare_from_with_phases(query, options.config(), source, observe),
        }
        .map_err(failure::prepare)?;
        let wire = PreparedWire {
            event_count: d.events,
            event_index_bytes: d.index_bytes,
            peak_build_bytes: d.peak_build_bytes,
            catalogue_mode: options.catalogue.name(),
            catalogue_reused: self.session.catalogue_reused(),
            catalogue_key: self.session.catalogue_key(),
            catalogue_origin: self.session.catalogue_origin().map(origin_name),
            held_catalogue_bytes: self.session.held_catalogue_bytes(),
            lookup_mode: options.lookup.name(),
            traversal_mode: options.traversal.name(),
            witness_comparison: options.witness_comparison.name(),
            frontier_storage: options.frontier_storage.name(),
            prefix_experiment: options.prefix_mode(),
            static_bound: options.static_bound,
            walking_bound: options.walking_bound,
            transfer_bound: options.transfer_bound,
            forward_seeds: options.forward_seeds,
        };
        let value = match serde_wasm_bindgen::to_value(&wire) {
            Ok(value) => value,
            Err(error) => {
                self.clear();
                return Err(JsError::new(&error.to_string()).into());
            }
        };
        self.validation = Some(options.validation);
        self.lookup = options.lookup;
        self.traversal = options.traversal;
        self.witness_comparison = options.witness_comparison;
        self.frontier_storage = options.frontier_storage;
        self.prefix_mode = options.prefix_mode();
        self.static_bound = options.static_bound;
        self.walking_bound = options.walking_bound;
        self.transfer_bound = options.transfer_bound;
        self.forward_seeds = options.forward_seeds;
        setup_mark!(setup_profile::Mark::Wasm("WireBuilt"));
        Ok(value)
    }

    /// Includes binding/setup, exact search, and JS projection. The external
    /// harness measures the whole call, not only these internal core phases.
    pub fn run(&self) -> Result<JsValue, JsError> {
        if self.prefix_mode.is_some() {
            return Err(JsError::new("prefix experiment requires run_winners"));
        }
        let validation = self
            .validation
            .ok_or_else(|| JsError::new("deadline request is not prepared"))?;
        let began = now();
        let mut prepared = 0.0;
        let mut finished = 0.0;
        let observe = |phase| match phase {
            DeadlinePhase::Prepared => prepared = now() - began,
            DeadlinePhase::SearchFinished => finished = now() - began,
        };
        let result = match validation {
            Validation::Checked => self.session.run_checked_with_phases(observe),
            Validation::Session => self.session.run_with_phases(observe),
        }
        .map_err(|e| JsError::new(&format!("deadline query: {e:?}")))?;
        let core_ms = now() - began;
        let d = result.diagnostics;
        let wire = ResultWire {
            scope: "deadline-constrained-r3-m4-experiment",
            complete: result.complete,
            points: result.points.iter().map(Into::into).collect(),
            prepare_ms: prepared,
            search_ms: finished - prepared,
            core_ms,
            lookup_work: d.lazy.work,
            pair_checks: d.lazy.pair_checks,
            segments_enqueued: d.segments_enqueued,
            stop_events_scanned: d.stop_events_scanned,
            prefix_enabled: d.prefix.enabled,
            stop_indexed: d.lazy.stop_indexed,
            validation_mode: validation.name(),
            lookup_mode: self.lookup.name(),
            traversal_mode: self.traversal.name(),
            witness_comparison: self.witness_comparison.name(),
            frontier_storage: self.frontier_storage.name(),
            pointer_bytes: core::mem::size_of::<usize>(),
            frontiers: result.frontiers.into(),
            static_bound: self.static_bound,
            walking_bound: self.walking_bound,
            transfer_bound: self.transfer_bound,
            forward_seeds: self.forward_seeds,
            forward: d.forward.into(),
            prefix_walking: PrefixWalkingWire {
                enabled: d.prefix.walking_enabled,
                bytes: d.prefix.walking_bytes,
                pruned_boardings: d.prefix.walking_pruned_boardings,
            },
            prefix_transfer: PrefixTransferWire {
                enabled: d.prefix.transfer_bound_enabled,
                bytes: d.prefix.transfer_bound_bytes,
            },
            optimistic: d.optimistic.into(),
            lazy: d.lazy.into(),
        };
        // Unknown tree node/header capacity is explicitly null, never zero or
        // an omitted field that could look like missing instrumentation.
        wire.serialize(&serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true))
            .map_err(|e| JsError::new(&format!("deadline output: {e}")))
    }

    /// Only the requested fixed selector(s) are complete, never a skyline,
    /// arrival band, fare or missed-transfer recovery policy. Historical
    /// departures remain eligible. Run arguments cannot change owned inputs.
    /// GTFS occurrences: https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
    pub fn run_winners(&self, goal: &str, suffix: &str) -> Result<JsValue, JsValue> {
        self.winner_output(goal, suffix, false)
    }

    /// Additive movement output; canonical points and existing run_winners
    /// remain unchanged. Any projection exhaustion fails the entire call.
    pub fn run_winner_journeys(&self, goal: &str, suffix: &str) -> Result<JsValue, JsValue> {
        self.winner_output(goal, suffix, true)
    }

    /// H70, experimental and opt-in: build and hold the catalogue for
    /// `[windowStart, windowEnd)` on the date of `query`, with its mobility
    /// and excluded modes (stops and time are ignored). The next `prepare`
    /// that builds a catalogue takes it over: a request with the same key
    /// whose catalogue interval lies inside gets it cut in place, identical
    /// to a fresh one; any other request drops it. This call retires the
    /// prepared request, as `clear` does. Without it, nothing changes.
    #[wasm_bindgen(js_name = prepareWindow)]
    pub fn prepare_window(
        &mut self,
        query: JsValue,
        window_start: f64,
        window_end: f64,
    ) -> Result<JsValue, JsError> {
        setup_mark!(setup_profile::Mark::Wasm("WindowStarted"));
        self.clear();
        let bound = |x: f64| {
            (x.fract() == 0.0 && x.abs() <= 1e15)
                .then_some(x as i64)
                .ok_or_else(|| JsError::new("window bounds must be integer seconds"))
        };
        let covered = bound(window_start)?..bound(window_end)?;
        let query = crate::query::build_engine_query(
            self.session.reader(),
            crate::query::deserialize_query(query)?,
        )?;
        let d = self
            .session
            .prepare_window_with_phases(
                query.date,
                query.mobility,
                query.excluded_modes,
                covered.clone(),
                |_p| {
                    setup_mark!(setup_profile::Mark::Core(_p));
                },
            )
            .map_err(|e| JsError::new(&format!("deadline window catalogue: {e:?}")))?;
        let wire = WindowWire {
            service_date: query.date,
            covered: [covered.start, covered.end],
            event_count: d.events,
            event_index_bytes: d.index_bytes,
            peak_build_bytes: d.peak_build_bytes,
        };
        let value = serde_wasm_bindgen::to_value(&wire)
            .map_err(|e| JsError::new(&format!("window catalogue output: {e}")))?;
        setup_mark!(setup_profile::Mark::Wasm("WindowWireBuilt"));
        Ok(value)
    }

    /// H58 phase A, experimental and opt-in: the latest departure in
    /// `[windowStart, windowEnd)` of any journey for `query` that arrives by
    /// `arrivalDeadline`, by a backward scan without a request catalogue.
    /// It returns a time, not a journey: the latest-departure selector on
    /// `[departure, departure + 1)` certifies the winner. A request outside
    /// the scan's scope returns `outOfScope` (not an error) and the caller
    /// runs the full request. The prepared request is left as it is.
    #[wasm_bindgen(js_name = latestDeparture)]
    pub fn latest_departure(
        &mut self,
        query: JsValue,
        window_start: f64,
        window_end: f64,
        arrival_deadline: f64,
    ) -> Result<JsValue, JsError> {
        let time = |x: f64| {
            (x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0)
                .then_some(x as i64)
                .ok_or_else(|| JsError::new("scan times must be integer seconds"))
        };
        let window = time(window_start)?..time(window_end)?;
        let deadline = time(arrival_deadline)?;
        let query = crate::query::build_engine_query(
            self.session.reader(),
            crate::query::deserialize_query(query)?,
        )?;
        let held = self.session.latest_scan_bytes();
        let began = now();
        let (departure, out_of_scope, d) =
            match self
                .session
                .latest_departure(&query, window.clone(), deadline)
            {
                Ok(r) => (r.departure, None, r.diagnostics),
                Err(LatestScanError::Unsupported(why)) => {
                    (None, Some(why), LatestScanDiagnostics::default())
                }
                Err(LatestScanError::Engine(e)) => {
                    return Err(JsError::new(&format!("latest scan: {e:?}")))
                }
            };
        let wire = LatestScanWire {
            schema: "latest-scan-v1",
            window: [window.start, window.end],
            arrival_deadline: deadline,
            departure,
            out_of_scope,
            // Also true when the first call was out of scope.
            index_built: d.index_built || held == 0 && self.session.latest_scan_bytes() > 0,
            dates: d.dates,
            instances: d.instances,
            template_positions: d.template_positions,
            position_scans: d.position_scans,
            label_relaxations: d.label_relaxations,
            scan_index_bytes: self.session.latest_scan_bytes(),
            core_ms: now() - began,
        };
        wire.serialize(&serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true))
            .map_err(|e| JsError::new(&format!("latest scan output: {e}")))
    }

    /// H81 phase A, experimental and opt-in: for `fewest-transfers` or
    /// `least-walking`, the selector's optimal first key over
    /// `[windowStart, windowEnd)` and the latest departure achieving it, by
    /// the H58 scan. It returns a time, not a journey: the same selector on
    /// `[departure, departure + 1)` certifies the winner, which must have
    /// this optimum. Out of the scan's scope returns `outOfScope` (not an
    /// error) and the caller runs the full request. Other goals are errors.
    /// The prepared request is left as it is.
    #[wasm_bindgen(js_name = selectorDeparture)]
    pub fn selector_departure(
        &mut self,
        goal: &str,
        query: JsValue,
        window_start: f64,
        window_end: f64,
        arrival_deadline: f64,
    ) -> Result<JsValue, JsError> {
        let preference = winner_goal(goal)
            .map_err(|e| JsError::new(&e))?
            .filter(|p| p.has_selector_scan())
            .ok_or_else(|| JsError::new("selector scan needs fewest-transfers or least-walking"))?;
        let time = |x: f64| {
            (x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0)
                .then_some(x as i64)
                .ok_or_else(|| JsError::new("scan times must be integer seconds"))
        };
        let window = time(window_start)?..time(window_end)?;
        let deadline = time(arrival_deadline)?;
        let query = crate::query::build_engine_query(
            self.session.reader(),
            crate::query::deserialize_query(query)?,
        )?;
        let held = self.session.latest_scan_bytes();
        let began = now();
        let (optimum, departure, out_of_scope, d) =
            match self
                .session
                .selector_departure(preference, &query, window.clone(), deadline)
            {
                Ok(r) => (r.optimum, r.departure, None, r.diagnostics),
                Err(LatestScanError::Unsupported(why)) => {
                    (None, None, Some(why), LatestScanDiagnostics::default())
                }
                Err(LatestScanError::Engine(e)) => {
                    return Err(JsError::new(&format!("selector scan: {e:?}")))
                }
            };
        if optimum.is_some_and(|o| o > 9_007_199_254_740_991) {
            return Err(JsError::new("selector optimum is not a JS safe integer"));
        }
        let wire = SelectorScanWire {
            schema: "selector-scan-v1",
            goal: preference.name(),
            window: [window.start, window.end],
            arrival_deadline: deadline,
            optimum,
            departure,
            out_of_scope,
            // Also true when the first call was out of scope.
            index_built: d.index_built || held == 0 && self.session.latest_scan_bytes() > 0,
            dates: d.dates,
            instances: d.instances,
            template_positions: d.template_positions,
            position_scans: d.position_scans,
            label_relaxations: d.label_relaxations,
            scan_index_bytes: self.session.latest_scan_bytes(),
            core_ms: now() - began,
        };
        wire.serialize(&serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true))
            .map_err(|e| JsError::new(&format!("selector scan output: {e}")))
    }

    pub fn clear(&mut self) {
        self.session.clear();
        self.validation = None;
        self.prefix_mode = None;
    }
}

impl TemporalDeadlineProbe {
    fn winner_output(&self, goal: &str, suffix: &str, movements: bool) -> Result<JsValue, JsValue> {
        let validation = self
            .validation
            .ok_or_else(|| JsError::new("deadline request is not prepared"))?;
        let preference = winner_goal(goal).map_err(|e| JsError::new(&e))?;
        let pruning = winner_suffix(suffix).map_err(|e| JsError::new(&e))?;
        let began = now();
        let mut prepared = 0.0;
        let mut finished = 0.0;
        let observe = |phase| match phase {
            DeadlinePhase::Prepared => prepared = now() - began,
            DeadlinePhase::SearchFinished => finished = now() - began,
        };
        let mut movement = None;
        let (winners, window, deadline, complete, d, frontiers, selection) = if let Some(p) =
            preference
        {
            let r = if movements {
                let r = match validation {
                    Validation::Checked => self
                        .session
                        .run_preference_journey_checked_with_phases(p, pruning, observe),
                    Validation::Session => self
                        .session
                        .run_preference_journey_with_phases(p, pruning, observe),
                }
                .map_err(|e| failure::query(e, true))?;
                movement = Some(journey::Projection::single(p, r.journey, r.projection));
                r.search
            } else {
                match validation {
                    Validation::Checked => self
                        .session
                        .run_preference_checked_with_phases(p, pruning, observe),
                    Validation::Session => {
                        self.session.run_preference_with_phases(p, pruning, observe)
                    }
                }
                .map_err(|e| failure::query(e, false))?
            };
            let mut w = DeadlinePortfolioWinners::default();
            let slot = DeadlinePreference::ALL
                .iter()
                .position(|s| *s == p)
                .unwrap();
            w.by_preference[slot] = r.winner;
            (
                w,
                r.window,
                r.arrival_deadline,
                r.complete,
                r.diagnostics,
                r.frontiers,
                r.selection,
            )
        } else {
            let r = if movements {
                let r = match validation {
                    Validation::Checked => self
                        .session
                        .run_portfolio_journeys_checked_with_phases(pruning, observe),
                    Validation::Session => self
                        .session
                        .run_portfolio_journeys_with_phases(pruning, observe),
                }
                .map_err(|e| failure::query(e, true))?;
                movement = Some(journey::Projection {
                    journeys: r.journeys,
                    by_preference: r.by_preference,
                    diagnostics: r.projection,
                });
                r.search
            } else {
                match validation {
                    Validation::Checked => self
                        .session
                        .run_portfolio_checked_with_phases(pruning, observe),
                    Validation::Session => self.session.run_portfolio_with_phases(pruning, observe),
                }
                .map_err(|e| failure::query(e, false))?
            };
            (
                r.winners,
                r.window,
                r.arrival_deadline,
                r.complete,
                r.diagnostics,
                r.frontiers,
                r.selection,
            )
        };
        let core_ms = now() - began;
        let wire = WinnerResultWire {
            scope: "deadline-winner-session-wasm-experiment",
            contract: "lexicographic-filter-winners-v1-no-arrival-floor",
            complete,
            completion_scope: if preference.is_some() {
                "single-selector-only"
            } else {
                "fixed-selectors-only"
            },
            query_kind: goal,
            suffix_bound: suffix,
            requested_window: [window.start, window.end],
            arrival_deadline: deadline,
            winners: project_winners(&winners, preference),
            validation_mode: validation.name(),
            lookup_mode: self.lookup.name(),
            traversal_mode: self.traversal.name(),
            witness_comparison: self.witness_comparison.name(),
            witness_date_memo_stack_bytes: DeadlineWitnessComparison::date_memo_stack_bytes(),
            frontier_storage: self.frontier_storage.name(),
            prefix_experiment: PrefixResultWire::new(self.prefix_mode, d.prefix),
            pointer_bytes: core::mem::size_of::<usize>(),
            frontiers: frontiers.into(),
            counters: (&d).into(),
            selection: WinnerSelectionWire::new(selection, d.lazy),
            lazy: d.lazy.into(),
            prepare_ms: prepared,
            search_ms: finished - prepared,
            core_ms,
        };
        // Null empty winners and ordinary JS objects are part of this separate
        // interface. Do not change the existing full-profile result serializer.
        let serializer = serde_wasm_bindgen::Serializer::new()
            .serialize_maps_as_objects(true)
            .serialize_missing_as_null(true);
        if let Some(movement) = movement {
            journey::ResultWire::new(
                self.session.reader(),
                wire,
                movement,
                preference,
                core_ms - finished,
            )
            .map_err(|e| JsError::new(&format!("deadline journey metadata: {e}")))?
            .serialize(&serializer)
        } else {
            wire.serialize(&serializer)
        }
        .map_err(|e| JsError::new(&format!("deadline winner output: {e}")))
        .map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owner_binding_factory_reports_actual_retention_and_keeps_query_options_unchanged() {
        let bytes = include_bytes!(
            "../../../packages/frontend/tests/services/__fixtures__/same-pattern-trips.ptb"
        );
        for mode in ["off", "unbounded", "covering-merge"] {
            for retained in [false, true] {
                let mut probe =
                    TemporalDeadlineProbe::new_inner(bytes, &[], mode, retained).unwrap();
                let wire = probe.binding_wire();
                assert_eq!(wire.policy, if retained { "retained" } else { "recompute" });
                assert_eq!(wire.populated_binding_bytes, if retained { 97 } else { 0 });
                assert!(wire.binding_slot_bytes >= wire.populated_binding_bytes);
                assert!(wire.owner_inline_bytes > wire.binding_slot_bytes);
                assert!(wire.probe_inline_bytes >= wire.owner_inline_bytes);
                assert_eq!(wire.separate_binding_allocation_bytes, 0);
                let before = serde_json::to_value(wire).unwrap();
                probe.clear();
                assert_eq!(serde_json::to_value(probe.binding_wire()).unwrap(), before);
                assert!(probe.validation.is_none());
            }
        }
        assert!(!Options::known_key("ownerBinding"));
        assert!(!Options::known_key("bindingInfo"));
    }
    fn options() -> Options {
        serde_json::from_str(r#"{"windowStart":900,"windowEnd":1001,"arrivalDeadline":1200}"#)
            .unwrap()
    }
    #[test]
    fn prefix_modes_are_explicit_and_defaults_are_unchanged() {
        let o = options();
        assert!(o.prefix_mode().is_none());
        assert_eq!(o.config().pruning, DeadlinePruning::EarliestPrefixAndPoints);
        for certificate in ["duration", "timetable"] {
            for setup in ["rebuild", "prepared"] {
                let value = serde_json::json!({"windowStart":900,"windowEnd":1001,
                    "arrivalDeadline":1200,"validation":"session",
                    "prefixCertificate":certificate,"prefixSetup":setup});
                let o: Options = serde_json::from_value(value.clone()).unwrap();
                o.validate().unwrap();
                assert_eq!(
                    o.config().pruning,
                    if certificate == "timetable" {
                        DeadlinePruning::EarliestPrefixAndTimetablePoints
                    } else {
                        DeadlinePruning::EarliestPrefixAndPoints
                    }
                );
                if let Some(mode) = o.prefix_mode() {
                    assert_eq!(
                        serde_json::to_value(mode).unwrap(),
                        serde_json::json!({"certificate":certificate,"setup":setup})
                    );
                } else {
                    assert_eq!((certificate, setup), ("duration", "rebuild"));
                }
                for key in ["prefixCertificate", "prefixSetup"] {
                    assert!(Options::known_key(key));
                    let mut invalid = value.clone();
                    invalid[key] = serde_json::json!("invalid");
                    assert!(serde_json::from_value::<Options>(invalid).is_err());
                }
            }
        }
    }
    #[test]
    fn prefix_modes_reject_unsupported_combinations_without_silent_reuse() {
        for certificate in ["duration", "timetable"] {
            let base = serde_json::json!({"windowStart":900,"windowEnd":1001,
                "arrivalDeadline":1200,"validation":"session",
                "prefixCertificate":certificate,"prefixSetup":"prepared"});
            for (key, value) in [
                ("objective", serde_json::json!("r3")),
                ("prefixBound", serde_json::json!(false)),
                ("pointBound", serde_json::json!(false)),
                ("staticBound", serde_json::json!(true)),
                ("forwardSeeds", serde_json::json!(true)),
                ("validation", serde_json::json!("checked")),
                ("catalogue", serde_json::json!("reuse")),
            ] {
                let mut input = base.clone();
                input[key] = value;
                assert!(
                    serde_json::from_value::<Options>(input)
                        .unwrap()
                        .validate()
                        .is_err(),
                    "{certificate}/{key}"
                );
            }
        }
        let o: Options = serde_json::from_value(serde_json::json!({"windowStart":900,
            "windowEnd":1001,"arrivalDeadline":1200,"prefixCertificate":"timetable"}))
        .unwrap();
        o.validate().unwrap(); // Explicit checked/rebuild control is supported.
    }
    #[test]
    fn walking_prefix_combinations_are_explicit_and_keep_defaults_and_caps() {
        assert!(!options().walking_bound);
        for certificate in ["duration", "timetable"] {
            for setup in ["rebuild", "prepared"] {
                let input = serde_json::json!({"windowStart":900,"windowEnd":1001,
                    "arrivalDeadline":1200,"validation":"session",
                    "prefixCertificate":certificate,"prefixSetup":setup,"walkingBound":true});
                let o: Options = serde_json::from_value(input.clone()).unwrap();
                o.validate().unwrap();
                let c = o.config();
                assert!(c.walking_bound);
                assert_eq!(c.max_lookup_work, 10_000_000);
                assert_eq!(c.max_stop_scans, 10_000_000);
                for key in ["prefixBound", "pointBound"] {
                    let mut bad = input.clone();
                    bad[key] = serde_json::json!(false);
                    assert!(serde_json::from_value::<Options>(bad)
                        .unwrap()
                        .validate()
                        .is_err());
                }
            }
        }
    }
    #[test]
    fn timetable_projection_keeps_all_nominal_stop_work() {
        let p = PrefixDiagnostics {
            enabled: true,
            event_scans: 2,
            walking_relaxations: 3,
            index_bytes: 1234,
            timetable: TimetablePrefixDiagnostics {
                enabled: true,
                event_scans: 5,
                walking_proposals: 7,
                profile_checks: 11,
                retained_labels: 13,
                index_bytes: 1000,
            },
            ..Default::default()
        };
        let d = DeadlineDiagnostics {
            seed_event_checks: 17,
            stop_events_scanned: 19,
            prefix: p,
            ..Default::default()
        };
        assert_eq!(WinnerCountersWire::from(&d).stop_work, 64);
        assert!(PrefixResultWire::new(None, p).is_none());
        let r = serde_json::to_value(PrefixResultWire::new(
            Some(PrefixModeWire {
                certificate: "timetable",
                setup: "prepared",
            }),
            p,
        ))
        .unwrap();
        assert_eq!(r["nominalStopWork"], 28);
        assert_eq!(r["indexBytes"], 1234);
        assert_eq!(r["timetable"]["work"], 23);
        assert_eq!(r["timetable"]["indexBytes"], 1000);
    }
    #[test]
    fn winner_goals_and_pruning_are_explicit_without_profile_defaults() {
        assert_eq!(winner_goal("portfolio").unwrap(), None);
        for p in DeadlinePreference::ALL {
            assert_eq!(winner_goal(p.name()).unwrap(), Some(p));
        }
        for name in ["", "profile", "latest", "top3", "LATEST-DEPARTURE"] {
            assert!(winner_goal(name).is_err());
        }
        assert_eq!(winner_suffix("off").unwrap(), DeadlineSuffixPruning::Off);
        assert_eq!(
            winner_suffix("row-prefix").unwrap(),
            DeadlineSuffixPruning::RowPrefix
        );
        for name in ["", "on", "row-ceiling", "before-pairs"] {
            assert!(winner_suffix(name).is_err());
        }
        assert_eq!(options().validation.name(), "checked");
    }
    #[test]
    fn winner_projection_omits_unrequested_selectors_but_keeps_empty_nulls() {
        let empty = DeadlinePortfolioWinners::default();
        let all = serde_json::to_value(project_winners(&empty, None)).unwrap();
        assert_eq!(all.as_object().unwrap().len(), 4);
        for p in DeadlinePreference::ALL {
            assert!(all[p.name()].is_null());
            let single = serde_json::to_value(project_winners(&empty, Some(p))).unwrap();
            assert_eq!(single.as_object().unwrap().len(), 1);
            assert!(single[p.name()].is_null());
        }
    }
    #[test]
    fn winner_work_and_certificate_projection_preserves_every_charge() {
        let d = DeadlineDiagnostics {
            seed_event_checks: 2,
            stop_events_scanned: 3,
            prefix: PrefixDiagnostics {
                event_scans: 5,
                walking_relaxations: 7,
                ..Default::default()
            },
            lazy: LazyLookupDiagnostics {
                row_bound_checks: 11,
                certified_source_rows_skipped: 13,
                ..Default::default()
            },
            ..Default::default()
        };
        let w = serde_json::to_value(WinnerCountersWire::from(&d)).unwrap();
        assert_eq!(w["stopWork"], 17);
        assert_eq!(w.as_object().unwrap().len(), 16);
        let s = serde_json::to_value(WinnerSelectionWire::new(
            DeadlinePortfolioDiagnostics {
                suffix_bound_checks: 19,
                ..Default::default()
            },
            d.lazy,
        ))
        .unwrap();
        assert_eq!(s["rowBoundChecks"], 11);
        assert_eq!(s["skippedRows"], 13);
        assert_eq!(s["suffixBoundChecks"], 19);
        assert_eq!(s.as_object().unwrap().len(), 11);
    }
    #[test]
    fn frontier_storage_defaults_to_tree_and_indexing_is_explicit() {
        assert_eq!(
            options().config().frontier_storage,
            DeadlineFrontierStorage::Tree
        );
        let o: Options = serde_json::from_str(r#"{"windowStart":900,"windowEnd":1001,"arrivalDeadline":1200,"frontierStorage":"event-indexed"}"#).unwrap();
        assert_eq!(
            o.config().frontier_storage,
            DeadlineFrontierStorage::EventIndexed
        );
        assert_eq!(o.frontier_storage.name(), "event-indexed");
        assert!(Options::known_key("frontierStorage"));
        assert!(serde_json::from_str::<Options>(r#"{"windowStart":900,"windowEnd":1001,"arrivalDeadline":1200,"frontierStorage":"indexed"}"#).is_err());
    }

    #[test]
    fn frontier_wire_preserves_capacities_and_unknown_tree_nodes() {
        let f = DeadlineFrontierStats {
            directory_entries: 10,
            directory_capacity_bytes: 40,
            records: 2,
            record_capacity_bytes: Some(48),
            retained_ids: 3,
            id_capacity_bytes: 32,
        };
        let value = serde_json::to_value(FrontierWire::from(f)).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"directoryEntries":10,"directoryCapacityBytes":40,
            "records":2,"recordCapacityBytes":48,"retainedIds":3,"idCapacityBytes":32})
        );
        let tree =
            serde_json::to_value(FrontierWire::from(DeadlineFrontierStats::default())).unwrap();
        assert!(tree["recordCapacityBytes"].is_null());
    }
    #[test]
    fn witness_comparison_defaults_to_materialized_and_streaming_is_explicit() {
        assert_eq!(
            options().config().witness_comparison,
            DeadlineWitnessComparison::Materialized
        );
        let o: Options = serde_json::from_str(r#"{"windowStart":900,"windowEnd":1001,"arrivalDeadline":1200,"witnessComparison":"streaming"}"#).unwrap();
        assert_eq!(
            o.config().witness_comparison,
            DeadlineWitnessComparison::Streaming
        );
        assert_eq!(o.witness_comparison.name(), "streaming");
        let memo: Options = serde_json::from_str(r#"{"windowStart":900,"windowEnd":1001,"arrivalDeadline":1200,"witnessComparison":"materialized-date-memo"}"#).unwrap();
        assert_eq!(
            memo.config().witness_comparison,
            DeadlineWitnessComparison::MaterializedDateMemo
        );
        assert_eq!(memo.witness_comparison.name(), "materialized-date-memo");
        assert_eq!(DeadlineWitnessComparison::date_memo_stack_bytes(), 64);
        assert!(Options::known_key("witnessComparison"));
        assert!(serde_json::from_str::<Options>(r#"{"windowStart":900,"windowEnd":1001,"arrivalDeadline":1200,"witnessComparison":"stream"}"#).is_err());
    }
    #[test]
    fn held_slice_catalogue_is_explicit_and_allowed_with_prepared_setup() {
        let base = serde_json::json!({"windowStart":900,"windowEnd":1001,
            "arrivalDeadline":1200,"validation":"session","catalogue":"held-slice"});
        let o: Options = serde_json::from_value(base.clone()).unwrap();
        o.validate().unwrap();
        assert_eq!(o.catalogue.name(), "held-slice");
        assert_eq!(o.catalogue.source(), CatalogueSource::HeldSlice);
        for certificate in ["duration", "timetable"] {
            let mut prepared = base.clone();
            prepared["prefixCertificate"] = serde_json::json!(certificate);
            prepared["prefixSetup"] = serde_json::json!("prepared");
            serde_json::from_value::<Options>(prepared.clone())
                .unwrap()
                .validate()
                .unwrap();
            prepared["validation"] = serde_json::json!("checked");
            assert!(serde_json::from_value::<Options>(prepared)
                .unwrap()
                .validate()
                .is_err());
        }
        assert_eq!(options().catalogue.source(), CatalogueSource::Fresh);
        let mut invalid = base;
        invalid["catalogue"] = serde_json::json!("heldslice");
        assert!(serde_json::from_value::<Options>(invalid).is_err());
        assert_eq!(
            [
                CatalogueOrigin::Built,
                CatalogueOrigin::Reused,
                CatalogueOrigin::WindowSlice,
                CatalogueOrigin::HeldSlice
            ]
            .map(origin_name),
            ["built", "reused", "window-slice", "held-slice"]
        );
    }
    #[test]
    fn defaults_match_native_caps_and_bounds() {
        let o = options();
        o.validate().unwrap();
        assert_eq!(
            (
                o.max_segments,
                o.max_frontier_width,
                o.max_stop_scans,
                o.max_lookup_work
            ),
            (250_000, 64, 10_000_000, 10_000_000)
        );
        assert!(o.prefix_bound && o.point_bound);
        assert_eq!(o.validation.name(), "checked");
        assert_eq!(o.catalogue.name(), "fresh");
        assert_eq!(o.traversal.name(), "fifo");
        assert!(!o.static_bound);
        assert!(!o.walking_bound);
        assert!(!o.transfer_bound);
        assert!(!o.forward_seeds);
        let config = o.config();
        assert_eq!(config.max_lookup_work, o.max_lookup_work);
        assert_eq!(config.window, o.window_start..o.window_end);
        assert_eq!(config.traversal, DeadlineTraversal::Fifo);
        assert_eq!(config.lookup, LazyLookupMode::PlainFast);
        assert_eq!(o.lookup.name(), "lazy-fast");
    }
    #[test]
    fn cached_lookup_is_explicit_and_diagnostics_preserve_semantic_counts() {
        let o: Options = serde_json::from_str(
            r#"{"windowStart":900,"windowEnd":1001,"arrivalDeadline":1200,"lookup":"lazy-cached"}"#,
        )
        .unwrap();
        o.validate().unwrap();
        assert_eq!(o.lookup.name(), "lazy-cached");
        assert_eq!(o.config().lookup, LazyLookupMode::PlainCached);
        let d = LazyLookupDiagnostics {
            work: 10,
            source_bound_cache_rows: 2,
            source_bound_cache_probes: 3,
            source_bound_cache_hits: 2,
            source_bound_cache_misses: 1,
            source_bound_cache_bytes: 48,
            ..LazyLookupDiagnostics::default()
        };
        let wire = serde_json::to_value(LazyWire::from(d)).unwrap();
        assert_eq!(wire["work"], 10);
        assert_eq!(wire["sourceBoundCacheHits"], 2);
        assert_eq!(wire["sourceBoundCacheBytes"], 48);
        assert!(serde_json::from_str::<Options>(
            r#"{"windowStart":900,"windowEnd":1001,"arrivalDeadline":1200,"lookup":"lazy-cache"}"#
        )
        .is_err());
    }
    #[test]
    fn unsafe_times_zero_caps_and_invalid_bounds_are_rejected() {
        assert!(!Options::known_key("unexpectedField"));
        assert!(Options::known_key("maxLookupWork"));
        let mut o = options();
        o.arrival_deadline = 9_007_199_254_740_992;
        assert!(o.validate().is_err());
        o = options();
        o.max_segments = 0;
        assert!(o.validate().is_err());
        o = options();
        o.window_start = o.window_end;
        assert!(o.validate().is_err());
        o = options();
        o.prefix_bound = false;
        assert!(o.validate().is_err());
        assert!(serde_json::from_str::<Options>(
            r#"{"windowStart":1,"windowEnd":2,"arrivalDeadline":3,"lookup":"unsupported"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Options>(
            r#"{"windowStart":1,"windowEnd":2,"arrivalDeadline":3,"validation":"unsupported"}"#
        )
        .is_err());
        assert!(Options::known_key("traversal"));
        assert!(serde_json::from_str::<Options>(
            r#"{"windowStart":1,"windowEnd":2,"arrivalDeadline":3,"traversal":"beam"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Options>(
            r#"{"windowStart":1,"windowEnd":2,"arrivalDeadline":3,"typo":0}"#
        )
        .is_err());
    }
    #[test]
    fn arrival_first_is_explicit_and_preserves_caps() {
        let mut o = options();
        o.traversal = Traversal::ArrivalFirst;
        assert_eq!(o.traversal.name(), "arrival-first");
        assert_eq!(o.config().traversal, DeadlineTraversal::ArrivalFirst);
        assert_eq!(o.config().max_lookup_work, 10_000_000);
    }
    #[test]
    fn guided_requires_explicit_bounds_and_preserves_limits() {
        let mut o = options();
        o.traversal = Traversal::Guided;
        assert!(o.validate().is_err());
        o.static_bound = true;
        o.validate().unwrap();
        assert_eq!(o.config().traversal, DeadlineTraversal::Guided);
        assert!(o.config().static_bound);
        assert_eq!(o.config().max_stop_scans, 10_000_000);
        assert!(Options::known_key("staticBound"));
    }
    #[test]
    fn walking_is_explicit_and_requires_point_bounds_without_cap_changes() {
        let mut o = options();
        o.walking_bound = true;
        o.validate().unwrap();
        assert!(o.config().walking_bound);
        assert_eq!(o.config().max_stop_scans, 10_000_000);
        assert!(Options::known_key("walkingBound"));
        o.point_bound = false;
        assert!(o.validate().is_err());
    }
    #[test]
    fn transfer_is_explicit_m4_only_and_keeps_caps() {
        let mut o = options();
        o.transfer_bound = true;
        o.validate().unwrap();
        let c = o.config();
        assert!(c.transfer_bound);
        assert_eq!(c.max_stop_scans, 10_000_000);
        assert_eq!(c.max_lookup_work, 10_000_000);
        assert!(Options::known_key("transferBound"));
        o.objective = Objective::R3;
        assert!(o.validate().is_err());
        o.objective = Objective::M4;
        o.point_bound = false;
        assert!(o.validate().is_err());
    }
    #[test]
    fn forward_is_explicit_and_requires_point_bounds_without_cap_changes() {
        let mut o = options();
        o.forward_seeds = true;
        o.validate().unwrap();
        assert!(o.config().forward_seeds);
        assert_eq!(o.config().max_lookup_work, 10_000_000);
        assert_eq!(o.config().max_stop_scans, 10_000_000);
        assert!(Options::known_key("forwardSeeds"));
        o.point_bound = false;
        assert!(o.validate().is_err());
    }
    #[test]
    fn witness_projection_keeps_concrete_instance_and_occurrence_fields() {
        let w = R3TransitWitness {
            service_date: 20261012,
            route_idx: 7,
            reader_route_idx: 3,
            trip_idx: 11,
            board_position: 2,
            alight_position: 5,
            board_secs: 900,
            alight_secs: 1200,
            frequency_offset_secs: 100,
            frequency_instance: true,
            in_seat: true,
        };
        let v = serde_json::to_value(WitnessWire::from(&w)).unwrap();
        assert_eq!(v["frequencyOffsetSecs"], 100);
        assert_eq!(v["inSeat"], true);
        assert_eq!(v["boardPosition"], 2);
        assert_eq!(v["readerRouteIdx"], 3);
        assert_eq!(v.as_object().unwrap().len(), 11);
    }
}
