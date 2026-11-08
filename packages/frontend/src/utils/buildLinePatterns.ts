import { captureCityData } from "../services/cityData.ts";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import type { LinePattern } from "../stores/lineViewStore.ts";

/**
 * Build LinePattern[] for a given route by reading the RAPTOR index
 * and resolving stop details from Dexie.
 *
 * GTFS `trip_headsign` is rider-facing destination text and is not a direction
 * identity. Opposite trips may legitimately share it; `direction_id` is the
 * timetable field that separates them. Prefer the backend's direction patterns
 * and match their representative trips by `(direction_id, trip_headsign)`, then
 * fall back to headsign grouping when direction_id is unavailable.
 *
 * GTFS reference (including the canonical Airport/Downtown example):
 * https://gtfs.org/documentation/schedule/reference/#tripstxt
 */
export async function buildLinePatterns(
  routeId: string,
): Promise<LinePattern[]> {
  const index = useGtfsDataStore.getState().raptorIndex;
  if (!index) return [];

  const routeIdx = index.routeIdToIdx.get(routeId);
  if (routeIdx === undefined) return [];

  const route = index.routes[routeIdx];
  if (!route || route.trips.length === 0) return [];

  type TripCandidate = {
    tripId: string;
    departureSecs: number[];
    shapeId?: string;
  };
  type DirectionCandidate = {
    headsign: string;
    /** Only when the direction's trips carry it (never from a pattern key alone). */
    gtfsDirectionId?: 0 | 1;
    stopIds?: string[];
    trips: TripCandidate[];
  };

  // Per-direction stop sequences from the backend index. Canonical
  // `route.stopIds` reflects only one direction's longest trip and drops
  // return-only stops. Build one candidate per pattern — never key this by
  // headsign, because two directions can legitimately display the same text.
  // New bundles carry trip.directionId so each pattern also gets its own shape.
  // Bundles without direction_id fall back to all trips with the matching headsign;
  // they still retain both stop sequences, but may share a representative shape.
  const directions: DirectionCandidate[] = [];
  if (route.directionPatterns && route.directionPatterns.length > 0) {
    for (const dp of route.directionPatterns) {
      const sameHeadsign = route.trips.filter((trip) => trip.headsign === dp.headsign);
      const exactDirection = sameHeadsign.filter(
        (trip) => trip.directionId !== undefined && String(trip.directionId) === dp.key,
      );
      const sourceTrips = exactDirection.length > 0 ? exactDirection : sameHeadsign;
      directions.push({
        headsign: dp.headsign,
        gtfsDirectionId: exactDirection[0]?.directionId,
        stopIds: dp.stopIds,
        trips: sourceTrips.map((trip) => ({
          tripId: trip.tripId,
          departureSecs: trip.departureSecs,
          shapeId: trip.shapeId,
        })),
      });
    }
  } else {
    // Bundles without directionPatterns can still carry direction_id. Use the
    // GTFS pair when available; otherwise group by rider-facing headsign.
    const byDirection = new Map<string, DirectionCandidate>();
    for (const trip of route.trips) {
      const key = trip.directionId === undefined
        ? trip.headsign
        : `${trip.directionId}\u0000${trip.headsign}`;
      let group = byDirection.get(key);
      if (!group) {
        group = { headsign: trip.headsign, gtfsDirectionId: trip.directionId, trips: [] };
        byDirection.set(key, group);
      }
      group.trips.push({ tripId: trip.tripId, departureSecs: trip.departureSecs, shapeId: trip.shapeId });
    }
    for (const group of byDirection.values()) directions.push(group);
  }

  // Collect every stop_id we'll need a Dexie record for: the canonical
  // sequence, plus every direction pattern's stops. Patterns may reach
  // outside the canonical set (return-only stops on bidirectional routes).
  const allStopIds = new Set<string>(route.stopIds);
  for (const dp of route.directionPatterns ?? []) {
    for (const id of dp.stopIds) allStopIds.add(id);
  }
  const data = captureCityData();
  const stopRecords = await data.gtfsStops.bulkGet([...allStopIds]);
  const stopMap = new Map<string, { name: string; lat: number; lon: number }>();
  for (const rec of stopRecords) {
    if (rec) stopMap.set(rec.id, { name: rec.name, lat: rec.lat, lon: rec.lon });
  }

  if (stopMap.size === 0) {
    console.warn(
      `[buildLinePatterns] stopMap is empty for route ${routeId} — gtfsStops table may not be synced yet (requested ${allStopIds.size} IDs)`,
    );
  }

  const patterns: LinePattern[] = [];

  for (let dirIdx = 0; dirIdx < directions.length; dirIdx++) {
    const { headsign, gtfsDirectionId, stopIds: directionStopIds, trips } = directions[dirIdx];
    if (trips.length === 0) {
      console.warn(
        `[buildLinePatterns] no trips match direction "${headsign}" of route ${routeId}`,
      );
      continue;
    }

    // Pick the trip with the most visited stops (departureSecs != -1)
    let bestTrip = trips[0];
    let bestCount = 0;
    for (const trip of trips) {
      const count = trip.departureSecs.filter((s) => s >= 0).length;
      if (count > bestCount) {
        bestCount = count;
        bestTrip = trip;
      }
    }

    // Choose the stop sequence for this direction. Prefer the direction
    // pattern emitted by the backend (carries return-only stops); fall
    // back to the canonical-sequence-with-departure-filter path when no
    // direction sequence is available. The fallback path can't surface stops absent from the
    // canonical sequence — that's the documented limitation.
    const visitedStops: { stopId: string; depSec: number }[] = [];
    if (directionStopIds && directionStopIds.length > 0) {
      // Pattern order is already travel order; depSec only carried so the
      // downstream `.map → filter null` shape stays uniform with the
      // fallback branch. No sort needed.
      for (let i = 0; i < directionStopIds.length; i++) {
        visitedStops.push({ stopId: directionStopIds[i], depSec: i });
      }
    } else {
      for (let i = 0; i < route.stopIds.length; i++) {
        if (bestTrip.departureSecs[i] >= 0) {
          visitedStops.push({
            stopId: route.stopIds[i],
            depSec: bestTrip.departureSecs[i],
          });
        }
      }
      visitedStops.sort((a, b) => a.depSec - b.depSec);
    }

    const stops = visitedStops
      .map((vs) => {
        const rec = stopMap.get(vs.stopId);
        if (!rec) return null;
        return {
          id: vs.stopId,
          name: rec.name,
          location: { lat: rec.lat, lon: rec.lon },
        };
      })
      .filter((s) => s !== null);

    if (stops.length === 0) {
      console.warn(
        `[buildLinePatterns] all stops filtered out for direction "${headsign}" of route ${routeId} — ${visitedStops.length} visited stops had no matching gtfsStops records`,
      );
    } else {
      // Prefer the in-memory shapeId on `bestTrip`. Bundle-read carries it
      // through; the Dexie fallback also preserves it. Falls back to a Dexie
      // lookup so feeds that drift between the two paths still resolve.
      // Wrap the fallback so a Dexie failure (DB closed, schema upgrade
      // mid-flight) degrades to "no shape" for this direction rather than
      // rejecting the whole `buildLinePatterns` call — a missing shape
      // should never prevent the line view from opening.
      let shapeId = bestTrip.shapeId;
      if (!shapeId) {
        try {
          const tripRecord = await data.gtfsTrips.get(bestTrip.tripId);
          shapeId = tripRecord?.shapeId;
        } catch (err) {
          console.warn(
            `[buildLinePatterns] gtfsTrips.get(${bestTrip.tripId}) failed; rendering pattern without shape`,
            err,
          );
        }
      }
      patterns.push({
        directionId: dirIdx,
        headsign,
        stops,
        shapeId,
        ...(gtfsDirectionId !== undefined ? { gtfsDirectionId } : {}),
      });
    }
  }

  data.assertCurrent();
  return patterns;
}
