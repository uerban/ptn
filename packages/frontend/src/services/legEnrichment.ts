import type { RaptorTransitLeg } from "@pt/shared";

/** Minimal local-GTFS route record shape needed for transit-leg display. */
export interface RouteDisplay {
  shortName?: string;
  color?: string;
}

/** Minimal local-GTFS trip record shape needed for transit-leg display. */
export interface TripDisplay {
  headsign?: string;
}

/**
 * Resolve a transit leg's display fields — route short name, route color,
 * headsign.
 *

 * * The on-device engine and pt-serve `/api/<city>/plan` both project through `pt_core`,
 * emitting a deliberately minimal wire that carries only `routeId` / `tripId` and leaves the
 * rest to the client — "client enrichment" (pt-serve; `crates/pt-serve/src/wire.rs`). The
 * backend-assist fallback (`searchOrchestrator.ts`) is the first client consumer of `/plan`, so
 * without this backfill a fallback itinerary would render with a blank route badge and the grey
 * default colour instead of the line number.

 *
 * A value the leg already carries always wins; otherwise it is filled from the
 * local GTFS DB maps by `routeId` / `tripId`. A missing route/trip yields
 * `undefined` (the caller's render path already tolerates absent fields).
 */
export function resolveTransitLegDisplay(
  leg: RaptorTransitLeg,
  routes: ReadonlyMap<string, RouteDisplay>,
  trips: ReadonlyMap<string, TripDisplay>,
): { routeShortName?: string; routeColor?: string; headsign?: string } {
  const route = routes.get(leg.routeId);
  const trip = trips.get(leg.tripId);
  return {
    routeShortName: leg.routeShortName ?? route?.shortName,
    routeColor: leg.routeColor ?? route?.color,
    headsign: leg.headsign ?? trip?.headsign,
  };
}
