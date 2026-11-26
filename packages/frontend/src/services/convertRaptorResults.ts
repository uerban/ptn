import { DEFAULT_WALK_SPEED_MPS } from "@pt/shared/constants";
import { serviceDayOriginUnix, unixToServiceDate } from "@pt/shared/time";
import type { Itinerary, Leg, LegPlace, LatLon, TransportMode } from "@pt/shared";
import { encodePolyline } from "../utils/polyline.ts";
import { captureCityData } from "./cityData.ts";
import { resolveTransitLegDisplay } from "./legEnrichment.ts";
import type { RtComposedItinerary } from "./rtOverlay.ts";

/**
 * Project a service-day-seconds value to an absolute-instant ISO string.
 * When `feedTz` is known, uses the GTFS wall-clock projection in the feed tz
 * (DST-correct, cross-tz-correct). When absent (local user / no tz), falls back
 * to the legacy device-local base-date cascade.
 */
function projectToIso(
  secs: number,
  serviceDateYmd: number,
  feedTz: string | undefined,
): string {
  // GTFS `Time` counts from the service date's origin (local noon minus 12 h),
  // the instant the engine resolved the departure against. Local midnight is
  // off by an hour on a DST date, so project from the origin, not midnight.
  const tz = feedTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Date((serviceDayOriginUnix(serviceDateYmd, tz) + secs) * 1000).toISOString();
}

/**
 * Display names for the two synthesized first/last-mile walk legs. They are
 * baked into the itinerary data rather than resolved at render, so the caller
 * has to hand them in already translated — every leg-row surface reads
 * `leg.to.name` straight through.
 */
interface EndpointLabels {
  origin: string;
  destination: string;
}

export async function convertRaptorResults(
  results: RtComposedItinerary[],
  departureTime: Date,
  origin: LatLon,
  destination: LatLon,
  feedTz: string | undefined,
  queryServiceDateYmd: number,
  endpointLabels: EndpointLabels,
): Promise<Itinerary[]> {
  const data = captureCityData();
  const allStops = await data.gtfsStops.toArray();
  const stopMap = new Map(allStops.map((s) => [s.id, s]));

  // Backfill transit-leg display fields (route short name / colour / headsign)
  // from the local GTFS DB. On-device-engine legs already carry these, but the
  // pt-serve `/plan` backend-assist fallback sends a minimal wire that omits
  // them — see `resolveTransitLegDisplay`. Routes is a small table (toArray);
  // trips is large, so only fetch the tripIds actually present in the results.
  const tripIds = new Set<string>();
  for (const it of results) {
    for (const leg of it.legs) {
      if (leg.type === "transit") tripIds.add(leg.tripId);
    }
  }
  const routeRecords = await data.gtfsRoutes.toArray();
  const routeMap = new Map(routeRecords.map((r) => [r.id, r]));
  const tripRecords = tripIds.size > 0 ? await data.gtfsTrips.bulkGet([...tripIds]) : [];
  const tripMap = new Map(
    tripRecords.filter((t): t is NonNullable<typeof t> => t != null).map((t) => [t.tripId, t]),
  );

  data.assertCurrent();
  return results.map((itin) => {
    // Project each time once, in the feed tz, against the query service date. Overnight-fallback
    // results carry the engine's -86400-rewritten secs and project correctly against the query date
    // (CUT — the previous-day projection is algebraically identical). No per-result branch.
    const iso = (secs: number) => projectToIso(secs, queryServiceDateYmd, feedTz);
    if (itin.directWalk) {
      const walk = itin.directWalk;
      return {
        legs: [{ mode: "WALK" as TransportMode,
          from: { name: endpointLabels.origin, location: walk.origin },
          to: { name: endpointLabels.destination, location: walk.destination },
          departureTime: iso(itin.departureSecs), arrivalTime: iso(itin.arrivalSecs),
          durationSeconds: itin.totalSecs,
          distanceMeters: itin.directWalk.route.distanceMeters,
          polyline: encodePolyline(itin.directWalk.route.coords.map(([lon, lat]) => ({ lat, lon }))) }],
        departureTime: iso(itin.departureSecs), arrivalTime: iso(itin.arrivalSecs),
        durationSeconds: itin.totalSecs, transfers: 0, walkingDistanceMeters: walk.route.distanceMeters,
      };
    }
    const transitLegs: Leg[] = itin.legs.map((leg) => {
      const fromStop = stopMap.get(leg.fromStopId);
      const toStop = stopMap.get(leg.toStopId);
      const from: LegPlace = {
        name: fromStop?.name ?? leg.fromStopId,
        stopId: leg.fromStopId,
        location: fromStop
          ? { lat: fromStop.lat, lon: fromStop.lon }
          : { lat: 0, lon: 0 },
      };
      const to: LegPlace = {
        name: toStop?.name ?? leg.toStopId,
        stopId: leg.toStopId,
        location: toStop
          ? { lat: toStop.lat, lon: toStop.lon }
          : { lat: 0, lon: 0 },
      };
      const isTransit = leg.type === "transit";
      const display = isTransit ? resolveTransitLegDisplay(leg, routeMap, tripMap) : undefined;
      return {
        mode: (leg.mode ?? (isTransit ? "BUS" : "WALK")) as TransportMode,
        from,
        to,
        departureTime: iso(leg.departSecs),
        arrivalTime: iso(leg.arriveSecs),
        durationSeconds: leg.arriveSecs - leg.departSecs,
        ...(!isTransit && "distanceMeters" in leg && typeof leg.distanceMeters === "number"
          ? { distanceMeters: leg.distanceMeters } : {}),
        routeShortName: display?.routeShortName,
        routeColor: display?.routeColor,
        tripId: isTransit ? leg.tripId : undefined,
        headsign: display?.headsign,
        intermediateStops: leg.intermediateStops,
        routeId: isTransit ? leg.routeId : undefined,
        approximate: isTransit ? leg.approximate : undefined,
        ...(isTransit && leg.inSeat ? { inSeat: true } : {}),
        ...(isTransit && leg.appliedDelaySeconds !== undefined
          ? { appliedDelaySeconds: leg.appliedDelaySeconds }
          : {}),
        boardStopIdx: isTransit ? leg.boardStopIdx : undefined,
        alightStopIdx: isTransit ? leg.alightStopIdx : undefined,
        patternStopIds: isTransit ? leg.patternStopIds : undefined,
      };
    });

    const legs: Leg[] = [];

    // Synthesize first-mile walking leg from origin to first boarding stop
    if (itin.sourceWalkSecs > 0 && transitLegs.length > 0) {
      const firstLeg = transitLegs[0];
      const walkStartSecs = itin.departureSecs;
      const walkEndSecs = walkStartSecs + itin.sourceWalkSecs;
      legs.push({
        mode: "WALK" as TransportMode,
        from: { name: endpointLabels.origin, location: origin },
        to: firstLeg.from,
        departureTime: iso(walkStartSecs),
        arrivalTime: iso(walkEndSecs),
        durationSeconds: itin.sourceWalkSecs,
        ...(itin.sourceRunToCatch ? { runToCatch: true } : {}),
      });
    }

    legs.push(...transitLegs);

    // Synthesize last-mile walking leg from final alighting stop to destination
    if (itin.destWalkSecs > 0 && transitLegs.length > 0) {
      const lastLeg = transitLegs[transitLegs.length - 1];
      const walkStartSecs = itin.arrivalSecs - itin.destWalkSecs;
      const walkEndSecs = itin.arrivalSecs;
      legs.push({
        mode: "WALK" as TransportMode,
        from: lastLeg.to,
        to: { name: endpointLabels.destination, location: destination },
        departureTime: iso(walkStartSecs),
        arrivalTime: iso(walkEndSecs),
        durationSeconds: itin.destWalkSecs,
      });
    }

    const walkDistanceKnown = Number.isFinite(itin.totalWalkMeters) && itin.totalWalkMeters! >= 0;
    return {
      legs,
      departureTime: iso(itin.departureSecs),
      arrivalTime: iso(itin.arrivalSecs),
      durationSeconds: itin.totalSecs,
      transfers: itin.transfers,
      // The walked metres themselves; seconds × 1.25 m/s overstated it for
      // anyone slower and understated a run to catch.
      walkingDistanceMeters: Math.round(walkDistanceKnown ? itin.totalWalkMeters! : itin.totalWalkSecs * DEFAULT_WALK_SPEED_MPS),
      ...(!walkDistanceKnown ? {walkingDistanceEstimated: true} : {}),
      ...(itin.cancelled ? { cancelled: true } : {}),
      ...(itin.timingUnreliable ? { timingUnreliable: true } : {}),
    };
  });
}

export function serviceDateYmdFor(departureTime: Date, feedTz: string | undefined): number {
  const tz = feedTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return unixToServiceDate(Math.floor(departureTime.getTime() / 1000), tz);
}
