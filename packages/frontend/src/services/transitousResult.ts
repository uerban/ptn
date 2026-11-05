import type { LatLon, TransportMode, TripResult } from "@pt/shared";
import { decodePolyline } from "../utils/polyline.ts";

/** A faithful, coordinate-shaped transitous leg (NO local-index hydration).
 *  Deliberately a faithful SUPERSET of what the text panel renders today — the
 *  geometry/aggregate fields (`fromLoc`/`toLoc`/`path`/`distanceMeters`, and the
 *  itinerary-level totals) are mapped for fidelity and a future map surface, not
 *  all consumed by the current list view. Not load-bearing for the panel. */
export interface TransitousLeg {
  mode: TransportMode;
  fromName: string;
  toName: string;
  fromLoc: LatLon;
  toLoc: LatLon;
  /** ISO 8601 — formatted in the feed tz at render time. */
  departIso: string;
  arriveIso: string;
  routeShortName?: string;
  routeColor?: string;
  headsign?: string;
  /** Decoded geometry; falls back to a straight [from,to] when no polyline. */
  path: LatLon[];
  distanceMeters?: number;
}

export interface TransitousItinerary {
  legs: TransitousLeg[];
  departIso: string;
  arriveIso: string;
  durationSeconds: number;
  transfers: number;
  walkingDistanceMeters: number;
}

/** Pure map from the backend's coordinate `TripResult` to the native view-model.
 *  Never produces RaptorItinerary; never touches the local GTFS index. */
export function mapTripResult(result: TripResult): TransitousItinerary[] {
  return result.itineraries.map((it) => ({
    legs: it.legs.map((leg) => ({
      mode: leg.mode,
      fromName: leg.from.name,
      toName: leg.to.name,
      fromLoc: leg.from.location,
      toLoc: leg.to.location,
      departIso: leg.departureTime,
      arriveIso: leg.arrivalTime,
      routeShortName: leg.routeShortName,
      routeColor: leg.routeColor,
      headsign: leg.headsign,
      path: leg.polyline ? decodePolyline(leg.polyline) : [leg.from.location, leg.to.location],
      distanceMeters: leg.distanceMeters,
    })),
    departIso: it.departureTime,
    arriveIso: it.arrivalTime,
    durationSeconds: it.durationSeconds,
    transfers: it.transfers,
    walkingDistanceMeters: it.walkingDistanceMeters,
  }));
}
