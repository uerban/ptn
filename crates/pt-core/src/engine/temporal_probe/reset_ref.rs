//! B1 benchmark control: one legacy forward plan per eligible origin event.
//!
//! This deliberately repeats the existing single-query engine. Its scalar
//! arrival labels can drop valid temporal alternatives, so these samples are
//! neither a complete timetable profile nor an independent routing oracle.
//! The explicit cap marks unfinished event coverage rather than pretending a
//! bounded run proved day exhaustion.

use alloc::vec::Vec;
use core::ops::Range;

use super::{enumerate_entry_events, EntryEvent};
use crate::engine::{plan, EngineError, Index, Itinerary, Query, ScanState};
use crate::transfers::Transfers;
use crate::Reader;

#[derive(Debug)]
pub struct ReferenceSample {
    pub event: EntryEvent,
    pub first_board_secs: Option<i64>,
    /// Raw production results for scalar-safe differential fixtures. These are
    /// not promoted to an oracle; transfer-aware cases can be lost by the
    /// production scan's scalar stop labels.
    pub itineraries: Vec<Itinerary>,
}

#[derive(Debug)]
pub struct ReferenceRun {
    pub total_events: usize,
    pub examined_events: usize,
    pub incomplete: bool,
    pub samples: Vec<ReferenceSample>,
}

pub fn reset_reference<B>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    query: &Query,
    service_secs: Range<i64>,
    max_events: usize,
) -> Result<ReferenceRun, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let events = enumerate_entry_events(reader, index, query, service_secs)?;
    let total_events = events.len();
    let mut state = ScanState::default();
    let mut samples = Vec::with_capacity(total_events.min(max_events));

    for event in events.into_iter().take(max_events) {
        let mut event_query = query.clone();
        event_query.date = event.service_date;
        event_query.departure_secs = event.origin_ready_secs;
        let itineraries = plan(reader, index, transfers, &mut state, &event_query)?;
        samples.push(ReferenceSample {
            event,
            first_board_secs: itineraries.first().map(|it| it.board_secs),
            itineraries,
        });
    }

    let examined_events = samples.len();
    Ok(ReferenceRun {
        total_events,
        examined_events,
        incomplete: examined_events < total_events,
        samples,
    })
}
