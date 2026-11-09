import { useMemo } from "react";
import type { Leg } from "@pt/shared";
import { useGuidanceStore } from "../stores/guidanceStore.ts";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import { useRtStore } from "../stores/rtStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { makeGetNextDeparture } from "../services/nextDeparture.ts";
import { useRiderDashboardData } from "./useRiderDashboardData.ts";

export interface GuidanceDashboard {
  /** The guidance itinerary's current leg, or null outside guidance. */
  currentLeg: Leg | null;
  upcomingStops: ReturnType<typeof useRiderDashboardData>["upcomingStops"];
  connectingDepartures: ReturnType<typeof useRiderDashboardData>["connectingDepartures"];
}

/**
 * The rider dashboard's data (upcoming stops and connecting departures) for
 * the current guidance leg. Map-free: Text and Map guidance both read it
 * through `GuidanceSessionProvider`.
 */
export function useGuidanceDashboard(): GuidanceDashboard {
  const guidanceItinerary = useGuidanceStore((s) => s.itinerary);
  const currentLegIndex = useGuidanceStore((s) => s.currentLegIndex);
  const riderTripId = useGuidanceStore((s) => s.riderTripId);
  const transitProgress = useGuidanceStore((s) => s.transitProgress);
  const raptorIndex = useGtfsDataStore((s) => s.raptorIndex);
  const feedTz = useCityStore((s) => s.activeCity.tz);
  const currentLeg = guidanceItinerary?.legs[currentLegIndex] ?? null;

  // Adapt RaptorIndex (array/map structure) to the interface useRiderDashboardData expects
  const dashboardIndex = useMemo(() => {
    if (!raptorIndex) return null;
    return {
      getRouteStops: (routeId: string) => {
        const idx = raptorIndex.routeIdToIdx.get(routeId);
        return idx !== undefined ? raptorIndex.routes[idx].stopIds : [];
      },
      getStopName: (stopId: string) => stopId,
      routesAtStop: (stopId: string) => {
        const idxs = raptorIndex.routesAtStop.get(stopId);
        return idxs ? idxs.map((i) => raptorIndex.routes[i].id) : [];
      },
      getRouteShortName: (routeId: string) => {
        const idx = raptorIndex.routeIdToIdx.get(routeId);
        return idx !== undefined ? raptorIndex.routes[idx].shortName : routeId;
      },
    };
  }, [raptorIndex]);

  const userStopIndex = transitProgress
    ? Math.max(0, (currentLeg?.intermediateStops ?? 0) + 1 - transitProgress.stopsRemaining)
    : 0;

  // RT-aware getNextDeparture for the dashboard, so connecting departures
  // carry live times instead of falling back to the static -1 path that the
  // `>= 0` guard in useRiderDashboardData filters out.
  //
  // Shape adapter: `makeGetNextDeparture` accepts a deliberately-narrow
  // `RaptorIndexLite`. The mapping passes through everything the factory
  // needs from the real RaptorIndex — including per-trip `headsign` so the
  // dashboard chip can show the *winning* trip's direction (a route with both
  // inbound and outbound trips would otherwise always show one direction).
  // The factory uses real `Date.now()` (default) and derives both the
  // service-day calendar and midnight-relative seconds internally.
  const rtDashboardAdapter = useMemo(() => {
    if (!raptorIndex) return {};
    const liteTrips = (trips: (typeof raptorIndex.routes)[number]["trips"]) =>
      trips.map((t) => ({
        tripId: t.tripId,
        serviceId: t.serviceId,
        headsign: t.headsign,
        departureSecs: t.departureSecs,
        // Key into `frequenciesByTrip` — without it, frequency-based
        // trips would surface their template clock times as departures.
        ptbTripIdx: t.ptbTripIdx,
      }));
    const liteIndex = {
      routes: raptorIndex.routes.map((r) => ({
        id: r.id,
        shortName: r.shortName,
        stopIds: r.stopIds,
        // Forwarded so `findStopIdxInRoute` can fall back to per-direction
        // patterns at return-only stops on bidirectional routes — without
        // this, the dashboard would still mask sibling-surface stops.
        directionPatterns: r.directionPatterns,
        trips: liteTrips(r.trips),
      })),
      routeIdToIdx: raptorIndex.routeIdToIdx,
      routesAtStop: raptorIndex.routesAtStop,
      services: raptorIndex.services,
      // Pattern-exact source: with these forwarded, displayed times at
      // pattern-covered stops come from the pattern's own columns instead of
      // the canonical+positional approximation (no `~` at return-direction
      // stops).
      patterns: raptorIndex.patterns?.map((p) => ({
        id: p.id,
        shortName: p.shortName,
        stopIds: p.stopIds,
        trips: liteTrips(p.trips),
      })),
      patternsAtStop: raptorIndex.patternsAtStop,
      frequenciesByTrip: raptorIndex.frequenciesByTrip,
    };
    const fn = makeGetNextDeparture(
      liteIndex,
      {
        getTripDelay: (tripId: string) =>
          useRtStore.getState().getTripDelay(tripId),
        getReceivedAt: (tripId: string) =>
          useRtStore.getState().getReceivedAt(tripId),
      },
      undefined,
      // Feed tz so a cross-tz device's "now" lands on the city's service day.
      feedTz,
    );
    return { getNextDeparture: fn };
  }, [raptorIndex, feedTz]);

  const { upcomingStops, connectingDepartures } = useRiderDashboardData(
    riderTripId,
    currentLeg?.tripId ?? null,
    userStopIndex,
    dashboardIndex,
    rtDashboardAdapter,
  );

  return { currentLeg, upcomingStops, connectingDepartures };
}
