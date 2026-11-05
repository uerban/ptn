//! Linear-size concrete event catalogue; no event-to-event edges are retained.
//! Events use the same enumeration, calendar/frequency interpretation and
//! binding as the unreduced reference table. Arrival CSR is sorted by time at
//! each physical stop; loop occurrences and vehicle identities remain distinct.
//! GTFS: https://gtfs.org/documentation/schedule/reference/#stop_timestxt

use super::*;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct EventIndexDiagnostics {
    pub events: usize,
    pub arrival_sources: usize,
    pub boarding_events: usize,
    pub index_bytes: usize,
    pub peak_build_bytes: usize,
}

#[cfg_attr(test, derive(Clone, PartialEq))]
pub struct EventIndex {
    pub(super) binding: TransferIndexBinding,
    pub(super) covered: Range<i64>,
    pub(super) events: Vec<StopEvent>,
    arrival_offsets: Vec<u32>,
    arrivals: Vec<u32>,
    diagnostics: EventIndexDiagnostics,
}

impl EventIndex {
    pub fn covered(&self) -> Range<i64> {
        self.covered.clone()
    }

    pub fn events(&self) -> &[StopEvent] {
        &self.events
    }

    pub fn arrivals_at_stop(&self, stop: u32) -> &[u32] {
        match self
            .arrival_offsets
            .get(stop as usize)
            .zip(self.arrival_offsets.get(stop as usize + 1))
        {
            Some((&a, &b)) => &self.arrivals[a as usize..b as usize],
            None => &[],
        }
    }

    pub fn diagnostics(&self) -> EventIndexDiagnostics {
        self.diagnostics
    }

    pub fn binding(&self) -> TransferIndexBinding {
        self.binding
    }

    pub fn is_bound_to<B: AsRef<[u8]> + Send + Sync + 'static>(
        &self,
        reader: &Reader<B>,
        index: &Index,
        transfers: Option<&Transfers>,
        config: &TransferIndexConfig,
    ) -> bool {
        binding(reader, index, transfers, config) == self.binding
    }
}

pub fn build_event_index<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    config: &TransferIndexConfig,
) -> Result<EventIndex, TransferIndexError> {
    build_event_index_with_phases(reader, index, transfers, config, None, None, &mut |_| {})
}

pub(super) fn build_event_index_with_phases<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    config: &TransferIndexConfig,
    immutable_binding: Option<ImmutableBinding>,
    spans: Option<&TripSpans>,
    observe: &mut impl FnMut(DeadlineSetupPhase),
) -> Result<EventIndex, TransferIndexError> {
    let (binding, mut events, mut peak) = build_events_with_phases(
        reader,
        index,
        transfers,
        config,
        immutable_binding,
        spans,
        observe,
    )?;
    let mut diagnostics = EventIndexDiagnostics {
        events: events.len(),
        arrival_sources: events.iter().filter(|e| e.is_source()).count(),
        boarding_events: events.iter().filter(|e| e.flags & TARGET != 0).count(),
        ..EventIndexDiagnostics::default()
    };
    let mut arrivals = Vec::new();
    reserve(
        &mut arrivals,
        diagnostics.arrival_sources,
        bytes_of(&events),
        config.limits,
        &mut peak,
    )?;
    arrivals.extend(
        events
            .iter()
            .enumerate()
            .filter(|(_, e)| e.is_source())
            .map(|(i, _)| i as u32),
    );
    let stop_of = |e: &StopEvent| index.routes[e.route_idx as usize].stop_ids[e.position as usize];
    arrivals.sort_unstable_by_key(|&e| {
        let event = &events[e as usize];
        (stop_of(event), event.arrival_secs, event.key())
    });
    let mut offsets = Vec::new();
    let count = reader
        .num_stops()
        .checked_add(1)
        .ok_or(EngineError::TimeOverflow)?;
    reserve(
        &mut offsets,
        count,
        bytes_of(&events) + bytes_of(&arrivals),
        config.limits,
        &mut peak,
    )?;
    offsets.resize(count, 0u32);
    for &e in &arrivals {
        offsets[stop_of(&events[e as usize]) as usize + 1] += 1;
    }
    for i in 1..offsets.len() {
        offsets[i] += offsets[i - 1];
    }
    observe(DeadlineSetupPhase::ArrivalsIndexed);
    events.shrink_to_fit();
    arrivals.shrink_to_fit();
    offsets.shrink_to_fit();
    diagnostics.index_bytes = len_bytes(&events) + len_bytes(&arrivals) + len_bytes(&offsets);
    diagnostics.peak_build_bytes = peak.max(diagnostics.index_bytes);
    observe(DeadlineSetupPhase::CatalogueCompacted);
    Ok(EventIndex {
        binding,
        covered: config.covered.clone(),
        events,
        arrival_offsets: offsets,
        arrivals,
        diagnostics,
    })
}

/// The catalogue `build_event_index_with_phases` builds for `config`, cut in
/// place from `window`, a catalogue built for `window_config` from the same
/// owned inputs. `window` is consumed either way: its buffers become the
/// request's, so no second catalogue is held. `Ok(None)` means `window` cannot
/// stand in for this request; nothing was observed and the caller builds the
/// catalogue fresh.
///
/// Identical by construction:
/// with the same date, mobility, modes and limits and `config.covered` inside
/// `window_config.covered`, the fresh build visits a subset of the window
/// build's instances with identical times; its flags are the window flags
/// restricted to `config.covered`; filtering keeps the key order of the events
/// and the `(stop, arrival, key)` order of the arrival index. A successful
/// window build under the same limits leaves no enumeration or limit error the
/// fresh build could reach; the checks before enumeration run unchanged.
#[allow(clippy::too_many_arguments)]
pub(super) fn take_slice_with_phases<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    config: &TransferIndexConfig,
    immutable_binding: Option<ImmutableBinding>,
    window_config: &TransferIndexConfig,
    window: EventIndex,
    observe: &mut impl FnMut(DeadlineSetupPhase),
) -> Result<Option<EventIndex>, TransferIndexError> {
    let covered = &config.covered;
    let Some(plan) = slice_plan(reader, config, window_config, &window) else {
        return Ok(None);
    };
    let restricted = |e: &StopEvent| restricted_flags(e, covered);
    let (binding, _) =
        catalogue_prelude(reader, index, transfers, config, immutable_binding, observe)?;
    let EventIndex {
        mut events,
        mut arrivals,
        arrival_offsets: mut offsets,
        ..
    } = window;
    // Kept events move down in order; `ordinals` maps old to new positions.
    let mut ordinals = alloc::vec![u32::MAX; events.len()];
    let mut next = 0usize;
    for i in 0..events.len() {
        let flags = restricted(&events[i]);
        if flags & (SOURCE | TARGET) != 0 {
            ordinals[i] = next as u32;
            events[next] = StopEvent { flags, ..events[i] };
            next += 1;
        }
    }
    events.truncate(next);
    let mut next = 0usize;
    for i in 0..arrivals.len() {
        let o = ordinals[arrivals[i] as usize];
        if o != u32::MAX && events[o as usize].is_source() {
            arrivals[next] = o;
            next += 1;
        }
    }
    arrivals.truncate(next);
    drop(ordinals);
    let stop_of = |e: &StopEvent| index.routes[e.route_idx as usize].stop_ids[e.position as usize];
    offsets.fill(0);
    for &e in &arrivals {
        offsets[stop_of(&events[e as usize]) as usize + 1] += 1;
    }
    for i in 1..offsets.len() {
        offsets[i] += offsets[i - 1];
    }
    observe(DeadlineSetupPhase::CatalogueSliced);
    events.shrink_to_fit();
    arrivals.shrink_to_fit();
    let mut diagnostics = EventIndexDiagnostics {
        events: events.len(),
        arrival_sources: arrivals.len(),
        boarding_events: events.iter().filter(|e| e.flags & TARGET != 0).count(),
        ..EventIndexDiagnostics::default()
    };
    diagnostics.index_bytes = len_bytes(&events) + len_bytes(&arrivals) + len_bytes(&offsets);
    diagnostics.peak_build_bytes = plan.fresh_peak.max(diagnostics.index_bytes);
    observe(DeadlineSetupPhase::CatalogueCompacted);
    Ok(Some(EventIndex {
        binding,
        covered: covered.clone(),
        events,
        arrival_offsets: offsets,
        arrivals,
        diagnostics,
    }))
}

/// What a slice of `window` for `config` keeps, once the window is known to
/// stand in for the request.
struct SlicePlan {
    kept: usize,
    sources: usize,
    offsets: usize,
    fresh_peak: usize,
}

/// Whether `window` (built for `window_config`) can stand in for `config`:
/// the same date, mobility, modes, walking settings and limits, and an
/// interval inside the window's. Constant time.
pub(super) fn slice_applies<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    config: &TransferIndexConfig,
    window_config: &TransferIndexConfig,
    window: &EventIndex,
) -> bool {
    let covered = &config.covered;
    config.service_date == window_config.service_date
        && config.mobility == window_config.mobility
        && config.excluded_routes == window_config.excluded_routes
        && config.excluded_modes == window_config.excluded_modes
        && config.walk_settings() == window_config.walk_settings()
        && config.limits == window_config.limits
        && covered.start >= window_config.covered.start
        && covered.end <= window_config.covered.end
        && window.covered == window_config.covered
        && reader.num_stops().checked_add(1) == Some(window.arrival_offsets.len())
}

/// What a slice keeps; `None` when `window` cannot stand in for `config`.
fn slice_plan<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    config: &TransferIndexConfig,
    window_config: &TransferIndexConfig,
    window: &EventIndex,
) -> Option<SlicePlan> {
    if !slice_applies(reader, config, window_config, window) {
        return None;
    }
    let (mut kept, mut sources) = (0usize, 0usize);
    for e in &window.events {
        let flags = restricted_flags(e, &config.covered);
        kept += usize::from(flags & (SOURCE | TARGET) != 0);
        sources += usize::from(flags & SOURCE != 0);
    }
    let offsets = window.arrival_offsets.len();
    // Unreachable after a successful window build; the fresh build then
    // reports whatever it reaches.
    let fresh_peak = replay_fresh_peak(kept, sources, offsets, config.limits).ok()?;
    Some(SlicePlan {
        kept,
        sources,
        offsets,
        fresh_peak,
    })
}

/// A window event's flags with source and target restricted to `covered`.
fn restricted_flags(e: &StopEvent, covered: &Range<i64>) -> u8 {
    let mut flags = e.flags & !(SOURCE | TARGET);
    if e.flags & SOURCE != 0 && covered.contains(&e.arrival_secs) {
        flags |= SOURCE;
    }
    if e.flags & TARGET != 0 && covered.contains(&e.departure_secs) {
        flags |= TARGET;
    }
    flags
}

/// H83: the catalogue `take_slice_with_phases` cuts from `window`, built in
/// new buffers of exact size; `window` is left intact. Same checks, same
/// outcome.
#[allow(clippy::too_many_arguments)]
pub(super) fn slice_copy_with_phases<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    config: &TransferIndexConfig,
    immutable_binding: Option<ImmutableBinding>,
    window_config: &TransferIndexConfig,
    window: &EventIndex,
    observe: &mut impl FnMut(DeadlineSetupPhase),
) -> Result<Option<EventIndex>, TransferIndexError> {
    let covered = &config.covered;
    let Some(plan) = slice_plan(reader, config, window_config, window) else {
        return Ok(None);
    };
    let (binding, _) =
        catalogue_prelude(reader, index, transfers, config, immutable_binding, observe)?;
    let mut events = Vec::with_capacity(plan.kept);
    let mut ordinals = alloc::vec![u32::MAX; window.events.len()];
    for (i, e) in window.events.iter().enumerate() {
        let flags = restricted_flags(e, covered);
        if flags & (SOURCE | TARGET) != 0 {
            ordinals[i] = events.len() as u32;
            events.push(StopEvent { flags, ..*e });
        }
    }
    let mut arrivals = Vec::with_capacity(plan.sources);
    for &a in &window.arrivals {
        let o = ordinals[a as usize];
        if o != u32::MAX && events[o as usize].is_source() {
            arrivals.push(o);
        }
    }
    drop(ordinals);
    let stop_of = |e: &StopEvent| index.routes[e.route_idx as usize].stop_ids[e.position as usize];
    let mut offsets = alloc::vec![0u32; plan.offsets];
    for &e in &arrivals {
        offsets[stop_of(&events[e as usize]) as usize + 1] += 1;
    }
    for i in 1..offsets.len() {
        offsets[i] += offsets[i - 1];
    }
    observe(DeadlineSetupPhase::HeldCatalogueSliced);
    let mut diagnostics = EventIndexDiagnostics {
        events: events.len(),
        arrival_sources: arrivals.len(),
        boarding_events: events.iter().filter(|e| e.flags & TARGET != 0).count(),
        ..EventIndexDiagnostics::default()
    };
    diagnostics.index_bytes = len_bytes(&events) + len_bytes(&arrivals) + len_bytes(&offsets);
    diagnostics.peak_build_bytes = plan.fresh_peak.max(diagnostics.index_bytes);
    observe(DeadlineSetupPhase::CatalogueCompacted);
    Ok(Some(EventIndex {
        binding,
        covered: covered.clone(),
        events,
        arrival_offsets: offsets,
        arrivals,
        diagnostics,
    }))
}

/// The peak tracked bytes the fresh build reaches for these counts: events
/// pushed one at a time, then the arrival list, then the stop offsets, each
/// grown by `reserve`'s rule.
fn replay_fresh_peak(
    events: usize,
    sources: usize,
    offsets: usize,
    limits: TransferIndexLimits,
) -> Result<usize, TransferIndexError> {
    let event_size = size_of::<StopEvent>();
    let (mut capacity, mut peak) = (0usize, 0usize);
    while capacity < events {
        capacity = grown_capacity(capacity, capacity + 1, event_size, 0, limits)?;
        peak = peak.max(capacity * event_size);
    }
    let mut others = capacity * event_size;
    for need in [sources, offsets] {
        if need > 0 {
            let grown = grown_capacity(0, need, size_of::<u32>(), others, limits)?;
            others += grown * size_of::<u32>();
            peak = peak.max(others);
        }
    }
    Ok(peak)
}

#[cfg(test)]
pub(crate) fn build_window_event_index_for_test<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    config: &TransferIndexConfig,
) -> Result<EventIndex, TransferIndexError> {
    let spans = TripSpans::build(reader, index);
    build_event_index_with_phases(reader, index, None, config, None, Some(&spans), &mut |_| {})
}

#[cfg(test)]
pub(crate) fn take_slice_for_test<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    config: &TransferIndexConfig,
    window_config: &TransferIndexConfig,
    window: EventIndex,
) -> Result<Option<EventIndex>, TransferIndexError> {
    take_slice_with_phases(
        reader,
        index,
        None,
        config,
        None,
        window_config,
        window,
        &mut |_| {},
    )
}

#[cfg(test)]
pub(crate) fn slice_copy_for_test<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    config: &TransferIndexConfig,
    window_config: &TransferIndexConfig,
    window: &EventIndex,
) -> Result<Option<EventIndex>, TransferIndexError> {
    slice_copy_with_phases(
        reader,
        index,
        None,
        config,
        None,
        window_config,
        window,
        &mut |_| {},
    )
}
