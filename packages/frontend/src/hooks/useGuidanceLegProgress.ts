import { useEffect, useRef, useState } from "react";
import type { Leg, LatLon, WalkingProgress, TransitProgress } from "@pt/shared";
import { LEG_ARRIVAL_RADIUS_M } from "@pt/shared/constants";
import {
  haversineDistance,
  bearing,
  nearestPointOnSegment,
  progressAlongLine,
} from "../utils/geo.ts";
import { db } from "../db/index.ts";
import { decodePolyline } from "../utils/polyline.ts";
import { useGuidanceStore } from "../stores/guidanceStore.ts";
import { useRtStore } from "../stores/rtStore.ts";
import { serverTime } from "../services/serverTime.ts";
import type { WalkRoute } from "../services/walkGraphClient.ts";
import { useWalkRoute } from "./useWalkRoute.ts";

/** Average walking speed in m/s (~4.5 km/h) */
const AVG_WALK_SPEED_MS = 1.25;

/**
 * How early, before its (live) departure, a vehicle may already be carrying
 * the rider: dwell at the boarding stop plus a bus running a little ahead of
 * a feed that doesn't say so.
 */
const BOARDING_GRACE_MS = 60_000;

/**
 * Farther than this from the ride's stop-to-stop line, the rider is not on
 * the vehicle. Consecutive stops are a few hundred metres apart and the road
 * between them rarely strays far from the straight line, so this is loose
 * enough for a curving route and tight enough to tell a rider still at home.
 */
const RIDE_OFF_ROUTE_M = 300;

/** A stop of the current ride, boarding to alighting, in order. */
export interface RideStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

/** A step this close behind the rider counts as passed. */
const STEP_PASSED_M = 5;

function cumulativeMeters(line: LatLon[]): number[] {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1]! + haversineDistance(line[i - 1]!, line[i]!));
  return cum;
}

/**
 * Forward bias for the walk route: the rider is looked for from
 * `ROUTE_BACK_M` behind the last match to `ROUTE_AHEAD_M` ahead of it, not on
 * the globally nearest segment. A path that doubles back (along one sidewalk,
 * across, back along the other) runs two segments a few metres apart, and GPS
 * noise would otherwise jump to the far side and skip "Cross the street".
 * Farther than `ROUTE_REACQUIRE_M` from everything in that window, the rider
 * has left it (a big GPS jump, a shortcut), and the nearest segment overall
 * is taken again.
 */
const ROUTE_BACK_M = 20;
const ROUTE_AHEAD_M = 60;
const ROUTE_REACQUIRE_M = 40;

function pointAt(a: LatLon, b: LatLon, f: number): LatLon {
  return { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon) };
}

/** Metres along `line` of the rider, searched within [lo, hi]. */
function nearestAlong(
  position: LatLon, line: LatLon[], cum: number[], lo: number, hi: number,
): { along: number; dist: number } | null {
  let best: { along: number; dist: number } | null = null;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const start = cum[i]!;
    const len = cum[i + 1]! - start;
    if (cum[i + 1]! < lo || start > hi) continue;
    const proj = nearestPointOnSegment(position, a, b);
    let along = start + haversineDistance(a, proj);
    let point = proj;
    const clamped = Math.min(Math.max(along, lo), hi);
    if (clamped !== along) {
      along = clamped;
      point = len > 0 ? pointAt(a, b, (along - start) / len) : a;
    }
    const dist = haversineDistance(position, point);
    if (!best || dist < best.dist) best = { along, dist };
  }
  return best;
}

/**
 * Walking progress along a walk-graph route, with the next instruction.
 * `prevAlongMeters` is the previous fix's result on this same leg and route
 * (undefined at the start); the result's `alongMeters` is the next call's.
 */
export function computeWalkRouteProgress(
  leg: Leg,
  position: LatLon,
  route: WalkRoute,
  prevAlongMeters?: number,
): { progress: WalkingProgress; alongMeters: number } {
  const line = route.coords.map(([lon, lat]) => ({ lat, lon }));
  const cum = cumulativeMeters(line);
  const total = cum[cum.length - 1]!;
  const windowed = prevAlongMeters === undefined
    ? null
    : nearestAlong(position, line, cum, prevAlongMeters - ROUTE_BACK_M, prevAlongMeters + ROUTE_AHEAD_M);
  const found = windowed && windowed.dist <= ROUTE_REACQUIRE_M
    ? windowed
    : nearestAlong(position, line, cum, 0, total);
  const along = found?.along ?? 0;
  const remaining = Math.max(0, total - along);
  const next = route.steps.find(
    (s) => s.kind !== "depart" && (cum[s.startIndex] ?? total) > along + STEP_PASSED_M,
  );
  const target = next ? (line[next.startIndex] ?? leg.to.location) : leg.to.location;
  return {
    alongMeters: along,
    progress: {
      distanceRemainingMeters: Math.round(remaining),
      estimatedSecondsRemaining: Math.round(remaining / AVG_WALK_SPEED_MS),
      bearingDegrees: bearing(position, target),
      remainingFraction: total > 0 ? remaining / total : 0,
      nextStep: next && next.kind !== "depart"
        ? {
            kind: next.kind,
            turn: next.turn,
            name: next.name,
            distanceToStartMeters: Math.round((cum[next.startIndex] ?? total) - along),
          }
        : undefined,
    },
  };
}

/** Walking progress along the walk-graph route when there is one (with the
 *  next instruction), else along the leg polyline or the endpoints' chord. */
export function computeWalkingProgress(
  leg: Leg,
  position: LatLon,
  route?: WalkRoute | null,
): WalkingProgress {
  if (route && route.coords.length >= 2) return computeWalkRouteProgress(leg, position, route).progress;

  const totalDistance = leg.distanceMeters ?? haversineDistance(leg.from.location, leg.to.location);
  const line = leg.polyline ? decodePolyline(leg.polyline) : [leg.from.location, leg.to.location];
  const progress = progressAlongLine(position, line);
  const distanceRemainingMeters = Math.max(0, totalDistance * (1 - progress));
  const estimatedSecondsRemaining = Math.round(distanceRemainingMeters / AVG_WALK_SPEED_MS);
  const bearingDegrees = bearing(position, leg.to.location);

  return {
    distanceRemainingMeters: Math.round(distanceRemainingMeters),
    estimatedSecondsRemaining,
    bearingDegrees,
    remainingFraction: 1 - progress,
  };
}

export function computeTransitProgress(
  leg: Leg,
  progressFraction: number,
  delaySeconds: number,
  stopIds?: string[],
  stopsLookup?: Record<string, string>
): TransitProgress {
  const totalStops = (leg.intermediateStops ?? 0) + 1; // +1 for destination
  const stopsRemaining = Math.max(1, Math.round(totalStops * (1 - progressFraction)));

  // Resolve current stop name from the route's stop sequence.
  // We estimate which stop the user is near based on progress fraction.
  let currentStopName: string | null = null;
  if (stopIds && stopIds.length > 0 && stopsLookup) {
    const currentStopIdx = Math.min(
      Math.round(progressFraction * (stopIds.length - 1)),
      stopIds.length - 1
    );
    const stopId = stopIds[currentStopIdx];
    currentStopName = stopsLookup[stopId] ?? stopId;
  } else if (stopIds && stopIds.length > 0) {
    // Fallback: use stop ID directly when name lookup is unavailable
    const currentStopIdx = Math.min(
      Math.round(progressFraction * (stopIds.length - 1)),
      stopIds.length - 1
    );
    currentStopName = stopIds[currentStopIdx];
  }
  // POC limitation: without stopIds from raptorIndex or GTFS data,
  // currentStopName remains null. Full implementation should pass
  // the route's stop sequence from raptorIndex.getRouteStops(routeId).

  return {
    currentStopName,
    stopsRemaining,
    delaySeconds,
  };
}

/**
 * Where the rider is along a ride, read against the ride's own stops rather
 * than the from → to chord: the stop they are nearest to, and how many stops
 * remain to the alighting stop (1 on the last stretch — "your stop is next").
 * null when the position is too far from the route for the rider to be on
 * this vehicle at all.
 */
export function computeRideProgress(
  stops: RideStop[],
  position: LatLon,
  delaySeconds: number,
): TransitProgress | null {
  if (stops.length < 2) return null;
  let bestDist = Infinity;
  let bestSeg = 0;
  let bestT = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = { lat: stops[i].lat, lon: stops[i].lon };
    const b = { lat: stops[i + 1].lat, lon: stops[i + 1].lon };
    const proj = nearestPointOnSegment(position, a, b);
    const d = haversineDistance(position, proj);
    if (d < bestDist) {
      const segLen = haversineDistance(a, b);
      bestDist = d;
      bestSeg = i;
      bestT = segLen > 0 ? haversineDistance(a, proj) / segLen : 0;
    }
  }
  if (bestDist > RIDE_OFF_ROUTE_M) return null;
  const nearest = bestT < 0.5 ? bestSeg : bestSeg + 1;
  return {
    currentStopName: stops[nearest].name,
    stopsRemaining: stops.length - 1 - bestSeg,
    delaySeconds,
  };
}

/**
 * The current ride's stops, boarding to alighting, from the local GTFS store.
 * "loading" until they are read; null for a walk, or when the leg carries no
 * pattern sequence or any of its stops is missing — callers then fall back
 * to the leg's endpoints.
 */
function useRideStops(leg: Leg | undefined): RideStop[] | null | "loading" {
  const ids =
    leg &&
    leg.patternStopIds &&
    leg.boardStopIdx !== undefined &&
    leg.alightStopIdx !== undefined &&
    leg.alightStopIdx > leg.boardStopIdx
      ? leg.patternStopIds.slice(leg.boardStopIdx, leg.alightStopIdx + 1)
      : null;
  const key = ids ? ids.join("|") : "";
  const [loaded, setLoaded] = useState<{ key: string; stops: RideStop[] | null }>({
    key: "",
    stops: null,
  });

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    db.gtfsStops
      .bulkGet(key.split("|"))
      .then((rows) => {
        if (cancelled) return;
        const complete = rows.every((r) => r !== undefined);
        setLoaded({
          key,
          stops: complete
            ? rows.map((r) => ({ id: r!.id, name: r!.name, lat: r!.lat, lon: r!.lon }))
            : null,
        });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key, stops: null });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (!key) return null;
  return loaded.key === key ? loaded.stops : "loading";
}

export function shouldAdvanceLeg(leg: Leg, position: LatLon): boolean {
  const distToEnd = haversineDistance(position, leg.to.location);
  return distToEnd < LEG_ARRIVAL_RADIUS_M;
}

/**
 * Hook that tracks guidance leg progress using continuous position updates.
 * Updates the guidance store with walking/transit progress and auto-advances legs.
 */
export function useGuidanceLegProgress(
  position: LatLon | null,
  speed: number | null
): void {
  const phase = useGuidanceStore((s) => s.phase);
  const itinerary = useGuidanceStore((s) => s.itinerary);
  const currentLegIndex = useGuidanceStore((s) => s.currentLegIndex);
  const currentLeg = itinerary?.legs[currentLegIndex];
  const rideStops = useRideStops(currentLeg);
  // Subscribed, not peeked: a route that resolves after guidance starts
  // re-runs the effect without waiting for the next position fix. Asks
  // nothing for a non-walk leg.
  const walkLeg = phase === "navigating" && currentLeg?.mode === "WALK" ? currentLeg : null;
  const { route: walkRoute } = useWalkRoute(walkLeg?.from.location ?? null, walkLeg?.to.location ?? null);
  /** The last match along this leg's route, for the forward bias. */
  const lastAlong = useRef<{ leg: Leg; route: WalkRoute; along: number } | null>(null);

  useEffect(() => {
    if (!position || !itinerary || phase !== "navigating") return;

    const leg = itinerary.legs[currentLegIndex];
    if (!leg) return;

    // Check if we should advance to next leg
    if (shouldAdvanceLeg(leg, position)) {
      useGuidanceStore.getState().advanceLeg();
      return;
    }

    // Update progress based on leg mode
    if (leg.mode === "WALK" || leg.mode === "BIKE" || leg.mode === "SCOOTER") {
      const route = leg.mode === "WALK" && walkRoute && walkRoute.coords.length >= 2 ? walkRoute : null;
      if (route) {
        const prev = lastAlong.current;
        const prevAlong = prev && prev.leg === leg && prev.route === route ? prev.along : undefined;
        const { progress, alongMeters } = computeWalkRouteProgress(leg, position, route, prevAlong);
        lastAlong.current = { leg, route, along: alongMeters };
        useGuidanceStore.getState().setWalkingProgress(progress);
      } else {
        lastAlong.current = null;
        useGuidanceStore.getState().setWalkingProgress(computeWalkingProgress(leg, position));
      }
    } else {
      // Read live delay from RT store instead of static leg.delaySeconds
      const rtResult = leg.tripId ? useRtStore.getState().getTripDelay(leg.tripId) : null;
      const liveDelay = rtResult ? rtResult.delaySeconds : (leg.delaySeconds ?? 0);

      // Nobody is aboard before the vehicle leaves the boarding stop. Until
      // then the rider is waiting — or still at home, planning ahead — and
      // projecting that position onto the route reads as progress: anywhere
      // near the far end, or any one-hop ride, is "1 stop remaining", which
      // fires the get-off alarm before the bus has even arrived.
      const departsMs = new Date(leg.departureTime).getTime() + liveDelay * 1000;
      if (Number.isFinite(departsMs) && serverTime.now() < departsMs - BOARDING_GRACE_MS) {
        return;
      }

      // Along the ride's own stops when they are known; the endpoints'
      // chord (or the leg polyline) only when the leg has none. Off the
      // stops' route, the rider is not on this vehicle.
      if (rideStops === "loading") return;
      let transit: TransitProgress;
      if (rideStops) {
        const along = computeRideProgress(rideStops, position, liveDelay);
        if (!along) {
          useGuidanceStore.getState().setTransitProgress(null);
          useGuidanceStore.getState().setTransferProximity(false);
          return;
        }
        transit = along;
      } else {
        const line = leg.polyline
          ? decodePolyline(leg.polyline)
          : [leg.from.location, leg.to.location];
        transit = computeTransitProgress(leg, progressAlongLine(position, line), liveDelay);
      }
      useGuidanceStore.getState().setTransitProgress(transit);

      // Check transfer proximity: within 2 stops of next leg
      if (transit.stopsRemaining <= 2) {
        useGuidanceStore.getState().setTransferProximity(true);
      } else {
        useGuidanceStore.getState().setTransferProximity(false);
      }
    }
  }, [position, speed, phase, itinerary, currentLegIndex, rideStops, walkRoute]);
}
