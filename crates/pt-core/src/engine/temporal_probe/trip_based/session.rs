//! Immutable owned deadline inputs and optional single-catalogue reuse.
//! Optional exact prepared-query prefix retention; no result/witness cache.
//! GTFS: https://gtfs.org/documentation/schedule/reference/#transferstxt

use super::deadline::{
    query_prepared_portfolio_with_phases, query_prepared_preference_with_phases,
    query_prepared_winner_incumbent_ceiling, query_prepared_with_phases, validate_request,
    validate_request_shape,
};
use super::prefix::CachedPrefix;
use super::*;
use crate::engine::temporal_probe::r3::ProfileObjectives;
use crate::PatternMode;

/// Owned per-query settings. Sessions support lazy lookup only; no caller can
/// substitute a graph, catalogue, reader, layout or walking table after prepare.
#[derive(Clone)]
pub struct DeadlineSessionConfig {
    pub window: Range<i64>,
    pub arrival_deadline: i64,
    pub objectives: ProfileObjectives,
    pub lookup: LazyLookupMode,
    pub pruning: DeadlinePruning,
    pub traversal: DeadlineTraversal,
    pub witness_comparison: DeadlineWitnessComparison,
    pub frontier_storage: DeadlineFrontierStorage,
    pub static_bound: bool,
    pub walking_bound: bool,
    /// Opt-in derived-aware, time-relaxed passenger-transfer prefix.
    pub transfer_bound: bool,
    pub forward_seeds: bool,
    /// Removed experiment: true is rejected during preparation.
    pub raptor_seeds: bool,
    /// Removed experiment: true is rejected during preparation.
    pub raptor_destination_ordering: bool,
    pub max_segments: usize,
    pub max_frontier_width: usize,
    pub max_stop_scans: usize,
    pub max_lookup_work: usize,
}

impl DeadlineSessionConfig {
    pub fn new(window: Range<i64>, arrival_deadline: i64) -> Self {
        Self {
            window,
            arrival_deadline,
            objectives: ProfileObjectives::M4,
            lookup: LazyLookupMode::PlainFast,
            pruning: DeadlinePruning::None,
            traversal: DeadlineTraversal::Fifo,
            witness_comparison: DeadlineWitnessComparison::Materialized,
            frontier_storage: DeadlineFrontierStorage::Tree,
            static_bound: false,
            walking_bound: false,
            transfer_bound: false,
            forward_seeds: false,
            raptor_seeds: false,
            raptor_destination_ordering: false,
            max_segments: 250_000,
            max_frontier_width: 64,
            max_stop_scans: 10_000_000,
            max_lookup_work: 10_000_000,
        }
    }

    fn request<'a>(
        &self,
        query: &'a Query,
        transfers: Option<&'a Transfers>,
    ) -> DeadlineRequest<'a> {
        DeadlineRequest {
            query,
            window: self.window.clone(),
            arrival_deadline: self.arrival_deadline,
            transfers,
            objectives: self.objectives,
            lookup: DeadlineLookup::Lazy(self.lookup),
            pruning: self.pruning,
            traversal: self.traversal,
            witness_comparison: self.witness_comparison,
            frontier_storage: self.frontier_storage,
            static_bound: self.static_bound,
            walking_bound: self.walking_bound,
            transfer_bound: self.transfer_bound,
            forward_seeds: self.forward_seeds,
            raptor_seeds: self.raptor_seeds,
            raptor_destination_ordering: self.raptor_destination_ordering,
            max_segments: self.max_segments,
            max_frontier_width: self.max_frontier_width,
            max_stop_scans: self.max_stop_scans,
            max_lookup_work: self.max_lookup_work,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeadlineSessionPrepareError {
    Catalogue(TransferIndexError),
    Request(DeadlineError),
}

/// Where a prepare takes its request catalogue from.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CatalogueSource {
    /// Build it (or take a `prepare_window` catalogue over); drop any other.
    Fresh,
    /// Keep the current catalogue when its canonical key matches.
    Reuse,
    /// H83: reuse an equal key; else cut it by copy from the held catalogue,
    /// or from the current one, which then becomes the held one; else build.
    HeldSlice,
}

/// How the prepared request's catalogue was obtained (diagnostic).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CatalogueOrigin {
    Built,
    Reused,
    WindowSlice,
    HeldSlice,
}

struct Prepared {
    query: Query,
    config: DeadlineSessionConfig,
    catalogue_reused: bool,
    origin: CatalogueOrigin,
    cached_prefix: Option<CachedPrefix>,
}

struct Catalogue {
    key: [u8; 32],
    config: TransferIndexConfig,
    events: EventIndex,
}

/// One `prepare_window` result, held until the next `prepare` that builds a
/// catalogue takes it over, or until `prepare_window`, `clear` or owner drop.
struct WindowCatalogue {
    config: TransferIndexConfig,
    events: EventIndex,
}

/// Owns all semantic inputs; no mutable references or backing storage escape.
/// Index is built from the owned reader, not supplied by a caller. Each fresh
/// catalogue is built from this exact layout, walking table and query settings.
/// The only interior-mutable reader field is an observational lookup counter.
/// Prepared settings are consumed, not borrowed, and no public token can forge
/// validation. `prepare`/`clear` require exclusive access and invalidate state.
/// All outputs are owned values. Generic checked APIs retain both binding checks.
pub struct DeadlineSession {
    reader: Reader<Vec<u8>>,
    index: Index,
    transfers: Option<Transfers>,
    immutable_binding: Option<ImmutableBinding>,
    spans: TripSpans,
    prepared: Option<Prepared>,
    catalogue: Option<Catalogue>,
    /// H83: the catalogue `CatalogueSource::HeldSlice` requests are cut from.
    held: Option<Catalogue>,
    window: Option<WindowCatalogue>,
    /// H58: built by the first `latest_departure` call, then kept with the
    /// owner like the trip spans.
    latest_scan: Option<super::latest_scan::LatestScanIndex>,
}

impl DeadlineSession {
    pub fn new(
        reader: Reader<Vec<u8>>,
        mode: PatternMode,
        transfers: Option<Transfers>,
    ) -> Result<Self, EngineError> {
        Self::assemble(reader, mode, transfers, &mut |_| {})
    }

    fn assemble(
        reader: Reader<Vec<u8>>,
        mode: PatternMode,
        transfers: Option<Transfers>,
        observe: &mut impl FnMut(DeadlineSetupPhase),
    ) -> Result<Self, EngineError> {
        let index = Index::build(&reader, mode)?;
        observe(DeadlineSetupPhase::IndexBuilt);
        let spans = TripSpans::build(&reader, &index);
        observe(DeadlineSetupPhase::TripSpansBuilt);
        Ok(Self {
            reader,
            index,
            transfers,
            immutable_binding: None,
            spans,
            prepared: None,
            catalogue: None,
            held: None,
            window: None,
            latest_scan: None,
        })
    }

    /// Bytes of the stored trip spans, outside the inline owner size.
    pub fn trip_span_bytes(&self) -> usize {
        self.spans.bytes()
    }

    /// H58 phase A, opt-in: the latest origin departure inside `window` of
    /// any journey that arrives by `arrival_deadline`, by a backward scan
    /// with no request catalogue. It neither reads nor changes the prepared
    /// request, its catalogue or a held window. The first call builds the
    /// owner's scan index (`index_built` in the diagnostics). The result is
    /// a departure time only; the exact selector on `[departure,
    /// departure + 1)` certifies the winner.
    pub fn latest_departure(
        &mut self,
        query: &Query,
        window: Range<i64>,
        arrival_deadline: i64,
    ) -> Result<LatestScanResult, LatestScanError> {
        let built = self.latest_scan.is_none();
        if built {
            self.latest_scan = Some(super::latest_scan::LatestScanIndex::build(
                &self.reader,
                &self.index,
                self.transfers.as_ref(),
                &self.spans,
            )?);
        }
        let scan = self.latest_scan.as_ref().expect("scan index built above");
        super::latest_scan::latest_departure(
            &self.reader,
            &self.index,
            &self.spans,
            scan,
            query,
            window,
            arrival_deadline,
            built,
        )
    }

    /// H81 phase A, opt-in: for fewest transfers or least walking, the
    /// selector's optimal first key over `window` and the latest origin
    /// departure achieving it, by the H58 scan with per-transfer-budget or
    /// (time, walk) labels. Same scope, index and request independence as
    /// [`Self::latest_departure`]; the other selectors are `Unsupported`.
    /// The exact selector on `[departure, departure + 1)` certifies the
    /// winner, which must have the returned optimum.
    pub fn selector_departure(
        &mut self,
        preference: DeadlinePreference,
        query: &Query,
        window: Range<i64>,
        arrival_deadline: i64,
    ) -> Result<SelectorScanResult, LatestScanError> {
        if !preference.has_selector_scan() {
            return Err(LatestScanError::Unsupported(
                "selector has no departure scan",
            ));
        }
        let built = self.latest_scan.is_none();
        if built {
            self.latest_scan = Some(super::latest_scan::LatestScanIndex::build(
                &self.reader,
                &self.index,
                self.transfers.as_ref(),
                &self.spans,
            )?);
        }
        let scan = self.latest_scan.as_ref().expect("scan index built above");
        super::latest_scan::selector_departure(
            &self.reader,
            &self.index,
            &self.spans,
            scan,
            preference,
            query,
            window,
            arrival_deadline,
            built,
        )
    }

    #[cfg(test)]
    pub(crate) fn index_for_test(&self) -> &Index {
        &self.index
    }

    /// Bytes of the owner's H58 scan index, zero before the first call.
    pub fn latest_scan_bytes(&self) -> usize {
        self.latest_scan.as_ref().map_or(0, |s| s.bytes())
    }

    /// Opt-in: build and hold one catalogue for `covered` on this date, with
    /// this mobility and these excluded modes, ahead of a request; typically
    /// the host's "depart now" window plus a margin, at city load or when
    /// idle. The next `prepare` that builds a catalogue takes it over: a
    /// request with the same key and limits whose interval lies inside
    /// `covered` gets it cut in place, equal to its fresh catalogue; any other
    /// request drops it and builds fresh. So at most one catalogue buffer is
    /// ever held: this call first retires the prepared request, its catalogue
    /// and any held window. A failure holds nothing and changes no request
    /// outcome. Without this call every request builds fresh, as before.
    pub fn prepare_window(
        &mut self,
        service_date: u32,
        mobility: Mobility,
        excluded_modes: Vec<u16>,
        covered: Range<i64>,
    ) -> Result<EventIndexDiagnostics, TransferIndexError> {
        self.prepare_window_with_phases(service_date, mobility, excluded_modes, covered, |_| {})
    }

    /// Same, with the catalogue's construction markers, then
    /// `WindowCatalogueBuilt`.
    pub fn prepare_window_with_phases(
        &mut self,
        service_date: u32,
        mobility: Mobility,
        excluded_modes: Vec<u16>,
        covered: Range<i64>,
        mut observe: impl FnMut(DeadlineSetupPhase),
    ) -> Result<EventIndexDiagnostics, TransferIndexError> {
        // Drop before allocation: never retain two catalogue buffers.
        self.clear();
        let config = TransferIndexConfig {
            mobility,
            excluded_modes,
            ..TransferIndexConfig::new(service_date, covered)
        };
        let events = event_index::build_event_index_with_phases(
            &self.reader,
            &self.index,
            self.transfers.as_ref(),
            &config,
            self.immutable_binding,
            Some(&self.spans),
            &mut observe,
        )?;
        observe(DeadlineSetupPhase::WindowCatalogueBuilt);
        let diagnostics = events.diagnostics();
        self.window = Some(WindowCatalogue { config, events });
        Ok(diagnostics)
    }

    /// Bytes of the held window catalogue's buffers; 0 when none is held.
    pub fn window_catalogue_bytes(&self) -> usize {
        self.window
            .as_ref()
            .map_or(0, |w| w.events.diagnostics().index_bytes)
    }

    /// Opt-in owner-scoped PTB/PTFT/layout digests, built from these immutable
    /// owned inputs after normal index validation. No query/config proof is
    /// retained; generic/forced checked APIs still recompute complete bindings.
    /// This construction and inline storage are part of owner lifecycle cost.
    /// GTFS: https://gtfs.org/documentation/schedule/reference/#transferstxt
    ///
    /// ```compile_fail
    /// use pt_core::engine::temporal_probe::trip_based::DeadlineSession;
    /// fn substitute_binding(owner: &mut DeadlineSession) {
    ///     owner.immutable_binding = None;
    /// }
    /// ```
    pub fn new_with_immutable_binding(
        reader: Reader<Vec<u8>>,
        mode: PatternMode,
        transfers: Option<Transfers>,
    ) -> Result<Self, EngineError> {
        Self::new_with_immutable_binding_and_phases(reader, mode, transfers, |_| {})
    }

    /// Same owner, with diagnostic completion markers: `IndexBuilt`,
    /// `TripSpansBuilt`, then the three binding hashes. Observing changes no owned state or result.
    pub fn new_with_immutable_binding_and_phases(
        reader: Reader<Vec<u8>>,
        mode: PatternMode,
        transfers: Option<Transfers>,
        mut observe: impl FnMut(DeadlineSetupPhase),
    ) -> Result<Self, EngineError> {
        let mut owner = Self::assemble(reader, mode, transfers, &mut observe)?;
        owner.immutable_binding = Some(immutable_binding_with_phases(
            &owner.reader,
            &owner.index,
            owner.transfers.as_ref(),
            &mut observe,
        ));
        Ok(owner)
    }

    /// Actual inline owner size in this build; includes the optional digest
    /// slot in both constructors. No retained digest allocation exists.
    pub const fn owner_storage_bytes() -> usize {
        core::mem::size_of::<Self>()
    }

    pub const fn immutable_binding_slot_bytes() -> usize {
        core::mem::size_of::<Option<ImmutableBinding>>()
    }

    /// Populated payload inside the inline slot, not additional heap memory.
    pub fn retained_binding_bytes(&self) -> usize {
        self.immutable_binding
            .map_or(0, |_| core::mem::size_of::<ImmutableBinding>())
    }

    /// Read-only access for the existing stop-ID query parser. Does not expose
    /// the Vec backing, mutable layout, walking table or prepared settings.
    ///
    /// ```compile_fail
    /// use pt_core::{Reader, engine::temporal_probe::trip_based::DeadlineSession};
    /// fn mutate_reader(session: &mut DeadlineSession) {
    ///     let _: &mut Reader<Vec<u8>> = session.reader();
    /// }
    /// ```
    pub fn reader(&self) -> &Reader<Vec<u8>> {
        &self.reader
    }

    pub fn prepare(
        &mut self,
        query: Query,
        config: DeadlineSessionConfig,
    ) -> Result<EventIndexDiagnostics, DeadlineSessionPrepareError> {
        self.prepare_with_phases(query, config, |_| {})
    }

    /// Diagnostic-only completion markers. Observing does not change routing,
    /// accounting, validation order, ownership or failure boundaries.
    pub fn prepare_with_phases(
        &mut self,
        query: Query,
        config: DeadlineSessionConfig,
        observe: impl FnMut(DeadlineSetupPhase),
    ) -> Result<EventIndexDiagnostics, DeadlineSessionPrepareError> {
        self.prepare_from_with_phases(query, config, CatalogueSource::Fresh, observe)
    }

    /// Same, taking the catalogue from `source`.
    pub fn prepare_from_with_phases(
        &mut self,
        query: Query,
        config: DeadlineSessionConfig,
        source: CatalogueSource,
        mut observe: impl FnMut(DeadlineSetupPhase),
    ) -> Result<EventIndexDiagnostics, DeadlineSessionPrepareError> {
        observe(DeadlineSetupPhase::Started);
        let diagnostics = self.prepare_inner(query, config, source, &mut observe)?;
        observe(DeadlineSetupPhase::Completed);
        Ok(diagnostics)
    }

    /// Reuse one validated catalogue only when the canonical configuration
    /// digest matches. No query result or origin-dependent setup is retained.
    pub fn prepare_reusing(
        &mut self,
        query: Query,
        config: DeadlineSessionConfig,
    ) -> Result<EventIndexDiagnostics, DeadlineSessionPrepareError> {
        self.prepare_inner(query, config, CatalogueSource::Reuse, &mut |_| {})
    }

    /// Retain one exact immutable prefix for repeated runs of this prepared
    /// query. No reuse across prepare calls, query/config/cap changes or owners.
    /// Construction errors are replayed at the ordinary query boundary, never
    /// exposed as partial bounds. Every run keeps the original nominal setup
    /// charge. Generic checked/ceiling diagnostics still rebuild independently.
    /// GTFS: https://gtfs.org/documentation/schedule/reference/#transferstxt
    ///
    /// ```compile_fail
    /// use pt_core::engine::temporal_probe::trip_based::DeadlineSession;
    /// fn substitute_prepared_inputs(session: &mut DeadlineSession) {
    ///     session.prepared = None;
    /// }
    /// ```
    pub fn prepare_with_prefix_cache(
        &mut self,
        query: Query,
        config: DeadlineSessionConfig,
    ) -> Result<EventIndexDiagnostics, DeadlineSessionPrepareError> {
        self.prepare_with_prefix_cache_and_phases(query, config, |_| {})
    }

    /// Same exact prepared-slot prefix policy, with setup completion markers.
    /// A stored prefix error still surfaces only at the ordinary run boundary.
    pub fn prepare_with_prefix_cache_and_phases(
        &mut self,
        query: Query,
        config: DeadlineSessionConfig,
        observe: impl FnMut(DeadlineSetupPhase),
    ) -> Result<EventIndexDiagnostics, DeadlineSessionPrepareError> {
        self.prepare_with_prefix_cache_from_and_phases(
            query,
            config,
            CatalogueSource::Fresh,
            observe,
        )
    }

    /// Same, taking the catalogue from `source`.
    pub fn prepare_with_prefix_cache_from_and_phases(
        &mut self,
        query: Query,
        config: DeadlineSessionConfig,
        source: CatalogueSource,
        mut observe: impl FnMut(DeadlineSetupPhase),
    ) -> Result<EventIndexDiagnostics, DeadlineSessionPrepareError> {
        observe(DeadlineSetupPhase::Started);
        self.invalidate_request();
        if config.objectives != ProfileObjectives::M4
            || !matches!(
                config.pruning,
                DeadlinePruning::EarliestPrefixAndPoints
                    | DeadlinePruning::EarliestPrefixAndTimetablePoints
            )
            || config.static_bound
            || config.forward_seeds
            || config.raptor_seeds
            || config.raptor_destination_ordering
        {
            if source == CatalogueSource::HeldSlice {
                // A failed held-slice prepare holds nothing.
                self.catalogue = None;
                self.held = None;
            }
            return Err(DeadlineSessionPrepareError::Request(
                DeadlineError::InvalidRequest(
                    "prefix cache requires M4 point bounds, static bounds and sampling off",
                ),
            ));
        }
        let diagnostics = self.prepare_inner(query, config, source, &mut observe)?;
        let p = self.prepared.as_ref().expect("prepared request");
        let prefix = CachedPrefix::build(
            &self.reader,
            &self.index,
            &self.catalogue.as_ref().expect("prepared catalogue").events,
            &p.config.request(&p.query, self.transfers.as_ref()),
        );
        self.prepared
            .as_mut()
            .expect("prepared request")
            .cached_prefix = Some(prefix);
        observe(DeadlineSetupPhase::PrefixBuilt);
        observe(DeadlineSetupPhase::Completed);
        Ok(diagnostics)
    }

    #[cfg(test)]
    pub(crate) fn prefix_cache_diagnostics_for_test(&self) -> Option<PrefixDiagnostics> {
        self.prepared
            .as_ref()?
            .cached_prefix
            .as_ref()?
            .diagnostics()
    }

    fn prepare_inner(
        &mut self,
        query: Query,
        config: DeadlineSessionConfig,
        source: CatalogueSource,
        observe: &mut impl FnMut(DeadlineSetupPhase),
    ) -> Result<EventIndexDiagnostics, DeadlineSessionPrepareError> {
        self.invalidate_request();
        // Only a held-slice request keeps the held catalogue, and only until
        // it succeeds: a failed prepare holds nothing.
        let held = match source {
            CatalogueSource::HeldSlice => self.held.take(),
            CatalogueSource::Fresh | CatalogueSource::Reuse => {
                self.held = None;
                None
            }
        };
        let current = match source {
            CatalogueSource::Fresh => {
                self.catalogue = None;
                None
            }
            CatalogueSource::Reuse => None,
            CatalogueSource::HeldSlice => self.catalogue.take(),
        };
        observe(DeadlineSetupPhase::RequestInvalidated);
        let until = validate_request_shape(
            &self.reader,
            &config.request(&query, self.transfers.as_ref()),
        )
        .map_err(DeadlineSessionPrepareError::Request)?;
        observe(DeadlineSetupPhase::RequestShapeValidated);
        let catalogue_config = TransferIndexConfig::for_query(&query, config.window.start..until);
        let key = configuration_digest(&catalogue_config);
        observe(DeadlineSetupPhase::CatalogueKeyComputed);
        let origin = match (source, current) {
            (CatalogueSource::Reuse, _)
                if self.catalogue.as_ref().is_some_and(|c| c.key == key) =>
            {
                CatalogueOrigin::Reused
            }
            (CatalogueSource::HeldSlice, Some(c)) if c.key == key => {
                self.catalogue = Some(c);
                self.held = held;
                CatalogueOrigin::Reused
            }
            (_, current) => {
                // Drop before allocation: never retain a catalogue this
                // request cannot use.
                self.catalogue = None;
                let (events, origin, held) =
                    self.build_or_slice(&catalogue_config, held, current, observe)?;
                // Fresh canonical construction proves the binding. Request/event
                // validation occurs before this immutable entry can be cached.
                validate_request(
                    &self.reader,
                    &events,
                    &config.request(&query, self.transfers.as_ref()),
                )
                .map_err(DeadlineSessionPrepareError::Request)?;
                observe(DeadlineSetupPhase::CatalogueValidated);
                self.catalogue = Some(Catalogue {
                    key,
                    config: catalogue_config,
                    events,
                });
                self.held = held;
                origin
            }
        };
        let diagnostics = self
            .catalogue
            .as_ref()
            .expect("validated catalogue")
            .events
            .diagnostics();
        self.prepared = Some(Prepared {
            query,
            config,
            catalogue_reused: origin == CatalogueOrigin::Reused,
            origin,
            cached_prefix: None,
        });
        observe(DeadlineSetupPhase::RequestStored);
        Ok(diagnostics)
    }

    /// The request's catalogue for `config`, with how it was obtained and the
    /// catalogue to hold afterwards. In order: a copy cut from `held` (the
    /// current one is dropped first); a copy cut from `current`, which becomes
    /// the held one; otherwise both are dropped and the catalogue is built
    /// fresh or, as before, cut from a `prepare_window` catalogue.
    fn build_or_slice(
        &mut self,
        config: &TransferIndexConfig,
        held: Option<Catalogue>,
        current: Option<Catalogue>,
        observe: &mut impl FnMut(DeadlineSetupPhase),
    ) -> Result<(EventIndex, CatalogueOrigin, Option<Catalogue>), DeadlineSessionPrepareError> {
        let source = if held
            .as_ref()
            .is_some_and(|h| covers(&self.reader, config, h))
        {
            drop(current);
            held
        } else {
            drop(held);
            current.filter(|c| covers(&self.reader, config, c))
        };
        if let Some(source) = source {
            // A held catalogue makes a request catalogue beside it, never a
            // third buffer: any `prepare_window` catalogue goes.
            self.window = None;
            if let Some(events) = event_index::slice_copy_with_phases(
                &self.reader,
                &self.index,
                self.transfers.as_ref(),
                config,
                self.immutable_binding,
                &source.config,
                &source.events,
                observe,
            )
            .map_err(DeadlineSessionPrepareError::Catalogue)?
            {
                return Ok((events, CatalogueOrigin::HeldSlice, Some(source)));
            }
            // Unreachable for a covering catalogue; built fresh, nothing held.
        }
        // A held window is taken over or dropped, never kept beside this.
        let sliced = match self.window.take() {
            Some(window) => event_index::take_slice_with_phases(
                &self.reader,
                &self.index,
                self.transfers.as_ref(),
                config,
                self.immutable_binding,
                &window.config,
                window.events,
                observe,
            )
            .map_err(DeadlineSessionPrepareError::Catalogue)?,
            None => None,
        };
        Ok(match sliced {
            Some(events) => (events, CatalogueOrigin::WindowSlice, None),
            None => (
                event_index::build_event_index_with_phases(
                    &self.reader,
                    &self.index,
                    self.transfers.as_ref(),
                    config,
                    self.immutable_binding,
                    Some(&self.spans),
                    observe,
                )
                .map_err(DeadlineSessionPrepareError::Catalogue)?,
                CatalogueOrigin::Built,
                None,
            ),
        })
    }

    /// H83: bytes of the held catalogue's buffers; 0 when none is held.
    pub fn held_catalogue_bytes(&self) -> usize {
        self.held
            .as_ref()
            .map_or(0, |c| c.events.diagnostics().index_bytes)
    }

    /// How the prepared request's catalogue was obtained; `None` without a
    /// prepared request.
    pub fn catalogue_origin(&self) -> Option<CatalogueOrigin> {
        self.prepared.as_ref().map(|p| p.origin)
    }

    /// Retire the request, its catalogue, the held catalogue and any held
    /// window catalogue.
    pub fn clear(&mut self) {
        self.invalidate_request();
        self.catalogue = None;
        self.held = None;
        self.window = None;
    }

    /// Invalidate the active query before external parsing. Retains only the
    /// inaccessible immutable catalogue; no run is possible after this call.
    pub fn invalidate_request(&mut self) {
        self.prepared = None;
    }

    pub fn catalogue_reused(&self) -> bool {
        self.prepared.as_ref().is_some_and(|p| p.catalogue_reused)
    }

    /// Read-only identity for experiment diagnostics, never a validation token.
    pub fn catalogue_key(&self) -> Option<[u8; 32]> {
        self.prepared.as_ref()?;
        self.catalogue.as_ref().map(|c| c.key)
    }

    /// Read-only diagnostic value, never accepted as a validation token.
    pub fn catalogue_binding(&self) -> Option<TransferIndexBinding> {
        self.prepared.as_ref()?;
        self.catalogue.as_ref().map(|c| c.events.binding())
    }

    pub fn run(&self) -> Result<DeadlineResult, DeadlineError> {
        self.run_with_phases(|_| {})
    }

    pub fn run_with_phases(
        &self,
        observe: impl FnMut(DeadlinePhase),
    ) -> Result<DeadlineResult, DeadlineError> {
        let p = self.prepared.as_ref().ok_or(DeadlineError::InvalidRequest(
            "deadline request is not prepared",
        ))?;
        query_prepared_with_phases(
            &self.reader,
            &self.index,
            &self.catalogue.as_ref().expect("prepared catalogue").events,
            p.config.request(&p.query, self.transfers.as_ref()),
            p.cached_prefix.as_ref(),
            observe,
        )
    }

    /// On-session ablation: recheck the binding and events exactly as the
    /// existing public query API does. Never selected implicitly after failure.
    pub fn run_checked_with_phases(
        &self,
        observe: impl FnMut(DeadlinePhase),
    ) -> Result<DeadlineResult, DeadlineError> {
        let p = self.prepared.as_ref().ok_or(DeadlineError::InvalidRequest(
            "deadline request is not prepared",
        ))?;
        query_deadline_with_phases(
            &self.reader,
            &self.index,
            &self.catalogue.as_ref().expect("prepared catalogue").events,
            p.config.request(&p.query, self.transfers.as_ref()),
            observe,
        )
    }

    /// Exact filter winners over immutable prepared inputs. Optional prefix
    /// storage is read-only; no query results or discovered incumbents survive.
    pub fn run_portfolio_with_phases(
        &self,
        suffix_pruning: DeadlineSuffixPruning,
        observe: impl FnMut(DeadlinePhase),
    ) -> Result<DeadlinePortfolioResult, DeadlineError> {
        let p = self.prepared.as_ref().ok_or(DeadlineError::InvalidRequest(
            "deadline request is not prepared",
        ))?;
        query_prepared_portfolio_with_phases(
            &self.reader,
            &self.index,
            &self.catalogue.as_ref().expect("prepared catalogue").events,
            p.config.request(&p.query, self.transfers.as_ref()),
            suffix_pruning,
            p.cached_prefix.as_ref(),
            observe,
        )
    }

    /// Same-owner ablation through the unchanged generic checked winner API.
    /// A failure never silently selects the prepared path.
    pub fn run_portfolio_checked_with_phases(
        &self,
        suffix_pruning: DeadlineSuffixPruning,
        observe: impl FnMut(DeadlinePhase),
    ) -> Result<DeadlinePortfolioResult, DeadlineError> {
        let p = self.prepared.as_ref().ok_or(DeadlineError::InvalidRequest(
            "deadline request is not prepared",
        ))?;
        query_deadline_portfolio_with_suffix_pruning(
            &self.reader,
            &self.index,
            &self.catalogue.as_ref().expect("prepared catalogue").events,
            p.config.request(&p.query, self.transfers.as_ref()),
            suffix_pruning,
            observe,
        )
    }

    pub fn run_preference_with_phases(
        &self,
        preference: DeadlinePreference,
        suffix_pruning: DeadlineSuffixPruning,
        observe: impl FnMut(DeadlinePhase),
    ) -> Result<DeadlinePreferenceResult, DeadlineError> {
        let p = self.prepared.as_ref().ok_or(DeadlineError::InvalidRequest(
            "deadline request is not prepared",
        ))?;
        query_prepared_preference_with_phases(
            &self.reader,
            &self.index,
            &self.catalogue.as_ref().expect("prepared catalogue").events,
            p.config.request(&p.query, self.transfers.as_ref()),
            preference,
            suffix_pruning,
            p.cached_prefix.as_ref(),
            observe,
        )
    }

    /// Forced checked single-selector counterpart; not a different search.
    pub fn run_preference_checked_with_phases(
        &self,
        preference: DeadlinePreference,
        suffix_pruning: DeadlineSuffixPruning,
        observe: impl FnMut(DeadlinePhase),
    ) -> Result<DeadlinePreferenceResult, DeadlineError> {
        let p = self.prepared.as_ref().ok_or(DeadlineError::InvalidRequest(
            "deadline request is not prepared",
        ))?;
        query_deadline_preference_with_suffix_pruning(
            &self.reader,
            &self.index,
            &self.catalogue.as_ref().expect("prepared catalogue").events,
            p.config.request(&p.query, self.transfers.as_ref()),
            preference,
            suffix_pruning,
            observe,
        )
    }

    /// Additive complete-movement output. Search and projection share the
    /// original stop/lookup caps; errors return no partial presentation result.
    /// No caller-supplied witness or substitute prepared input is accepted.
    pub fn run_portfolio_journeys(
        &self,
        suffix_pruning: DeadlineSuffixPruning,
    ) -> Result<DeadlinePortfolioJourneyResult, DeadlineError> {
        self.run_portfolio_journeys_with_phases(suffix_pruning, |_| {})
    }

    /// Search markers retain their original meaning; projection follows
    /// SearchFinished and consumes the same request's remaining work budget.
    pub fn run_portfolio_journeys_with_phases(
        &self,
        suffix_pruning: DeadlineSuffixPruning,
        observe: impl FnMut(DeadlinePhase),
    ) -> Result<DeadlinePortfolioJourneyResult, DeadlineError> {
        let search = self.run_portfolio_with_phases(suffix_pruning, observe)?;
        self.project_portfolio(search)
    }

    /// Forced checked counterpart. Never substitutes sealed-owner validation
    /// or retained prefix setup for the requested generic checked search.
    pub fn run_portfolio_journeys_checked_with_phases(
        &self,
        suffix_pruning: DeadlineSuffixPruning,
        observe: impl FnMut(DeadlinePhase),
    ) -> Result<DeadlinePortfolioJourneyResult, DeadlineError> {
        let search = self.run_portfolio_checked_with_phases(suffix_pruning, observe)?;
        self.project_portfolio(search)
    }

    fn project_portfolio(
        &self,
        search: DeadlinePortfolioResult,
    ) -> Result<DeadlinePortfolioJourneyResult, DeadlineError> {
        let p = self.prepared.as_ref().expect("successful prepared search");
        let (journeys, by_preference, projection) = super::journey::project(
            &self.reader,
            &self.index,
            &self.catalogue.as_ref().expect("prepared catalogue").events,
            &p.query,
            self.transfers.as_ref(),
            &p.config,
            &search.diagnostics,
            search.winners.by_preference.each_ref().map(Option::as_ref),
        )?;
        Ok(DeadlinePortfolioJourneyResult {
            search,
            journeys,
            by_preference,
            projection,
        })
    }

    /// Only the requested selector is certified; an empty result is not a
    /// certificate for the other selectors. All projection cost is included.
    pub fn run_preference_journey(
        &self,
        preference: DeadlinePreference,
        suffix_pruning: DeadlineSuffixPruning,
    ) -> Result<DeadlinePreferenceJourneyResult, DeadlineError> {
        self.run_preference_journey_with_phases(preference, suffix_pruning, |_| {})
    }

    pub fn run_preference_journey_with_phases(
        &self,
        preference: DeadlinePreference,
        suffix_pruning: DeadlineSuffixPruning,
        observe: impl FnMut(DeadlinePhase),
    ) -> Result<DeadlinePreferenceJourneyResult, DeadlineError> {
        let search = self.run_preference_with_phases(preference, suffix_pruning, observe)?;
        self.project_preference(search)
    }

    /// Same completed selector and aggregate budget, with generic checked
    /// validation retained. Projection does not turn a single into a portfolio.
    pub fn run_preference_journey_checked_with_phases(
        &self,
        preference: DeadlinePreference,
        suffix_pruning: DeadlineSuffixPruning,
        observe: impl FnMut(DeadlinePhase),
    ) -> Result<DeadlinePreferenceJourneyResult, DeadlineError> {
        let search =
            self.run_preference_checked_with_phases(preference, suffix_pruning, observe)?;
        self.project_preference(search)
    }

    fn project_preference(
        &self,
        search: DeadlinePreferenceResult,
    ) -> Result<DeadlinePreferenceJourneyResult, DeadlineError> {
        let p = self.prepared.as_ref().expect("successful prepared search");
        let mut points = [None; 4];
        points[0] = search.winner.as_ref();
        let (journeys, _, projection) = super::journey::project(
            &self.reader,
            &self.index,
            &self.catalogue.as_ref().expect("prepared catalogue").events,
            &p.query,
            self.transfers.as_ref(),
            &p.config,
            &search.diagnostics,
            points,
        )?;
        Ok(DeadlinePreferenceJourneyResult {
            search,
            journey: journeys.into_iter().next(),
            projection,
        })
    }

    /// Native theoretical diagnostic, never an implicit optimization. Seeds
    /// come only from a completed winner query on these exact immutable inputs.
    /// Each pass has independent original caps; their sum is not aggregate-capped.
    /// None requests all four selectors, not full skyline completion. Ordinary
    /// queries do not call this method and retain no discovered incumbents.
    pub fn run_winner_incumbent_ceiling_with_phases(
        &self,
        preference: Option<DeadlinePreference>,
        suffix_pruning: DeadlineSuffixPruning,
        observe: impl FnMut(DeadlineWinnerCeilingPhase),
    ) -> Result<DeadlineWinnerIncumbentCeiling, DeadlineIncumbentCeilingError> {
        let p = self
            .prepared
            .as_ref()
            .ok_or(DeadlineIncumbentCeilingError::Baseline(
                DeadlineError::InvalidRequest("deadline request is not prepared"),
            ))?;
        query_prepared_winner_incumbent_ceiling(
            &self.reader,
            &self.index,
            &self.catalogue.as_ref().expect("prepared catalogue").events,
            p.config.request(&p.query, self.transfers.as_ref()),
            preference,
            suffix_pruning,
            observe,
        )
    }
}

/// Whether `c` can stand in for a request catalogue built for `config`.
fn covers(reader: &Reader<Vec<u8>>, config: &TransferIndexConfig, c: &Catalogue) -> bool {
    event_index::slice_applies(reader, config, &c.config, &c.events)
}
