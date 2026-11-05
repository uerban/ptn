// Minimal stand-in for the on-device `pt-wasm` plan step, used by the
// SearchOrchestrator tail tests.
//
// Routing CORRECTNESS is owned by the engine (`crates/pt-core`: the committed
// `.ptb` corpus, `raptor_behavior.rs` goldens, and the `pt-wasm` golden replay).
// These tests exercise the HOST tail the engine feeds — service-day resolution,
// entry/exit stop resolution, compose, RT overlay, and the "never silently
// auto-fire a server query" rule — so they need a plan
// step that is deterministic and independent of the wasm binary.
//
// The stub is deliberately dumb: one direct ride per route, no transfers, no
// footpaths. It honours the query fields the tail depends on — the service
// date it is handed, `activeServiceIds` and `departureSecs`. Overnight trips
// are the engine's job (it scans the service dates its horizon reaches), so the
// stub does not re-run another day.
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";
import type { RaptorItinerary, RaptorQuery } from "@pt/shared";

export function planFromIndex(index: RaptorIndex, query: RaptorQuery): RaptorItinerary[] {
  const entry = new Map(query.entryStops.map((s) => [s.stopId, s.walkSecs]));
  const exit = new Map(query.exitStops.map((s) => [s.stopId, s.walkSecs]));
  const out: RaptorItinerary[] = [];

  for (const route of index.routes) {
    for (const trip of route.trips) {
      if (!query.activeServiceIds.has(trip.serviceId)) continue;
      for (let b = 0; b < route.stopIds.length; b++) {
        const fromStopId = route.stopIds[b];
        if (!entry.has(fromStopId)) continue;
        // Earliest boardable stop-time at or after the query departure, with
        // the access walk paid first (mirrors the engine's entry relaxation).
        const departSecs = trip.departureSecs[b];
        if (departSecs < query.departureSecs + (entry.get(fromStopId) ?? 0)) continue;
        for (let a = b + 1; a < route.stopIds.length; a++) {
          const toStopId = route.stopIds[a];
          if (!exit.has(toStopId)) continue;
          const arriveSecs = trip.departureSecs[a];
          out.push({
            legs: [{
              type: "transit",
              fromStopId,
              toStopId,
              departSecs,
              arriveSecs,
              routeId: route.id,
              routeShortName: route.shortName,
              mode: route.mode,
              tripId: trip.tripId,
              headsign: trip.headsign,
              boardStopIdx: b,
              alightStopIdx: a,
              patternStopIds: route.stopIds,
            }],
            boardSecs: departSecs,
            alightSecs: arriveSecs,
            transfers: 0,
          });
          break;
        }
      }
    }
  }
  return out;
}
