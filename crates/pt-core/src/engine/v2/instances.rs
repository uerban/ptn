//! Concrete-instance enumeration for the temporal experiment (production
//! planning lists instances in `scan`).
//!
//! GTFS frequencies replace the template with departures `start + n * headway
//! < end`; exact_times=0 is approximate and exact_times=1 is scheduled.
//! <https://gtfs.org/documentation/schedule/reference/#frequenciestxt>
//! Each instance retains its originating service date. Elapsed event times use
//! the bundle's noon-minus-12-hour origins, including DST and times above 24h.
//! <https://gtfs.org/documentation/schedule/reference/#field-types>

use super::{index::V2Index, scan::Inst, time};
use crate::engine::scan::dep_secs_at;
use crate::engine::{index::RouteTrip, EngineError};
use crate::Reader;
use core::ops::Range;

#[derive(Clone, Copy, Debug)]
pub(crate) struct ConcreteInstance {
    pub board_secs: i64,
    pub inst: Inst,
    pub approximate: bool,
}

/// Visit instances without materializing an unbounded intermediate vector.
/// `every_frequency` chooses every occurrence or the first feasible occurrence
/// per frequency window/date. Scheduled trips always visit every active date.
#[allow(clippy::too_many_arguments)]
pub(crate) fn visit_instances<B, E>(
    reader: &Reader<B>,
    v2: &V2Index,
    trip: &RouteTrip,
    position: usize,
    dates: Range<usize>,
    origin_unix: i64,
    ready: i64,
    deadline: i64,
    every_frequency: bool,
    mut visit: impl FnMut(ConcreteInstance) -> Result<(), E>,
) -> Result<(), E>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
    E: From<EngineError>,
{
    let info = v2
        .trips
        .get(trip.trip_idx as usize)
        .ok_or(EngineError::Corrupt("concrete trip ordinal"))?;
    if info.route == u32::MAX || ready > deadline {
        return Ok(());
    }
    let dep = dep_secs_at(reader, trip, position)?;
    if dep < 0 {
        return Ok(());
    }
    let first_dep = v2.first_dep[trip.trip_idx as usize];
    for date in dates {
        // `candidate_dates` supplies the bundle's service-day ordinal. Use
        // its calendar bit directly, preserving the original service day for
        // overnight/DST trips without a civil-date conversion round trip.
        if !reader.service_active_on_day(trip.service_idx, date as u32) {
            continue;
        }
        let date_shift = time::origin(reader, date)?
            .checked_sub(origin_unix)
            .ok_or(EngineError::TimeOverflow)?;
        let base = date_shift
            .checked_add(dep)
            .ok_or(EngineError::TimeOverflow)?;
        let Some(windows) = v2.freq.get(&trip.trip_idx) else {
            if base >= ready && base <= deadline {
                visit(ConcreteInstance {
                    board_secs: base,
                    inst: Inst {
                        trip: trip.trip_idx,
                        date: date as u32,
                        shift: 0,
                    },
                    approximate: false,
                })?;
            }
            continue;
        };
        let need = ready
            .checked_sub(base)
            .and_then(|n| n.checked_add(first_dep))
            .ok_or(EngineError::TimeOverflow)?;
        for window in windows {
            let repeat = if need <= window.start {
                0
            } else {
                need.checked_sub(window.start)
                    .and_then(|n| n.checked_add(window.headway - 1))
                    .ok_or(EngineError::TimeOverflow)?
                    / window.headway
            };
            let mut first = window
                .start
                .checked_add(
                    repeat
                        .checked_mul(window.headway)
                        .ok_or(EngineError::TimeOverflow)?,
                )
                .ok_or(EngineError::TimeOverflow)?;
            while first < window.end {
                let shift = first
                    .checked_sub(first_dep)
                    .ok_or(EngineError::TimeOverflow)?;
                let board_secs = base.checked_add(shift).ok_or(EngineError::TimeOverflow)?;
                if board_secs > deadline {
                    break;
                }
                visit(ConcreteInstance {
                    board_secs,
                    inst: Inst {
                        trip: trip.trip_idx,
                        date: date as u32,
                        shift,
                    },
                    approximate: !window.exact,
                })?;
                if !every_frequency {
                    break;
                }
                first = first
                    .checked_add(window.headway)
                    .ok_or(EngineError::TimeOverflow)?;
            }
        }
    }
    Ok(())
}
