//! Metadata-only projection of engine-certified movement. Never infer walking
//! from timetable gaps. Synthetic costs are not pedestrian-path geometry.
//! GTFS: https://gtfs.org/documentation/schedule/reference/#transferstxt
//! https://gtfs.org/documentation/schedule/reference/#frequenciestxt
//! https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes

use super::*;

pub(super) struct Projection {
    pub journeys: Vec<DeadlineJourney>,
    pub by_preference: [Option<usize>; 4],
    pub diagnostics: DeadlineJourneyDiagnostics,
}
impl Projection {
    pub fn single(
        preference: DeadlinePreference,
        journey: Option<DeadlineJourney>,
        diagnostics: DeadlineJourneyDiagnostics,
    ) -> Self {
        let mut by_preference = [None; 4];
        if journey.is_some() {
            let slot = DeadlinePreference::ALL
                .iter()
                .position(|p| *p == preference)
                .unwrap();
            by_preference[slot] = Some(0);
        }
        Self {
            journeys: journey.into_iter().collect(),
            by_preference,
            diagnostics,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResultWire<'a> {
    #[serde(flatten)]
    winner: WinnerResultWire<'a>,
    journey_contract: &'static str,
    journeys: Vec<JourneyWire>,
    journey_by_preference: BTreeMap<&'static str, Option<usize>>,
    projection: DiagnosticsWire,
    /// Engine movement replay only. String metadata and JS serialization are
    /// outside this value and must be included by external whole-call timing.
    movement_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsWire {
    stop_work: usize,
    lookup_work: usize,
    aggregate_stop_work: usize,
    aggregate_lookup_work: usize,
    unique_journeys: usize,
    /// Logical core payload only: not wire allocations, capacity, peak or RSS.
    core_output_bytes: usize,
    /// Bounded metadata reads, not routed event work or saved routing work.
    metadata_records: usize,
    metadata_stop_ids: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JourneyWire {
    point: PointWire,
    access: AccessWire,
    rides: Vec<RideWire>,
    connections: Vec<ConnectionWire>,
    egress: EgressWire,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessWire {
    stop_id: String,
    walk_secs: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RideWire {
    witness: WitnessWire,
    route_id: String,
    route_short_name: String,
    route_color: Option<String>,
    trip_id: String,
    mode: &'static str,
    route_type: u16,
    from_stop_id: String,
    to_stop_id: String,
    pattern_stop_ids: Vec<String>,
    approximate: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionWire {
    from_stop_id: String,
    to_stop_id: String,
    arrival_secs: i64,
    boarding_secs: i64,
    walk_secs: u64,
    minimum_elapsed_secs: i64,
    kind: &'static str,
    spends_transfer: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EgressWire {
    from_stop_id: String,
    exit_stop_id: String,
    physical_walk_secs: u64,
    caller_walk_secs: u32,
}

fn kind(k: TransferKind) -> &'static str {
    match k {
        TransferKind::SameStop => "same-stop",
        TransferKind::Footpath => "footpath",
        TransferKind::Synthetic => "synthetic",
        TransferKind::Linked => "linked",
        TransferKind::InSeat => "in-seat",
        TransferKind::Derived => "derived",
    }
}
fn safe(n: i64) -> Result<(), String> {
    if n.unsigned_abs() > 9_007_199_254_740_991 {
        Err("unsafe journey integer".into())
    } else {
        Ok(())
    }
}

struct Metadata<'a> {
    reader: &'a Reader<Vec<u8>>,
    records: usize,
    stops: usize,
}
impl Metadata<'_> {
    fn stop(&mut self, at: u32) -> Result<String, String> {
        self.stops += 1;
        self.reader
            .stop_id(at as usize)
            .map(str::to_owned)
            .map_err(|e| format!("stop metadata: {e:?}"))
    }
    fn journey(&mut self, j: &DeadlineJourney) -> Result<JourneyWire, String> {
        let p = &j.point;
        for n in [p.origin_departure_secs, p.destination_arrival_secs] {
            safe(n)?;
        }
        if p.total_walk_secs > 9_007_199_254_740_991 {
            return Err("unsafe journey walking".into());
        }
        let access = AccessWire {
            stop_id: self.stop(j.access.stop)?,
            walk_secs: j.access.walk_secs,
        };
        let mut rides = Vec::with_capacity(j.rides.len());
        for ride in &j.rides {
            let w = &ride.witness;
            for n in [w.board_secs, w.alight_secs, w.frequency_offset_secs] {
                safe(n)?;
            }
            self.records += 2;
            let route = self
                .reader
                .route(w.reader_route_idx as usize)
                .map_err(|e| format!("route metadata: {e:?}"))?;
            let trip = self
                .reader
                .trip(w.trip_idx as usize)
                .map_err(|e| format!("trip metadata: {e:?}"))?;
            rides.push(RideWire {
                witness: w.into(),
                route_id: route.route_id,
                route_short_name: route.short_name,
                route_color: (!route.route_color.is_empty()).then_some(route.route_color),
                trip_id: trip.trip_id,
                mode: pt_core::engine::mode::mode_to_wire_str(
                    pt_core::engine::mode::route_type_to_mode(ride.route_type),
                ),
                route_type: ride.route_type,
                from_stop_id: self.stop(ride.from_stop)?,
                to_stop_id: self.stop(ride.to_stop)?,
                pattern_stop_ids: ride
                    .pattern_stop_ids
                    .iter()
                    .map(|&s| self.stop(s))
                    .collect::<Result<_, _>>()?,
                // Historical witness field means approximate (exact_times=0),
                // not every frequency-generated scheduled occurrence.
                approximate: w.frequency_instance,
            });
        }
        let connections = j
            .connections
            .iter()
            .map(|c| {
                for n in [c.arrival_secs, c.boarding_secs, c.elapsed_secs] {
                    safe(n)?;
                }
                if c.walk_secs > 9_007_199_254_740_991 {
                    return Err("unsafe connection walking".into());
                }
                Ok(ConnectionWire {
                    from_stop_id: self.stop(c.from_stop)?,
                    to_stop_id: self.stop(c.to_stop)?,
                    arrival_secs: c.arrival_secs,
                    boarding_secs: c.boarding_secs,
                    walk_secs: c.walk_secs,
                    minimum_elapsed_secs: c.elapsed_secs,
                    kind: kind(c.kind),
                    spends_transfer: c.kind.spends_transfer(),
                })
            })
            .collect::<Result<_, String>>()?;
        let e = j.egress;
        if e.physical_walk_secs > 9_007_199_254_740_991 {
            return Err("unsafe egress walking".into());
        }
        let egress = EgressWire {
            from_stop_id: self.stop(e.from_stop)?,
            exit_stop_id: self.stop(e.exit_stop)?,
            physical_walk_secs: e.physical_walk_secs,
            caller_walk_secs: e.caller_walk_secs,
        };
        Ok(JourneyWire {
            point: p.into(),
            access,
            rides,
            connections,
            egress,
        })
    }
}

impl<'a> ResultWire<'a> {
    pub fn new(
        reader: &Reader<Vec<u8>>,
        winner: WinnerResultWire<'a>,
        p: Projection,
        preference: Option<DeadlinePreference>,
        movement_ms: f64,
    ) -> Result<Self, String> {
        let mut metadata = Metadata {
            reader,
            records: 0,
            stops: 0,
        };
        let journeys = p
            .journeys
            .iter()
            .map(|j| metadata.journey(j))
            .collect::<Result<Vec<_>, _>>()?;
        let journey_by_preference = DeadlinePreference::ALL
            .into_iter()
            .zip(p.by_preference)
            .filter(|(s, _)| preference.is_none_or(|selected| selected == *s))
            .map(|(s, j)| (s.name(), j))
            .collect();
        let d = p.diagnostics;
        Ok(Self {
            winner,
            journey_contract: "complete-selected-movement-v1",
            journeys,
            journey_by_preference,
            projection: DiagnosticsWire {
                stop_work: d.stop_work,
                lookup_work: d.lookup_work,
                aggregate_stop_work: d.aggregate_stop_work,
                aggregate_lookup_work: d.aggregate_lookup_work,
                unique_journeys: d.unique_journeys,
                core_output_bytes: d.output_bytes,
                metadata_records: metadata.records,
                metadata_stop_ids: metadata.stops,
            },
            movement_ms,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> DeadlineJourney {
        let w = R3TransitWitness {
            service_date: 20260507,
            route_idx: 0,
            reader_route_idx: 0,
            trip_idx: 0,
            board_position: 1,
            alight_position: 2,
            board_secs: 900,
            alight_secs: 1000,
            frequency_offset_secs: 100,
            frequency_instance: true,
            in_seat: false,
        };
        DeadlineJourney {
            point: R3Point {
                origin_departure_secs: 880,
                destination_arrival_secs: 1120,
                actual_transfers: 0,
                total_walk_secs: 140,
                transit_rounds: 1,
                service_date: 20260507,
                witness: vec![w],
            },
            access: pt_core::engine::StopWalk {
                stop: 0,
                walk_secs: 20,
            },
            rides: vec![DeadlineJourneyRide {
                witness: w,
                from_stop: 1,
                to_stop: 0,
                route_type: 3,
                pattern_stop_ids: vec![0, 1, 0],
            }],
            connections: vec![],
            egress: DeadlineJourneyEgress {
                from_stop: 0,
                exit_stop: 1,
                physical_walk_secs: 80,
                caller_walk_secs: 40,
            },
        }
    }
    fn reader() -> Reader<Vec<u8>> {
        Reader::from_bytes(
            include_bytes!(
                "../../../../packages/frontend/tests/services/__fixtures__/same-pattern-trips.ptb"
            )
            .to_vec(),
        )
        .unwrap()
    }
    #[test]
    fn journey_metadata_preserves_ids_repeated_positions_dates_and_approximation() {
        let reader = reader();
        let mut m = Metadata {
            reader: &reader,
            records: 0,
            stops: 0,
        };
        let mut j = sample();
        let v = serde_json::to_value(m.journey(&j).unwrap()).unwrap();
        assert_eq!(
            v["point"],
            serde_json::to_value(PointWire::from(&j.point)).unwrap()
        );
        assert_eq!(v["point"].as_object().unwrap().len(), 8);
        assert_eq!(v["rides"][0]["witness"].as_object().unwrap().len(), 11);
        assert_eq!(
            v["rides"][0]["patternStopIds"],
            serde_json::json!([
                reader.stop_id(0).unwrap(),
                reader.stop_id(1).unwrap(),
                reader.stop_id(0).unwrap()
            ])
        );
        assert_eq!(v["rides"][0]["routeId"], reader.route(0).unwrap().route_id);
        assert_eq!(v["rides"][0]["tripId"], reader.trip(0).unwrap().trip_id);
        assert_eq!(v["rides"][0]["mode"], "BUS");
        assert_eq!(v["rides"][0]["witness"]["boardPosition"], 1);
        assert_eq!(v["rides"][0]["witness"]["serviceDate"], 20260507);
        assert_eq!(v["rides"][0]["approximate"], true);
        assert_eq!(v["egress"]["physicalWalkSecs"], 80);
        assert_eq!(v["egress"]["callerWalkSecs"], 40);
        assert_eq!((m.records, m.stops), (2, 8));
        j.rides[0].witness.frequency_instance = false;
        assert_eq!(
            serde_json::to_value(m.journey(&j).unwrap()).unwrap()["rides"][0]["approximate"],
            false
        );
    }
    #[test]
    fn journey_connection_kinds_do_not_confuse_elapsed_walking_or_passenger_transfers() {
        let reader = reader();
        for k in [
            TransferKind::SameStop,
            TransferKind::Footpath,
            TransferKind::Synthetic,
            TransferKind::Linked,
            TransferKind::InSeat,
            TransferKind::Derived,
        ] {
            let mut j = sample();
            j.connections.push(DeadlineJourneyConnection {
                from_stop: 0,
                to_stop: 1,
                arrival_secs: 1000,
                boarding_secs: 1300,
                walk_secs: 30,
                elapsed_secs: 180,
                kind: k,
            });
            let v = serde_json::to_value(
                Metadata {
                    reader: &reader,
                    records: 0,
                    stops: 0,
                }
                .journey(&j)
                .unwrap(),
            )
            .unwrap();
            assert_eq!(v["connections"][0]["kind"], kind(k));
            assert_eq!(v["connections"][0]["walkSecs"], 30);
            assert_eq!(v["connections"][0]["minimumElapsedSecs"], 180);
            assert_eq!(v["connections"][0]["spendsTransfer"], k.spends_transfer());
        }
    }
    #[test]
    fn journey_metadata_rejects_unsafe_numbers_and_invalid_ids_without_partial_output() {
        let reader = reader();
        for case in 0..5 {
            let mut j = sample();
            match case {
                0 => j.point.destination_arrival_secs = 9_007_199_254_740_992,
                1 => j.rides[0].witness.frequency_offset_secs = i64::MIN,
                2 => j.point.total_walk_secs = u64::MAX,
                3 => j.rides[0].witness.trip_idx = u32::MAX,
                _ => j.egress.physical_walk_secs = u64::MAX,
            }
            assert!(Metadata {
                reader: &reader,
                records: 0,
                stops: 0
            }
            .journey(&j)
            .is_err());
        }
    }
    #[test]
    fn journey_single_projection_keeps_only_the_requested_selector_slot() {
        for (slot, preference) in DeadlinePreference::ALL.into_iter().enumerate() {
            for some in [false, true] {
                let p = Projection::single(
                    preference,
                    some.then(sample),
                    DeadlineJourneyDiagnostics::default(),
                );
                assert_eq!(p.journeys.len(), usize::from(some));
                for (i, at) in p.by_preference.iter().enumerate() {
                    assert_eq!(*at, (some && slot == i).then_some(0));
                }
            }
        }
    }
}
