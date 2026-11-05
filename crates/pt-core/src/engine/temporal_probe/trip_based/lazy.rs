//! Exact lazy predecessor lookup. No transition edges are cached or retained.
//! Rule-free feeds can use incoming directed PTFT and sorted stop-arrival CSR.
//! Ordinary rules use an indexed movement superset and exact targeted boarding.
//! Derived block continuations stay stop-indexed (same-stop by construction);
//! explicit linked rules retain global sources. No second GTFS resolver is added.
//! GTFS: https://gtfs.org/documentation/schedule/reference/#transferstxt

use super::*;
use crate::engine::temporal_probe::v2::{physical_walks, synthetic_destinations, BoardingTarget};
use crate::engine::v2::{instances::ConcreteInstance, rules::ordinary_floor};
use alloc::collections::BTreeMap;
use alloc::vec;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LazyLookupMode {
    ScanAll,
    StopIndexed,
    PlainFast,
    /// Native ablation: PlainFast plus one exact source-boundary cache row
    /// per physical stop. No predecessor edges or query results are retained.
    PlainCached,
    /// PlainCached plus guarded compact ordering after all exact pair checks.
    /// No edge cache, resolver change or charged-work reduction.
    PlainCachedPacked,
}

#[derive(Clone, Copy, Debug)]
pub struct LazyLookupConfig {
    pub mode: LazyLookupMode,
    pub max_work: usize,
}

impl Default for LazyLookupConfig {
    fn default() -> Self {
        Self {
            mode: LazyLookupMode::PlainFast,
            max_work: 10_000_000,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LazyLookupDiagnostics {
    pub work: usize,
    pub event_probes: usize,
    pub pair_checks: usize,
    pub instance_probes: usize,
    pub plain_pair_checks: usize,
    pub fallback_pair_checks: usize,
    pub walking_index_edges: usize,
    /// Ordinary synthetic candidates plus sparse derived inverse entries.
    pub rule_candidate_edges: usize,
    pub stop_indexed: bool,
    pub early_source_rows_skipped: usize,
    pub source_bound_cache_rows: usize,
    pub source_bound_cache_probes: usize,
    pub source_bound_cache_hits: usize,
    pub source_bound_cache_misses: usize,
    pub source_bound_cache_bytes: usize,
    /// Charged event probes used by the private winner-only binary cut.
    pub row_bound_checks: usize,
    /// Candidates skipped after the unconditional earliest-source boundary.
    pub certified_source_rows_skipped: usize,
    /// Representation diagnostics, not charged semantic work. Extra temporary
    /// u64 key capacity excludes the still-live output and allocator overhead.
    pub packed_sort_calls: usize,
    pub packed_sort_peak_bytes: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LazyLookupError {
    Engine(EngineError),
    BindingMismatch,
    InvalidRequest(&'static str),
    WorkExhausted { limit: usize, attempted: usize },
}

impl From<EngineError> for LazyLookupError {
    fn from(e: EngineError) -> Self {
        Self::Engine(e)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct IncomingTransfer {
    pub source: u32,
    pub walk_secs: u32,
    pub elapsed_secs: u32,
    pub kind: TransferKind,
}

#[derive(Clone, Copy)]
struct SourceBoundary {
    earliest: i64,
    start: usize,
}

pub struct LazyPredecessors<'a, B: AsRef<[u8]>> {
    reader: &'a Reader<B>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    transfers: Option<&'a Transfers>,
    query: Query,
    origin_unix: i64,
    incoming_walks: Vec<Vec<(u32, i64)>>,
    source_boundaries: Vec<Option<SourceBoundary>>,
    /// Existing derived rules inverted only for terminal sources in this
    /// catalogue. Keys retain concrete target trip and service-date ordinal.
    derived_sources: BTreeMap<(u32, u32), Vec<u32>>,
    plain: bool,
    indexed: bool,
    config: LazyLookupConfig,
    diagnostics: LazyLookupDiagnostics,
}

fn charge(d: &mut LazyLookupDiagnostics, limit: usize) -> Result<(), LazyLookupError> {
    let attempted = d.work.checked_add(1).ok_or(EngineError::TimeOverflow)?;
    if attempted > limit {
        return Err(LazyLookupError::WorkExhausted { limit, attempted });
    }
    d.work = attempted;
    Ok(())
}

impl<'a, B: AsRef<[u8]> + Send + Sync + 'static> LazyPredecessors<'a, B> {
    pub fn new(
        reader: &'a Reader<B>,
        index: &'a Index,
        catalogue: &'a EventIndex,
        transfers: Option<&'a Transfers>,
        query: &Query,
        config: LazyLookupConfig,
    ) -> Result<Self, LazyLookupError> {
        Self::new_with_work(reader, index, catalogue, transfers, query, config, 0)
    }

    pub(super) fn new_with_work(
        reader: &'a Reader<B>,
        index: &'a Index,
        catalogue: &'a EventIndex,
        transfers: Option<&'a Transfers>,
        query: &Query,
        config: LazyLookupConfig,
        consumed: usize,
    ) -> Result<Self, LazyLookupError> {
        if config.max_work == 0 {
            return Err(LazyLookupError::InvalidRequest("zero work cap"));
        }
        let binding_config = TransferIndexConfig::for_query(query, catalogue.covered());
        if !catalogue.is_bound_to(reader, index, transfers, &binding_config) {
            return Err(LazyLookupError::BindingMismatch);
        }
        Self::new_session_bound_with_work(
            reader, index, catalogue, transfers, query, config, consumed,
        )
    }

    // Only the owned session's private prepared path skips binding validation.
    // The public constructor above retains its original check, including for
    // generic AsRef backings whose immutability is not enforced by the type.
    pub(super) fn new_session_bound(
        reader: &'a Reader<B>,
        index: &'a Index,
        catalogue: &'a EventIndex,
        transfers: Option<&'a Transfers>,
        query: &Query,
        config: LazyLookupConfig,
    ) -> Result<Self, LazyLookupError> {
        Self::new_session_bound_with_work(reader, index, catalogue, transfers, query, config, 0)
    }

    pub(super) fn new_session_bound_with_work(
        reader: &'a Reader<B>,
        index: &'a Index,
        catalogue: &'a EventIndex,
        transfers: Option<&'a Transfers>,
        query: &Query,
        config: LazyLookupConfig,
        consumed: usize,
    ) -> Result<Self, LazyLookupError> {
        if config.max_work == 0 {
            return Err(LazyLookupError::InvalidRequest("zero work cap"));
        }
        if consumed > config.max_work {
            return Err(LazyLookupError::WorkExhausted {
                limit: config.max_work,
                attempted: consumed,
            });
        }
        let ordinal =
            time::date_ordinal(reader, query.date).ok_or(EngineError::UnsupportedServiceDate)?;
        let query = Query {
            entry_stops: Vec::new(),
            exit_stops: Vec::new(),
            departure_secs: catalogue.covered.start,
            date: query.date,
            max_rounds: None,
            mobility: query.mobility,
            excluded_routes: query.excluded_routes.clone(),
            excluded_modes: query.excluded_modes.clone(),
            walk_speed_mm_s: query.walk_speed_mm_s,
            min_transfer_secs: query.min_transfer_secs,
        };
        let v2 = index.v2.as_deref().ok_or(EngineError::UnsupportedVersion)?;
        let plain = v2.rules.ordinary.is_empty() && v2.rules.linked.is_empty();
        // Derived block continuations keep the stop index. `build_derived` only
        // links a trip whose terminal stop is the next trip's initial stop, and
        // `linked` applies them only from the terminal arrival, which the
        // catalogue keeps as a SOURCE even without drop-off. Every derived
        // predecessor is therefore a same-stop row below, and `pair` resolves
        // it through the unchanged reference. Explicit linked rules may join
        // different stops, so they still use global sources. Plain lookup adds
        // short-layover derived sources separately instead of lowering every
        // ordinary pair's transfer floor.
        let indexed = v2.rules.linked.is_empty();
        let mut diagnostics = LazyLookupDiagnostics {
            work: consumed,
            stop_indexed: indexed && config.mode != LazyLookupMode::ScanAll,
            ..LazyLookupDiagnostics::default()
        };
        let mut incoming_walks = vec![Vec::new(); reader.num_stops()];
        let mut derived_sources: BTreeMap<(u32, u32), Vec<u32>> = BTreeMap::new();
        if plain
            && !v2.derived.is_empty()
            && matches!(
                config.mode,
                LazyLookupMode::PlainFast
                    | LazyLookupMode::PlainCached
                    | LazyLookupMode::PlainCachedPacked
            )
        {
            for (source, &event) in catalogue.events.iter().enumerate() {
                charge(&mut diagnostics, config.max_work)?;
                diagnostics.event_probes += 1;
                if !event.is_source() || !super::prefix::continues_in_seat(v2, event) {
                    continue;
                }
                for &target in &v2.derived[&(event.trip_idx, event.date_ordinal)] {
                    charge(&mut diagnostics, config.max_work)?;
                    diagnostics.rule_candidate_edges += 1;
                    derived_sources
                        .entry((target, event.date_ordinal))
                        .or_default()
                        .push(source as u32);
                }
            }
        }
        if indexed && config.mode != LazyLookupMode::ScanAll {
            for from in 0..reader.num_stops() {
                for (to, walk) in physical_walks(reader, &query, transfers, from as u32)? {
                    charge(&mut diagnostics, config.max_work)?;
                    incoming_walks[to as usize].push((from as u32, walk));
                    diagnostics.walking_index_edges += 1;
                }
                for to in synthetic_destinations(&v2.rules, from as u32, None) {
                    if to == from as u32 {
                        continue;
                    } // Same-stop is queried separately.
                    charge(&mut diagnostics, config.max_work)?;
                    incoming_walks[to as usize].push((from as u32, 0));
                    diagnostics.rule_candidate_edges += 1;
                }
            }
            // A physical and synthetic movement may share endpoints. One
            // exact pair check suffices; non-plain pair() ignores this walk hint.
            for rows in &mut incoming_walks {
                rows.sort_unstable();
                rows.dedup_by_key(|r| r.0);
            }
        }
        Ok(Self {
            reader,
            index,
            catalogue,
            transfers,
            query,
            origin_unix: time::origin(reader, ordinal)?,
            incoming_walks,
            source_boundaries: Vec::new(),
            derived_sources,
            plain,
            indexed,
            config,
            diagnostics,
        })
    }

    pub fn diagnostics(&self) -> LazyLookupDiagnostics {
        self.diagnostics
    }

    /// Logical incoming-walk contents, including outer Vec headers. Not peak
    /// allocation/RSS: capacities, cloned movements and output buffers excluded.
    /// Includes occupied source-boundary cache rows and sparse derived inverse
    /// payload. BTree node/allocator overhead is excluded, not claimed as peak.
    pub fn incoming_index_bytes(&self) -> usize {
        core::mem::size_of_val(self.incoming_walks.as_slice())
            + self
                .incoming_walks
                .iter()
                .map(|rows| core::mem::size_of_val(rows.as_slice()))
                .sum::<usize>()
            + core::mem::size_of_val(self.source_boundaries.as_slice())
            + self
                .derived_sources
                .iter()
                .map(|(key, rows)| {
                    core::mem::size_of_val(key)
                        + core::mem::size_of_val(rows)
                        + core::mem::size_of_val(rows.as_slice())
                })
                .sum::<usize>()
    }

    pub fn incoming(&mut self, target: u32) -> Result<Vec<IncomingTransfer>, LazyLookupError> {
        self.incoming_bounded(target, None)
    }

    #[cfg(test)]
    pub(crate) fn incoming_bounded_for_test(
        &mut self,
        target: u32,
        earliest: &[i64],
    ) -> Result<Vec<IncomingTransfer>, LazyLookupError> {
        self.incoming_bounded(target, Some(earliest))
    }

    // Sorted catalogue arrival rows are immutable for this provider. Their
    // lower boundary depends only on physical stop and the exact bound value,
    // not target identity, movement or suffix. Repeated stop occurrences and
    // frequency/date instances remain separate rows; pair() still resolves
    // each one. GTFS: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
    fn source_start(&mut self, from: u32, earliest: i64) -> Result<usize, LazyLookupError> {
        let cached = matches!(
            self.config.mode,
            LazyLookupMode::PlainCached | LazyLookupMode::PlainCachedPacked
        );
        if cached {
            if self.source_boundaries.is_empty() {
                for _ in 0..self.reader.num_stops() {
                    charge(&mut self.diagnostics, self.config.max_work)?;
                    self.diagnostics.source_bound_cache_rows += 1;
                }
                self.source_boundaries.resize(self.reader.num_stops(), None);
                self.diagnostics.source_bound_cache_bytes =
                    core::mem::size_of_val(self.source_boundaries.as_slice());
            }
            charge(&mut self.diagnostics, self.config.max_work)?;
            self.diagnostics.source_bound_cache_probes += 1;
            if let Some(row) = self.source_boundaries[from as usize] {
                if row.earliest == earliest {
                    self.diagnostics.source_bound_cache_hits += 1;
                    return Ok(row.start);
                }
            }
        }
        let mut comparisons = 0;
        let start = self.catalogue.arrivals_at_stop(from).partition_point(|&e| {
            comparisons += 1;
            self.catalogue.events[e as usize].arrival_secs < earliest
        });
        for _ in 0..comparisons {
            charge(&mut self.diagnostics, self.config.max_work)?;
            self.diagnostics.event_probes += 1;
        }
        if cached {
            // A capped miss must never publish a partially charged entry.
            charge(&mut self.diagnostics, self.config.max_work)?;
            self.diagnostics.source_bound_cache_misses += 1;
            self.source_boundaries[from as usize] = Some(SourceBoundary { earliest, start });
        }
        Ok(start)
    }

    fn plain_fast(&self) -> bool {
        self.plain
            && matches!(
                self.config.mode,
                LazyLookupMode::PlainFast
                    | LazyLookupMode::PlainCached
                    | LazyLookupMode::PlainCachedPacked
            )
    }

    pub(super) fn has_sorted_sources(&self) -> bool {
        self.indexed && self.config.mode != LazyLookupMode::ScanAll
    }

    pub(super) fn incoming_bounded(
        &mut self,
        target: u32,
        earliest: Option<&[i64]>,
    ) -> Result<Vec<IncomingTransfer>, LazyLookupError> {
        self.incoming_certified(target, earliest, |_| true)
    }

    #[cfg(test)]
    pub(crate) fn incoming_certified_for_test(
        &mut self,
        target: u32,
        earliest: Option<&[i64]>,
        keep: impl FnMut(u32) -> bool,
    ) -> Result<Vec<IncomingTransfer>, LazyLookupError> {
        self.incoming_certified(target, earliest, keep)
    }

    #[cfg(test)]
    pub(crate) fn incoming_row_certified_for_test(
        &mut self,
        target: u32,
        earliest: Option<&[i64]>,
        certified: impl FnMut(i64) -> bool,
    ) -> Result<Vec<IncomingTransfer>, LazyLookupError> {
        self.incoming_row_certified(target, earliest, certified)
    }

    // Private winner-only filtering: each source still pays the event probe.
    // The caller proves all completions through a rejected source are strictly
    // nonwinning for this suffix. No filtered edges/results are cached; source
    // boundary rows remain suffix-independent. No GTFS permission is inferred:
    // https://gtfs.org/documentation/schedule/reference/#transferstxt
    pub(super) fn incoming_certified(
        &mut self,
        target: u32,
        earliest: Option<&[i64]>,
        keep: impl FnMut(u32) -> bool,
    ) -> Result<Vec<IncomingTransfer>, LazyLookupError> {
        self.incoming_filtered(target, earliest, keep, None::<fn(i64) -> bool>)
    }

    // Checked winner queries only. Origin departure <= source arrival, and
    // fixed-suffix strict rank coverage is monotone true->false as arrival
    // increases. The caller supplies that proof, not a GTFS permission test.
    // Concrete date/frequency/loop occurrences survive in the unchanged rows:
    // https://gtfs.org/documentation/schedule/reference/#stop_timestxt
    pub(super) fn incoming_row_certified(
        &mut self,
        target: u32,
        earliest: Option<&[i64]>,
        certified: impl FnMut(i64) -> bool,
    ) -> Result<Vec<IncomingTransfer>, LazyLookupError> {
        self.incoming_filtered(target, earliest, |_| true, Some(certified))
    }

    fn incoming_filtered(
        &mut self,
        target: u32,
        earliest: Option<&[i64]>,
        mut keep: impl FnMut(u32) -> bool,
        mut certified: Option<impl FnMut(i64) -> bool>,
    ) -> Result<Vec<IncomingTransfer>, LazyLookupError> {
        let Some(&event) = self.catalogue.events.get(target as usize) else {
            return Err(LazyLookupError::InvalidRequest("target event out of range"));
        };
        if event.flags & TARGET == 0 {
            return Ok(Vec::new());
        }
        let stop = self.index.routes[event.route_idx as usize].stop_ids[event.position as usize];
        let mut out = Vec::new();
        if self.indexed && self.config.mode != LazyLookupMode::ScanAll {
            let mut movements = self.incoming_walks[stop as usize].clone();
            movements.push((stop, 0));
            for (from, walk) in movements {
                let elapsed = if self.plain_fast() {
                    ordinary_floor(None, self.query.min_transfer_floor_secs())
                        .expect("default transfer floor")
                        .max(walk)
                } else {
                    0
                };
                let latest = event
                    .departure_secs
                    .checked_sub(elapsed)
                    .ok_or(EngineError::TimeOverflow)?;
                let rows = self.catalogue.arrivals_at_stop(from);
                let mut comparisons = 0;
                let end = rows.partition_point(|&e| {
                    comparisons += 1;
                    self.catalogue.events[e as usize].arrival_secs <= latest
                });
                for _ in 0..comparisons {
                    charge(&mut self.diagnostics, self.config.max_work)?;
                    self.diagnostics.event_probes += 1;
                }
                let start = match earliest {
                    Some(bounds) => self.source_start(from, bounds[from as usize])?,
                    None => 0,
                };
                self.diagnostics.early_source_rows_skipped += start.min(end);
                let mut start = start.min(end);
                if let Some(certified) = certified.as_mut() {
                    let original = start;
                    let mut hi = end;
                    while start < hi {
                        // Charge before reading/testing the candidate; a capped
                        // cut publishes neither a boundary nor a partial result.
                        charge(&mut self.diagnostics, self.config.max_work)?;
                        self.diagnostics.event_probes += 1;
                        self.diagnostics.row_bound_checks += 1;
                        let mid = start + (hi - start) / 2;
                        let source = self.catalogue.arrivals_at_stop(from)[mid];
                        if certified(self.catalogue.events[source as usize].arrival_secs) {
                            start = mid + 1;
                        } else {
                            hi = mid;
                        }
                    }
                    self.diagnostics.certified_source_rows_skipped += start - original;
                    // Never publish this suffix/incumbent-dependent cut in the
                    // unconditional physical-stop/exact-earliest-time cache.
                }
                for i in start..end {
                    let source = self.catalogue.arrivals_at_stop(from)[i];
                    charge(&mut self.diagnostics, self.config.max_work)?;
                    self.diagnostics.event_probes += 1;
                    if keep(source) {
                        self.pair(source, target, Some(walk), &mut out)?;
                    }
                }
            }
            // Ordinary rows end one transfer floor before departure. A derived
            // terminal/start pair may have a shorter layover; recover only those
            // missing sources through the existing reference boarding resolver.
            // Older derived sources already visited above also use that resolver
            // in pair(), preserving both ordinary and in-seat alternatives.
            if self.plain_fast() && !self.derived_sources.is_empty() && event.is_trip_start() {
                charge(&mut self.diagnostics, self.config.max_work)?;
                self.diagnostics.event_probes += 1;
                let key = (event.trip_idx, event.date_ordinal);
                let count = self.derived_sources.get(&key).map_or(0, Vec::len);
                let ordinary_latest = event
                    .departure_secs
                    .checked_sub(
                        ordinary_floor(None, self.query.min_transfer_floor_secs())
                            .expect("default floor"),
                    )
                    .ok_or(EngineError::TimeOverflow)?;
                for i in 0..count {
                    charge(&mut self.diagnostics, self.config.max_work)?;
                    self.diagnostics.event_probes += 1;
                    let source = self.derived_sources[&key][i];
                    let arrival = self.catalogue.events[source as usize].arrival_secs;
                    if arrival <= ordinary_latest {
                        continue;
                    }
                    if earliest.is_some_and(|bounds| arrival < bounds[stop as usize]) {
                        self.diagnostics.early_source_rows_skipped += 1;
                        continue;
                    }
                    if let Some(certified) = certified.as_mut() {
                        self.diagnostics.row_bound_checks += 1;
                        if certified(arrival) {
                            self.diagnostics.certified_source_rows_skipped += 1;
                            continue;
                        }
                    }
                    if keep(source) {
                        self.pair(source, target, Some(0), &mut out)?;
                    }
                }
            }
        } else {
            for i in 0..self.catalogue.events.len() {
                charge(&mut self.diagnostics, self.config.max_work)?;
                self.diagnostics.event_probes += 1;
                let source = self.catalogue.events[i];
                if source.is_source() && source.arrival_secs <= event.departure_secs {
                    let from = self.index.routes[source.route_idx as usize].stop_ids
                        [source.position as usize];
                    if earliest.is_some_and(|bounds| source.arrival_secs < bounds[from as usize]) {
                        self.diagnostics.early_source_rows_skipped += 1;
                        continue;
                    }
                    if keep(i as u32) {
                        self.pair(i as u32, target, None, &mut out)?;
                    }
                }
            }
        }
        let packed = self.config.mode == LazyLookupMode::PlainCachedPacked && self.plain_fast();
        if let Some(bytes) =
            super::incoming_sort::sort(&mut out, packed, self.query.min_transfer_floor_secs())
        {
            self.diagnostics.packed_sort_calls =
                self.diagnostics.packed_sort_calls.saturating_add(1);
            self.diagnostics.packed_sort_peak_bytes =
                self.diagnostics.packed_sort_peak_bytes.max(bytes);
        }
        Ok(out)
    }

    fn pair(
        &mut self,
        source: u32,
        target: u32,
        walk: Option<i64>,
        out: &mut Vec<IncomingTransfer>,
    ) -> Result<(), LazyLookupError> {
        charge(&mut self.diagnostics, self.config.max_work)?;
        self.diagnostics.pair_checks += 1;
        let a = self.catalogue.events[source as usize];
        let b = self.catalogue.events[target as usize];
        let v2 = self.index.v2.as_deref().expect("v2 index checked");
        let derived_pair = a.position == v2.trips[a.trip_idx as usize].last_pos
            && b.is_trip_start()
            && a.date_ordinal == b.date_ordinal
            && a.frequency_offset_secs == 0
            && b.frequency_offset_secs == 0
            && v2
                .derived
                .get(&(a.trip_idx, a.date_ordinal))
                .is_some_and(|targets| targets.contains(&b.trip_idx));
        if self.plain_fast() && !derived_pair {
            self.diagnostics.plain_pair_checks += 1;
            if !a.can_alight()
                || !b.can_board()
                || (a.trip_idx, a.date_ordinal, a.frequency_offset_secs)
                    == (b.trip_idx, b.date_ordinal, b.frequency_offset_secs)
            {
                return Ok(());
            }
            let walk = walk.expect("plain fast lookup has a physical movement");
            let elapsed = ordinary_floor(None, self.query.min_transfer_floor_secs())
                .expect("default floor")
                .max(walk);
            if a.arrival_secs
                .checked_add(elapsed)
                .ok_or(EngineError::TimeOverflow)?
                <= b.departure_secs
            {
                out.push(IncomingTransfer {
                    source,
                    walk_secs: u32::try_from(walk).map_err(|_| EngineError::TimeOverflow)?,
                    elapsed_secs: u32::try_from(elapsed).map_err(|_| EngineError::TimeOverflow)?,
                    kind: if walk == 0
                        && self.index.routes[a.route_idx as usize].stop_ids[a.position as usize]
                            == self.index.routes[b.route_idx as usize].stop_ids[b.position as usize]
                    {
                        TransferKind::SameStop
                    } else {
                        TransferKind::Footpath
                    },
                });
            }
            return Ok(());
        }
        self.diagnostics.fallback_pair_checks += 1;
        let route = &self.index.routes[a.route_idx as usize];
        let arrival = State {
            inst: Inst {
                trip: a.trip_idx,
                date: a.date_ordinal,
                shift: a.frequency_offset_secs,
            },
            stop: route.stop_ids[a.position as usize],
            position: a.position,
            time: a.arrival_secs,
            transfers: 0,
            rounds: 1,
            walk: 0,
            can_alight: a.can_alight(),
            id: 0,
            parent: None,
            origin_departure: 0,
            continuation_only: false,
            leg: R3TransitWitness {
                service_date: crate::reader::days_add(
                    self.reader.feed_start_date(),
                    a.date_ordinal as i64,
                ),
                route_idx: a.route_idx,
                reader_route_idx: route.reader_route_idx,
                trip_idx: a.trip_idx,
                board_position: a.position,
                alight_position: a.position,
                board_secs: a.arrival_secs,
                alight_secs: a.arrival_secs,
                frequency_offset_secs: a.frequency_offset_secs,
                frequency_instance: a.approximate(),
                in_seat: false,
            },
        };
        visit_boardings(
            self.reader,
            self.index,
            &self.query,
            self.transfers,
            self.origin_unix,
            b.departure_secs,
            arrival,
            MatchTarget {
                source,
                target: BoardingTarget {
                    route: b.route_idx,
                    position: b.position,
                    instance: ConcreteInstance {
                        inst: Inst {
                            trip: b.trip_idx,
                            date: b.date_ordinal,
                            shift: b.frequency_offset_secs,
                        },
                        board_secs: b.departure_secs,
                        approximate: b.approximate(),
                    },
                },
                out,
                diagnostics: &mut self.diagnostics,
                max_work: self.config.max_work,
            },
        )?;
        Ok(())
    }
}

struct MatchTarget<'a> {
    source: u32,
    target: BoardingTarget,
    out: &'a mut Vec<IncomingTransfer>,
    diagnostics: &'a mut LazyLookupDiagnostics,
    max_work: usize,
}

impl Strategy for MatchTarget<'_> {
    type Error = LazyLookupError;
    fn before_board(&mut self) -> Result<(), Self::Error> {
        charge(self.diagnostics, self.max_work)?;
        self.diagnostics.instance_probes += 1;
        Ok(())
    }
    fn accept(&mut self, _: &State, _: &[State], _: usize) -> Result<bool, Self::Error> {
        Ok(false)
    }
    fn boarding_target(&self) -> Option<BoardingTarget> {
        Some(self.target)
    }
    fn observe_board(&mut self, _: &State, b: &Boarding) -> Result<bool, Self::Error> {
        if b.route == self.target.route
            && b.position == self.target.position
            && b.instance.inst == self.target.instance.inst
            && b.instance.board_secs == self.target.instance.board_secs
        {
            self.out.push(IncomingTransfer {
                source: self.source,
                walk_secs: u32::try_from(b.walk).map_err(|_| EngineError::TimeOverflow)?,
                elapsed_secs: u32::try_from(b.elapsed).map_err(|_| EngineError::TimeOverflow)?,
                kind: b.kind,
            });
        }
        Ok(false)
    }
}
